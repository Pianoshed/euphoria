from datetime import timedelta

from django.db.models import Count
from django.utils import timezone
from rest_framework import status as http
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import media
from .models import REACTION_EMOJI, Status, StatusReaction, Thought, ThoughtReaction

MAX_STATUSES_PER_DAY = 20
MAX_THOUGHTS_PER_DAY = 30


def _who(u):
    return {"id": str(u.id), "name": getattr(u, "display_name", "") or u.username}


def _status(request, s):
    rs = list(s.reactions.all())
    return {
        "id": str(s.id), "kind": s.kind, "text": s.text, "duration": s.duration_seconds,
        "file": request.build_absolute_uri(s.file.url) if s.file else None,
        "created_at": s.created_at, "expires_at": s.expires_at, "user": _who(s.user),
        "likes": len(rs),
        "my_reaction": next((r.emoji for r in rs if r.user_id == request.user.id), None),
    }


def _thought(request, t):
    rs = list(t.reactions.all())
    counts = {e: 0 for e in REACTION_EMOJI}
    for r in rs:
        counts[r.emoji] = counts.get(r.emoji, 0) + 1
    return {
        "id": str(t.id), "text": t.text, "created_at": t.created_at, "user": _who(t.user),
        "reactions": counts, "total": len(rs),
        "my_reaction": next((r.emoji for r in rs if r.user_id == request.user.id), None),
    }


def _toggle(model, fk, obj, user, emoji):
    if emoji not in REACTION_EMOJI:
        raise ValidationError({"emoji": ["Pick one of the available emoji."]})
    existing = model.objects.filter(user=user, **{fk: obj}).first()
    if existing and existing.emoji == emoji:
        existing.delete()
    else:
        model.objects.update_or_create(user=user, **{fk: obj}, defaults={"emoji": emoji})


class _Base(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]


class StatusListCreateView(_Base):
    def get(self, request):
        qs = (Status.objects.filter(expires_at__gt=timezone.now())
              .select_related("user").prefetch_related("reactions").order_by("-created_at")[:100])
        return Response([_status(request, s) for s in qs])

    def post(self, request):
        now = timezone.now()
        if Status.objects.filter(user=request.user, created_at__gte=now - timedelta(hours=24)).count() >= MAX_STATUSES_PER_DAY:
            raise ValidationError({"detail": "You've reached today's status limit."})
        text = (request.data.get("text") or "").strip()[:140]
        f = request.FILES.get("file")
        if not f and not text:
            raise ValidationError({"detail": "Add a photo, a video or some text."})
        s = Status(user=request.user, text=text, kind=Status.Kind.TEXT)
        content = name = None
        if f:
            ctype = (getattr(f, "content_type", "") or "").lower()
            if ctype.startswith("image/"):
                s.kind, content, name = Status.Kind.IMAGE, media.process_image(f), "s.jpg"
            elif ctype.startswith("video/"):
                content, ext, s.duration_seconds = media.process_video(f, request.data.get("duration"))
                s.kind, name = Status.Kind.VIDEO, f"s.{ext}"
            else:
                raise ValidationError({"file": ["Choose a photo or a video."]})
        s.save()
        if content:
            s.file.save(name, content, save=True)
        s = Status.objects.select_related("user").prefetch_related("reactions").get(pk=s.pk)
        return Response(_status(request, s), status=http.HTTP_201_CREATED)


class StatusReactView(_Base):
    def post(self, request, status_id):
        s = Status.objects.filter(pk=status_id, expires_at__gt=timezone.now()).first()
        if s is None:
            raise NotFound("Status not found.")
        _toggle(StatusReaction, "status", s, request.user, request.data.get("emoji"))
        s = Status.objects.select_related("user").prefetch_related("reactions").get(pk=s.pk)
        return Response(_status(request, s))


class ThoughtListCreateView(_Base):
    def get(self, request):
        qs = Thought.objects.select_related("user").prefetch_related("reactions").order_by("-created_at")[:50]
        return Response([_thought(request, t) for t in qs])

    def post(self, request):
        text = (request.data.get("text") or "").strip()
        if not text:
            raise ValidationError({"text": ["Write something first."]})
        if len(text) > 280:
            raise ValidationError({"text": ["Keep it under 280 characters."]})
        since = timezone.now() - timedelta(hours=24)
        if Thought.objects.filter(user=request.user, created_at__gte=since).count() >= MAX_THOUGHTS_PER_DAY:
            raise ValidationError({"detail": "You've reached today's limit."})
        t = Thought.objects.create(user=request.user, text=text)
        t = Thought.objects.select_related("user").prefetch_related("reactions").get(pk=t.pk)
        return Response(_thought(request, t), status=http.HTTP_201_CREATED)


class ThoughtReactView(_Base):
    def post(self, request, thought_id):
        t = Thought.objects.filter(pk=thought_id).first()
        if t is None:
            raise NotFound("Thought not found.")
        _toggle(ThoughtReaction, "thought", t, request.user, request.data.get("emoji"))
        t = Thought.objects.select_related("user").prefetch_related("reactions").get(pk=t.pk)
        return Response(_thought(request, t))


class TrendingView(_Base):
    def get(self, request):
        now = timezone.now()
        since = now - timedelta(hours=24)
        top_s = (Status.objects.filter(expires_at__gt=now).annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user").prefetch_related("reactions").order_by("-n", "-created_at")[:5])
        top_t = (Thought.objects.filter(created_at__gte=since).annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user").prefetch_related("reactions").order_by("-n", "-created_at")[:5])
        tally = {}
        for model in (StatusReaction, ThoughtReaction):
            for row in model.objects.filter(created_at__gte=since).values("emoji").annotate(c=Count("id")):
                tally[row["emoji"]] = tally.get(row["emoji"], 0) + row["c"]
        emoji = [e for e, _ in sorted(tally.items(), key=lambda kv: -kv[1])[:3]]
        return Response({
            "statuses": [_status(request, s) for s in top_s],
            "thoughts": [_thought(request, t) for t in top_t],
            "emoji": emoji,
        })
