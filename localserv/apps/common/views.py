import logging

from django.db import connection
from django.core.cache import cache
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger("apps")


class HealthCheckView(APIView):
    """
    GET /healthz/ -- for load balancer health checks, container
    orchestrator liveness/readiness probes, and uptime monitoring.

    Deliberately unauthenticated (a load balancer doing a health check
    has no session), but the response never includes error messages,
    stack traces, or which specific dependency failed in detail --
    only whether each checked dependency is reachable. An attacker
    probing this endpoint learns "cache is down" at most, never why.

    Returns 200 if every dependency is reachable, 503 otherwise (so a
    load balancer or orchestrator correctly stops routing traffic to
    an instance that can't reach its database or cache, rather than
    getting a false "I'm fine" from a bare `return HttpResponse(200)`
    style check that doesn't actually verify anything).
    """

    permission_classes = [AllowAny]

    def get(self, request):
        checks = {"database": self._check_database(), "cache": self._check_cache()}
        healthy = all(checks.values())
        status_code = 200 if healthy else 503
        return Response({"status": "ok" if healthy else "degraded", "checks": checks}, status=status_code)

    def _check_database(self) -> bool:
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
            return True
        except Exception:
            logger.warning("Health check: database unreachable", exc_info=True)
            return False

    def _check_cache(self) -> bool:
        try:
            cache.set("healthz_probe", "1", timeout=5)
            return cache.get("healthz_probe") == "1"
        except Exception:
            logger.warning("Health check: cache unreachable", exc_info=True)
            return False
