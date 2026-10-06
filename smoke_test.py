"""Browser skill self-test.

Three checks that matter for real use:
  1. launch + navigate + title
  2. JS-rendered content (the reason to use a browser at all)
  3. full-page screenshot
Exit 0 = all passed.
"""
import sys
from playwright.sync_api import sync_playwright

DATA_URL = "data:text/html,<h1 id=t>hello</h1><script>document.title='JS-OK'</script>"
ok = True

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page()

    # 1. real network navigation
    page.goto("https://example.com", wait_until="domcontentloaded", timeout=60000)
    print("1. title:", page.title())
    ok &= "Example" in page.title()

    # 2. JS execution / DOM mutation
    page.goto(DATA_URL)
    page.wait_for_selector("#t")
    print("2. js title:", page.title(), "| h1:", page.locator("#t").inner_text())
    ok &= page.title() == "JS-OK"

    # 3. screenshot
    page.goto("https://example.com", wait_until="domcontentloaded", timeout=60000)
    page.screenshot(path="smoke.png", full_page=True)
    print("3. screenshot written: smoke.png")
    b.close()

print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
