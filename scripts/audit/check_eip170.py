import glob
import json
import os
import sys

EIP170_RUNTIME_LIMIT = 24576
EIP3860_INITCODE_LIMIT = 49152

REQUIRED_PRODUCTION_CONTRACTS = {
    "GenomicNFT",
    "GenomicTimelock",
    "GenomicToken",
    "GenomicZkVerifier",
    "GenomicsEscrowEngine",
    "GenomicsMetadataStore",
    "GenomicsRegistry",
}


def main() -> int:
    print("=== EIP-170 (RUNTIME) & EIP-3860 (INITCODE) CONTRACT BYTECODE SIZE AUDIT ===")
    artifacts = sorted(glob.glob("artifacts/contracts/**/*.json", recursive=True))
    found_production = set()
    failures = []

    for artifact_path in artifacts:
        norm_path = artifact_path.replace("\\", "/")
        if norm_path.endswith(".dbg.json"):
            continue
        if "/mocks/" in norm_path or "/interfaces/" in norm_path:
            continue

        with open(artifact_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        deployed_hex = data.get("deployedBytecode", "")
        init_hex = data.get("bytecode", "")
        deployed_size = (len(deployed_hex) - 2) // 2 if deployed_hex.startswith("0x") and len(deployed_hex) > 2 else 0
        init_size = (len(init_hex) - 2) // 2 if init_hex.startswith("0x") and len(init_hex) > 2 else 0

        # Skip abstract base contracts with zero bytecode
        if deployed_size == 0 and init_size == 0:
            continue

        contract_name = data.get("contractName") or os.path.basename(artifact_path).replace(".json", "")
        found_production.add(contract_name)

        rt_ok = deployed_size <= EIP170_RUNTIME_LIMIT
        init_ok = init_size <= EIP3860_INITCODE_LIMIT
        status = "PASS" if (rt_ok and init_ok) else "FAIL"
        if not (rt_ok and init_ok):
            failures.append(
                f"{contract_name}: runtime={deployed_size}/{EIP170_RUNTIME_LIMIT}, init={init_size}/{EIP3860_INITCODE_LIMIT}"
            )

        print(
            f"Contract: {contract_name:24} "
            f"Runtime: {deployed_size:5}/{EIP170_RUNTIME_LIMIT} B (margin {EIP170_RUNTIME_LIMIT - deployed_size:5} B) | "
            f"Init: {init_size:5}/{EIP3860_INITCODE_LIMIT} B (margin {EIP3860_INITCODE_LIMIT - init_size:5} B) | "
            f"[{status}]"
        )

    missing = sorted(REQUIRED_PRODUCTION_CONTRACTS - found_production)
    if missing:
        print(f"[FAIL] Missing required production contract artifacts: {', '.join(missing)}")
        return 1

    if failures:
        print("[FAIL] EIP-170 / EIP-3860 bytecode limit exceeded:")
        for item in failures:
            print(f"  - {item}")
        return 1

    print(
        f"[PASS] All {len(found_production)} production contracts satisfy EIP-170 (<= {EIP170_RUNTIME_LIMIT} B) "
        f"and EIP-3860 (<= {EIP3860_INITCODE_LIMIT} B)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
