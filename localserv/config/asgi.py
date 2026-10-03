import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")

# Must be called before importing anything that touches Django models
# (channels routing -> consumers -> models) so the app registry is
# fully loaded first -- see Channels' deployment docs.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from apps.chat.routing import websocket_urlpatterns  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        # AllowedHostsOriginValidator checks the WS handshake's Origin
        # header against ALLOWED_HOSTS (defense against cross-site WS
        # hijacking). AuthMiddlewareStack resolves scope["user"] from
        # the same Django session cookie used by the REST API -- no
        # separate WS auth token/scheme.
        "websocket": AllowedHostsOriginValidator(
            AuthMiddlewareStack(URLRouter(websocket_urlpatterns))
        ),
    }
)
