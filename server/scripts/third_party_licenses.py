"""
The licences of every Python distribution installed in this environment, with their full texts, for
the notices that travel with the server image (server/Dockerfile writes them to
/app/THIRD_PARTY_LICENSES-python.txt). Then licenses/extra-notices.txt: what the packages carry
without a licence file of their own, and the image's operating system. Standard library only.

    python scripts/third_party_licenses.py > THIRD_PARTY_LICENSES-python.txt
"""

from __future__ import annotations

import importlib.metadata as md
import re
import sys
from pathlib import Path

LICENCE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice|authors)[^/]*$", re.I)
EXTRA_NOTICES = Path(__file__).resolve().parent.parent / "licenses" / "extra-notices.txt"


def licence_of(dist: md.Distribution) -> str:
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression
    classifiers = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
    field = (meta.get("License") or "").strip()
    parts = [field] if field and len(field) < 120 and "\n" not in field else []
    parts += [c for c in classifiers if c not in parts]
    return "; ".join(dict.fromkeys(parts)) or "see the licence text below"


def main() -> None:
    dists = sorted(md.distributions(), key=lambda d: (d.metadata["Name"] or "").lower())
    out = sys.stdout
    out.write("Third-party Python software in this image, with its licences.\n")
    out.write("The project's own code is under the GNU AGPL-3.0-only (LICENSE).\n\n")
    extra = EXTRA_NOTICES.read_text(encoding="utf-8")
    seen: set[str] = set()
    for dist in dists:
        name = dist.metadata["Name"] or "?"
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        out.write("=" * 78 + "\n")
        out.write(f"{name} {dist.version}\nLicence: {licence_of(dist)}\n")
        project_urls = dist.metadata.get_all("Project-URL") or []
        urls = [u.split(", ", 1)[-1] for u in project_urls if "source" in u.lower() or "home" in u.lower()]
        home = dist.metadata.get("Home-page") or next(iter(urls), "")
        if home:
            out.write(f"Source: {home}\n")
        # The distribution's own licence files, and those of what it vendors (e.g. the admin's scripts).
        found = False
        for file in sorted(dist.files or [], key=str):
            if not LICENCE_FILE.search(str(file)) or str(file).endswith((".py", ".pyc", ".pyi")):
                continue
            try:
                text = file.locate().read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            found = True
            out.write(f"\n--- {file} ---\n{text.rstrip()}\n")
        if not found:
            out.write("\n(the distribution ships no licence file; see the notices at the end)\n")
            if name not in extra:
                print(f"warning: {name} ships no licence file; add its notice to {EXTRA_NOTICES.name}", file=sys.stderr)
        out.write("\n")
    out.write("=" * 78 + "\n")
    out.write(extra)


if __name__ == "__main__":
    main()
