from rest_framework.permissions import BasePermission

from apps.common.constants import AccountStatus


class IsActiveAccount(BasePermission):
    """Blocks any authenticated-but-not-ACTIVE account (suspended,
    banned, deactivated, pending verification) from protected actions,
    even if their session/token is still technically valid."""

    message = "Your account is not currently active."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and getattr(user, "status", None) == AccountStatus.ACTIVE
        )


class IsOwner(BasePermission):
    """Object-level check: the object must have an `owner`-like field
    pointing at request.user. Never trust an ID submitted by the client
    for this -- always compare against request.user server-side."""

    owner_field = "owner"

    def has_object_permission(self, request, view, obj):
        owner = getattr(obj, self.owner_field, None)
        return owner is not None and owner == request.user


class IsParticipant(BasePermission):
    """Object-level check for models exposing a `participants` M2M
    or a queryset-returning `is_participant(user)` method."""

    def has_object_permission(self, request, view, obj):
        if hasattr(obj, "is_participant"):
            return obj.is_participant(request.user)
        participants = getattr(obj, "participants", None)
        if participants is None:
            return False
        return participants.filter(pk=request.user.pk).exists()
