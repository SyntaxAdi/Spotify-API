'use strict';

const SUPPORTED_SPOTIFY_TYPES = new Set(['track', 'playlist']);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
  } else {
    record.count++;
  }

  rateLimitMap.set(ip, record);

  // Cleanup old entries to prevent memory leak
  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (now > val.resetTime) rateLimitMap.delete(key);
    }
  }

  return record.count <= MAX_REQUESTS_PER_WINDOW;
}

module.exports = async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(200).json({ ok: true });
    return;
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    console.warn(`[Rate Limit Exceeded] IP: ${ip}`);
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Rate limit exceeded. Please try again later.'
    });
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
    const incomingUrl = getIncomingUrl(req);

    if (!incomingUrl) {
      console.warn(`[Suspicious Traffic] Missing URL from IP: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
      res.status(400).json({
        error: 'missing_url',
        message: 'Provide a Spotify or YouTube URL using ?url=... or a POST body with { "url": "..." }.'
      });
      return;
    }

    const platform = detectPlatform(incomingUrl);

    if (platform === 'spotify') {
      await handleSpotify(incomingUrl, res);
    } else if (platform === 'youtube') {
      await handleYouTube(incomingUrl, res);
    } else {
      console.warn(`[Suspicious Traffic] Unsupported URL: ${incomingUrl}`);
      throw createError(400, 'unsupported_platform', 'Only Spotify and YouTube URLs are supported.');
    }
  } catch (error) {
    console.error(`[API Error] ${error.code || 'internal_error'}: ${error.message}`);
    res.status(error.statusCode || 500).json({
      error: error.code || 'internal_error',
      message: error.message || 'Something went wrong while fetching metadata.'
    });
  }
};

// ─── Platform Detection ──────────────────────────────────────────────

function detectPlatform(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (['open.spotify.com', 'play.spotify.com'].includes(url.hostname)) {
    return 'spotify';
  }

  if (['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    return 'youtube';
  }

  if (url.hostname === 'youtu.be') {
    return 'youtube';
  }

  return null;
}

// ─── Spotify Handler ─────────────────────────────────────────────────

async function handleSpotify(spotifyUrl, res) {
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
}

// ─── YouTube Handler ─────────────────────────────────────────────────

async function handleYouTube(youtubeUrl, res) {
  const parsed = parseYouTubeUrl(youtubeUrl);

  if (parsed.type === 'video') {
    const videoData = await fetchYouTubeVideoDetails(parsed.id);
    res.status(200).json(videoData);
    return;
  }

  const playlistVideos = await fetchYouTubePlaylistVideos(parsed.id);
  res.status(200).json(playlistVideos);
}

function parseYouTubeUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw createError(400, 'invalid_url', 'Not a valid URL.');
  }

  // Playlist URL: youtube.com/playlist?list=PLxxxxx
  const listParam = url.searchParams.get('list');

  if (url.pathname === '/playlist' && listParam) {
    return { type: 'playlist', id: listParam };
  }

  // Video URL with playlist: youtube.com/watch?v=xxx&list=PLxxx
  // Treat as playlist when list param present
  if (listParam && url.searchParams.get('v')) {
    return { type: 'playlist', id: listParam };
  }

  // Single video: youtube.com/watch?v=xxx
  const videoId = url.searchParams.get('v');
  if (videoId) {
    return { type: 'video', id: videoId };
  }

  // Short URL: youtu.be/xxx
  if (url.hostname === 'youtu.be') {
    const shortId = url.pathname.split('/').filter(Boolean)[0];
    if (shortId) {
      return { type: 'video', id: shortId };
    }
  }

  throw createError(400, 'unsupported_youtube_url', 'Provide a YouTube video or playlist URL.');
}

function getYouTubeApiKey() {
  const key = process.env.YOUTUBE_API_KEY;

  if (!key) {
    throw createError(500, 'missing_api_key', 'YOUTUBE_API_KEY environment variable not set.');
  }

  return key;
}

async function fetchYouTubeVideoDetails(videoId) {
  const apiKey = getYouTubeApiKey();
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${apiKey}`;

  const response = await fetch(apiUrl, {
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw createError(response.status || 500, 'youtube_api_failed', 'Unable to fetch YouTube video data.');
  }

  const data = await response.json();
  const items = data.items;

  if (!Array.isArray(items) || items.length === 0) {
    throw createError(404, 'video_not_found', 'YouTube video not found.');
  }

  const snippet = items[0].snippet;

  return {
    video_title: cleanValue(snippet.title || ''),
    channel_name: cleanValue(snippet.channelTitle || ''),
    video_url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null
  };
}

async function fetchYouTubePlaylistVideos(playlistId) {
  const apiKey = getYouTubeApiKey();
  const videos = [];
  let pageToken = '';

  do {
    const apiUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`;

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw createError(response.status || 500, 'youtube_api_failed', 'Unable to fetch YouTube playlist data.');
    }

    const data = await response.json();
    const items = data.items;

    if (Array.isArray(items)) {
      for (const item of items) {
        const snippet = item.snippet;
        const videoId = snippet?.resourceId?.videoId;

        // Skip deleted/private videos
        if (!videoId || snippet.title === 'Deleted video' || snippet.title === 'Private video') {
          continue;
        }

        videos.push({
          video_title: cleanValue(snippet.title || ''),
          channel_name: cleanValue(snippet.videoOwnerChannelTitle || snippet.channelTitle || ''),
          video_url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail_url: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null
        });
      }
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  if (videos.length === 0) {
    throw createError(404, 'playlist_empty', 'YouTube playlist has no accessible videos.');
  }

  return videos;
}

// ─── Shared Utilities ────────────────────────────────────────────────

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

// ─── Spotify-Specific Functions ──────────────────────────────────────

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

  if (!SUPPORTED_SPOTIFY_TYPES.has(type) || !rawId) {
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
  const rawTrackList = nextData?.props?.pageProps?.state?.data?.entity?.trackList;
  const rawTracks = Array.isArray(rawTrackList)
    ? rawTrackList
    : (rawTrackList && typeof rawTrackList === 'object' ? Object.values(rawTrackList) : []);

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
