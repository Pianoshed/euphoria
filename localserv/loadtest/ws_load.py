"""WebSocket load test: realistic chat traffic against a RUNNING server (staging / local, never production).

    python loadtest/ws_load.py --url ws://127.0.0.1:8000 --seed loadtest/seed.json \
        --users 300 --msgs-per-min 6 --duration 60 --group-share 0.3 --origin http://localhost:5173 \
        --reconnect-storm --db-dsn postgres://t:t@127.0.0.1:5432/t

What it measures
  * connect time (p50/p95/max) and failures
  * message round trip: time from send until the sender sees its own message come back through the
    channel layer (that includes the DB write), for DMs and for groups
  * delivery: every other member of the conversation must receive each message (counted)
  * peak open Postgres connections (needs --db-dsn and psql on PATH)
  * reconnect storm: all sockets drop and reconnect at once; time until all are back
It prints one JSON line at the end so runs can be compared / stored.
"""
import argparse, asyncio, json, random, statistics, subprocess, time, uuid

import websockets


def pct(values, p):
    if not values:
        return None
    values = sorted(values)
    return round(values[min(len(values) - 1, int(len(values) * p))] * 1000, 1)


class Stats:
    def __init__(self):
        self.connect, self.rtt_dm, self.rtt_group = [], [], []
        self.connect_fail = self.errors = self.sent = self.echo = self.deliveries_expected = self.deliveries_got = 0
        self.closed = {}


async def client(idx, conv_ids, cfg, st, stop, seed_clients, member_count, pending):
    cookie = f"sessionid={seed_clients[idx]['session']}"
    sockets = []
    await asyncio.sleep(random.random() * cfg.ramp)  # people do not all connect in the same millisecond
    for cid in conv_ids:
        t0 = time.monotonic()
        try:
            ws = await websockets.connect(f"{cfg.url}/ws/chat/{cid}/", additional_headers={"Cookie": cookie, "Origin": cfg.origin},
                                          open_timeout=20, max_size=2**20)
            st.connect.append(time.monotonic() - t0)
            sockets.append((cid, ws))
        except Exception:
            st.connect_fail += 1
    my_uid = seed_clients[idx]["user_id"]

    async def reader(cid, ws):
        try:
            async for raw in ws:
                data = json.loads(raw)
                if data.get("type") == "error":
                    st.errors += 1
                    continue
                if data.get("type") != "message":
                    continue
                body = data.get("body", "")
                if body.startswith("lt:"):
                    token = body.split(":")[1]
                    p = pending.get(token)
                    if p is None:
                        continue
                    p["got"] += 1
                    st.deliveries_got += 1
                    if str(data.get("sender_id") or data.get("sender", {}).get("id", "")) == my_uid and not p.get("rtt_done"):
                        p["rtt_done"] = True
                        (st.rtt_group if p["group"] else st.rtt_dm).append(time.monotonic() - p["t"])
        except Exception as exc:
            st.closed[type(exc).__name__] = st.closed.get(type(exc).__name__, 0) + 1

    readers = [asyncio.create_task(reader(cid, ws)) for cid, ws in sockets]
    interval = 60.0 / cfg.msgs_per_min
    await asyncio.sleep(random.random() * interval)
    while not stop.is_set() and sockets:
        cid, ws = random.choice(sockets)
        token = uuid.uuid4().hex[:10]
        group = member_count[cid] > 2
        pending[token] = {"t": time.monotonic(), "got": 0, "group": group}
        st.deliveries_expected += member_count[cid]  # everyone, sender included (broadcast)
        try:
            await ws.send(json.dumps({"type": "message", "body": f"lt:{token}:x"}))
            st.sent += 1
        except Exception:
            st.errors += 1
        await asyncio.sleep(interval * (0.5 + random.random()))
    for r in readers:
        r.cancel()
    for _, ws in sockets:
        await ws.close()


def db_connections(dsn):
    if not dsn:
        return None
    out = subprocess.run(["psql", dsn, "-tAc", "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()"],
                         capture_output=True, text=True)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return None


async def run_phase(cfg, seed, label, duration, ramp=None):
    cfg = argparse.Namespace(**{**vars(cfg), "ramp": cfg.ramp if ramp is None else ramp})
    st, pending, stop = Stats(), {}, asyncio.Event()
    n = cfg.users
    member_count, mine = {}, [[] for _ in range(n)]
    for d in seed["dms"]:
        member_count[d["conversation_id"]] = 2
        for m in d["members"]:
            if m < n:
                mine[m].append(d["conversation_id"])
    for g in seed["groups"][: max(0, int(len(seed["groups"]) * cfg.group_share * 3))]:
        member_count[g["conversation_id"]] = len(g["members"])
        for m in g["members"]:
            if m < n:
                mine[m].append(g["conversation_id"])
    peak = [0]

    async def sampler():
        while not stop.is_set():
            c = db_connections(cfg.db_dsn)
            if c:
                peak[0] = max(peak[0], c)
            await asyncio.sleep(1)

    t_start = time.monotonic()
    tasks = [asyncio.create_task(client(i, mine[i], cfg, st, stop, seed["clients"], member_count, pending)) for i in range(n) if mine[i]]
    samp = asyncio.create_task(sampler()) if cfg.db_dsn else None
    await asyncio.sleep(duration)
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    if samp:
        samp.cancel()
    lost = sum(1 for p in pending.values() if p["got"] == 0)
    return {
        "phase": label, "sockets": len(st.connect), "connect_fail": st.connect_fail,
        "connect_ms_p50": pct(st.connect, .5), "connect_ms_p95": pct(st.connect, .95), "connect_ms_max": pct(st.connect, 1),
        "sent": st.sent, "rtt_dm_ms_p50": pct(st.rtt_dm, .5), "rtt_dm_ms_p95": pct(st.rtt_dm, .95),
        "rtt_group_ms_p50": pct(st.rtt_group, .5), "rtt_group_ms_p95": pct(st.rtt_group, .95),
        "delivered_pct": round(100 * st.deliveries_got / max(1, st.deliveries_expected), 2), "messages_never_seen": lost,
        "errors": st.errors, "socket_drops": st.closed, "peak_db_connections": peak[0] or None,
        "seconds": round(time.monotonic() - t_start, 1),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8000")
    ap.add_argument("--origin", default="http://localhost:5173")
    ap.add_argument("--seed", default="loadtest/seed.json")
    ap.add_argument("--users", type=int, default=200)
    ap.add_argument("--msgs-per-min", type=float, default=6)
    ap.add_argument("--duration", type=int, default=30)
    ap.add_argument("--group-share", type=float, default=0.3)
    ap.add_argument("--ramp", type=float, default=10, help="spread the initial connects over this many seconds")
    ap.add_argument("--reconnect-storm", action="store_true")
    ap.add_argument("--db-dsn", default="")
    ap.add_argument("--label", default="run")
    cfg = ap.parse_args()
    seed = json.load(open(cfg.seed))
    cfg.users = min(cfg.users, len(seed["clients"]))
    results = [await run_phase(cfg, seed, f"{cfg.label}:steady", cfg.duration)]
    if cfg.reconnect_storm:
        results.append(await run_phase(cfg, seed, f"{cfg.label}:reconnect-storm", 5, ramp=0))
    for r in results:
        print(json.dumps(r))


asyncio.run(main())
