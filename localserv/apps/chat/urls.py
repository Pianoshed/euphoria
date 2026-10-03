from django.urls import path

from . import views
from .turn_views import IceServersView

app_name = "chat"

urlpatterns = [
    path("conversations/", views.ConversationListCreateView.as_view(), name="conversation-list"),
    path("conversations/<uuid:conversation_id>/", views.ConversationDetailView.as_view(), name="conversation-detail"),
    path(
        "conversations/<uuid:conversation_id>/messages/",
        views.ConversationMessageListCreateView.as_view(),
        name="conversation-messages",
    ),
    path("conversations/<uuid:conversation_id>/read/", views.ConversationMarkReadView.as_view(), name="conversation-read"),
    path("ice-servers/", IceServersView.as_view(), name="ice-servers"),
    path("messages/<uuid:message_id>/", views.MessageDetailView.as_view(), name="message-detail"),
]
