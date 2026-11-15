#!/usr/bin/env python3
"""Owner-view screenshots of the edge states, driven through the real API + UI on a local fork:
flood (stop budget alarm + on-chain HOLD + Allow/Stop), late (TOO LATE + recovery ticket), revoke, hero payday countdown, payday guard.
usage: python3 e2e/edge_walk.py --shots DIR [--base URL]"""
import argparse, glob, json, os, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--shots", required=True); ap.add_argument("--base", default="http://localhost:3000")
a = ap.parse_args()
exe = os.environ.get("CHROMIUM") or next(iter(sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))[::-1]), None)
t0 = time.time()
def log(m): print(f"[{time.time()-t0:6.1f}s] {m}", flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    pg = ctx.new_page(); pg.goto(a.base)
    def api(path, method="GET", body=None, token=None):
        return pg.evaluate("""async ([path, method, body, token]) => {
          const r = await fetch(path, {method, headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, body: body ? JSON.stringify(body) : undefined});
          return {status: r.status, json: await r.json().catch(() => ({}))}; }""", [path, method, body, token])
    def make(scenario):
        r = api("/api/runs", "POST", {"scenario": scenario}); assert r["status"] == 201, r
        rid, tok = r["json"]["id"], r["json"]["token"]
        pg.evaluate("([i,t]) => { localStorage.setItem('brake:token:'+i, t); localStorage.setItem('brake:last', i); }", [rid, tok])
        return rid, tok
    def idle(rid, tok, need_open=True):
        for _ in range(150):
            r = api(f"/api/runs/{rid}", token=tok)["json"]
            if (r.get("openTx") or not need_open) and not any(j["status"] in ("queued", "running") for j in r["jobs"]) and r["decisions"]: return r
            time.sleep(2)
        raise SystemExit("timeout waiting for reviews")
    def payday(rid, tok):
        while True:
            r = api(f"/api/runs/{rid}/payday?wait=1", "POST", {}, tok)["json"]
            if r.get("notYet") and not r.get("batchTx") and not r.get("proofs"): time.sleep(min(max(n["secondsLeft"] for n in r["notYet"]), 20) + 1.5); continue
            return r
    def shot(rid, sub, name):
        pg.goto(f"{a.base}/run/{rid}{sub}"); pg.wait_for_timeout(3500); pg.screenshot(path=f"{a.shots}/{name}.png", full_page=True); log(f"shot {name}")

    # A. flood — budget alarm + HELD with owner controls
    rid, tok = make("flood"); idle(rid, tok)
    for seed in ("E14", "E15", "E16"):
        api(f"/api/runs/{rid}/inbox", "POST", {"seed": seed}, tok); time.sleep(3); idle(rid, tok)
    log("flood reviewed"); payday(rid, tok)
    shot(rid, "/payday", "edge-budget-held"); shot(rid, "", "edge-budget-sheet")
    # B. late — TOO LATE
    rid, tok = make("late"); idle(rid, tok); payday(rid, tok)
    api(f"/api/runs/{rid}/inbox", "POST", {"seed": "E13"}, tok); time.sleep(3); idle(rid, tok)
    for _ in range(40):
        r = api(f"/api/runs/{rid}", token=tok)["json"]
        if any(l["status"] == "TOO_LATE" for l in r["lines"]): break
        api("/api/verify/events"); time.sleep(3)
    shot(rid, "/payday", "edge-too-late")
    # C. hero: payday guard text, revoke state, countdown on the hero button
    rid, tok = make("hero"); idle(rid, tok)
    pg.goto(f"{a.base}/run/{rid}/payday"); pg.wait_for_timeout(2500)
    msgs = []
    pg.once("dialog", lambda d: (msgs.append(d.message), d.dismiss()))
    pg.get_by_role("button", name="Run payday now").click(); pg.wait_for_timeout(800)
    log(f"payday guard dialog: {msgs[0][:90] if msgs else 'NONE'}"); assert msgs, "guard confirm did not appear"
    pg.goto(f"{a.base}/run/{rid}"); pg.wait_for_timeout(2500)
    pg.get_by_role("button", name="Deliver Tuesday's email").click()
    pg.locator("tr[data-line='3'] .st.after").wait_for(timeout=120000)
    pg.get_by_role("button", name="Run payday now").first.click(); pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{a.shots}/hero-countdown.png"); log("shot hero-countdown")
    pg.get_by_text("Re-issue — finance pays").wait_for(); pg.locator("tr[data-line='1'] .st.cleared").wait_for(timeout=120000)
    pg.get_by_role("button", name="Revoke agent").click(); pg.get_by_role("button", name="Revoked").wait_for(timeout=60000)
    pg.screenshot(path=f"{a.shots}/revoked.png"); log("shot revoked")
    b.close()
