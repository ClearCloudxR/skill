"""Verify Playwright loads its browser from E:, with NO help from the shell.

Real-world condition: DSH / MCP spawn Python as a child process and may not
have the user-level PLAYWRIGHT_BROWSERS_PATH in their environment. The .pth in
site-packages is what makes this work, so this script must NOT set the variable
itself - it only reports what it found and proves the browser actually launches.
"""
import os

env = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
print("PLAYWRIGHT_BROWSERS_PATH:", env)

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    exe = p.chromium.executable_path
    print("chromium exe:", exe)

    b = p.chromium.launch(headless=True)
    pg = b.new_page()
    pg.goto("data:text/html,<h1 id=t>ok</h1>")
    pg.wait_for_selector("#t")
    print("render:", pg.locator("#t").inner_text())
    b.close()

on_e = exe.lower().startswith("e:")
print("RESULT:", "PASS" if on_e else "FAIL (browser is not on E:)")
raise SystemExit(0 if on_e else 1)
