import time
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase

from apps.common.storage import CachedSignedUrlS3Storage


def _storage(**kw):
    return CachedSignedUrlS3Storage(bucket_name="b", access_key="k", secret_key="s", region_name="auto",
                                    endpoint_url="https://acct.r2.example.com", signature_version="s3v4",
                                    querystring_expire=3600, **kw)


class CachedSignedUrls(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_same_file_gets_the_same_signed_url_between_calls(self):
        st = _storage()
        first = st.url("square_status/u/a.webp")
        time.sleep(1.1)  # a plain presigned URL embeds the current second, so it would differ here
        self.assertEqual(st.url("square_status/u/a.webp"), first)
        self.assertNotEqual(st.url("square_status/u/b.webp"), first)
        self.assertIn("X-Amz-Signature", first)

    def test_link_is_refreshed_before_it_gets_old(self):
        st = _storage()
        with mock.patch("apps.common.storage.cache") as c:
            c.get.return_value = None
            st.url("x.webp")
        ttl = c.set.call_args.args[2]
        self.assertEqual(ttl, 1800)  # re-signed after half of the 3600s life

    def test_cache_outage_falls_back_to_fresh_link(self):
        st = _storage()
        with mock.patch("apps.common.storage.cache") as c:
            c.get.side_effect = RuntimeError("redis down")
            self.assertIn("X-Amz-Signature", st.url("x.webp"))

    def test_public_bucket_urls_untouched(self):
        st = _storage(querystring_auth=False)
        self.assertNotIn("X-Amz-Signature", st.url("x.webp"))
