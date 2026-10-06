from django.urls import path

from . import views
from .turn_views import IceServersView

app_name = "chat"

urlpatterns = [
    path("conversations/", views.ConversationListCreateView.as_view(), name="conversation-list"),
    path("conversations/<uuid:conversation_id>/", views.ConversationDetailView.as_view(), name="conversation-detail"),
    path("conversations/<uuid:conversation_id>/members/", views.ConversationMembersView.as_view(), name="conversation-members"),
    path(
        "conversations/<uuid:conversation_id>/members/<uuid:user_id>/",
        views.ConversationMemberDetailView.as_view(),
        name="conversation-member-detail",
    ),
    path(
        "conversations/<uuid:conversation_id>/messages/",
        views.ConversationMessageListCreateView.as_view(),
        name="conversation-messages",
    ),
    path("conversations/<uuid:conversation_id>/read/", views.ConversationMarkReadView.as_view(), name="conversation-read"),
    path("conversations/<uuid:conversation_id>/invite/", views.ConversationInviteView.as_view(), name="conversation-invite"),
    path(
        "conversations/<uuid:conversation_id>/join-requests/",
        views.ConversationJoinRequestsView.as_view(),
        name="conversation-join-requests",
    ),
    path(
        "conversations/<uuid:conversation_id>/join-requests/<uuid:request_id>/",
        views.ConversationJoinRequestDecisionView.as_view(),
        name="conversation-join-request-decision",
    ),
    path("groups/join/<str:code>/", views.GroupJoinPreviewView.as_view(), name="group-join"),
    path("conversations/<uuid:conversation_id>/mood/", views.ConversationMoodView.as_view(), name="conversation-mood"),
    path("conversations/<uuid:conversation_id>/group-call/", views.GroupCallStateView.as_view(), name="group-call-state"),
    path("calls/", views.CallLogListView.as_view(), name="call-log"),
    path("calls/incoming/", views.CallIncomingView.as_view(), name="call-incoming"),
    path("ice-servers/", IceServersView.as_view(), name="ice-servers"),
    path("messages/<uuid:message_id>/", views.MessageDetailView.as_view(), name="message-detail"),
    path("messages/<uuid:message_id>/view-once/", views.MessageViewOnceView.as_view(), name="message-view-once"),
    path("messages/<uuid:message_id>/pin/", views.MessagePinView.as_view(), name="message-pin"),
]
