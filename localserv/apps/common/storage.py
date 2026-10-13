"""Bucket storage tuned for cheap, smooth media delivery.

Private-bucket S3 links are *signed*, and a signature embeds the moment it was made, so stock django-storages
hands out a brand-new URL on every API call. To a browser (and any CDN) a new URL is a new file: every refresh of
the status list re-downloaded every picture, and nothing could ever be cached. This class remembers each signed
URL in the shared cache and re-serves it until half of its life is gone, so:
  * the same file keeps the same URL between API calls -> browser and CDN caches actually hit;
  * a client is never handed a link with less than half its lifetime (MEDIA_S3_URL_EXPIRE_SECONDS) left.
Cost: one cache lookup per file instead of one HMAC computation.
"""
import hashlib

from django.core.cache import cache
from storages.backends.s3 import S3Storage


class CachedSignedUrlS3Storage(S3Storage):
    def _url_key(self, name):
        return "media-url:" + hashlib.sha1(f"{self.bucket_name}/{name}".encode()).hexdigest()

    def urls(self, names, expire=None):
        """{name: url} for many files with ONE cache read (get_many) and one write for the misses, instead of a
        network round trip per file. Same keys and lifetimes as url(), so both share the cache."""
        names = list(dict.fromkeys(n for n in names if n))
        if not names:
            return {}
        ttl = int(expire or self.querystring_expire)
        if not self.querystring_auth:
            return {n: super().url(n, expire=ttl) for n in names}
        keys = {self._url_key(n): n for n in names}
        try:
            hit = cache.get_many(list(keys))
        except Exception:  # cache down: fresh links
            hit = {}
        out, fresh = {}, {}
        for key, name in keys.items():
            if hit.get(key):
                out[name] = hit[key]
            else:
                out[name] = fresh[key] = super().url(name, expire=ttl)
        if fresh:
            try:
                cache.set_many(fresh, max(60, ttl // 2))
            except Exception:
                pass
        return out

    def url(self, name, parameters=None, expire=None, http_method=None):
        if not self.querystring_auth or parameters or http_method:
            return super().url(name, parameters, expire, http_method)
        ttl = int(expire or self.querystring_expire)
        key = self._url_key(name)
        try:
            url = cache.get(key)
        except Exception:  # cache down: fall back to a fresh link
            return super().url(name, expire=ttl)
        if url:
            return url
        url = super().url(name, expire=ttl)
        try:
            cache.set(key, url, max(60, ttl // 2))
        except Exception:
            pass
        return url
