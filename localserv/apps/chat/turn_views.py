import os

from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from .turn import build_turn_credentials


def _conf(name, default=""):
    """Read from Django settings first, then the environment."""
    value = getattr(settings, name, None)
    if value in (None, ""):
        value = os.environ.get(name, default)
    if isinstance(value, (list, tuple)):
        value = ",".join(value)
    return str(value)


class IceServersView(APIView):
    """
    GET /api/chat/ice-servers/ -> {"ice_servers": [...], "ttl": 3600}

    Always includes a STUN server. When TURN_SECRET and TURN_URLS are set it also
    includes a TURN entry with credentials that expire after TURN_TTL_SECONDS.
    """

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_scope = "ice_servers"  # rate defined in REST_FRAMEWORK DEFAULT_THROTTLE_RATES

    def get(self, request):
        ttl = int(_conf("TURN_TTL_SECONDS", "3600"))
        servers = [{"urls": _conf("STUN_URL", "stun:stun.l.google.com:19302")}]

        secret = _conf("TURN_SECRET")
        urls = [u.strip() for u in _conf("TURN_URLS").split(",") if u.strip()]
        if secret and urls:
            username, credential = build_turn_credentials(request.user.id, secret, ttl)
            servers.append({"urls": urls, "username": username, "credential": credential})

        response = Response({"ice_servers": servers, "ttl": ttl})
        response["Cache-Control"] = "no-store"
        return response
