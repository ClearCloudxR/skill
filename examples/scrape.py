r"""Scrape / screenshot a JS-rendered page. Template - copy and adapt.

Usage:
    $py examples/scrape.py <url> [--text SELECTOR] [--shot OUT.png] [--headful]

Locating the right python on this machine (playwright lives in the bundled one):
    $py = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

(This docstring is raw: a plain docstring treats \U / \d in the path above as escapes.)
"""
import argparse
import sys

# Windows consoles default to GBK, which cannot encode the Arabic/Cyrillic/CJK text
# that real pages contain (crashes with UnicodeEncodeError mid-scrape).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser(description="Load a page with a real browser and extract content.")
    ap.add_argument("url")
    ap.add_argument("--text", default="body", help="selector whose text to print (default: body)")
    ap.add_argument("--shot", help="write a full-page screenshot to this path")
    ap.add_argument("--headful", action="store_true", help="show the browser window (debugging)")
    ap.add_argument("--timeout", type=int, default=60, help="navigation timeout in seconds")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headful)
        page = browser.new_page()
        try:
            page.goto(args.url, wait_until="domcontentloaded", timeout=args.timeout * 1000)

            # Wait for the target element rather than sleeping - JS-rendered content
            # is not there yet at domcontentloaded.
            page.wait_for_selector(args.text, timeout=args.timeout * 1000)

            print(f"title: {page.title()}")
            print(f"url:   {page.url}")
            print("---")
            print(page.locator(args.text).first.inner_text())

            if args.shot:
                page.screenshot(path=args.shot, full_page=True)
                print(f"---\nscreenshot: {args.shot}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - surface any browser error as exit 1
            print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        finally:
            browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
