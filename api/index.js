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

    if (parsed.type === 'track') {
      const oembed = await fetchSpotifyOEmbed(spotifyUrl);
      res.status(200).json(extractTrackMetadata(oembed));
      return;
    }

    const playlistHtml = await fetchSpotifyEmbedPage(parsed.id);
    const playlistTracks = extractPlaylistTracks(playlistHtml);
    const enrichedTracks = await enrichPlaylistTracks(playlistTracks);

    res.status(200).json(enrichedTracks);
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

async function fetchSpotifyOEmbed(spotifyUrl) {
  return fetchSpotifyPage(spotifyUrl);
}

async function fetchSpotifyEmbedPage(playlistId) {
  const embedUrl = `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}?utm_source=oembed`;
  const response = await fetch(embedUrl, {
    headers: {
      Accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw createError(response.status || 500, 'spotify_embed_fetch_failed', 'Unable to fetch Spotify playlist data.');
  }

  return response.text();
}

function extractTrackMetadata(oembed) {
  const title = cleanValue(oembed?.title || '');
  const thumbnailUrl = typeof oembed?.thumbnail_url === 'string' ? oembed.thumbnail_url : null;
  const authorName = cleanValue(oembed?.author_name || '');

  if (!title) {
    throw createError(500, 'missing_title', 'Could not read metadata from Spotify oEmbed.');
  }

  return {
    thumbnail_url: thumbnailUrl,
    song_name: title,
    artist_name: authorName
  };
}

function extractPlaylistTracks(html) {
  const nextData = extractNextDataJson(html);
  const rawTracks = nextData?.props?.pageProps?.state?.data?.entity?.tracks;

  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    throw createError(500, 'playlist_tracks_missing', 'Could not read tracks from the Spotify playlist embed.');
  }

  return rawTracks
    .filter((track) => track?.entityType === 'track' && typeof track?.uri === 'string')
    .map((track) => ({
      track_id: extractTrackIdFromUri(track.uri),
      song_name: cleanValue(track.title || ''),
      artist_name: cleanValue(track.subtitle || '')
    }))
    .filter((track) => track.track_id && track.song_name);
}

function extractNextDataJson(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);

  if (!match?.[1]) {
    throw createError(500, 'missing_next_data', 'Could not locate playlist data in the Spotify embed page.');
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    throw createError(500, 'invalid_next_data', 'Could not parse playlist data from the Spotify embed page.');
  }
}

function extractTrackIdFromUri(uri) {
  const match = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return match ? match[1] : '';
}

async function enrichPlaylistTracks(tracks) {
  const concurrency = 8;
  const results = [];

  for (let index = 0; index < tracks.length; index += concurrency) {
    const chunk = tracks.slice(index, index + concurrency);
    const enrichedChunk = await Promise.all(chunk.map(enrichSingleTrack));
    results.push(...enrichedChunk);
  }

  return results;
}

async function enrichSingleTrack(track) {
  const spotifyUrl = `https://open.spotify.com/track/${track.track_id}`;

  try {
    const oembed = await fetchSpotifyOEmbed(spotifyUrl);
    return {
      thumbnail_url: typeof oembed?.thumbnail_url === 'string' ? oembed.thumbnail_url : null,
      song_name: track.song_name,
      artist_name: track.artist_name
    };
  } catch {
    return {
      thumbnail_url: null,
      song_name: track.song_name,
      artist_name: track.artist_name
    };
  }
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
