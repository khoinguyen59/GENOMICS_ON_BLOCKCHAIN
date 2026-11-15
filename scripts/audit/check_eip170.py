import json
import glob
import os

print("=== EIP-170 CONTRACT BYTECODE SIZE AUDIT ===")
limit = 24576
artifacts = glob.glob("artifacts/contracts/*/*.json")
for a in sorted(artifacts):
    if a.endswith(".dbg.json") or "mocks" in a:
        continue
    with open(a, "r", encoding="utf-8") as f:
        data = json.load(f)
    deployed_hex = data.get("deployedBytecode", "")
    init_hex = data.get("bytecode", "")
    deployed_size = (len(deployed_hex) - 2) // 2 if deployed_hex.startswith("0x") else 0
    init_size = (len(init_hex) - 2) // 2 if init_hex.startswith("0x") else 0
    contract_name = os.path.basename(a).replace(".json", "")
    status = "PASS (< 24,576)" if deployed_size <= limit else "FAIL (> 24,576)"
    print(f"Contract: {contract_name:20} Deployed: {deployed_size:5} bytes | Init: {init_size:5} bytes | Margin: {limit - deployed_size:5} bytes | [{status}]")
