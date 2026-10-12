"""Group calls: the cap of 4 still holds, and seats left behind by a dead server are freed."""
import asyncio
from datetime import timedelta

import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.utils import timezone

from apps.accounts.models import User
from apps.chat import group_calls, services
from apps.chat.models import GroupCall, GroupCallParticipant
from apps.chat.routing import websocket_urlpatterns

application = URLRouter(websocket_urlpatterns)


def mk(i):
    u = User.objects.create_user(email=f"g{i}@example.com", username=f"guser{i}", password="a-strong-password-1", role="CUSTOMER")
    u.mark_email_verified()
    return u


def group_of(n_members):
    users = [mk(i) for i in range(n_members)]
    conv = services.create_group_conversation(users[0], [u.id for u in users[1:]], "Crew")
    return conv, users


def age_seats(call, seconds):
    GroupCallParticipant.objects.filter(call=call).update(updated_at=timezone.now() - timedelta(seconds=seconds))


@pytest.mark.django_db
def test_fifth_person_is_refused_and_nobody_is_kicked():
    conv, users = group_of(6)
    for u in users[:4]:
        call, *_ = group_calls.join(conv, u, "video")
    with pytest.raises(group_calls.CallFull):
        group_calls.join(conv, users[4], "video")
    assert GroupCallParticipant.objects.filter(call=call, left_at__isnull=True).count() == 4
    assert group_calls.active_call(conv.id)["full"] is True
    group_calls.leave(call.id, users[0].id)  # a seat opens
    group_calls.join(conv, users[4], "video")  # and the 5th person can now get in
    assert GroupCallParticipant.objects.filter(call=call, left_at__isnull=True).count() == 4


@pytest.mark.django_db
def test_ghost_seats_are_freed_so_a_new_person_can_join():
    conv, users = group_of(6)
    for u in users[:4]:
        call, *_ = group_calls.join(conv, u, "video")
    age_seats(call, group_calls.SEAT_STALE_SECONDS + 5)  # the server died: nobody refreshed these
    assert group_calls.active_call(conv.id) is None  # all four were ghosts: the call is over
    new_call, peers, created, _ = group_calls.join(conv, users[4], "video")
    assert created is True and peers == [] and new_call.id != call.id
    assert GroupCall.objects.get(id=call.id).ended_at is not None


@pytest.mark.django_db
def test_live_seats_are_kept_and_only_ghosts_are_freed():
    conv, users = group_of(6)
    for u in users[:4]:
        call, *_ = group_calls.join(conv, u, "video")
    GroupCallParticipant.objects.filter(call=call, user__in=[users[2], users[3]]).update(
        updated_at=timezone.now() - timedelta(seconds=group_calls.SEAT_STALE_SECONDS + 5))
    assert group_calls.touch_seat(call.id, users[0].id) is True
    joined_call, peers, created, _ = group_calls.join(conv, users[4], "video")
    assert created is False and joined_call.id == call.id
    assert sorted(peers) == sorted(str(u.id) for u in users[:2])  # only the two live people are peers
    assert group_calls.touch_seat(call.id, users[3].id) is False  # a freed seat cannot be refreshed


@pytest.mark.django_db
def test_just_joined_seats_are_not_treated_as_ghosts():
    conv, users = group_of(5)
    for u in users[:4]:
        group_calls.join(conv, u, "video")
    with pytest.raises(group_calls.CallFull):
        group_calls.join(conv, users[4], "video")


async def _connect(user, conv):
    comm = WebsocketCommunicator(application, f"/ws/gcall/{conv.id}/")
    comm.scope["user"] = user
    assert (await comm.connect())[0]
    return comm


async def _recv_type(comm, wanted, tries=8):
    for _ in range(tries):
        msg = await comm.receive_json_from(timeout=3)
        if msg.get("type") == wanted:
            return msg
    raise AssertionError(f"never received {wanted}")


@pytest.mark.django_db(transaction=True)
async def test_connected_socket_keeps_its_seat_fresh_and_stops_after_leaving(monkeypatch):
    monkeypatch.setattr(group_calls, "HEARTBEAT_SECONDS", 0.05)
    conv, users = await sync_to_async(group_of)(3)
    comm = await _connect(users[0], conv)
    await comm.send_json_to({"type": "join", "mode": "voice"})
    await _recv_type(comm, "joined")
    seat = await sync_to_async(lambda: GroupCallParticipant.objects.get(user=users[0], left_at__isnull=True))()
    first = seat.updated_at
    await asyncio.sleep(0.3)
    fresh = await sync_to_async(lambda: GroupCallParticipant.objects.get(pk=seat.pk).updated_at)()
    assert fresh > first  # the heartbeat has been refreshing it
    await comm.disconnect()
    row = await sync_to_async(lambda: GroupCallParticipant.objects.get(pk=seat.pk))()
    assert row.left_at is not None
    stopped_at = row.updated_at
    await asyncio.sleep(0.3)
    assert (await sync_to_async(lambda: GroupCallParticipant.objects.get(pk=seat.pk).updated_at)()) == stopped_at


@pytest.mark.django_db(transaction=True)
async def test_socket_steps_off_if_its_seat_was_freed(monkeypatch):
    monkeypatch.setattr(group_calls, "HEARTBEAT_SECONDS", 0.05)
    conv, users = await sync_to_async(group_of)(3)
    comm = await _connect(users[0], conv)
    await comm.send_json_to({"type": "join", "mode": "voice"})
    await _recv_type(comm, "joined")
    await sync_to_async(lambda: GroupCallParticipant.objects.filter(user=users[0]).update(left_at=timezone.now()))()
    out = await comm.receive_output(timeout=3)
    while out["type"] != "websocket.close":
        out = await comm.receive_output(timeout=3)
    assert out["code"] == 4410
