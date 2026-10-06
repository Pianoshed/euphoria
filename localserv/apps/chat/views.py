from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import call_logs, group_calls, services
from .models import CallLog, Message
from .serializers import (
    AddMembersSerializer,
    CallLogSerializer,
    ConversationSerializer,
    EditMessageSerializer,
    JoinRequestSerializer,
    MessageSerializer,
    MoodSerializer,
    RenameGroupSerializer,
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
        data = serializer.validated_data
        if data.get("member_ids"):
            conversation = services.create_group_conversation(request.user, data["member_ids"], data.get("title", ""))
        else:
            conversation = services.start_or_get_conversation(request.user, data["target_user_id"])
        return Response(
            ConversationSerializer(conversation, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ConversationDetailView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        return Response(ConversationSerializer(conversation, context={"request": request, "detail": True}).data)

    def patch(self, request, conversation_id):
        """Rename a group (admins only)."""
        conversation = _get_conversation_or_404(conversation_id, request.user)
        serializer = RenameGroupSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.rename_group(conversation, request.user, serializer.validated_data["title"])
        services.broadcast_event(conversation, {"type": "members_changed", "conversation_id": str(conversation.id)})
        return Response(ConversationSerializer(conversation, context={"request": request}).data)


class ConversationMembersView(APIView):
    """POST /conversations/<id>/members/ {user_ids: [...]} -- admins add people to a group."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def post(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        serializer = AddMembersSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.add_group_members(conversation, request.user, serializer.validated_data["user_ids"])
        services.broadcast_event(conversation, {"type": "members_changed", "conversation_id": str(conversation.id)})
        return Response(ConversationSerializer(conversation, context={"request": request}).data)


class ConversationMemberDetailView(APIView):
    """DELETE /conversations/<id>/members/<user_id>/ -- an admin removes someone, or you leave."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def delete(self, request, conversation_id, user_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        services.remove_group_member(conversation, request.user, user_id)
        # Tell the removed person's open socket to close, and everyone else to refresh the member list.
        services.broadcast_event(
            conversation,
            {"type": "member_removed", "conversation_id": str(conversation.id), "user_id": str(user_id)},
        )
        services.broadcast_event(conversation, {"type": "members_changed", "conversation_id": str(conversation.id)})
        return Response(status=status.HTTP_204_NO_CONTENT)


class ConversationMessageListCreateView(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "messages"

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        after = None
        raw_after = request.query_params.get("after")
        if raw_after:
            try:
                after = parse_datetime(raw_after)
            except ValueError:
                after = None
            if after is not None and timezone.is_naive(after):
                after = timezone.make_aware(after)
        qs, page_size = services.list_messages(
            conversation, page_size=request.query_params.get("page_size"), after=after
        )
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
        was_pinned = message.pinned_at is not None
        services.delete_message(message, request.user)
        services.broadcast_event(
            message.conversation,
            {"type": "message_deleted", "id": str(message.id), "conversation_id": str(message.conversation_id)},
        )
        if was_pinned:
            _broadcast_pins(message.conversation)
        return Response(status=status.HTTP_204_NO_CONTENT)


def _broadcast_pins(conversation):
    pinned = [services.serialize_pinned(m) for m in services.list_pinned_messages(conversation)]
    services.broadcast_event(
        conversation,
        {"type": "pins_changed", "conversation_id": str(conversation.id), "pinned_messages": pinned},
    )
    return pinned


class MessagePinView(APIView):
    """POST /messages/<id>/pin/ pins it to the top of the group; DELETE unpins."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def _message_or_404(self, request, message_id):
        message = Message.objects.select_related("conversation").filter(id=message_id).first()
        if message is None or not message.conversation.is_participant(request.user):
            raise NotFound("Message not found.")
        return message

    def post(self, request, message_id):
        message = self._message_or_404(request, message_id)
        services.pin_message(message, request.user)
        return Response({"pinned_messages": _broadcast_pins(message.conversation)})

    def delete(self, request, message_id):
        message = self._message_or_404(request, message_id)
        services.unpin_message(message, request.user)
        return Response({"pinned_messages": _broadcast_pins(message.conversation)})


class ConversationMoodView(APIView):
    """PUT /conversations/<id>/mood/ {mood} sets my colour in this group ("" clears it).
    Silent by design: no message, no list re-order, no unread count -- just a tiny live event."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def put(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        serializer = MoodSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        member = services.set_mood(conversation, request.user, serializer.validated_data["mood"])
        mood = member.mood or None
        mood_set_at = member.mood_set_at.isoformat() if member.mood_set_at else None
        services.broadcast_event(
            conversation,
            {
                "type": "mood_changed", "conversation_id": str(conversation.id),
                "user_id": str(request.user.id), "mood": mood, "mood_set_at": mood_set_at,
            },
        )
        return Response({"mood": mood, "mood_set_at": mood_set_at})


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
        ] + [
            {
                "conversation_id": str(g.conversation_id), "caller_id": str(g.started_by_id), "mode": g.mode,
                "started_at": g.started_at, "group": True, "title": g.conversation.title or "Group call",
            }
            for g in group_calls.ringing_for(request.user.id) if g.conversation_id
        ])


class GroupCallStateView(APIView):
    """
    GET /api/chat/conversations/<id>/group-call/

    Is there a call going on in this group right now, and who is on it? The chat page shows a
    'Call in progress - Join' bar from this. Live updates arrive as a `group_call_changed` event
    on the chat socket; this is what that event (and the page's slow poll) re-reads.
    """

    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        if not conversation.is_group:
            raise NotFound("Conversation not found.")
        state = group_calls.active_call(conversation.id)
        if state is None:
            return Response({"active": False})
        return Response({**state, "active": True, "in_call": str(request.user.id) in state["participants"],
                         "max_participants": group_calls.MAX_PARTICIPANTS})


# ---------------------------------------------------------------------------
# Group invite links + join requests
# ---------------------------------------------------------------------------
class ConversationInviteView(APIView):
    """POST /conversations/<id>/invite/ {reset?: bool} -- an admin gets (or replaces) the group's invite code."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def post(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        code = services.ensure_invite_code(conversation, request.user, reset=bool(request.data.get("reset")))
        return Response({"invite_code": code})


class GroupJoinPreviewView(APIView):
    """
    GET  /groups/join/<code>/ -- what the person sees after opening an invite link:
         the group's name, how many people are in it, and where their own request stands.
    POST /groups/join/<code>/ -- ask to join. An admin must approve.
    An unknown or reset code is a plain 404, so codes can't be guessed or probed.
    """

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def _group_or_404(self, code):
        conversation = services.group_for_invite_code(code)
        if conversation is None:
            raise NotFound("This invite link is not valid any more.")
        return conversation

    def _payload(self, conversation, user):
        status_ = services.join_status(conversation, user)
        return {
            "title": conversation.title or "Group chat",
            "member_count": conversation.members.count(),
            "status": status_,
            "conversation_id": str(conversation.id) if status_ == "member" else None,
        }

    def get(self, request, code):
        conversation = self._group_or_404(code)
        return Response(self._payload(conversation, request.user))

    def post(self, request, code):
        conversation = self._group_or_404(code)
        req = services.request_to_join(conversation, request.user)
        if req is not None:
            # Tell the group's open sockets; only admins act on it (the panel reloads the list).
            services.broadcast_event(
                conversation, {"type": "join_requests_changed", "conversation_id": str(conversation.id)}
            )
        return Response(self._payload(conversation, request.user), status=status.HTTP_200_OK)


class ConversationJoinRequestsView(APIView):
    """GET /conversations/<id>/join-requests/ -- the people waiting to be let in (admins only)."""

    permission_classes = [IsAuthenticated, IsActiveAccount]

    def get(self, request, conversation_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        pending = services.list_join_requests(conversation, request.user)
        return Response(JoinRequestSerializer(pending, many=True).data)


class ConversationJoinRequestDecisionView(APIView):
    """POST /conversations/<id>/join-requests/<request_id>/ {action: "approve" | "decline"} (admins only)."""

    permission_classes = [IsAuthenticated, IsActiveAccount]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "chat_write"

    def post(self, request, conversation_id, request_id):
        conversation = _get_conversation_or_404(conversation_id, request.user)
        action = request.data.get("action")
        if action not in ("approve", "decline"):
            raise ValidationError({"action": "Use \"approve\" or \"decline\"."})
        services.decide_join_request(conversation, request.user, request_id, approve=(action == "approve"))
        services.broadcast_event(
            conversation, {"type": "join_requests_changed", "conversation_id": str(conversation.id)}
        )
        if action == "approve":
            services.broadcast_event(conversation, {"type": "members_changed", "conversation_id": str(conversation.id)})
        return Response(ConversationSerializer(conversation, context={"request": request}).data)
