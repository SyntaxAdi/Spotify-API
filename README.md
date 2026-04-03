# Spotify Metadata API

A minimal Vercel-ready API that accepts a Spotify playlist URL or track URL and returns metadata as JSON using the official Spotify Web API.

## Environment variables

Add these in Vercel Project Settings -> Environment Variables:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

## Usage

### GET

```bash
curl "https://your-app.vercel.app/?url=https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl"
```

```bash
curl "https://your-app.vercel.app/?url=https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
```

### POST

```bash
curl -X POST "https://your-app.vercel.app/" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl"}'
```

## Local development

```bash
npm install -g vercel
vercel dev
```

Then open:

```bash
http://localhost:3000/?url=https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl
```
