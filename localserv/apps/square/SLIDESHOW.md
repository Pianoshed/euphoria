# Slideshow statuses - API and frontend contract

## Create (POST /api/square/statuses/, multipart)
| field | notes |
|---|---|
| `slides` | 2-7 image files (repeat the field). Order = play order. Don't also send `file`. |
| `slide_seconds` | 2-6, default 3 (default shrinks automatically so the show fits). **photos x seconds <= 15**, otherwise 400 |
| `template` | motion between photos: `fade` (default), `drift` (slow zoom), `slide`, `pop` |
| `canvas` | stage behind the photo: `blur` (default, blurred copy), `fill` (full-bleed crop), `frame` (polaroid card), `night` (dark) |
| `text` | optional caption, 140 chars |
| `music` | optional JSON **string** `{"provider":"openverse","id":"<id from /music/>"}`. Never a URL: the server re-fetches the track. |

Browser should shrink first (longest side ~1280px, JPEG/WebP ~0.8) with the existing `shrinkMedia.js` logic,
one photo at a time. Server re-encodes to WebP anyway, but a shrunk upload is ~10x less mobile data.

## Read (GET /api/square/statuses/)
A slideshow item has `kind: "slideshow"`, `cover` (360x360 SQUARE crop, centred a little high, so it fills the round story ring with no extra cropping), `slide_seconds`, `duration` (always <= 15), `template`, `canvas` (both `null` on non-slideshows),
`slides: [{url, w, h}]`, `music: {title, artist, url, credit, license, license_url, source_url, duration} | null`.

## Music picker (GET /api/square/music/?q=lofi)
`{providers: [...], results: [{provider, id, title, artist, url, credit, license, license_url, duration, cover}]}`.
Only CC0 / public domain / CC-BY tracks (commercial-use OK). **CC-BY requires showing `credit`** while the track plays
(e.g. a small "♪ credit" line in the viewer, linking to `source_url`).

## Suggested tracks (GET /api/square/music/suggest/?exclude=id1,id2)
`{results: [2 random tracks, same shape as /music/]}`. Served from a pool shared by all users and rebuilt every 6 hours
(about 3 catalogue calls per rebuild). Send the ids already shown in `exclude` for a fresh pair on "Shuffle".

## Viewer tips for smooth playback
- Show `cover` instantly, then preload slide 1-2 with `new Image().src = url; await img.decode()`; keep preloading n+1.
- Use `<audio preload="auto" src=music.url>`; start it on the first tap/open (autoplay rules), loop it, fade out at the end.
  Set `crossorigin` only if you need WebAudio. If the track is shorter than the show, loop it.
- If audio fails to load, play the slides silently.
- CSP: allow `media-src https:` (catalogue hosts vary) and your bucket host in `img-src`.

## Env vars
`STATUS_SLIDE_MAX_SIDE` (1280), `STATUS_SLIDE_QUALITY` (70), `MUSIC_ALLOWED_LICENSES` (cc0,pdm,by),
`MEDIA_CACHE_CONTROL` (public, max-age=86400, immutable), `OPENVERSE_CLIENT_ID` + `OPENVERSE_CLIENT_SECRET` (optional, free: raises Openverse's anonymous limit of 20 req/min, 200/day shared by the whole server), `JAMENDO_CLIENT_ID` (off by default; Jamendo's free API is non-commercial).
After deploy: `python manage.py migrate` (adds 0004_slideshow_status and 0005_slideshow_template_canvas). Existing buckets: objects uploaded before this change
keep their old headers; only new uploads get the Cache-Control.
