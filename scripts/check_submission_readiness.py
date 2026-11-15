#!/usr/bin/env python3
"""Pre-submission readiness for the judged repo. Run from anywhere: python3 scripts/check_submission_readiness.py [--url https://…]
PASS/FAIL/WARN per check; exit 1 on any FAIL. Only looks at what a judge can see (this repo + the live URL)."""
import argparse, json, os, re, shutil, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = []


def check(name, ok, detail="", warn=False):
    rows.append(("PASS" if ok else ("WARN" if warn else "FAIL"), name, detail))


def sh(*cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"user-agent": "readiness-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf8", "replace")


ap = argparse.ArgumentParser()
ap.add_argument("--url", default=os.environ.get("PUBLIC_URL"))
a = ap.parse_args()

for f in ("README.md", "LICENSE"):
    check(f"{f} exists", os.path.getsize(os.path.join(ROOT, f)) > 200 if os.path.exists(os.path.join(ROOT, f)) else False)
for f in ("DEMO.md", "ARCHITECTURE.md"):
    check(f"{f} exists", os.path.exists(os.path.join(ROOT, f)), "written in the README phase", warn=True)
check("CI workflows present", os.path.isdir(os.path.join(ROOT, ".github", "workflows")) and bool(os.listdir(os.path.join(ROOT, ".github", "workflows"))), warn=True)

tc = os.path.join(ROOT, "evidence", "test-counts.json")
if os.path.exists(tc):
    j = json.load(open(tc))
    check("test counts recorded", True, json.dumps(j)[:160])
else:
    check("test counts recorded", False)

br = os.path.join(ROOT, "bench", "results.json")
if os.path.exists(br):
    j = json.load(open(br))
    n = j["latency_email_to_cancel_confirmed_ms"]["n"]
    check("bench/results.json n >= 10 with p50/p95", n >= 10 and j["latency_email_to_cancel_confirmed_ms"]["p95"] is not None, f"n={n}, {j.get('label')}")
    check("bench is from the live chain", j.get("deployment") == "live", "fork-labelled figures must not headline judge-facing pages", warn=True)
else:
    check("bench/results.json exists", False)

tracked = sh("git", "ls-files").stdout.splitlines()
bad = [f for f in tracked if re.search(r"(^|/)(specs?|progress|predict\w*|radar|CLAUDE|AGENTS)\b|\.claude|(^|/)\.env$|\.pem$|wallets", f, re.I) and not re.search(r"(^|/)test/specs?/", f)]
check("no kitchen/secret filenames tracked", not bad, ", ".join(bad[:5]))
if shutil.which("gitleaks"):
    g = sh("gitleaks", "detect", "--source", ".", "--log-opts=--all", "--no-banner")
    check("gitleaks clean (full history)", g.returncode == 0, (g.stderr or g.stdout)[-120:].strip())
else:
    check("gitleaks clean", False, "gitleaks not installed", warn=True)
ev = [f for f in tracked if f.startswith("evidence/") and f.endswith("-fork.json")]
check("fork evidence is labelled in-file", all(re.search(r'"(deployment|mode|network)": *"fork', open(os.path.join(ROOT, f)).read()) for f in ev) if ev else True, f"{len(ev)} fork files")

live = os.path.join(ROOT, "evidence", "deploy-44005-live.json")
check("live deployment record exists", os.path.exists(live), "needs funded deployer wallet", warn=True)
if a.url:
    try:
        s, body = get(a.url.rstrip("/") + "/api/health")
        h = json.loads(body)
        check("live URL /api/health ok", s == 200 and h.get("ok") is True, f"deployment={h.get('deployment')} block={h.get('block')}")
        check("live URL serves the live deployment", h.get("deployment") == "live")
        s2, home = get(a.url)
        check("live URL home 200", s2 == 200)
    except Exception as e:  # noqa: BLE001
        check("live URL reachable", False, str(e)[:120])
else:
    check("live URL checked", False, "pass --url or set PUBLIC_URL", warn=True)

w = max(len(r[1]) for r in rows)
for st, n, d in rows:
    print(f"{st:5} {n:{w}}  {d}")
sys.exit(1 if any(r[0] == "FAIL" for r in rows) else 0)
