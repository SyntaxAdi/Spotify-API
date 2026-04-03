'use strict';

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SUPPORTED_TYPES = new Set(['track', 'playlist']);
const DEFAULT_MARKET = process.env.SPOTIFY_MARKET || 'US';

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

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).json({
      error: 'missing_spotify_credentials',
      message: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your Vercel environment variables.'
    });
    return;
  }

  try {
    const spotifyUrl = getIncomingUrl(req);
    const market = getIncomingMarket(req);

    if (!spotifyUrl) {
      res.status(400).json({
        error: 'missing_url',
        message: 'Provide a Spotify playlist or track URL using ?url=... or a POST body with { "url": "..." }.',
        example: {
          get: '/?url=https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl',
          post: {
            url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'
          }
        }
      });
      return;
    }

    const parsed = parseSpotifyUrl(spotifyUrl);
    const accessToken = await getAccessToken(clientId, clientSecret);

    if (parsed.type === 'track') {
      const track = await spotifyFetch(`/tracks/${parsed.id}?market=${encodeURIComponent(market)}`, accessToken);

      res.status(200).json({
        ok: true,
        type: 'track',
        input_url: spotifyUrl,
        market,
        metadata: normalizeTrack(track)
      });
      return;
    }

    const playlist = await fetchPlaylistWithTracks(parsed.id, accessToken, market);

    res.status(200).json({
      ok: true,
      type: 'playlist',
      input_url: spotifyUrl,
      market,
      metadata: playlist
    });
  } catch (error) {
    const status = error.statusCode || 500;

    res.status(status).json({
      error: error.code || 'internal_error',
      message: error.message || 'Something went wrong while fetching Spotify metadata.',
      spotify: error.spotify || undefined
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

function getIncomingMarket(req) {
  if (req.method === 'GET') {
    const market = typeof req.query?.market === 'string' ? req.query.market.trim().toUpperCase() : '';
    return normalizeMarket(market);
  }

  const body = req.body;

  if (!body) {
    return DEFAULT_MARKET;
  }

  if (typeof body === 'string') {
    try {
      const parsedBody = JSON.parse(body);
      return normalizeMarket(parsedBody?.market);
    } catch {
      return DEFAULT_MARKET;
    }
  }

  return normalizeMarket(body.market);
}

function normalizeMarket(market) {
  if (typeof market !== 'string') {
    return DEFAULT_MARKET;
  }

  const trimmed = market.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : DEFAULT_MARKET;
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

  const id = rawId.split('?')[0];

  if (!/^[A-Za-z0-9]+$/.test(id)) {
    throw createError(400, 'invalid_spotify_id', 'The Spotify URL does not contain a valid resource ID.');
  }

  return { type, id };
}

async function getAccessToken(clientId, clientSecret) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw createError(
      response.status || 500,
      'spotify_auth_failed',
      data.error_description || 'Unable to authenticate with Spotify. Check your client ID and client secret.'
    );
  }

  return data.access_token;
}

async function spotifyFetch(pathname, accessToken) {
  const response = await fetch(`${SPOTIFY_API_BASE}${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const status = response.status || 500;
    const message =
      data?.error?.message ||
      `Spotify API request failed for ${pathname}.`;

    if (status === 404) {
      throw createError(404, 'not_found', message);
    }

    throw createError(status, 'spotify_api_error', message, data);
  }

  return data;
}

async function fetchPlaylistWithTracks(playlistId, accessToken, market) {
  const playlist = await spotifyFetch(
    `/playlists/${playlistId}?market=${encodeURIComponent(market)}&fields=id,name,description,public,collaborative,external_urls,href,images,owner(id,display_name,external_urls),followers(total),snapshot_id,tracks(total,limit,next,offset,items(added_at,added_by(id),track(id,name,album(id,name,release_date,images,external_urls),artists(id,name,external_urls),disc_number,duration_ms,explicit,external_ids,external_urls,is_local,is_playable,preview_url,track_number,type,uri,popularity)))`,
    accessToken
  );

  const items = [...(playlist.tracks.items || [])];
  let nextUrl = playlist.tracks.next;

  while (nextUrl) {
    const nextPath = nextUrl.replace(`${SPOTIFY_API_BASE}`, '');
    const page = await spotifyFetch(nextPath, accessToken);
    items.push(...(page.items || []));
    nextUrl = page.next;
  }

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    public: playlist.public,
    collaborative: playlist.collaborative,
    snapshot_id: playlist.snapshot_id,
    href: playlist.href,
    external_urls: playlist.external_urls,
    images: playlist.images,
    followers: playlist.followers,
    owner: playlist.owner,
    tracks_total: playlist.tracks.total,
    tracks: items.map((item) => ({
      added_at: item.added_at,
      added_by: item.added_by,
      track: item.track ? normalizeTrack(item.track) : null
    }))
  };
}

function normalizeTrack(track) {
  return {
    id: track.id,
    name: track.name,
    type: track.type,
    uri: track.uri,
    href: track.href,
    external_urls: track.external_urls,
    external_ids: track.external_ids,
    duration_ms: track.duration_ms,
    explicit: track.explicit,
    popularity: track.popularity,
    preview_url: track.preview_url,
    track_number: track.track_number,
    disc_number: track.disc_number,
    is_local: track.is_local,
    is_playable: track.is_playable,
    artists: track.artists,
    album: track.album
  };
}

function createError(statusCode, code, message, spotify) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.spotify = spotify;
  return error;
}
