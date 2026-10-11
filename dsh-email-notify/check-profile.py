"""Validate the profile layers for dsh-email-notify without booting DSH.

Parses the profile's cordis.patch.yml (which uses dsh's `!!js` tag) and the
plugin bundle patch, then prints the effective email-notify row.

    python check-profile.py
"""
from __future__ import annotations

import json
import os
import sys

import yaml

PROFILE = os.path.expandvars(r"%USERPROFILE%\.dsh\profiles\desktop")
PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)))

SECRET_KEYS = {"pass"}


class DshLoader(yaml.SafeLoader):
    """SafeLoader that understands dsh's `!!js` expression tag."""


def _js(loader: yaml.Loader, node: yaml.Node) -> str:
    return f"<js:{loader.construct_scalar(node)}>"


DshLoader.add_constructor("tag:yaml.org,2002:js", _js)
DshLoader.add_constructor("!js", _js)


def load(path: str):
    with open(path, encoding="utf-8") as handle:
        return yaml.load(handle, Loader=DshLoader)


def mask(config: dict) -> dict:
    masked = json.loads(json.dumps(config))
    smtp = masked.get("smtp")
    if isinstance(smtp, dict):
        for key in SECRET_KEYS:
            if smtp.get(key):
                smtp[key] = f"<{len(str(smtp[key]))} chars>"
    return masked


def main() -> int:
    problems: list[str] = []

    for name in ("package.json", "cordis.patch.yml", "index.js", "smtp.js"):
        if not os.path.exists(os.path.join(PLUGIN, name)):
            problems.append(f"missing plugin file: {name}")

    with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    patch_path = manifest.get("dsh", {}).get("bundle", {}).get("patch")
    if not patch_path:
        problems.append("package.json has no dsh.bundle.patch")
    bundle_patch = load(os.path.join(PLUGIN, patch_path.lstrip("./")))
    inserted = [
        row
        for entry in bundle_patch or []
        for row in entry.get("insert", []) or []
        if row.get("id") == "email-notify"
    ]
    if not inserted:
        problems.append("bundle patch does not insert the email-notify row")

    profile_patch = load(os.path.join(PROFILE, "cordis.patch.yml"))
    overrides = [row for row in profile_patch or [] if row.get("id") == "email-notify"]
    if not overrides:
        problems.append("profile cordis.patch.yml has no email-notify override")

    with open(os.path.join(PROFILE, "package.json"), encoding="utf-8") as handle:
        profile_manifest = json.load(handle)
    bundles = profile_manifest.get("dsh", {}).get("profile", {}).get("bundles", [])
    if "dsh-email-notify" not in bundles:
        problems.append("'dsh-email-notify' is not in dsh.profile.bundles")
    deps = profile_manifest.get("dependencies", {})
    if "dsh-email-notify" not in deps:
        problems.append("'dsh-email-notify' is not a profile dependency")
    link_target = str(deps.get("dsh-email-notify", ""))
    for scheme in ("link:", "file:"):
        if link_target.startswith(scheme):
            resolved = link_target[len(scheme):]
            if not os.path.isdir(resolved):
                problems.append(f"profile dependency points at a missing directory: {resolved}")

    config = overrides[-1].get("config", {}) if overrides else {}
    print("profile patches:", len(profile_patch or []))
    print("bundles:", bundles)
    print("dependency:", link_target)
    print("effective email-notify config:")
    print(json.dumps(mask(config), ensure_ascii=False, indent=2))

    smtp = config.get("smtp") or {}
    if not smtp.get("user"):
        print("\nNOTE: smtp.user is not filled in yet — the plugin stays idle until then.")
    if not smtp.get("pass") and not smtp.get("passEnv"):
        print("NOTE: smtp.pass (授权码) is not filled in yet — the plugin stays idle until then.")

    print()
    if problems:
        print("FAILED:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("profile wiring OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
