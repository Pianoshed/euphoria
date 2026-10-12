#!/usr/bin/env python
"""Post-deploy smoke test for a RUNNING environment (staging first, then production).

    SMOKE_PASSWORD='...' python scripts/smoke_test.py --base https://api.example.com \
        --email smoke@example.com --origin https://app.example.com

Use a dedicated, verified test account with no 2FA and no money in its wallet. Checks, in order:
health, CSRF cookie, login, own profile, conversation list, unread summary, presence ping, and the
site-wide WebSocket (/ws/calls/inbox/ must say "ready"). Exit code 0 only if every step passed.
The password is read from the SMOKE_PASSWORD environment variable and is never printed.
"""
import argparse, asyncio, json, os, sys, time
import httpx
import websockets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="API base, e.g. https://api.example.com")
    ap.add_argument("--origin", required=True, help="the frontend origin the browser would send")
    ap.add_argument("--email", required=True)
    ap.add_argument("--health-path", default="/healthz/")
    ap.add_argument("--slow-ms", type=int, default=1500, help="flag any step slower than this")
    a = ap.parse_args()
    password = os.environ.get("SMOKE_PASSWORD")
    if not password:
        sys.exit("Set SMOKE_PASSWORD in the environment.")
    base = a.base.rstrip("/")
    results = []

    def record(name, ok, ms, note=""):
        results.append((name, ok, ms, note))
        flag = "PASS" if ok else "FAIL"
        slow = "  (SLOW)" if ok and ms > a.slow_ms else ""
        print(f"{flag}  {name:<28} {ms:7.0f} ms  {note}{slow}")

    c = httpx.Client(base_url=base, timeout=20, headers={"Origin": a.origin, "Referer": a.origin + "/"})

    def step(name, fn):
        t = time.monotonic()
        try:
            ok, note = fn()
        except Exception as exc:
            ok, note = False, type(exc).__name__
        record(name, ok, (time.monotonic() - t) * 1000, note)
        return ok

    step("health", lambda: ((r := c.get(a.health_path)).status_code == 200, f"HTTP {r.status_code}"))
    step("csrf cookie", lambda: ((r := c.get("/api/accounts/csrf/")).status_code == 200 and "csrftoken" in c.cookies, f"HTTP {r.status_code}"))

    def login():
        r = c.post("/api/accounts/login/", json={"email": a.email, "password": password},
                   headers={"X-CSRFToken": c.cookies.get("csrftoken", "")})
        body = {}
        try:
            body = r.json()
        except Exception:
            pass
        needs = []
        if body.get("mfa_required"):
            needs.append("2FA is on")
        if body.get("session_conflict"):
            needs.append("the account is already logged in elsewhere (single-device login)")
        return r.status_code == 200 and not needs, f"HTTP {r.status_code}" + (f": {'; '.join(needs)} - use a dedicated smoke account" if needs else "")

    if not step("login", login):
        print("\nLogin failed: skipping the rest.")
        sys.exit(1)
    step("profile/me", lambda: ((r := c.get("/api/accounts/profile/me/")).status_code == 200, f"HTTP {r.status_code}"))
    step("conversation list", lambda: ((r := c.get("/api/chat/conversations/")).status_code == 200, f"HTTP {r.status_code}"))
    step("unread summary", lambda: ((r := c.get("/api/chat/unread/")).status_code == 200, f"HTTP {r.status_code}"))
    step("presence ping", lambda: ((r := c.post("/api/accounts/presence/ping/", headers={"X-CSRFToken": c.cookies.get("csrftoken", "")})).status_code in (200, 204), f"HTTP {r.status_code}"))

    async def ws_check():
        ws_url = base.replace("https://", "wss://").replace("http://", "ws://") + "/ws/calls/inbox/"
        cookie = "; ".join(f"{k}={v}" for k, v in c.cookies.items() if k in ("sessionid",))
        async with websockets.connect(ws_url, additional_headers={"Cookie": cookie, "Origin": a.origin}, open_timeout=15) as ws:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
            return msg.get("type") == "ready", f"first frame: {msg.get('type')}"

    step("websocket inbox ready", lambda: asyncio.run(ws_check()))
    step("logout", lambda: ((r := c.post("/api/accounts/logout/", headers={"X-CSRFToken": c.cookies.get("csrftoken", "")})).status_code in (200, 204), f"HTTP {r.status_code}"))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + ("" if not failed else "  -> ROLL BACK / INVESTIGATE"))
    sys.exit(1 if failed else 0)


main()
