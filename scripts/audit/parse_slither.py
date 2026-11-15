import json
import os
import sys


def main():
    if len(sys.argv) < 2 or not str(sys.argv[1]).strip():
        print("[FAIL] Usage: python scripts/audit/parse_slither.py <slither_results.json>")
        sys.exit(1)
    report_path = os.path.abspath(sys.argv[1])
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
    high_findings = []
    for d in detectors:
        desc = d.get("description", "")
        elements = d.get("elements", [])
        is_our_contract = False
        for el in elements:
            src = el.get("source_mapping", {}).get("filename_relative", "")
            if src.startswith("contracts/") and not src.startswith("contracts/mocks/"):
                is_our_contract = True
                break
        if is_our_contract:
            finding = {
                "check": d.get("check"),
                "impact": d.get("impact"),
                "confidence": d.get("confidence"),
                "description": desc,
            }
            contract_findings.append(finding)
            if str(finding["impact"]).lower() == "high":
                high_findings.append(finding)

    print(f"\n--- Findings in contracts/ ({len(contract_findings)}) ---")
    for i, cf in enumerate(contract_findings[:14], 1):
        print(f"\n[{i}] [{str(cf['impact']).upper()}] Check: {cf['check']}")
        print(cf["description"].strip())

    if high_findings:
        print(f"\n[FAIL] Detected {len(high_findings)} HIGH-impact Slither finding(s) in production contracts/.")
        sys.exit(1)

    print("\n[PASS] Zero HIGH-impact Slither findings in production contracts/.")


if __name__ == "__main__":
    main()
