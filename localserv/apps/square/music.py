"""Background music for slideshow statuses: free, legally reusable tracks from public catalogues.

Nothing is downloaded or stored. A status keeps a small *reference* (title, artist, licence, stream URL, credit
line) and viewers' players stream the file straight from the catalogue's own servers, so music costs the bucket
zero bytes. The client NEVER sends a URL: it sends {provider, id}, and we re-fetch the track from the provider,
so nobody can attach an arbitrary link (tracking pixels, someone else's copyrighted file, adult content...).

Providers
  * openverse  (default, no key): Openverse (WordPress Foundation) indexes CC / public-domain audio incl. Jamendo,
               Wikimedia Commons, Freesound. Asked for commercial-use + modifiable licences only.
  * jamendo    (optional, set JAMENDO_CLIENT_ID): Jamendo's API is free for NON-commercial apps. If Euphoria earns
               money (wallet, fees...) you need Jamendo's commercial licensing terms first - leave it off until then.

Licences: only those in MUSIC_ALLOWED_LICENSES (default cc0, pdm, by). By-NC is excluded because the app is
commercial, By-ND because a slideshow edits/mixes the track, By-SA to avoid share-alike claims on the status.
CC-BY requires credit, so every track carries `credit`, which the status viewer must display.
"""
import logging
import re

import requests
from django.conf import settings
from django.core.cache import cache
from rest_framework.exceptions import ValidationError

logger = logging.getLogger("apps")

TIMEOUT = 4  # seconds; the picker must never hang a request
SEARCH_TTL = 30 * 60
TRACK_TTL = 6 * 60 * 60
MAX_SECONDS = 600  # ignore very long tracks: slideshows are at most 48s, no point streaming a 40-min mix
OPENVERSE = "https://api.openverse.org/v1/audio/"
JAMENDO = "https://api.jamendo.com/v3.0/tracks/"
HEADERS = {"User-Agent": "Euphoria/1.0 (status music picker)"}


def allowed_licenses():
    raw = getattr(settings, "MUSIC_ALLOWED_LICENSES", ["cc0", "pdm", "by"])
    return {x.strip().lower() for x in raw}


def providers():
    out = ["openverse"]
    if getattr(settings, "JAMENDO_CLIENT_ID", ""):
        out.append("jamendo")
    return out


def _license_url(code, version=""):
    if code == "cc0":
        return "https://creativecommons.org/publicdomain/zero/1.0/"
    if code == "pdm":
        return "https://creativecommons.org/publicdomain/mark/1.0/"
    return f"https://creativecommons.org/licenses/{code}/{version or '4.0'}/"


def _credit(title, artist, code, version):
    label = "CC0" if code == "cc0" else "Public domain" if code == "pdm" else f"CC {code.upper()} {version}".strip()
    who = f" by {artist}" if artist else ""
    return f"“{title}”{who} · {label}"


def _https(url):
    return isinstance(url, str) and url.startswith("https://")


def _openverse_track(r):
    code = (r.get("license") or "").lower()
    ver = str(r.get("license_version") or "")
    stream = r.get("url")
    if code not in allowed_licenses() or not _https(stream) or not r.get("id"):
        return None
    secs = int(round((r.get("duration") or 0) / 1000))  # Openverse reports milliseconds
    if secs and secs > MAX_SECONDS:
        return None
    title = (r.get("title") or "Untitled")[:120]
    artist = (r.get("creator") or "")[:80]
    return {
        "provider": "openverse", "id": str(r["id"]), "title": title, "artist": artist, "url": stream,
        "license": code, "license_url": r.get("license_url") or _license_url(code, ver),
        "source_url": r.get("foreign_landing_url") or "", "duration": secs or None,
        "cover": r.get("thumbnail") if _https(r.get("thumbnail")) else None,
        "credit": _credit(title, artist, code, ver),
    }


_JAMENDO_LIC = re.compile(r"/licenses/([a-z\-]+)/([\d.]+)/?")


def _jamendo_track(r):
    url = r.get("license_ccurl") or ""
    m = _JAMENDO_LIC.search(url)
    code, ver = (m.group(1), m.group(2)) if m else ("", "")
    stream = r.get("audio")
    if code not in allowed_licenses() or not _https(stream) or not r.get("id"):
        return None
    title = (r.get("name") or "Untitled")[:120]
    artist = (r.get("artist_name") or "")[:80]
    secs = int(r.get("duration") or 0)
    if secs > MAX_SECONDS:
        return None
    return {
        "provider": "jamendo", "id": str(r["id"]), "title": title, "artist": artist, "url": stream,
        "license": code, "license_url": url, "source_url": r.get("shareurl") or "", "duration": secs or None,
        "cover": r.get("image") if _https(r.get("image")) else None,
        "credit": _credit(title, artist, code, ver),
    }


def _get(url, params):
    resp = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def search(query, provider="openverse", limit=15):
    """Playable, legally reusable tracks matching `query`. Cached; returns [] if the provider is down."""
    query = (query or "").strip()[:60]
    if provider not in providers():
        raise ValidationError({"provider": ["Unknown music source."]})
    if len(query) < 2:
        return []
    key = f"square:music:s:{provider}:{limit}:{query.lower()}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    try:
        if provider == "openverse":
            data = _get(OPENVERSE, {"q": query, "category": "music", "license_type": "commercial,modification",
                                    "page_size": min(limit * 2, 40), "mature": "false"})
            tracks = [t for t in map(_openverse_track, data.get("results", [])) if t]
        else:
            data = _get(JAMENDO, {"client_id": settings.JAMENDO_CLIENT_ID, "format": "json", "search": query,
                                  "limit": min(limit * 2, 40), "audioformat": "mp32", "include": "licenses",
                                  "ccnc": "false", "ccnd": "false", "ccsa": "false"})
            tracks = [t for t in map(_jamendo_track, data.get("results", [])) if t]
    except (requests.RequestException, ValueError):
        logger.warning("Music search failed (%s)", provider, exc_info=True)
        return []  # not cached, so the next try can succeed
    tracks = tracks[:limit]
    cache.set(key, tracks, SEARCH_TTL)
    return tracks


def get_track(provider, track_id):
    """Canonical, re-verified track data for storing on a status. Raises a 400 when it can't be used."""
    if provider not in providers() or not track_id or not re.fullmatch(r"[\w\-]{1,64}", str(track_id)):
        raise ValidationError({"music": ["Pick a track from the music list."]})
    key = f"square:music:t:{provider}:{track_id}"
    hit = cache.get(key)
    if hit is not None:
        return hit
    try:
        if provider == "openverse":
            track = _openverse_track(_get(f"{OPENVERSE}{track_id}/", {}))
        else:
            rows = _get(JAMENDO, {"client_id": settings.JAMENDO_CLIENT_ID, "format": "json", "id": track_id,
                                  "audioformat": "mp32", "include": "licenses"}).get("results", [])
            track = _jamendo_track(rows[0]) if rows else None
    except (requests.RequestException, ValueError):
        logger.warning("Music lookup failed (%s/%s)", provider, track_id, exc_info=True)
        raise ValidationError({"music": ["The music service is busy. Try again, or post without music."]})
    if track is None:
        raise ValidationError({"music": ["That track can't be used. Pick another one."]})
    cache.set(key, track, TRACK_TTL)
    return track
