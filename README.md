# Spotify Metadata API

A minimal Vercel-ready API that accepts a Spotify playlist URL or track URL and returns only:

- `thumbnail_url`
- `song_name`
- `artist_name`

This version does not use Spotify Web API credentials. It reads public Spotify page metadata instead.

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
