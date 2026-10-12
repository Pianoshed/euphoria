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
    ap.add_argument("--i-know-this-is-not-production", action="store_true", required=True)
    a = ap.parse_args()
    if not settings.DEBUG and "localhost" not in str(settings.DATABASES["default"].get("HOST", "")) and "127.0.0.1" not in str(settings.DATABASES["default"].get("HOST", "")):
        print("Refusing: database host is not local. Point DATABASE_URL at a throw-away database."); sys.exit(2)

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
