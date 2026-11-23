import json
import os
import sys


def sync() -> int:
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    contracts = [
        ("GenomicToken", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicTokenABI.json")),
        ("GenomicNFT", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicNFTABI.json")),
        ("GenomicsRegistry", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicsRegistryABI.json")),
        ("GenomicZkVerifier", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicZkVerifierABI.json")),
        ("GenomicTimelock", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicTimelockABI.json")),
    ]
    missing = []
    for cname, dest in contracts:
        art_path = os.path.join(base_dir, "artifacts", "contracts", f"{cname}.sol", f"{cname}.json")
        if not os.path.exists(art_path):
            print(f"[FAIL] Artifact not found: {art_path}")
            missing.append(cname)
            continue
        with open(art_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        abi = data.get("abi", [])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(abi, f, indent=2)
            f.write("\n")
        print(f"[OK] Synced {cname} ABI ({len(abi)} entries) -> {dest}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(sync())
