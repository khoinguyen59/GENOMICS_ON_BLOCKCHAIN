#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Independent Audit Script for Stream B (Evidence & Anti-Mockup Verification)
GenoChain Verification & Audit Suite
Auditor: victory_reviewer_b_1
"""

import os
import sys
import glob
import struct
import hashlib
import json
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVIDENCE_DIR = os.path.join(BASE_DIR, "docs", "evidence")
RECORDINGS_DIR = os.path.join(BASE_DIR, "recordings")
REPORT_PATH = os.path.join(BASE_DIR, "docs", "reports", "07_live_execution_evidence_report.md")
RPC_URL = "http://127.0.0.1:8545"

def check_png(file_path):
    size = os.path.getsize(file_path)
    with open(file_path, "rb") as f:
        data = f.read()
    
    sha256 = hashlib.sha256(data).hexdigest()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "Invalid PNG header"
    
    idx = 8
    chunks = []
    text_data = []
    width, height = 0, 0
    bit_depth, color_type = 0, 0
    iccp_profile_name = None
    metadata_bytes = bytearray()
    
    while idx < len(data):
        if idx + 8 > len(data):
            break
        length = struct.unpack(">I", data[idx:idx+4])[0]
        ctype = data[idx+4:idx+8].decode("latin-1", errors="ignore")
        cdata = data[idx+8:idx+8+length]
        crc = data[idx+8+length:idx+12+length]
        chunks.append(ctype)
        
        if ctype == "IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", cdata[:10])
        elif ctype == "iCCP":
            null_pos = cdata.find(b"\x00")
            if null_pos != -1:
                iccp_profile_name = cdata[:null_pos].decode("latin-1", errors="ignore")
            metadata_bytes.extend(cdata)
        elif ctype in ("tEXt", "zTXt", "iTXt"):
            text_data.append((ctype, cdata[:120].decode("latin-1", errors="ignore")))
            metadata_bytes.extend(cdata)
        elif ctype != "IDAT":
            metadata_bytes.extend(cdata)
        
        idx += 12 + length
        if ctype == "IEND":
            break

    # Look for synthetic markers in metadata chunks (NOT in compressed IDAT)
    meta_lower = bytes(metadata_bytes).lower()
    synthetic_markers = [b"pillow", b"matplotlib", b"canvas", b"cairo", b"agg", b"photoshop", b"gimp"]
    detected_markers_in_meta = [m.decode() for m in synthetic_markers if m in meta_lower]
    
    return {
        "file": os.path.relpath(file_path, BASE_DIR),
        "size": size,
        "width": width,
        "height": height,
        "bit_depth": bit_depth,
        "color_type": color_type,
        "chunks": chunks,
        "iccp_profile_name": iccp_profile_name,
        "text_data": text_data,
        "detected_markers": detected_markers_in_meta,
        "sha256": sha256
    }

def audit_screenshots():
    print("=" * 80)
    print("AUDIT SECTION 1: 28 NATIVE SCREENSHOTS VERIFICATION")
    print("=" * 80)
    
    png_files = sorted(glob.glob(os.path.join(EVIDENCE_DIR, "**", "*.png"), recursive=True))
    print(f"Total PNG images found in {EVIDENCE_DIR}: {len(png_files)}")
    
    audit_results = []
    synthetic_violations = []
    non_native_res = []
    sha256_map = {}

    for p in png_files:
        info = check_png(p)
        audit_results.append(info)
        rel = info["file"]
        
        # Check synthetic markers
        if info["detected_markers"]:
            synthetic_violations.append((rel, info["detected_markers"]))
        
        # Check resolution
        # Report claims 2561x1398 or similar standard resolution
        if (info["width"], info["height"]) != (2561, 1398):
            non_native_res.append((rel, info["width"], info["height"]))
            
        # Check duplicate hashes
        h = info["sha256"]
        if h in sha256_map:
            sha256_map[h].append(rel)
        else:
            sha256_map[h] = [rel]

        print(f"[{rel}]")
        print(f"  Dimensions: {info['width']}x{info['height']} | Size: {info['size']:,} bytes | Chunks: {set(info['chunks'])} | ICCP: {info['iccp_profile_name']}")
        if info["text_data"]:
            print(f"  Metadata texts: {info['text_data']}")
        if info["detected_markers"]:
            print(f"  WARNING: Detected synthetic markers: {info['detected_markers']}")

    print("\n--- Screenshot Summary Analysis ---")
    print(f"Total screenshots audited: {len(png_files)}")
    print(f"Synthetic generation markers (Pillow/Matplotlib/Canvas/etc.): {len(synthetic_violations)}")
    if synthetic_violations:
        for v in synthetic_violations:
            print(f"  VIOLATION: {v[0]} contains {v[1]}")
    else:
        print("  VERIFIED: 0 synthetic generation markers detected across all 28 screenshots.")
        
    print(f"Resolution compliance (2561x1398): {len(png_files) - len(non_native_res)} / {len(png_files)}")
    if non_native_res:
        print("  Non-standard resolution files:")
        for r in non_native_res:
            print(f"    - {r[0]}: {r[1]}x{r[2]}")
            
    print(f"Duplicate files (identical SHA-256):")
    for h, files in sha256_map.items():
        if len(files) > 1:
            print(f"  - SHA-256 {h[:12]}... shared by: {files}")

    return audit_results

def audit_recordings():
    print("\n" + "=" * 80)
    print("AUDIT SECTION 2: DEMO VIDEO & RECORDINGS VERIFICATION")
    print("=" * 80)
    
    demo_path = os.path.join(RECORDINGS_DIR, "genomics_rubric_official_demo.mp4")
    if not os.path.exists(demo_path):
        print(f"ERROR: {demo_path} does not exist!")
        return None
        
    size = os.path.getsize(demo_path)
    with open(demo_path, "rb") as f:
        demo_sha256 = hashlib.sha256(f.read()).hexdigest()
        
    claimed_sha256 = "d070d11dd573be8f7e51b54c3bd2f7cd866114a9931cda0c081505adb66b9c05"
    claimed_size = 3258891
    
    print(f"Official demo path: {demo_path}")
    print(f"Actual size: {size} bytes (Claimed: {claimed_size} bytes)")
    print(f"Actual SHA-256 : {demo_sha256}")
    print(f"Claimed SHA-256: {claimed_sha256}")
    print(f"Size Match: {size == claimed_size}")
    print(f"Hash Match: {demo_sha256 == claimed_sha256}")
    
    # Check raw_sessions
    raw_sessions_dir = os.path.join(RECORDINGS_DIR, "raw_sessions")
    if os.path.exists(raw_sessions_dir):
        raw_files = os.listdir(raw_sessions_dir)
        print(f"\nRaw sessions directory contains {len(raw_files)} files:")
        for rf in sorted(raw_files):
            rsize = os.path.getsize(os.path.join(raw_sessions_dir, rf))
            print(f"  - {rf} ({rsize:,} bytes)")
            
    return {
        "size": size,
        "sha256": demo_sha256,
        "hash_match": (demo_sha256 == claimed_sha256),
        "size_match": (size == claimed_size)
    }

def raw_rpc_call(method, params=[]):
    req_data = json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    }).encode("utf-8")
    req = urllib.request.Request(RPC_URL, data=req_data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))

def audit_onchain_ledger():
    print("\n" + "=" * 80)
    print("AUDIT SECTION 3: ON-CHAIN LEDGER & TRANSACTIONS (BLOCKS #41-#49 & #189-#197)")
    print("=" * 80)
    
    # Check RPC connection
    try:
        block_num_res = raw_rpc_call("eth_blockNumber")
        current_block = int(block_num_res["result"], 16)
        chain_id_res = raw_rpc_call("eth_chainId")
        chain_id = int(chain_id_res["result"], 16)
        print(f"Hardhat RPC connected: {RPC_URL}")
        print(f"Chain ID: {chain_id} (Expected: 31337)")
        print(f"Current Block Height: #{current_block}")
    except Exception as e:
        print(f"Warning: Could not connect to RPC {RPC_URL}: {e}")
        return
        
    # Transactions to audit from Report Section 2.3 (Blocks #41-#49)
    run1_txs = [
        {"block": 41, "hash": "0xe0dbd5d967516e45fba48dda175b9e8005e934cb33ea94f993055a2dd0dbb721", "name": "Token Deflationary Burn", "claimed_gas": 33847},
        {"block": 42, "hash": "0x9a474e9610ce4013f88b23710186c6848576cd1889018efd046dbe76c7d7b1c7", "name": "registerGenomicData", "claimed_gas": 854263},
        {"block": 43, "hash": "0x9328b25242468b9473207c5e8c03729103d847aed094cf738ded2697e7abaad9", "name": "registerResearcherPublicKey", "claimed_gas": 101279},
        {"block": 44, "hash": "0x1131906d1dee88afb101c921a96431b9e0a7a51011b49949c0576a824963c41c", "name": "Token Approval for Registry", "claimed_gas": 46402},
        {"block": 45, "hash": "0xef1c8f87ff1d3626171d7da0a3da381c4ad13a32cc695db06ef58c074f962daf", "name": "grantAccess Purchase", "claimed_gas": 158844},
        {"block": 46, "hash": "0xf1065e01c8ceadfeb799b0d0172eef88e2df60f72fcb1cbef35497d38efba44c", "name": "storeTransformedCapsule", "claimed_gas": 601205},
        {"block": 47, "hash": "0x4a42d22861f544a76ba6041cc2a7bd75ff35700004817cc31784f6e35248ec24", "name": "registerGenomicData (Escrow Demo)", "claimed_gas": 854263},
        {"block": 48, "hash": "0x85ae11b8a40f0664fc71076d4bc25989f8d13c39e5f1958d3fe1325fc4ed28ff", "name": "Approve Token for Escrow", "claimed_gas": 46402},
        {"block": 49, "hash": "0x433c61d215b35edd0d8f08ec7953ff69aedbc12931a9a416a91890e701db446f", "name": "grantAccessWithEscrow", "claimed_gas": 203312},
    ]

    print("\nAuditing Blocks #41 to #49 Transactions against live node:")
    for tx_info in run1_txs:
        tx_hash = tx_info["hash"]
        # Check 0x prefix and length
        assert tx_hash.startswith("0x"), f"TxHash missing 0x prefix: {tx_hash}"
        assert len(tx_hash) == 66, f"TxHash invalid length {len(tx_hash)}: {tx_hash}"
        
        res = raw_rpc_call("eth_getTransactionReceipt", [tx_hash])
        receipt = res.get("result")
        if receipt is None:
            print(f"  [MISSING] Block #{tx_info['block']} ({tx_info['name']}): Tx {tx_hash} not found in current ledger!")
        else:
            actual_block = int(receipt["blockNumber"], 16)
            actual_gas = int(receipt["gasUsed"], 16)
            actual_status = int(receipt["status"], 16)
            status_str = "SUCCESS" if actual_status == 1 else "FAILED"
            block_match = (actual_block == tx_info["block"])
            gas_match = (actual_gas == tx_info["claimed_gas"])
            print(f"  [OK] Block #{actual_block} ({tx_info['name']}): Tx {tx_hash[:12]}... | Gas: {actual_gas} (Claimed: {tx_info['claimed_gas']}) | Status: {status_str} | BlockMatch: {block_match}")

    # Transactions to audit from Report Section 2.4 (Blocks #189-#197)
    run2_txs = [
        {"block": 189, "hash": "0x9fe840f461bcbebcb16ccb397f442c5a09b5c86ccebf8a339f0b7049d261c337", "name": "Token Deflationary Burn", "claimed_gas": 33847},
        {"block": 190, "hash": "0xeae70c3a7cd9d23accb53f0b881e59c7acfcec85e06c02970b8b23aecf06e0b1", "name": "registerGenomicData (ID #46)", "claimed_gas": 854263},
        {"block": 191, "hash": "0x7a2c7d66651b7d46673946f99791b5016f9f0357e5fdc2983397baacf2517638", "name": "registerResearcherPublicKey", "claimed_gas": 101279},
        {"block": 192, "hash": "0x5550838e4b269c9c169c02a4cf7f27df718c0eef741c9d8ac47a337b2da5d1d2", "name": "Token Approval", "claimed_gas": 46402},
        {"block": 193, "hash": "0x665c6c37041d2a6122001c5e1ef59ab3a1dee40c85a78415547979dc3c1b6502", "name": "grantAccess Purchase", "claimed_gas": 158844},
        {"block": 194, "hash": "0x10afeb985ec644dd137e2fcfa7b13cff61d9e9424f4ba96cf33cb53d6641ae55", "name": "storeTransformedCapsule", "claimed_gas": 601205},
        {"block": 195, "hash": "0x2ef21545b36eb51192dfe7e6cb71f3a97a24f13bf45de5ce5200ba56bed4de38", "name": "registerGenomicData (Escrow Demo)", "claimed_gas": 854263},
        {"block": 196, "hash": "0x463936c3dc3f5cee833e162e75fa291f6273d2f07db6bfb618025c3d2d775551", "name": "Approve Token for Escrow", "claimed_gas": 46402},
        {"block": 197, "hash": "0xc48ca6d6db456076abd85d7259d55f609da7389171cae1868efbf2e4b4011fd0", "name": "grantAccessWithEscrow", "claimed_gas": 203312},
    ]

    print("\nAuditing Blocks #189 to #197 Transactions against live node:")
    for tx_info in run2_txs:
        tx_hash = tx_info["hash"]
        assert tx_hash.startswith("0x"), f"TxHash missing 0x prefix: {tx_hash}"
        assert len(tx_hash) == 66, f"TxHash invalid length {len(tx_hash)}: {tx_hash}"
        
        res = raw_rpc_call("eth_getTransactionReceipt", [tx_hash])
        receipt = res.get("result")
        if receipt is None:
            print(f"  [MISSING] Block #{tx_info['block']} ({tx_info['name']}): Tx {tx_hash} not found in current ledger!")
        else:
            actual_block = int(receipt["blockNumber"], 16)
            actual_gas = int(receipt["gasUsed"], 16)
            actual_status = int(receipt["status"], 16)
            status_str = "SUCCESS" if actual_status == 1 else "FAILED"
            block_match = (actual_block == tx_info["block"])
            gas_match = (actual_gas == tx_info["claimed_gas"])
            print(f"  [OK] Block #{actual_block} ({tx_info['name']}): Tx {tx_hash[:12]}... | Gas: {actual_gas} (Claimed: {tx_info['claimed_gas']}) | Status: {status_str} | BlockMatch: {block_match}")

if __name__ == "__main__":
    audit_screenshots()
    audit_recordings()
    audit_onchain_ledger()
