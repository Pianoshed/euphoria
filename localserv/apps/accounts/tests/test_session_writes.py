"""Sliding idle timeout without a session write on every request."""
from datetime import timedelta

import pytest
from django.contrib.sessions.models import Session
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User

pytestmark = pytest.mark.django_db


def make_user():
    u = User.objects.create_user(email="s@example.com", username="suser", password="a-strong-password-1", role="CUSTOMER")
    u.mark_email_verified()
    return u


def login(client):
    return client.post(reverse("accounts:login"), {"email": "s@example.com", "password": "a-strong-password-1"}, content_type="application/json")


def writes(ctx, table):
    return [q for q in ctx.captured_queries if q["sql"].lstrip().upper().startswith(("UPDATE", "INSERT")) and table in q["sql"]]


def test_repeated_requests_do_not_rewrite_the_session_each_time(client):
    make_user(); assert login(client).status_code == 200
    url = reverse("accounts:presence-ping")
    client.post(url)  # may refresh once
    with CaptureQueriesContext(connection) as ctx:
        for _ in range(5):
            assert client.post(url).status_code == 200
    assert writes(ctx, "django_session") == []  # was 5 UPDATEs with SESSION_SAVE_EVERY_REQUEST


def test_session_is_refreshed_once_it_is_older_than_the_refresh_interval(client, settings):
    make_user(); login(client)
    key = client.session.session_key
    s = client.session; s["_refreshed_at"] = 1; s.save()  # pretend the last refresh was long ago
    Session.objects.filter(session_key=key).update(expire_date=timezone.now() + timedelta(minutes=1))
    client.post(reverse("accounts:presence-ping"))
    row = Session.objects.get(session_key=key)
    assert row.expire_date > timezone.now() + timedelta(seconds=settings.SESSION_COOKIE_AGE - 120)  # slid forward


def test_idle_session_still_expires(client):
    make_user(); login(client)
    Session.objects.filter(session_key=client.session.session_key).update(expire_date=timezone.now() - timedelta(seconds=1))
    assert client.post(reverse("accounts:presence-ping")).status_code in (401, 403)
