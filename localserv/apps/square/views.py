import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.exceptions import ObjectDoesNotExist, ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import status as http
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.permissions import IsActiveAccount

from . import media, music, services
from .models import (REACTION_EMOJI, Circle, FriendTree, FriendTreeMember, Status, StatusReaction,
                     StatusSlide, StatusView, Thought, ThoughtReaction)

MAX_STATUSES_PER_DAY = 20
MAX_THOUGHTS_PER_DAY = 30
MAX_TREES_PER_DAY = 10
MAX_TREE_MEMBERS = 30


def _who(u):
    """Public label for a person. The display name lives on Profile (never on User), so read it from
    there; fall back to the username when no profile or no display name exists."""
    try:
        name = (u.profile.display_name or "").strip()
    except ObjectDoesNotExist:
        name = ""
    return {"id": str(u.id), "name": name or u.username}


def _abs(request, f, urls=None):
    """Absolute URL of a stored file. Bucket links are already absolute; local-disk ones get the host added.
    `urls` (from _urls_for) holds links fetched for the whole list in one go."""
    if not f:
        return None
    return request.build_absolute_uri((urls or {}).get(f.name) or f.url)


def _urls_for(statuses):
    """Signed links for every file of these statuses with a single cache round trip (None on plain disk storage)."""
    bulk = getattr(Status._meta.get_field("cover").storage, "urls", None)
    if bulk is None:
        return None
    names = []
    for s in statuses:
        names += [s.file.name, s.cover.name] + [sl.file.name for sl in s.slides.all()]
    return bulk(names)


def _seen_ids(request, statuses):
    """Ids (among `statuses`) that the current user has already watched. One query for the whole list."""
    ids = [s.pk for s in statuses]
    if not ids:
        return set()
    return set(StatusView.objects.filter(user=request.user, status_id__in=ids).values_list("status_id", flat=True))


def _music_public(m):
    """What viewers need to play and credit a track (CC-BY needs the credit line shown)."""
    if not m:
        return None
    keys = ("title", "artist", "url", "duration", "credit", "license", "license_url", "source_url")
    return {k: m.get(k) for k in keys}


def _status(request, s, seen=None, urls=None):
    rs = list(s.reactions.all())
    if seen is None:
        seen = _seen_ids(request, [s])
    # your own statuses always count as seen
    watched = s.pk in seen or s.user_id == request.user.id
    return {
        "seen": watched,
        "id": str(s.id), "kind": s.kind, "text": s.text, "duration": s.duration_seconds,
        "file": _abs(request, s.file, urls),
        "cover": _abs(request, s.cover, urls),
        "slide_seconds": s.slide_seconds,
        "template": (s.template or media.DEFAULT_TEMPLATE) if s.kind == Status.Kind.SLIDESHOW else None,
        "canvas": (s.canvas or media.DEFAULT_CANVAS) if s.kind == Status.Kind.SLIDESHOW else None,
        "slides": [{"url": _abs(request, sl.file, urls), "w": sl.width, "h": sl.height} for sl in s.slides.all()]
                  if s.kind == Status.Kind.SLIDESHOW else None,
        "music": _music_public(s.music),
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


def _store(model, field_name, instance, filename, content, saved):
    """Write `content` to the field's storage under its normal upload path and return the stored name.
    Same result as FieldFile.save(), but without touching the DB; the name is remembered in `saved` for clean-up."""
    field = model._meta.get_field(field_name)
    stored = field.storage.save(field.generate_filename(instance, filename), content, max_length=field.max_length)
    saved.append(stored)
    return stored


class _Base(APIView):
    permission_classes = [IsAuthenticated, IsActiveAccount]


class StatusListCreateView(_Base):
    def get(self, request):
        services.purge_in_background()  # free stand-in for a cron job; runs at most every 15 min
        qs = list(_visible_statuses(request.user)
                  .select_related("user__profile").prefetch_related("reactions", "slides")
                  .order_by("-created_at")[:100])
        seen = _seen_ids(request, qs)
        urls = _urls_for(qs)
        return Response([_status(request, s, seen, urls) for s in qs])

    def post(self, request):
        now = timezone.now()
        if Status.objects.filter(user=request.user, created_at__gte=now - timedelta(hours=24)).count() >= MAX_STATUSES_PER_DAY:
            raise ValidationError({"detail": "You've reached today's status limit."})
        text = (request.data.get("text") or "").strip()[:140]
        f = request.FILES.get("file")
        photos = request.FILES.getlist("slides")
        if photos and f:
            raise ValidationError({"detail": "Send either a slideshow or a single photo/video, not both."})
        if not f and not photos and not text:
            raise ValidationError({"detail": "Add a photo, a video or some text."})
        s = Status(user=request.user, text=text, kind=Status.Kind.TEXT)
        content = name = None
        slides = cover = None
        if photos:
            # Cheap checks first (timing, look, music), then validate + compress EVERYTHING, so a bad 7th photo
            # never leaves six stored ones behind and a bad option never costs any image work.
            s.kind = Status.Kind.SLIDESHOW
            s.slide_seconds = media.parse_slide_seconds(request.data.get("slide_seconds"), len(photos))
            s.template = media.parse_choice(request.data.get("template"), media.TEMPLATES, media.DEFAULT_TEMPLATE, "template")
            s.canvas = media.parse_choice(request.data.get("canvas"), media.CANVASES, media.DEFAULT_CANVAS, "canvas")
            s.music = self._music(request.data.get("music"))
            slides, cover = media.process_slides(photos)
            s.duration_seconds = s.slide_seconds * len(slides)
        elif request.data.get("music"):
            raise ValidationError({"music": ["Music can only be added to a slideshow."]})
        elif f:
            ctype = (getattr(f, "content_type", "") or "").lower()
            if ctype.startswith("image/"):
                s.kind, content, name = Status.Kind.IMAGE, media.process_image(f), "s.jpg"
            elif ctype.startswith("video/"):
                content, ext, s.duration_seconds = media.process_video(f, request.data.get("duration"))
                s.kind, name = Status.Kind.VIDEO, f"s.{ext}"
            else:
                raise ValidationError({"file": ["Choose a photo or a video."]})
        saved = []  # storage names written so far, removed again if anything below fails
        try:
            # 1) Upload first: no DB transaction (and no pooled connection) is held while the network is busy.
            if content:
                s.file = _store(Status, "file", s, name, content, saved)
            if slides:
                s.cover = _store(Status, "cover", s, "c.webp", cover, saved)
                rows = [StatusSlide(status=s, position=i, width=w, height=h,
                                    file=_store(StatusSlide, "file", StatusSlide(status=s), "s.webp", blob, saved))
                        for i, (blob, w, h) in enumerate(slides)]
            # 2) One short transaction: the status row (written once, with its file names) and all slides in one INSERT.
            with transaction.atomic():
                s.save()
                if slides:
                    StatusSlide.objects.bulk_create(rows)
        except BaseException:
            storage = Status._meta.get_field("file").storage
            for n in saved:
                try:
                    storage.delete(n)
                except Exception:
                    pass
            raise
        s = Status.objects.select_related("user__profile").prefetch_related("reactions", "slides").get(pk=s.pk)
        return Response(_status(request, s), status=http.HTTP_201_CREATED)

    @staticmethod
    def _music(raw):
        """Optional {"provider": "openverse", "id": "..."} (dict or JSON string). Returns the verified track."""
        if raw in (None, "", "null"):
            return None
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = None
        if not isinstance(raw, dict):
            raise ValidationError({"music": ["Pick a track from the music list."]})
        return music.get_track(raw.get("provider"), raw.get("id"))


class StatusDetailView(_Base):
    """DELETE /statuses/<id>/ -> the creator permanently removes their own status (files + row, no undo).
    Same 404 for "doesn't exist" and "not yours", so nobody can probe for other people's status ids. An already
    expired status that the purge has not reached yet can still be deleted by its owner."""

    def delete(self, request, status_id):
        s = Status.objects.filter(pk=status_id, user=request.user).prefetch_related("slides").first()
        if s is None:
            raise NotFound("Status not found.")
        services.delete_status(s)  # even if the bucket is down it is hidden at once and finished by the purge
        return Response(status=http.HTTP_204_NO_CONTENT)


class MusicSearchView(_Base):
    """GET ?q=lofi[&provider=openverse] -> free, legally reusable tracks the status can use as background music.
    Results are cached for 30 minutes; if the outside catalogue is down the list is simply empty."""

    throttle_scope = "music_search"

    def get(self, request):
        provider = request.query_params.get("provider") or "openverse"
        return Response({"providers": music.providers(), "provider": provider,
                         "results": music.search(request.query_params.get("q"), provider)})


class MusicSuggestView(_Base):
    """GET [?exclude=id1,id2] -> 2 random free tracks for the "suggested" picks under the search box.
    Served from a pool shared by everyone and refreshed every 6 hours (see music._pool)."""

    throttle_scope = "music_search"

    def get(self, request):
        exclude = [x for x in (request.query_params.get("exclude") or "").split(",") if x][:20]
        return Response({"results": music.suggest(2, exclude)})


class StatusReactView(_Base):
    def post(self, request, status_id):
        s = _visible_statuses(request.user).filter(pk=status_id).first()
        if s is None:  # same answer for "gone" and "not someone in your trees"
            raise NotFound("Status not found.")
        _toggle(StatusReaction, "status", s, request.user, request.data.get("emoji"))
        s = Status.objects.select_related("user__profile").prefetch_related("reactions", "slides").get(pk=s.pk)
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
        qs = Thought.objects.select_related("user__profile").prefetch_related("reactions").order_by("-created_at")[:50]
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
        t = Thought.objects.select_related("user__profile").prefetch_related("reactions").get(pk=t.pk)
        return Response(_thought(request, t), status=http.HTTP_201_CREATED)


class ThoughtReactView(_Base):
    def post(self, request, thought_id):
        t = Thought.objects.filter(pk=thought_id).first()
        if t is None:
            raise NotFound("Thought not found.")
        _toggle(ThoughtReaction, "thought", t, request.user, request.data.get("emoji"))
        t = Thought.objects.select_related("user__profile").prefetch_related("reactions").get(pk=t.pk)
        return Response(_thought(request, t))


class TrendingView(_Base):
    def get(self, request):
        now = timezone.now()
        since = now - timedelta(hours=24)
        seen = _visible_statuses(request.user)
        top_s = (seen.annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user__profile").prefetch_related("reactions", "slides")
                 .order_by("-n", "-created_at")[:5])
        top_t = (Thought.objects.filter(created_at__gte=since).annotate(n=Count("reactions")).filter(n__gt=0)
                 .select_related("user__profile").prefetch_related("reactions").order_by("-n", "-created_at")[:5])
        tally = {}
        for model, scope in ((StatusReaction, {"status__in": seen}), (ThoughtReaction, {})):
            for row in model.objects.filter(created_at__gte=since, **scope).values("emoji").annotate(c=Count("id")):
                tally[row["emoji"]] = tally.get(row["emoji"], 0) + row["c"]
        emoji = [e for e, _ in sorted(tally.items(), key=lambda kv: -kv[1])[:3]]
        top_s = list(top_s)
        seen_ids, urls = _seen_ids(request, top_s), _urls_for(top_s)
        return Response({
            "statuses": [_status(request, s, seen_ids, urls) for s in top_s],
            "thoughts": [_thought(request, t) for t in top_t],
            "emoji": emoji,
        })


# ---------- Friend trees: visible only to the owner and the people tagged in them ----------

def _visible(user):
    return (FriendTree.objects.filter(Q(owner=user) | Q(members__user=user)).distinct()
            .select_related("owner__profile").prefetch_related("members__user__profile"))


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
