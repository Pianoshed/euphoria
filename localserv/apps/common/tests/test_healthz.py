import pytest
from django.test import Client, override_settings


@pytest.mark.django_db
def test_healthz_reachable_at_root_path():
    client = Client()
    resp = client.get("/healthz/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"] == {"database": True, "cache": True}


@pytest.mark.django_db
@override_settings(
    CACHES={
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": "redis://localhost:6399/0",  # nothing listening here
        }
    }
)
def test_healthz_reports_degraded_when_cache_unreachable():
    """Must return 503 (so a load balancer stops routing here), not a
    500 -- the health check itself must never crash just because a
    dependency it's checking is down."""
    client = Client()
    resp = client.get("/healthz/")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["cache"] is False
    assert body["checks"]["database"] is True
    # Never leak *why* it failed (no exception text, no connection details)
    assert "error" not in body
    assert "redis" not in str(body).lower()
