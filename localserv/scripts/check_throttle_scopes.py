#!/usr/bin/env python
"""
Fails if any throttle scope used in apps/ has no rate in REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].
(A missing rate makes ScopedRateThrottle raise -> HTTP 500 on that endpoint.)

Run from the project root:
    python scripts/check_throttle_scopes.py                    # checks config.settings.prod
    python scripts/check_throttle_scopes.py config.settings.dev
Needs the same env vars as the settings module (DJANGO_SECRET_KEY, DATABASE_URL, ...).
"""
import importlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

module = sys.argv[1] if len(sys.argv) > 1 else "config.settings.prod"
rates = set(importlib.import_module(module).REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"])

# throttle_scope = "x"  |  scope = "x"  |  throttle_scope="x"  |  @throttle_scope("x") style kwargs
PATTERN = re.compile(r"""\b(?:throttle_)?scope\s*=\s*["']([\w\-]+)["']""")
used = {}
for path in (ROOT / "apps").rglob("*.py"):
    if "migrations" in path.parts or path.name.startswith("test"):
        continue
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        for m in PATTERN.finditer(line):
            used.setdefault(m.group(1), []).append(f"{path.relative_to(ROOT)}:{lineno}")

missing = {s: where for s, where in used.items() if s not in rates}
# anon/user are provided by DRF's Anon/UserRateThrottle, not scopes in code
unused = sorted(rates - set(used) - {"anon", "user"})

print(f"settings: {module} | scopes in code: {len(used)} | rates configured: {len(rates)}")
if unused:
    print("rates with no scope found in code (fine if set elsewhere):", ", ".join(unused))
if missing:
    print("\nMISSING RATES -- these endpoints will error:")
    for s, where in sorted(missing.items()):
        print(f"  {s!r:28} {', '.join(where[:3])}")
    sys.exit(1)
print("OK: every scope used in code has a rate.")
