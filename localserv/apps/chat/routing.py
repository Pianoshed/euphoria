from django.urls import re_path

from . import call_consumers, consumers

websocket_urlpatterns = [
    re_path(
        r"^ws/chat/(?P<conversation_id>[0-9a-fA-F-]{36})/$",
        consumers.ChatConsumer.as_asgi(),
    ),
    re_path(
        r"^ws/call/(?P<conversation_id>[0-9a-fA-F-]{36})/$",
        call_consumers.CallConsumer.as_asgi(),
    ),
    re_path(r"^ws/calls/inbox/$", call_consumers.CallInboxConsumer.as_asgi()),
]
