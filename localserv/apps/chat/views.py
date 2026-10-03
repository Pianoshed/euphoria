from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import services
from .models import Message
from .serializers import (
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
        return Response(status=status.HTTP_204_NO_CONTENT)
