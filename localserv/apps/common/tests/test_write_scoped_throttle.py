"""WriteScopedRateThrottle: reads are never counted, writes are capped."""
import pytest
from django.core.cache import cache
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView

from apps.common.throttles import WriteScopedRateThrottle


class _View(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [WriteScopedRateThrottle]
    throttle_scope = "service_write"

    def get(self, request):
        return Response({"ok": True})

    def post(self, request):
        return Response({"ok": True})


@pytest.fixture(autouse=True)
def _clean_cache(settings):
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        "DEFAULT_THROTTLE_RATES": {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "service_write": "3/hour"},
    }
    from rest_framework.throttling import ScopedRateThrottle as _Base
    _Base.THROTTLE_RATES = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    cache.clear()
    yield
    cache.clear()


def test_gets_are_never_throttled():
    rf = APIRequestFactory()
    for _ in range(50):
        assert _View.as_view()(rf.get("/x/")).status_code == 200


def test_posts_are_capped_and_gets_still_work_after():
    rf = APIRequestFactory()
    codes = [_View.as_view()(rf.post("/x/", {})).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert _View.as_view()(rf.get("/x/")).status_code == 200
