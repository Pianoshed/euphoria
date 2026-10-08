import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import status as http
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import media
from .models import (REACTION_EMOJI, Circle, FriendTree, FriendTreeMember, Status, StatusReaction,
                     StatusView, Thought, ThoughtReaction)

MAX_STATUSES_PER_DAY = 20
MAX_THOUGHTS_PER_DAY = 30
MAX_TREES_PER_DAY = 10
MAX_TREE_MEMBERS = 30


def _who(u):
    return {"id": str(u.id), "name": getattr(u, "display_name", "") or u.username}


def _seen_ids(request, statuses):
    """Ids (among `statuses`) that the current user has already watched. One query for the whole list."""
    ids = [s.pk for s in statuses]
    if not ids:
        return set()
    return set(StatusView.objects.filter(user=request.user, status_id__in=ids).values_list("status_id", flat=True))


def _status(request, s, seen=None):
    rs = list(s.reactions.all())
    if seen is None:
        seen = _seen_ids(request, [s])
    # your own statuses always count as seen
    watched = s.pk in seen or s.user_id == request.user.id
    return {
        "seen": watched,
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


def _circle_ids(user):
    """Everyone whose statuses `user` may see: themselves plus every owner and member of every
    friend tree they own or are tagged in. This is the ONLY source of truth for status visibility;
    the app also filters, but it can't be trusted to."""
    trees = list(FriendTree.objects.filter(Q(owner=user) | Q(members__user=user)).values_list("pk", flat=True))
    ids = {user.pk}
    ids.update(FriendTree.objects.filter(pk__in=trees).values_list("owner_id", flat=True))
    ids.update(FriendTreeMember.objects.filter(tree_id__in=trees).values_list("user_id", flat=True))
    return ids


def _visible_statuses(user):
    return Status.objects.filter(expires_at__gt=timezone.now(), user_id__in=_circle_ids(user))


class _Base(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]


class StatusListCreateView(_Base):
    def get(self, request):
        qs = list(_visible_statuses(request.user)
                  .select_related("user").prefetch_related("reactions").order_by("-created_at")[:100])
        seen = _seen_ids(request, qs)
        return Response([_status(request, s, seen) for s in qs])

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
        s = _visible_statuses(request.user).filter(pk=status_id).first()
        if s is None:  # same answer for "gone" and "not someone in your trees"
            raise NotFound("Status not found.")
        _toggle(StatusReaction, "status", s, request.user, request.data.get("emoji"))
        s = Status.objects.select_related("user").prefetch_related("reactions").get(pk=s.pk)
        return Response(_status(request, s))


class StatusSeenView(_Base):
    """POST marks a status as watched by me. Idempotent; same 404 for "gone" and "not in your trees"."""

    def post(self, request, status_id):
        s = _visible_statuses(request.user).filter(pk=status_id).first()
        if s is None:
            raise NotFound("Status not found.")
        if s.user_id != request.user.id:
            StatusView.objects.get_or_create(status=s, user=request.user)
        return Response(status=http.HTTP_204_NO_CONTENT)


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
        seen = _visible_statuses(request.user)
        top_s = (seen.annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user").prefetch_related("reactions").order_by("-n", "-created_at")[:5])
        top_t = (Thought.objects.filter(created_at__gte=since).annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user").prefetch_related("reactions").order_by("-n", "-created_at")[:5])
        tally = {}
        for model, scope in ((StatusReaction, {"status__in": seen}), (ThoughtReaction, {})):
            for row in model.objects.filter(created_at__gte=since, **scope).values("emoji").annotate(c=Count("id")):
                tally[row["emoji"]] = tally.get(row["emoji"], 0) + row["c"]
        emoji = [e for e, _ in sorted(tally.items(), key=lambda kv: -kv[1])[:3]]
        return Response({
            "statuses": [_status(request, s) for s in top_s],
            "thoughts": [_thought(request, t) for t in top_t],
            "emoji": emoji,
        })


# ---------- Friend trees: visible only to the owner and the people tagged in them ----------

def _visible(user):
    return (FriendTree.objects.filter(Q(owner=user) | Q(members__user=user)).distinct()
            .select_related("owner").prefetch_related("members__user"))


def _tree(request, t):
    """The owner sees everyone. A tagged person sees the same tree *shape* (partner beside the owner, tiers down
    the trunk) but only their OWN spot by name: everyone else comes back as an anonymous placeholder
    (hidden=True, no name), so who sits in which tier stays private."""
    mine = t.owner_id == request.user.id
    members = []
    for m in t.members.all():
        if mine or m.user_id == request.user.id:
            w = _who(m.user)
        else:
            w = {"id": str(m.user_id), "name": "", "hidden": True}
        w["label"] = m.label
        members.append(w)
    return {
        "id": str(t.id), "title": t.title, "note": t.note, "created_at": t.created_at,
        "owner": _who(t.owner), "mine": mine, "members": members,
        "labels": {m["id"]: m["label"] for m in members},
    }


def _labels_in(raw):
    """Parse {personId: circleKey}. Unknown circles are rejected; ids are matched against real members later."""
    if raw in (None, ""):
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if not isinstance(raw, dict):
        raise ValidationError({"labels": ["Labels must map each person to a circle."]})
    valid = set(Circle.values)
    out = {}
    for who, key in raw.items():
        if key not in valid:
            raise ValidationError({"labels": [f"Unknown circle: {key}."]})
        out[str(who)] = key
    return out


def _member_users(request, raw):
    if not isinstance(raw, list) or not raw:
        raise ValidationError({"members": ["Tag at least one friend."]})
    if len(raw) > MAX_TREE_MEMBERS:
        raise ValidationError({"members": [f"You can tag up to {MAX_TREE_MEMBERS} people."]})
    try:
        users = list(get_user_model().objects.filter(pk__in=[str(x) for x in raw], is_active=True)
                     .exclude(pk=request.user.pk))
    except (DjangoValidationError, ValueError):
        raise ValidationError({"members": ["One of those people could not be found."]})
    if not users:
        raise ValidationError({"members": ["Tag at least one friend."]})
    return users


class FriendTreeListCreateView(_Base):
    def get(self, request):
        return Response([_tree(request, t) for t in _visible(request.user).order_by("-created_at")[:50]])

    def post(self, request):
        since = timezone.now() - timedelta(hours=24)
        if FriendTree.objects.filter(owner=request.user, created_at__gte=since).count() >= MAX_TREES_PER_DAY:
            raise ValidationError({"detail": "You've reached today's limit for trees."})
        title = (request.data.get("title") or "").strip()[:60]
        if not title:
            raise ValidationError({"title": ["Give your tree a name."]})
        users = _member_users(request, request.data.get("members"))
        labels = _labels_in(request.data.get("labels"))
        with transaction.atomic():
            t = FriendTree.objects.create(owner=request.user, title=title,
                                          note=(request.data.get("note") or "").strip()[:140])
            FriendTreeMember.objects.bulk_create([
                FriendTreeMember(tree=t, user=u, label=labels.get(str(u.pk), Circle.FRIENDS)) for u in users])
        return Response(_tree(request, _visible(request.user).get(pk=t.pk)), status=http.HTTP_201_CREATED)


class FriendTreeDetailView(_Base):
    def _get(self, request, tree_id):
        t = _visible(request.user).filter(pk=tree_id).first()
        if t is None:  # same answer for "missing" and "not yours to see"
            raise NotFound("Tree not found.")
        return t

    def get(self, request, tree_id):
        return Response(_tree(request, self._get(request, tree_id)))

    def patch(self, request, tree_id):
        t = self._get(request, tree_id)
        if t.owner_id != request.user.id:
            raise NotFound("Tree not found.")
        labels = _labels_in(request.data.get("labels")) if "labels" in request.data else {}
        with transaction.atomic():
            if "title" in request.data:
                title = (request.data.get("title") or "").strip()[:60]
                if not title:
                    raise ValidationError({"title": ["Give your tree a name."]})
                t.title = title
            if "note" in request.data:
                t.note = (request.data.get("note") or "").strip()[:140]
            t.save()
            if "members" in request.data:
                users = _member_users(request, request.data.get("members"))
                keep = {u.pk for u in users}
                t.members.exclude(user_id__in=keep).delete()
                have = set(t.members.values_list("user_id", flat=True))
                FriendTreeMember.objects.bulk_create(
                    [FriendTreeMember(tree=t, user=u, label=labels.get(str(u.pk), Circle.FRIENDS))
                     for u in users if u.pk not in have])
            if labels:  # fresh query: the prefetched members above may be stale after the edits
                for m in FriendTreeMember.objects.filter(tree=t):
                    new = labels.get(str(m.user_id))
                    if new and new != m.label:
                        m.label = new
                        m.save(update_fields=["label", "updated_at"])
        return Response(_tree(request, self._get(request, tree_id)))

    def delete(self, request, tree_id):
        t = self._get(request, tree_id)
        if t.owner_id == request.user.id:
            t.delete()  # owner deletes the whole tree
        else:
            t.members.filter(user=request.user).delete()  # a tagged friend just leaves it
        return Response(status=http.HTTP_204_NO_CONTENT)
