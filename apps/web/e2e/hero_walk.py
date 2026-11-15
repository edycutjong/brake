#!/usr/bin/env python3
"""Cold-visitor walk of the hero through the real UI: start → Monday review → Tuesday's email → payday → re-issue.
usage: python3 e2e/hero_walk.py [--base http://localhost:3000] [--shots DIR]   (needs: pip install playwright; playwright install chromium)
Exits non-zero if any step fails; prints the wall-clock time of the walk (acceptance: < 2 min on the live deploy)."""
import argparse, glob, json, os, sys, time
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:3000")
ap.add_argument("--shots", default=None)
ap.add_argument("--timeout", type=int, default=240)
a = ap.parse_args()
T = a.timeout * 1000
t0 = time.time()
def step(msg): print(f"[{time.time()-t0:6.1f}s] {msg}", flush=True)
def shot(page, name):
    if a.shots: page.screenshot(path=f"{a.shots}/{name}.png", full_page=True)

with sync_playwright() as p:
    exe = os.environ.get("CHROMIUM") or next(iter(sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))[::-1]), None)
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    ctx1 = b.new_context(viewport={"width": 1280, "height": 900})
    page = ctx1.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(a.base)
    page.get_by_role("button", name="Start a demo run").click()
    try:
        page.wait_for_url("**/run/**", timeout=60000)
    except Exception:
        print("start failed; page says:", page.locator("[role=alert]").all_inner_texts(), errors, flush=True); raise
    run_url = page.url
    step(f"run created {run_url}")
    page.get_by_text("All lines read and allowed on-chain.").wait_for(timeout=T)
    step("Monday review done (ALLOW x4)")
    shot(page, "run-sheet-monday")
    page.get_by_role("button", name="Deliver Tuesday's email").click()
    page.locator("tr[data-line='3'] .st.after").wait_for(timeout=T)
    step("line 3 STOPPED (stamp on the sheet)")
    page.locator("tr[data-line='3'] .stamp").wait_for(timeout=T)
    shot(page, "run-sheet-stopped")
    page.get_by_role("button", name="Run payday now").first.click()
    page.get_by_text("Re-issue — finance pays").wait_for()
    page.locator("tr[data-line='1'] .st.cleared").wait_for(timeout=T)
    step("payday: lines paid")
    page.get_by_role("checkbox").check()
    page.get_by_role("button", name="Re-issue and pay").click()
    page.get_by_text("Done — the stopped payment never cleared").wait_for(timeout=T)
    page.locator("tr[data-line='5'] .st.cleared").wait_for(timeout=T)  # the re-issued line itself is PAID
    step("re-issued line 5 paid — hero complete")
    shot(page, "run-sheet-done")
    walk = time.time() - t0
    base = a.base
    page.goto(run_url + "/agent"); page.get_by_text("model-only stop").first.wait_for(timeout=30000); shot(page, "agent-desk")
    page.goto(run_url + "/payday"); page.get_by_text("Proof of stop").first.wait_for(timeout=30000); shot(page, "payday")
    page.goto(base + "/verify"); page.get_by_text("LineStopped").first.wait_for(timeout=30000); shot(page, "verify")
    # 390 px: no horizontal scroll on every screen
    m = b.new_context(viewport={"width": 390, "height": 844}, storage_state=ctx1.storage_state()).new_page()  # same session: owner view at 390 px
    for path in ["/", run_url.replace(base, ""), run_url.replace(base, "") + "/agent", run_url.replace(base, "") + "/payday", "/verify"]:
        m.goto(base + path); m.wait_for_timeout(2500)
        w = m.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        step(f"390px {path[:30]:30s} scrollWidth={w[0]} innerWidth={w[1]} {'OK' if w[0] <= w[1] else 'H-SCROLL'}")
        if w[0] > w[1]: errors.append(f"horizontal scroll at {path}")
    shot_m = a.shots and m.goto(run_url) is None
    if a.shots: m.wait_for_timeout(2500); m.screenshot(path=f"{a.shots}/run-sheet-390.png", full_page=True)
    print(json.dumps({"walk_seconds": round(walk, 1), "errors": errors[:10]}))
    sys.exit(1 if errors else 0)
