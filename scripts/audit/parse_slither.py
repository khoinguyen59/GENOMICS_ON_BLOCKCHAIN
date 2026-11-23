import json
import os
import shutil
import subprocess
import sys
import tempfile


def parse_report_file(report_path: str) -> None:
    if not os.path.exists(report_path):
        print(f"[FAIL] Slither JSON report not found: {report_path}")
        sys.exit(1)
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[FAIL] Cannot open Slither JSON report {report_path}: {e}")
        sys.exit(1)

    if not data.get("success", False):
        print(f"[FAIL] Slither execution reported success=false in {report_path}: {data.get('error')}")
        sys.exit(1)

    detectors = data.get("results", {}).get("detectors", [])
    print(f"Report loaded from: {report_path}")
    print(f"Total raw detectors triggered: {len(detectors)}")

    contract_findings = []
    blocking_findings = []
    for d in detectors:
        desc = d.get("description", "")
        elements = d.get("elements", [])
        is_our_contract = False
        for el in elements:
            src = str(el.get("source_mapping", {}).get("filename_relative", "")).replace("\\", "/")
            if src.startswith("contracts/") and not src.startswith("contracts/mocks/"):
                is_our_contract = True
                break
        if is_our_contract:
            impact = str(d.get("impact", "")).strip()
            finding = {
                "check": d.get("check"),
                "impact": impact,
                "confidence": d.get("confidence"),
                "description": desc,
            }
            contract_findings.append(finding)
            if impact.lower() in ("high", "medium"):
                blocking_findings.append(finding)

    print(f"\n--- Findings in contracts/ ({len(contract_findings)}) ---")
    for i, cf in enumerate(contract_findings, 1):
        print(f"\n[{i}] [{str(cf['impact']).upper()}] Check: {cf['check']} (Confidence: {cf['confidence']})")
        print(cf["description"].strip())

    if blocking_findings:
        print(
            f"\n[FAIL] Detected {len(blocking_findings)} HIGH/MEDIUM-impact Slither finding(s) in production contracts/."
        )
        sys.exit(1)

    print("\n[PASS] Zero HIGH or MEDIUM-impact Slither findings in production contracts/.")


def main():
    if len(sys.argv) >= 2 and str(sys.argv[1]).strip() and str(sys.argv[1]).strip() != "--run":
        parse_report_file(os.path.abspath(sys.argv[1]))
        return

    slither_bin = shutil.which("slither")
    if not slither_bin:
        print("[FAIL] 'slither' executable not found on PATH. Install slither-analyzer or pass an existing JSON report.")
        sys.exit(1)

    with tempfile.TemporaryDirectory(prefix="genochain_slither_") as tmpdir:
        tmp_json = os.path.join(tmpdir, "slither_report.json")
        cmd = [slither_bin, ".", "--exclude-dependencies", "--json", tmp_json]
        print(f"[*] Running Slither static analysis -> temporary report ({os.path.basename(tmp_json)})...")
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if not os.path.exists(tmp_json):
            if proc.stdout:
                print(proc.stdout)
            if proc.stderr:
                print(proc.stderr, file=sys.stderr)
            print(f"[FAIL] Slither failed to emit JSON report (exit={proc.returncode}).")
            sys.exit(1)
        parse_report_file(tmp_json)


if __name__ == "__main__":
    main()