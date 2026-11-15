#!/usr/bin/env python3
"""Screenshots of the edge states (TOO LATE, stop-budget alarm + HELD) from runs the demo scripts made, via the public read-only view.
usage: python3 e2e/edge_shots.py --late run_… --flood run_… --shots DIR [--base URL]"""
import argparse, glob, os
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument("--late"); ap.add_argument("--flood"); ap.add_argument("--shots", required=True); ap.add_argument("--base", default="http://localhost:3000")
a = ap.parse_args()
exe = os.environ.get("CHROMIUM") or next(iter(sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))[::-1]), None)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    pg = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
    for name, rid, sub in (("too-late", a.late, "/payday"), ("budget-held", a.flood, "/payday"), ("budget-sheet", a.flood, "")):
        if not rid: continue
        pg.goto(f"{a.base}/run/{rid}{sub}"); pg.wait_for_timeout(3000)
        pg.screenshot(path=f"{a.shots}/edge-{name}.png", full_page=True); print("shot", name)
    b.close()
