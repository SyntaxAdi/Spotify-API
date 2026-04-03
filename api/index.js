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
  const response = await fetch(spotifyUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SpotifyMetadataBot/1.0)',
      Accept: 'text/html,application/xhtml+xml'
    }
  });

  if (!response.ok) {
    throw createError(response.status || 500, 'spotify_page_fetch_failed', 'Unable to fetch the Spotify page.');
  }

  return response.text();
}

function extractMetadata(html, type) {
  const pageTitle = decodeHtmlEntities(findTagContent(html, 'title'));
  const thumbnailUrl = findMetaContent(html, 'property', 'og:image') || null;

  if (!pageTitle) {
    throw createError(500, 'missing_page_title', 'Could not read metadata from the Spotify page.');
  }

  if (type === 'track') {
    const match = pageTitle.match(/^(.*?) - song and lyrics by (.*?) \| Spotify$/i);

    if (!match) {
      throw createError(500, 'track_parse_failed', 'Could not parse track metadata from the Spotify page.');
    }

    return {
      thumbnail_url: thumbnailUrl,
      song_name: cleanValue(match[1]),
      artist_name: cleanValue(match[2])
    };
  }

  const playlistMatch = pageTitle.match(/^(.*?) - playlist by (.*?) \| Spotify$/i);

  if (!playlistMatch) {
    throw createError(500, 'playlist_parse_failed', 'Could not parse playlist metadata from the Spotify page.');
  }

  return {
    thumbnail_url: thumbnailUrl,
    song_name: cleanValue(playlistMatch[1]),
    artist_name: cleanValue(playlistMatch[2])
  };
}

function findTagContent(html, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  return html.match(regex)?.[1]?.trim() || '';
}

function findMetaContent(html, attrName, attrValue) {
  const regex = new RegExp(
    `<meta[^>]*${attrName}=["']${escapeRegExp(attrValue)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i'
  );

  const directMatch = html.match(regex)?.[1];

  if (directMatch) {
    return decodeHtmlEntities(directMatch.trim());
  }

  const reversedRegex = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${escapeRegExp(attrValue)}["'][^>]*>`,
    'i'
  );

  return decodeHtmlEntities(reversedRegex.exec(html)?.[1]?.trim() || '');
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
