from django.db.models import Q
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import call_logs, services
from .models import CallLog, Message
from .serializers import (
    CallLogSerializer,
    ConversationSerializer,
    EditMessageSerializer,
    MessageSerializer,
    SendMessageSerializer,
    StartConversationSerializer,
)


class ChatPagination(PageNumberPagination):
    page_size = 30
    max_page_size = 100


def _get_conversation_or_404(conversation_id, user):
    conversation = services.get_conversation_for_user(conversation_id, user)
    if conversation is None:
        raise NotFound("Conversation not found.")
    return conversation


class ConversationListCreateView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def get(self, request):
        qs, page_size = services.list_conversations(request.user, page_size=request.query_params.get("page_size"))
        paginator = ChatPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(
            ConversationSerializer(page, many=True, context={"request": request}).data
        )

    def post(self, request):
        serializer = StartConversationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        conversation = services.start_or_get_conversation(request.user, serializer.validated_data["target_user_id"])
        return Response(
            ConversationSerializer(conversation, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ConversationDetailView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        return Response(ConversationSerializer(conversation, context={"request": request}).data)


class ConversationMessageListCreateView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "messages"

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        qs, page_size = services.list_messages(conversation, page_size=request.query_params.get("page_size"))
        paginator = ChatPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(MessageSerializer(page, many=True, context={"request": request}).data)

    def post(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        serializer = SendMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        message = services.send_message(conversation, request.user, **serializer.validated_data)

        # REST send and WebSocket send both funnel through
        # services.send_message, then broadcast identically here --
        # a client using either transport sees the same live delivery.
        services.broadcast_message(conversation, message)

        return Response(MessageSerializer(message, context={"request": request}).data, status=status.HTTP_201_CREATED)


class ConversationMarkReadView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]

    def post(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        services.mark_read(conversation, request.user)
        return Response({"detail": "Marked as read."})


class MessageDetailView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]

    def _get_message_or_404(self, request, message_id):
        message = Message.objects.select_related("conversation").filter(id=message_id).first()
        if message is None or not message.conversation.is_participant(request.user):
            raise NotFound("Message not found.")
        return message

    def patch(self, request, message_id):
        message = self._get_message_or_404(request, message_id)
        serializer = EditMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        message = services.edit_message(message, request.user, **serializer.validated_data)
        return Response(MessageSerializer(message, context={"request": request}).data)

    def delete(self, request, message_id):
        message = self._get_message_or_404(request, message_id)
        services.delete_message(message, request.user)
        services.broadcast_event(
            message.conversation,
            {"type": "message_deleted", "id": str(message.id), "conversation_id": str(message.conversation_id)},
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class MessageViewOnceView(APIView):
    """POST /api/chat/messages/<id>/view-once/ -- returns the photo's bytes once,
    then deletes it. POST (not GET) because it changes state."""

    permission_classes = [IsAuthenticated, IsActiveAccount]

    def post(self, request, message_id):
        try:
            message, data = services.consume_view_once(message_id, request.user)
        except Message.DoesNotExist:
            raise NotFound("Message not found.") from None
        services.broadcast_event(
            message.conversation,
            {
                "type": "attachment_viewed",
                "message_id": str(message.id),
                "conversation_id": str(message.conversation_id),
            },
        )
        response = HttpResponse(data, content_type="image/jpeg")
        response["Cache-Control"] = "no-store"
        return response


class CallLogListView(APIView):
    """
    GET /api/chat/calls/?scope=mine|all&page=N

    scope=mine (default): calls the signed-in user made or received.
    scope=all: every call on the site, for the audit trail. Staff only.

    Read-only on purpose: calls are written by the server from the call signaling
    (see call_logs.py), so there is no way to create or edit one over the API.
    """

    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request):
        call_logs.reap_stale_calls()  # close calls that ended without a hangup
        qs = CallLog.objects.select_related("caller", "callee").order_by("-started_at", "-id")
        if request.query_params.get("scope") == "all":
            if not call_logs.can_audit(request.user):
                raise PermissionDenied("Only staff can view every call.")
        else:
            qs = qs.filter(Q(caller=request.user) | Q(callee=request.user))
        paginator = ChatPagination()
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(CallLogSerializer(page, many=True).data)


class CallIncomingView(APIView):
    """
    GET /api/chat/calls/incoming/

    Calls ringing for the signed-in user right now. The site-wide inbox socket normally
    delivers these; this is the fallback the browser polls while that socket is down.
    """

    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request):
        calls = call_logs.ringing_for(request.user.id)
        return Response([
            {
                "conversation_id": str(c.conversation_id), "caller_id": str(c.caller_id),
                "mode": c.mode, "started_at": c.started_at,
            }
            for c in calls if c.conversation_id
        ])
