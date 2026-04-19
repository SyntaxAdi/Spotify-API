'use strict';

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
    const inputUrl = getIncomingUrl(req);

    if (!inputUrl) {
      res.status(400).json({
        error: 'missing_url',
        message: 'Provide a Spotify or YouTube track/playlist URL using ?url=... or a POST body with { "url": "..." }.'
      });
      return;
    }

    const parsed = parseUrl(inputUrl);

    if (parsed.service === 'spotify') {
      if (parsed.type === 'track') {
        const oembed = await fetchSpotifyOEmbed(inputUrl);
        res.status(200).json(extractTrackMetadata(oembed));
        return;
      }

      const playlistHtml = await fetchSpotifyEmbedPage(parsed.id);
      const playlistTracks = extractPlaylistTracks(playlistHtml);
      const enrichedTracks = await enrichPlaylistTracks(playlistTracks);

      res.status(200).json(enrichedTracks);
    } else if (parsed.service === 'youtube') {
      if (parsed.type === 'playlist') {
        const playlistTracks = await fetchYouTubePlaylist(parsed.id);
        res.status(200).json(playlistTracks);
        return;
      }
    }
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

function parseUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw createError(400, 'invalid_url', 'The provided value is not a valid URL.');
  }

  const hostname = url.hostname.replace('www.', '');

  if (['open.spotify.com', 'play.spotify.com'].includes(hostname)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const [type, rawId] = segments;

    if (!['track', 'playlist'].includes(type) || !rawId) {
      throw createError(400, 'unsupported_spotify_url', 'Only Spotify track and playlist URLs are supported.');
    }

    return { service: 'spotify', type, id: rawId };
  }

  if (['youtube.com', 'youtu.be', 'm.youtube.com'].includes(hostname)) {
    const list = url.searchParams.get('list');
    if (list) {
      return { service: 'youtube', type: 'playlist', id: list };
    }
    throw createError(400, 'unsupported_youtube_url', 'Only YouTube playlist URLs are supported.');
  }

  throw createError(400, 'unsupported_host', 'Only Spotify and YouTube URLs are supported.');
}

async function fetchSpotifyOEmbed(spotifyUrl) {
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

async function fetchYouTubePlaylist(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  if (!response.ok) {
    throw createError(response.status || 500, 'youtube_playlist_fetch_failed', 'Unable to fetch YouTube playlist data.');
  }

  const html = await response.text();
  const match = html.match(/var ytInitialData = ({.*?});/s);
  if (!match?.[1]) {
    throw createError(500, 'missing_yt_data', 'Could not locate playlist data in the YouTube page.');
  }

  let jsonData;
  try {
    jsonData = JSON.parse(match[1]);
  } catch {
    throw createError(500, 'invalid_yt_data', 'Could not parse playlist data from the YouTube page.');
  }

  const contents = jsonData.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents;

  if (!Array.isArray(contents)) {
    throw createError(500, 'playlist_tracks_missing', 'Could not read tracks from the YouTube playlist.');
  }

  return contents
    .map(item => item.playlistVideoRenderer)
    .filter(Boolean)
    .map(video => ({
      thumbnail_url: video.thumbnail?.thumbnails?.pop()?.url || null,
      song_name: video.title?.runs?.[0]?.text || video.title?.accessibility?.accessibilityData?.label || 'Unknown Title',
      artist_name: video.shortBylineText?.runs?.[0]?.text || 'Unknown Artist',
      video_url: video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : null
    }));
}

function extractTrackMetadata(oembed) {
  const title = cleanValue(oembed?.title || '');
  const thumbnailUrl = typeof oembed?.thumbnail_url === 'string' ? oembed.thumbnail_url : null;
  const authorName = cleanValue(oembed?.author_name || '');

  if (!title) {
    throw createError(500, 'missing_title', 'Could not read metadata from oEmbed.');
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
