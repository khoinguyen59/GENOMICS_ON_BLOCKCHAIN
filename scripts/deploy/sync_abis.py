import json
import os

def sync():
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    contracts = [
        ("GenomicToken", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicTokenABI.json")),
        ("GenomicNFT", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicNFTABI.json")),
        ("GenomicsRegistry", os.path.join(base_dir, "frontend", "src", "contracts", "GenomicsRegistryABI.json"))
    ]
    for cname, dest in contracts:
        art_path = os.path.join(base_dir, "artifacts", "contracts", f"{cname}.sol", f"{cname}.json")
        if not os.path.exists(art_path):
            print(f"Artifact not found: {art_path}")
            continue
        with open(art_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        abi = data.get('abi', [])
        with open(dest, 'w', encoding='utf-8') as f:
            json.dump(abi, f, indent=2)
        print(f"Synced {cname} ABI ({len(abi)} entries) -> {dest}")

if __name__ == '__main__':
    sync()
