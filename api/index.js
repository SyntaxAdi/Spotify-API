'use strict';

const SUPPORTED_TYPES = new Set(['track', 'playlist']);

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(200).json({ ok: true });
    return;
  }

  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({
      error: 'method_not_allowed',
      message: 'Use GET with ?url=... or POST with a JSON body containing "url".'
    });
    return;
  }

  try {
    const spotifyUrl = getIncomingUrl(req);

    if (!spotifyUrl) {
      res.status(400).json({
        error: 'missing_url',
        message: 'Provide a Spotify track or playlist URL using ?url=... or a POST body with { "url": "..." }.'
      });
      return;
    }

    const parsed = parseSpotifyUrl(spotifyUrl);
    const html = await fetchSpotifyPage(spotifyUrl);
    const metadata = extractMetadata(html, parsed.type);

    res.status(200).json(metadata);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.code || 'internal_error',
      message: error.message || 'Something went wrong while fetching metadata.'
    });
  }
};

function setJsonHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getIncomingUrl(req) {
  if (req.method === 'GET') {
    return typeof req.query?.url === 'string' ? req.query.url.trim() : '';
  }

  const body = req.body;

  if (!body) {
    return '';
  }

  if (typeof body === 'string') {
    try {
      const parsedBody = JSON.parse(body);
      return typeof parsedBody?.url === 'string' ? parsedBody.url.trim() : '';
    } catch {
      return '';
    }
  }

  return typeof body.url === 'string' ? body.url.trim() : '';
}

function parseSpotifyUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw createError(400, 'invalid_url', 'The provided value is not a valid URL.');
  }

  if (!['open.spotify.com', 'play.spotify.com'].includes(url.hostname)) {
    throw createError(400, 'unsupported_host', 'Only Spotify track and playlist URLs are supported.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const [type, rawId] = segments;

  if (!SUPPORTED_TYPES.has(type) || !rawId) {
    throw createError(400, 'unsupported_spotify_url', 'Only Spotify track and playlist URLs are supported.');
  }

  return { type, id: rawId };
}

async function fetchSpotifyPage(spotifyUrl) {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const response = await fetch(oembedUrl, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw createError(response.status || 500, 'spotify_oembed_fetch_failed', 'Unable to fetch Spotify metadata.');
  }

  return response.json();
}

function extractMetadata(oembed, type) {
  const title = cleanValue(oembed?.title || '');
  const thumbnailUrl = typeof oembed?.thumbnail_url === 'string' ? oembed.thumbnail_url : null;
  const authorName = cleanValue(oembed?.author_name || '');

  if (!title) {
    throw createError(500, 'missing_title', 'Could not read metadata from Spotify oEmbed.');
  }

  if (type === 'track') {
    return {
      thumbnail_url: thumbnailUrl,
      song_name: title,
      artist_name: authorName
    };
  }

  return {
    thumbnail_url: thumbnailUrl,
    song_name: title,
    artist_name: authorName
  };
}

function cleanValue(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
