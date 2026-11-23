#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Independent Evidence & Checksum Audit Script (Stream B — INV-17 / INV-18)
Verifies every cataloged evidence artifact listed in docs/evidence/README.md against
actual files on disk: existence, exact byte size, exact SHA-256 prefix match, valid PNG
headers, and zero synthetic plotting markers (Pillow/Matplotlib/etc.). Exits non-zero on
any missing artifact, size/hash mismatch, or integrity violation.
"""

import hashlib
import json
import os
import re
import struct
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVIDENCE_DIR = os.path.join(BASE_DIR, "docs", "evidence")
EVIDENCE_README = os.path.join(EVIDENCE_DIR, "README.md")


def verify_png_integrity(file_path: str) -> tuple[bool, list[str], tuple[int, int]]:
    with open(file_path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return False, ["Invalid PNG magic header"], (0, 0)

    idx = 8
    width, height = 0, 0
    metadata_bytes = bytearray()
    while idx + 8 <= len(data):
        length = struct.unpack(">I", data[idx : idx + 4])[0]
        ctype = data[idx + 4 : idx + 8].decode("latin-1", errors="ignore")
        cdata = data[idx + 8 : idx + 8 + length]
        if ctype == "IHDR" and len(cdata) >= 10:
            width, height = struct.unpack(">II", cdata[:8])
        elif ctype != "IDAT":
            metadata_bytes.extend(cdata)
        idx += 12 + length
        if ctype == "IEND":
            break

    meta_lower = bytes(metadata_bytes).lower()
    synthetic_markers = [b"pillow", b"matplotlib", b"canvas", b"cairo", b"agg", b"photoshop", b"gimp"]
    detected = [m.decode("ascii") for m in synthetic_markers if m in meta_lower]
    return (len(detected) == 0 and width > 0 and height > 0), detected, (width, height)


def parse_evidence_table_rows(readme_text: str) -> list[dict]:
    """Parse Markdown table rows with `[name](rel_path) | size B | `sha_prefix``."""
    row_re = re.compile(
        r"\|\s*(?:\d+\s*\|\s*)?\[`?([^`\]]+)`?\]\(([^)]+)\)\s*\|\s*([0-9,]+)\s*B\s*\|\s*`([0-9a-f]{8,64})`\s*\|",
        re.IGNORECASE,
    )
    entries = []
    for m in row_re.finditer(readme_text):
        label, rel_href, size_str, sha_prefix = m.groups()
        entries.append(
            {
                "label": label.strip(),
                "rel_href": rel_href.strip(),
                "expected_size": int(size_str.replace(",", "")),
                "expected_sha_prefix": sha_prefix.lower(),
            }
        )
    return entries


def main() -> int:
    print("=" * 80)
    print("GENOCHAIN STREAM-B EVIDENCE & CHECKSUM AUDIT (docs/evidence/README.md)")
    print("=" * 80)

    if not os.path.exists(EVIDENCE_README):
        print(f"[FAIL] Missing evidence catalog: {EVIDENCE_README}")
        return 1

    with open(EVIDENCE_README, "r", encoding="utf-8") as f:
        readme_text = f.read()

    entries = parse_evidence_table_rows(readme_text)
    if not entries:
        print("[FAIL] No cataloged checksum rows parsed from docs/evidence/README.md!")
        return 1

    failures: list[str] = []
    verified_count = 0

    for entry in entries:
        abs_path = os.path.normpath(os.path.join(EVIDENCE_DIR, entry["rel_href"]))
        rel_display = os.path.relpath(abs_path, BASE_DIR)
        if not os.path.isfile(abs_path):
            failures.append(f"MISSING artifact: {rel_display}")
            print(f"  [FAIL] {rel_display} -> FILE MISSING")
            continue

        actual_size = os.path.getsize(abs_path)
        with open(abs_path, "rb") as af:
            actual_sha = hashlib.sha256(af.read()).hexdigest()

        size_ok = actual_size == entry["expected_size"]
        sha_ok = actual_sha.startswith(entry["expected_sha_prefix"])
        png_ok = True
        png_note = ""
        if abs_path.lower().endswith(".png"):
            ok_png, markers, dims = verify_png_integrity(abs_path)
            png_ok = ok_png
            png_note = f" | PNG {dims[0]}x{dims[1]} markers={markers}"

        if size_ok and sha_ok and png_ok:
            verified_count += 1
            print(
                f"  [PASS] {rel_display} ({actual_size:,} B | sha256={actual_sha[:16]}...{png_note})"
            )
        else:
            msg = (
                f"{rel_display}: size_ok={size_ok} (actual={actual_size}, expected={entry['expected_size']}), "
                f"sha_ok={sha_ok} (actual={actual_sha[:16]}, expected={entry['expected_sha_prefix']}), png_ok={png_ok}"
            )
            failures.append(msg)
            print(f"  [FAIL] {msg}")

    # Also verify referenced machine-readable audit JSON reports exist and parse cleanly
    for rel_report in ("docs/reports/slither_latest.json", "docs/reports/ui_ux_axe_report.json"):
        abs_rep = os.path.join(BASE_DIR, rel_report)
        if not os.path.isfile(abs_rep):
            failures.append(f"MISSING report: {rel_report}")
            print(f"  [FAIL] {rel_report} -> MISSING")
            continue
        try:
            with open(abs_rep, "r", encoding="utf-8") as rf:
                data = json.load(rf)
            if rel_report.endswith("ui_ux_axe_report.json"):
                sc = int(data.get("scenarios_count", 0))
                bv = int(data.get("blocking_violations_total", -1))
                ov = int(data.get("overflow_failures_total", -1))
                if sc < 34 or bv != 0 or ov != 0:
                    failures.append(
                        f"{rel_report}: expected scenarios_count>=34, blocking=0, overflow=0 (got sc={sc}, bv={bv}, ov={ov})"
                    )
                    print(f"  [FAIL] {rel_report}: sc={sc}, blocking={bv}, overflow={ov}")
                else:
                    print(f"  [PASS] {rel_report}: scenarios={sc}, blocking={bv}, overflow={ov}")
            else:
                print(f"  [PASS] {rel_report}: valid JSON ({os.path.getsize(abs_rep):,} B)")
        except Exception as exc:
            failures.append(f"{rel_report}: invalid JSON ({exc})")
            print(f"  [FAIL] {rel_report}: invalid JSON ({exc})")

    print("-" * 80)
    print(f"Cataloged Evidence Verified: {verified_count}/{len(entries)} | Failures: {len(failures)}")
    if failures:
        for err in failures:
            print(f"  - {err}")
        return 1
    print("[PASS] 100% of cataloged evidence files & machine-readable reports verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
