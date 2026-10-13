"""Create load-test users, sessions and conversations. NEVER run this against production.

    python loadtest/seed.py --users 300 --group-size 10 --out loadtest/seed.json

Needs the same env as the server (DATABASE_URL, REDIS_URL, DJANGO_SECRET_KEY, ...) and
DJANGO_SETTINGS_MODULE=config.settings.dev (or staging). Users are named lt_<n>@loadtest.invalid.
Sessions are created directly, so no login throttle and no password hashing is involved.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
import django
django.setup()

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore

from apps.accounts.models import User
from apps.chat import services


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", type=int, default=200)
    ap.add_argument("--group-size", type=int, default=10)
    ap.add_argument("--out", default="loadtest/seed.json")
    ap.add_argument("--fast", action="store_true", help="bulk-create users without password hashing (thousands of users in seconds)")
    ap.add_argument("--i-know-this-is-not-production", action="store_true", required=True)
    a = ap.parse_args()
    if not settings.DEBUG and "localhost" not in str(settings.DATABASES["default"].get("HOST", "")) and "127.0.0.1" not in str(settings.DATABASES["default"].get("HOST", "")):
        print("Refusing: database host is not local. Point DATABASE_URL at a throw-away database."); sys.exit(2)

    if a.fast:
        from django.contrib.sessions.models import Session
        from django.utils import timezone
        from django.utils.crypto import get_random_string
        from apps.accounts.models import Profile, ProfilePrivacy
        existing = {u.email: u for u in User.objects.filter(email__startswith="lt_", email__endswith="@loadtest.invalid")}
        tpl = next(iter(existing.values()), None) or User.objects.create_user(
            email="lt_tpl@loadtest.invalid", username="lttpluser", password="unused-Loadtest-1!", role="CUSTOMER")
        pf = Profile.objects.get(user=tpl); pv = ProfilePrivacy.objects.get(user=tpl)
        pf_f = {f.name: getattr(pf, f.name) for f in Profile._meta.concrete_fields if f.name not in ("id", "user", "created_at", "updated_at", "display_name")}
        pv_f = {f.name: getattr(pv, f.name) for f in ProfilePrivacy._meta.concrete_fields if f.name not in ("id", "user", "created_at", "updated_at")}
        missing = [i for i in range(a.users) if f"lt_{i}@loadtest.invalid" not in existing]
        for start in range(0, len(missing), 2000):
            chunk = missing[start:start + 2000]
            new_users = [User(email=f"lt_{i}@loadtest.invalid", username=f"lt{i}user", role="CUSTOMER", status="ACTIVE", password="!", email_verified=True, email_verified_at=timezone.now()) for i in chunk]
            User.objects.bulk_create(new_users)
            Profile.objects.bulk_create([Profile(user_id=u.id, display_name=f"LT {u.username}", **pf_f) for u in new_users])
            ProfilePrivacy.objects.bulk_create([ProfilePrivacy(user_id=u.id, **pv_f) for u in new_users])
        by_email = {u.email: u for u in User.objects.filter(email__startswith="lt_", email__endswith="@loadtest.invalid")}
        users = [by_email[f"lt_{i}@loadtest.invalid"] for i in range(a.users)]
        store = SessionStore()
        sessions, clients = [], []
        for u in users:
            data = {SESSION_KEY: str(u.pk), BACKEND_SESSION_KEY: "django.contrib.auth.backends.ModelBackend", HASH_SESSION_KEY: u.get_session_auth_hash()}
            key = get_random_string(32, "abcdefghijklmnopqrstuvwxyz0123456789")
            sessions.append(Session(session_key=key, session_data=store.encode(data), expire_date=timezone.now() + timezone.timedelta(hours=6)))
            clients.append({"user_id": str(u.pk), "session": key})
        Session.objects.bulk_create(sessions)
    else:
        users = []
        for i in range(a.users):
            email = f"lt_{i}@loadtest.invalid"
            u = User.objects.filter(email=email).first() or User.objects.create_user(
                email=email, username=f"lt{i}user", password="unused-Loadtest-1!", role="CUSTOMER")
            u.mark_email_verified()
            users.append(u)

        clients = []
        for u in users:
            s = SessionStore()
            s[SESSION_KEY] = str(u.pk)
            s[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
            s[HASH_SESSION_KEY] = u.get_session_auth_hash()
            s.set_expiry(60 * 60 * 6)
            s.create()
            clients.append({"user_id": str(u.pk), "session": s.session_key})

    dms = []
    for i in range(0, len(users) - 1, 2):
        c = services.start_or_get_conversation(users[i], users[i + 1].id)
        dms.append({"conversation_id": str(c.id), "members": [i, i + 1]})
    groups = []
    for start in range(0, len(users) - a.group_size + 1, a.group_size):
        idx = list(range(start, start + a.group_size))
        try:
            g = services.create_group_conversation(users[idx[0]], [users[j].id for j in idx[1:]], f"LT group {start}")
            groups.append({"conversation_id": str(g.id), "members": idx})
        except Exception as exc:  # e.g. privacy settings; skip that group
            print("group skipped:", exc)
    json.dump({"clients": clients, "dms": dms, "groups": groups}, open(a.out, "w"))
    print(f"seeded {len(users)} users, {len(dms)} DMs, {len(groups)} groups -> {a.out}")


main()
