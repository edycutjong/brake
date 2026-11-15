#!/usr/bin/env python3
"""Interaction QA: every internal link answers, every external link resolves, and every interactive element CLASS gives
hover/focus feedback (screenshot byte-diff before/after). usage: python3 e2e/interaction_qa.py [--base http://localhost:3000]
Exit 1 on any dead link or element with no feedback."""
import argparse, glob, os, re, sys, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:3000")
a = ap.parse_args()
fails = []
def res(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg, flush=True)
    if not ok: fails.append(msg)

def status(url, method="GET"):
    try:
        req = urllib.request.Request(url, method=method, headers={"user-agent": "interaction-qa"})
        return urllib.request.urlopen(req, timeout=20).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0

exe = os.environ.get("CHROMIUM") or next(iter(sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))[::-1]), None)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    page = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
    page.goto(a.base)
    page.get_by_role("button", name="Start a demo run").click()
    page.wait_for_url("**/run/**", timeout=60000)
    run = page.url.replace(a.base, "")
    page.get_by_text("Monday — the agent reviews").wait_for()
    pages = ["/", run, run + "/agent", run + "/payday", "/verify"]
    hrefs = set()
    for u in pages:
        page.goto(a.base + u); page.wait_for_timeout(2500)
        for h in page.eval_on_selector_all("a[href]", "els => els.map(e => e.getAttribute('href'))"):
            hrefs.add(h)
        # ---- feedback audit on this page
        sels = {"nav link": ".nav a:not([aria-current])", "primary button": ".btn:not(.ghost):not(.danger):not(:disabled)", "ghost button": ".btn.ghost:not(:disabled)",
                "danger button": ".btn.danger:not(:disabled)", "text link": "p a, .lede a, dd a, td a"}
        for name, sel in sels.items():
            el = page.locator(sel).first
            if el.count() == 0: continue
            el.scroll_into_view_if_needed(); page.mouse.move(0, 0); page.wait_for_timeout(500)
            before = el.screenshot(); el.hover(); page.wait_for_timeout(450); after = el.screenshot()
            res(before != after, f"hover feedback  {u[:24]:24} {name}")
        for name, sel in {"input": "input.data, input:not([type=checkbox])", "textarea": "textarea", "select": "select"}.items():
            el = page.locator(sel).first
            if el.count() == 0: continue
            el.scroll_into_view_if_needed(); page.mouse.move(0, 0); page.wait_for_timeout(300)
            before = page.screenshot(clip=el.bounding_box() and {"x": el.bounding_box()["x"] - 6, "y": el.bounding_box()["y"] - 6, "width": el.bounding_box()["width"] + 12, "height": el.bounding_box()["height"] + 12})
            page.keyboard.press("Tab"); el.focus(); page.wait_for_timeout(300)
            after = page.screenshot(clip={"x": el.bounding_box()["x"] - 6, "y": el.bounding_box()["y"] - 6, "width": el.bounding_box()["width"] + 12, "height": el.bounding_box()["height"] + 12})
            res(before != after, f"focus feedback  {u[:24]:24} {name}")
    # ---- links
    for h in sorted(hrefs):
        if h.startswith("#"):
            res(page.locator(h).count() > 0 if re.match(r"^#[\w-]+$", h) else True, f"anchor {h}")
        elif h.startswith("/"):
            s = status(a.base + h); res(s in (200, 307), f"link {h[:60]} -> {s}")
        elif h.startswith("http"):
            s = status(h, "HEAD") or status(h); res(s in range(200, 400), f"external {h[:60]} -> {s}")
    # explorer links appear only on the live deployment; assert none are 'javascript:' or '#' placeholders
    res(not any(h in ("#", "") or h.startswith("javascript:") for h in hrefs), "no placeholder hrefs")
    b.close()
print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
