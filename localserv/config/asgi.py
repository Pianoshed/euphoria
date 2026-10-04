import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")

# Must be called before importing anything that touches Django models
# (channels routing -> consumers -> models) so the app registry is
# fully loaded first -- see Channels' deployment docs.
django_asgi_app = get_asgi_application()

from django.conf import settings  # noqa: E402
from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import OriginValidator  # noqa: E402

from apps.chat.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        # OriginValidator checks the WS handshake's Origin header against an
        # explicit list (defense against cross-site WS hijacking).
        #
        # We use it instead of AllowedHostsOriginValidator because the
        # frontend and API live on different domains: the Origin is the
        # FRONTEND's host, which is not (and should not be) in ALLOWED_HOSTS.
        # We reuse CORS_ALLOWED_ORIGINS so there is one list to maintain.
        #
        # AuthMiddlewareStack resolves scope["user"] from the same Django
        # session cookie used by the REST API -- no separate WS auth scheme.
        "websocket": OriginValidator(
            AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
            settings.CORS_ALLOWED_ORIGINS,
        ),
    }
)
