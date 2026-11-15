#!/usr/bin/env python3
"""Brake bench — reproducible numbers from raw rows committed in evidence/bench-rows.json.

  python3 scripts/bench.py                # recompute p50/p95/n, gas and injection-suite numbers from the committed rows -> bench/results.json
  python3 scripts/bench.py --export       # (needs local Postgres + the RPC the runs used) re-extract the raw rows from a database

Latency = wall-clock from the vendor email landing in the run's inbox to the agent's Brake.stop receipt coming back
(tx_queue.settled_at). N comes from runs that happened anyway (hero, flood, tests) — no dedicated bench runs. Exits non-zero if
a correctness check fails: n < 10, a missing figure, or an agent-initiated transfer."""
import argparse, glob, json, math, os, statistics, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS = os.path.join(ROOT, "evidence", "bench-rows.json")
OUT = os.path.join(ROOT, "bench", "results.json")
MIN_N = 10


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def psql(db, sql):
    out = subprocess.run(["psql", db, "-At", "-F", "\t", "-c", sql], check=True, capture_output=True, text=True).stdout
    return [l.split("\t") for l in out.splitlines() if l]


def rpc(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30)).get("result")


def export(db, rpc_url, deployment):
    # one row per agent STOP that reached the chain: the email that triggered it = the run's latest inbox row at/before the decision
    lat = psql(db, """
      select d.run_id, d.idx, r.scenario, d.tx, q.settled_at is not null,
             extract(epoch from (q.settled_at - m.received_at)) * 1000, m.id, m.source, d.model
        from decisions d
        join runs r on r.id = d.run_id
        join tx_queue q on q.tx_hash = d.tx and q.status = 'mined' and q.action = 'stop'
        join lateral (select id, received_at, source from inbox where run_id = d.run_id and received_at <= d.created_at order by received_at desc limit 1) m on true
       where d.verdict = 'STOP' and q.settled_at is not null and d.model is not null and d.model <> 'finance'
       order by d.created_at""")
    latency = [dict(run=a, line=int(b) + 1, scenario=c, stop_tx=d, latency_ms=round(float(f)), trigger_message=g, trigger_source=h, model=mo) for a, b, c, d, e, f, g, h, mo in lat if float(f) >= 0]
    acts = psql(db, "select action, tx_hash from tx_queue where status = 'mined' and tx_hash is not null order by created_at")
    gas = []
    for action, h in acts:
        rc = rpc(rpc_url, "eth_getTransactionReceipt", [h])
        if rc:
            gas.append(dict(action=action, tx=h, gas_used=int(rc["gasUsed"], 16)))
    agent_transfers = psql(db, "select count(*) from tx_queue where action in ('transfer','transferWithAuthorization','pay') and sender = (select lower(agent) from runs order by created_at desc limit 1)")
    json.dump(dict(deployment=deployment, source="Postgres tx_queue/decisions/inbox + receipts from " + rpc_url, latency=latency, gas=gas, agent_initiated_transfers=int(agent_transfers[0][0])), open(ROWS, "w"), indent=1)
    print(f"exported {len(latency)} latency rows, {len(gas)} gas rows -> {ROWS}")


def compute():
    d = json.load(open(ROWS))
    lat = [r["latency_ms"] for r in d["latency"]]
    by_action = {}
    for g in d["gas"]:
        by_action.setdefault(g["action"], []).append(g["gas_used"])
    inj = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "evidence", "g4", "*.json"))):
        j = json.load(open(f))
        if "split" in j:
            inj[os.path.basename(f)[:-5]] = {k: j[k] for k in ("split", "model", "n", "correct", "missedStops", "falseStops", "falseHolds", "benignAutoRelease", "collateralLines") if k in j}
    res = dict(
        deployment=d["deployment"],
        label="FORK — anvil fork of Aevum 44005, not the live chain" if d["deployment"] != "live" else "live Aevum testnet 44005",
        models=sorted({r.get("model", "?") for r in d["latency"]}),
        latency_email_to_cancel_confirmed_ms=dict(n=len(lat), p50=pct(lat, 50), p95=pct(lat, 95), mean=round(statistics.mean(lat)) if lat else None, min=min(lat, default=None), max=max(lat, default=None)),
        gas_used_median={a: int(statistics.median(v)) for a, v in sorted(by_action.items())},
        gas_samples={a: len(v) for a, v in sorted(by_action.items())},
        injection_suite=inj,
        agent_initiated_transfers=d["agent_initiated_transfers"],
        reproduce="python3 scripts/bench.py  (reads evidence/bench-rows.json; --export re-extracts from a database)",
    )
    checks = [
        (f"n >= {MIN_N}", len(lat) >= MIN_N),
        ("p50 and p95 present", res["latency_email_to_cancel_confirmed_ms"]["p50"] is not None),
        ("agent initiated 0 transfers (invariant)", d["agent_initiated_transfers"] == 0),
        ("injection suite present (tune + holdout)", any("tune" in k for k in inj) and any("holdout" in k for k in inj)),
    ]
    res["checks"] = [dict(check=c, ok=ok) for c, ok in checks]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(res, open(OUT, "w"), indent=2)
    print(json.dumps(res, indent=2))
    return all(ok for _, ok in checks)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--db", default=os.environ.get("DATABASE_URL", "postgres://localhost:5432/brake"))
    ap.add_argument("--rpc", default=os.environ.get("RPC_URL", "http://127.0.0.1:8545"))
    ap.add_argument("--deployment", default=os.environ.get("DEPLOYMENT", "fork"))
    a = ap.parse_args()
    if a.export:
        export(a.db, a.rpc, a.deployment)
    sys.exit(0 if compute() else 1)
