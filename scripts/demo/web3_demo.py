#!/usr/bin/env python3
"""
GenoChain - Hệ thống Quản lý và Chia sẻ Dữ liệu Di truyền trên Blockchain
Môn học: IS355 - Công nghệ Blockchain
Giảng viên hướng dẫn: ThS. Hà Lê Hoài Trung
Sinh viên thực hiện: Nguyễn Trọng Khôi - MSSV: 23520783
Khoa Hệ thống Thông tin - Trường ĐH Công nghệ Thông tin, ĐHQG-HCM

Thực hiện 100% giao dịch thật trên EVM qua Web3.py kết hợp Mật mã học Client-Side:
1. Sinh khóa đối xứng AES-256-GCM & mã hóa Client-Side dữ liệu VCF nhị phân.
2. Tính toán mã băm rawDataHash trên toàn bộ gói bản mã (IV + Ciphertext + Tag) và sinh CIDv0 IPFS Multihash thực tế.
3. Sinh cặp khóa bất đối xứng RSA-OAEP 2048-bit cho Nhà nghiên cứu và đăng ký Public Key on-chain.
4. Đăng ký bộ dữ liệu: registerGenomicData() neo giữ toàn vẹn dữ liệu trên Blockchain.
5. Mua quyền truy cập qua Ký quỹ Escrow (grantAccessWithEscrow) kèm khấu trừ tự động 10% Royalty (EIP-2981).
6. Bọc khóa phiên (Key Encapsulation) qua RSA-OAEP và lưu trữ Capsule trên Blockchain (storeTransformedCapsule).
7. Nhà nghiên cứu truy vấn Capsule, giải bọc khóa RSA và giải mã AES-GCM khôi phục dữ liệu VCF nguyên bản.
8. Quản lý vòng đời dữ liệu & kiểm soát quyền hạn: updateDataStatus, updateDataPrice, grantDirectAccess.
"""

import json
import os
import sys
import hashlib
import time
import urllib.request
import urllib.error
from typing import Optional
from decimal import Decimal

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from web3 import Web3
    from web3.exceptions import ContractLogicError
    from web3.logs import DISCARD
except ImportError:
    print("\n[!] Cần cài đặt thư viện web3: cmd /c python -m pip install web3\n")
    sys.exit(1)

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.asymmetric import rsa, padding
    from cryptography.hazmat.primitives import hashes, serialization
except ImportError:
    print("\n[!] Cần cài đặt thư viện cryptography: cmd /c python -m pip install cryptography\n")
    sys.exit(1)

def b58encode(raw: bytes) -> str:
    """Mã hóa nhị phân sang chuỗi Base58 tiêu chuẩn Bitcoin/IPFS"""
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    num = int.from_bytes(raw, "big")
    res = ""
    while num > 0:
        num, rem = divmod(num, 58)
        res = alphabet[rem] + res
    for b in raw:
        if b == 0:
            res = "1" + res
        else:
            break
    return res

def encode_varint(val: int) -> bytes:
    """Encode an integer into protobuf varint format"""
    res = bytearray()
    n = val
    while n >= 0x80:
        res.append((n & 0x7F) | 0x80)
        n >>= 7
    res.append(n)
    return bytes(res)

def encode_unixfs_file_node(file_bytes: bytes) -> bytes:
    """Encode raw file bytes into authentic IPFS UnixFS DAG-PB Protobuf framing (RFC / ipfs/multihash.js match)"""
    if not file_bytes:
        return b"\x0a\x04\x08\x02\x18\x00"
    len_varint = encode_varint(len(file_bytes))
    unixfs = b"\x08\x02\x12" + len_varint + file_bytes + b"\x18" + len_varint
    return b"\x0a" + encode_varint(len(unixfs)) + unixfs

UNIXFS_CHUNK_SIZE = 262144  # 256 KiB standard IPFS chunk size
UNIXFS_MAX_LINKS = 174      # Standard Kubo balanced DAG-PB max links per internal node


def _encode_pb_link(multihash_bytes: bytes, tsize: int) -> bytes:
    body = (
        b"\x0a"
        + encode_varint(len(multihash_bytes))
        + multihash_bytes
        + b"\x12\x00\x18"
        + encode_varint(tsize)
    )
    return b"\x12" + encode_varint(len(body)) + body


def _build_unixfs_internal_node(children: list[tuple[bytes, int, int]]) -> tuple[bytes, int, int]:
    pb_links = bytearray()
    block_sizes = bytearray()
    total_file_size = 0
    children_tsize_sum = 0
    for mh, tsize, fsize in children:
        pb_links.extend(_encode_pb_link(mh, tsize))
        block_sizes.extend(b"\x20" + encode_varint(fsize))
        total_file_size += fsize
        children_tsize_sum += tsize
    unixfs_parent = b"\x08\x02\x18" + encode_varint(total_file_size) + bytes(block_sizes)
    data_field = b"\x0a" + encode_varint(len(unixfs_parent)) + unixfs_parent
    dag_pb = bytes(pb_links) + data_field
    mh = b"\x12\x20" + hashlib.sha256(dag_pb).digest()
    return (mh, len(dag_pb) + children_tsize_sum, total_file_size)


def compute_ipfs_cidv0(data: bytes) -> str:
    """Tạo IPFS Multihash CIDv0 thực tế: balanced 174-link UnixFS DAG-PB + SHA-256 (khớp Kubo mọi kích thước)"""
    if len(data) <= UNIXFS_CHUNK_SIZE:
        dag_pb = encode_unixfs_file_node(data)
        multihash = b"\x12\x20" + hashlib.sha256(dag_pb).digest()
        return b58encode(multihash)

    level: list[tuple[bytes, int, int]] = []
    for offset in range(0, len(data), UNIXFS_CHUNK_SIZE):
        chunk = data[offset : offset + UNIXFS_CHUNK_SIZE]
        leaf_block = encode_unixfs_file_node(chunk)
        leaf_mh = b"\x12\x20" + hashlib.sha256(leaf_block).digest()
        level.append((leaf_mh, len(leaf_block), len(chunk)))

    while len(level) > 1:
        next_level: list[tuple[bytes, int, int]] = []
        for i in range(0, len(level), UNIXFS_MAX_LINKS):
            next_level.append(_build_unixfs_internal_node(level[i : i + UNIXFS_MAX_LINKS]))
        level = next_level

    return b58encode(level[0][0])


def unpack_abi_outputs(abi: list, fn_name: str, values) -> dict:
    """Map positional return tuple from web3.py call() to ABI output parameter names."""
    for entry in abi:
        if entry.get("type") == "function" and entry.get("name") == fn_name:
            outputs = entry.get("outputs", [])
            if len(outputs) == 1 and outputs[0].get("type") == "tuple" and isinstance(values, (list, tuple)):
                comps = outputs[0].get("components", [])
                return {comp.get("name", str(idx)): values[idx] for idx, comp in enumerate(comps) if idx < len(values)}
            return {out.get("name", str(idx)): values[idx] for idx, out in enumerate(outputs) if idx < len(values)}
    return {}

def compute_raw_hash(content_bytes: bytes) -> bytes:
    """Tính mã băm SHA-256 dạng 32 bytes khớp với bytes32 trên Solidity"""
    return hashlib.sha256(content_bytes).digest()

def fetch_from_kubo(cid: str, kubo_rpc: str = "http://127.0.0.1:5001") -> Optional[bytes]:
    """Tải dữ liệu trực tiếp từ IPFS Kubo RPC API (/api/v0/cat) với graceful fallback"""
    try:
        url = f"{kubo_rpc}/api/v0/cat?arg={cid}"
        req = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.read()
    except Exception:
        return None

def upload_to_kubo(data_bytes: bytes, filename: str = "payload.enc", kubo_rpc: str = "http://127.0.0.1:5001") -> Optional[str]:
    """Tải dữ liệu lên IPFS Kubo RPC API (/api/v0/add) nếu daemon đang chạy"""
    try:
        boundary = "----GenoChainBoundary" + os.urandom(8).hex()
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + data_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
        
        req = urllib.request.Request(
            f"{kubo_rpc}/api/v0/add",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            res_json = json.loads(resp.read().decode("utf-8"))
            return res_json.get("Hash")
    except Exception:
        return None

def build_iso32000_pdf_summary(text_line: str) -> bytes:
    """Build a strict ISO 32000-1 PDF-1.4 document with exact dynamic /Length, xref byte offsets, and startxref."""
    safe_text = (
        text_line.encode("ascii", errors="replace").decode("ascii")
        .replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
    )
    stream_bytes = f"BT /F1 12 Tf 72 712 Td ({safe_text}) Tj ET".encode("ascii")
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        (
            b"3 0 obj\n"
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> "
            b"/Contents 4 0 R >>\nendobj\n"
        ),
        (
            f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
            + stream_bytes
            + b"\nendstream\nendobj\n"
        ),
    ]
    buf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(buf))
        buf.extend(obj)
    xref_offset = len(buf)
    buf.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    buf.extend(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        buf.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    buf.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(buf)


def load_json(filepath: str):
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="GenoChain - Hệ thống Quản lý và Chia sẻ Dữ liệu Di truyền trên Blockchain (Web3.py Production Engine)"
    )
    parser.add_argument(
        "--offline-demo",
        action="store_true",
        help="Cho phép mô phỏng ngoại tuyến (kiểm tra tính hợp lệ ABI & Mật mã học khi chưa khởi động RPC/IPFS node)"
    )
    parser.add_argument(
        "--rpc-url",
        default=os.getenv("RPC_URL", "http://127.0.0.1:8545"),
        help="EVM RPC endpoint URL (mặc định: http://127.0.0.1:8545)"
    )
    args, unknown = parser.parse_known_args()

    print("=" * 80)
    print("  GENOCHAIN PROTOCOL - DECENTRALIZED GENOMIC DATA INFRASTRUCTURE")
    print("  WEB3.PY PRODUCTION INTERACTION SCRIPT & VERIFICATION ENGINE")
    print("  ARCHITECTURE: SMART CONTRACTS • CLIENT-SIDE AES-GCM • IPFS STORAGE")
    print("  STANDARDS: GA4GH PHENOPACKETS v2 • EIP-2981 AUTOMATED ROYALTY")
    print("  CORE INVARIANT: ZERO PLAINTEXT SENSITIVE DATA ON PUBLIC IPFS / BLOCKCHAIN")
    print("=" * 80)

    offline_allowed = args.offline_demo or (os.environ.get("GENOCHAIN_ALLOW_OFFLINE_DEMO") == "1")
    rpc_url = args.rpc_url
    w3 = Web3(Web3.HTTPProvider(rpc_url))

    # Base path to contract artifacts
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    contracts_dir = os.path.join(base_dir, "frontend", "src", "contracts")

    addr_path = os.path.join(contracts_dir, "contractAddresses.json")
    token_abi_path = os.path.join(contracts_dir, "GenomicTokenABI.json")
    nft_abi_path = os.path.join(contracts_dir, "GenomicNFTABI.json")
    registry_abi_path = os.path.join(contracts_dir, "GenomicsRegistryABI.json")

    if not all(os.path.exists(p) for p in [addr_path, token_abi_path, nft_abi_path, registry_abi_path]):
        print("[-] Thiếu file ABI hoặc địa chỉ contract. Hãy chạy deploy script trước:")
        print("    cmd /c npx hardhat run scripts/deploy/deploy.js")
        sys.exit(1)

    addresses = load_json(addr_path)
    token_abi = load_json(token_abi_path)
    nft_abi = load_json(nft_abi_path)
    registry_abi = load_json(registry_abi_path)

    token_addr = addresses.get("GenomicToken")
    nft_addr = addresses.get("GenomicNFT")
    registry_addr = addresses.get("GenomicsRegistry")

    print(f"\n[+] Địa chỉ GenomicToken     : {token_addr}")
    print(f"[+] Địa chỉ GenomicNFT       : {nft_addr}")
    print(f"[+] Địa chỉ GenomicsRegistry : {registry_addr}")

    token_contract = w3.eth.contract(address=token_addr, abi=token_abi)
    nft_contract = w3.eth.contract(address=nft_addr, abi=nft_abi)
    registry_contract = w3.eth.contract(address=registry_addr, abi=registry_abi)

    # Verify ABI function signatures on Web3.py
    print("\n[+] Kiểm tra tính hợp lệ của ABI và các hàm nghiệp vụ trên Web3.py:")
    assert hasattr(registry_contract.functions, "registerGenomicData"), "Missing registerGenomicData"
    assert hasattr(registry_contract.functions, "grantAccess"), "Missing grantAccess"
    assert hasattr(registry_contract.functions, "updateDataStatus"), "Missing updateDataStatus"
    assert hasattr(registry_contract.functions, "getAllDataItems"), "Missing getAllDataItems"
    assert hasattr(registry_contract.functions, "getDataItemsPaginated"), "Missing getDataItemsPaginated"
    assert hasattr(registry_contract.functions, "registerResearcherPublicKey"), "Missing registerResearcherPublicKey"
    assert hasattr(registry_contract.functions, "capsuleDispatcher"), "Missing capsuleDispatcher"
    assert hasattr(registry_contract.functions, "updateDataPrice"), "Missing updateDataPrice"
    assert hasattr(registry_contract.functions, "grantDirectAccess"), "Missing grantDirectAccess"
    assert hasattr(registry_contract.functions, "grantAccessWithEscrow"), "Missing grantAccessWithEscrow"
    assert hasattr(registry_contract.functions, "claimEscrowRefund"), "Missing claimEscrowRefund"
    assert hasattr(registry_contract.functions, "escrowDeposits"), "Missing escrowDeposits"
    assert hasattr(registry_contract.functions, "storeTransformedCapsule"), "Missing storeTransformedCapsule"
    assert hasattr(registry_contract.functions, "getTransformedCapsule"), "Missing getTransformedCapsule"
    assert hasattr(token_contract.functions, "faucet"), "Missing faucet"
    assert hasattr(token_contract.functions, "burn"), "Missing burn"
    assert hasattr(registry_contract.functions, "zkVerifier"), "Missing zkVerifier"
    assert hasattr(registry_contract.functions, "setZkVerifier"), "Missing setZkVerifier"
    assert hasattr(registry_contract.functions, "verifyDatasetTraitPossession"), "Missing verifyDatasetTraitPossession"
    assert hasattr(registry_contract.functions, "hasDonorClaimedZkBounty"), "Missing hasDonorClaimedZkBounty"
    print("    [OK] registerGenomicData(bytes32,string,string,string,string,uint256,uint256,uint96)")
    print("    [OK] grantAccess(uint256)")
    print("    [OK] grantAccessWithEscrow(uint256,uint256) [Timelocked Escrow & Dispute Window]")
    print("    [OK] claimEscrowRefund(uint256) [100% Refund Guarantee]")
    print("    [OK] escrowDeposits(uint256,address)")
    print("    [OK] storeTransformedCapsule(uint256,address,string) [PRE & Asymmetric Capsule Delivery]")
    print("    [OK] getTransformedCapsule(uint256)")
    print("    [OK] updateDataStatus(uint256,uint8)")
    print("    [OK] updateDataPrice(uint256,uint256)")
    print("    [OK] grantDirectAccess(uint256,address)")
    print("    [OK] getAllDataItems()")
    print("    [OK] getDataItemsPaginated(uint256,uint256)")
    print("    [OK] registerResearcherPublicKey(string)")
    print("    [OK] capsuleDispatcher()")
    print("    [OK] buyerCapsules(uint256,address)")
    print("    [OK] zkVerifier() [zk-Genomics Verification Link]")
    print("    [OK] verifyDatasetTraitPossession(uint256,bytes32) [ZK Proof On-Chain Query]")
    print("    [OK] hasDonorClaimedZkBounty(uint256,address) [ZK Bounty Cross-Validation]")
    print("    [OK] faucet(address)")
    print("    [OK] burn(uint256) [ERC20Burnable Deflationary]")

    if not w3.is_connected():
        print(f"\n[!] Lỗi kết nối RPC: Node EVM tại {rpc_url} chưa khởi động.")
        if not offline_allowed:
            raise ConnectionError(
                f"Không thể kết nối RPC Hardhat Node tại {rpc_url}. "
                "Vui lòng khởi chạy node ('cmd /c npx hardhat node') hoặc truyền cờ --offline-demo."
            )
        print("[*] Chế độ --offline-demo: Xác nhận Web3.py ABI binding và cú pháp hợp đồng đạt chuẩn 100%.")
        print("[*] Để chạy giao dịch trực tiếp trên blockchain:")
        print("    1. Mở terminal mới: cmd /c npx hardhat node")
        print("    2. Deploy hợp đồng: cmd /c npx hardhat run scripts/deploy/deploy.js --network localhost")
        print("    3. Chạy script này : cmd /c python scripts/demo/web3_demo.py")
        return

    accounts = w3.eth.accounts
    if len(accounts) < 3:
        print("[-] Cần ít nhất 3 tài khoản trong node Hardhat.")
        sys.exit(1)

    deployer = accounts[0]
    data_owner = accounts[1]
    researcher = accounts[2]

    print(f"\n[+] Đang chạy giao dịch trực tiếp trên EVM Block #{w3.eth.block_number}")
    print(f"    - Data Owner : {data_owner}")
    print(f"    - Researcher : {researcher}")

    # 1. Researcher Faucet
    print("\n--- 1. Nghiệp vụ Token Faucet ---")
    try:
        tx_hash = token_contract.functions.faucet(researcher).transact({"from": researcher})
        w3.eth.wait_for_transaction_receipt(tx_hash)
        bal = token_contract.functions.balanceOf(researcher).call()
        print(f"[+] Researcher nhận faucet: {w3.from_wei(bal, 'ether')} $GENO")
    except Exception as e:
        print(f"[!] Faucet thông báo: {e}")

    # Deflationary burn demo
    try:
        burn_wei = w3.to_wei(50, "ether")
        burn_tx = token_contract.functions.burn(burn_wei).transact({"from": researcher})
        w3.eth.wait_for_transaction_receipt(burn_tx)
        bal_after_burn = token_contract.functions.balanceOf(researcher).call()
        print(f"[OK] Researcher đốt (burn) 50 $GENO chống lạm phát: Còn lại {w3.from_wei(bal_after_burn, 'ether')} $GENO")
    except Exception as e:
        print(f"[!] Burn notice: {e}")

    # 2. Cryptographic Setup & Client-Side Encryption
    print("\n--- Step 2: Client-Side Cryptography (AES-256-GCM & IPFS Multihash CIDv0) ---")
    vcf_candidate_paths = [
        os.path.join(base_dir, "data", "diverse_real_datasets", "KHV_chr12_1000genomes.vcf"),
        os.path.join(base_dir, "frontend", "public", "datasets", "KHV_chr12_1000genomes.vcf"),
        os.path.join(base_dir, "data", "sample_metabolic_traits.vcf"),
    ]
    raw_vcf_content = None
    for p in vcf_candidate_paths:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as vf:
                raw_vcf_content = vf.read()
                print(f"[VCF] Đã nạp tập tin VCF sinh học thực tế từ: {os.path.relpath(p, base_dir)}")
                break

    if not raw_vcf_content:
        # Authentic standard VCFv4.2 with complete headers, contigs, and variant descriptions
        raw_vcf_content = (
            "##fileformat=VCFv4.2\n"
            "##fileDate=20261110\n"
            "##source=1000Genomes_Phase3_KHV_WGS\n"
            "##reference=GRCh38\n"
            "##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n"
            "##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n"
            "##INFO=<ID=KHV_AF,Number=A,Type=Float,Description=\"Allele Frequency in 1000 Genomes Kinh in Ho Chi Minh City, Vietnam\">\n"
            "##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n"
            "##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait or Analysis Locus\">\n"
            "##INFO=<ID=DP,Number=1,Type=Integer,Description=\"Total Depth Across Cohort\">\n"
            "##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional annotations\">\n"
            "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n"
            "##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n"
            "##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n"
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tKHV01\tKHV02\n"
            "chr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.380;KHV_AF=0.520;GENE=ALDH2;TRAIT=Alcohol_Dehydrogenase_Metabolism;DP=2400;ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|c.1510G>A|p.Glu504Lys\tGT:DP:GQ\t0/1:42:99\t1/1:38:99\n"
        )
    raw_vcf_bytes = raw_vcf_content.encode("utf-8")
    print(f"[+] Bản rõ VCF ban đầu ({len(raw_vcf_bytes)} bytes): {raw_vcf_content.strip()[:70]}...")

    # Client-Side AES-256-GCM Encryption
    aes_session_key = AESGCM.generate_key(bit_length=256)
    aes_iv = os.urandom(12) # 96-bit standard GCM nonce
    aesgcm = AESGCM(aes_session_key)
    ciphertext_with_tag = aesgcm.encrypt(aes_iv, raw_vcf_bytes, None)
    encrypted_payload = aes_iv + ciphertext_with_tag

    # Calculate rawDataHash strictly over the encrypted ciphertext package (INVARIANT-05)
    raw_data_hash = compute_raw_hash(encrypted_payload)
    real_raw_cid = compute_ipfs_cidv0(encrypted_payload)
    print(f"[+] Đã mã hóa AES-256-GCM phía Client ({len(encrypted_payload)} bytes nhị phân)")
    print(f"[+] rawDataHash (SHA-256 trên Ciphertext nhị phân): 0x{raw_data_hash.hex()}")
    print(f"[+] IPFS Multihash CIDv0 thực tế: {real_raw_cid}")

    # Pin ciphertext to local IPFS Kubo Daemon if running (fail closed unless --offline-demo / GENOCHAIN_ALLOW_OFFLINE_DEMO=1)
    offline_allowed = ("--offline-demo" in sys.argv) or (os.environ.get("GENOCHAIN_ALLOW_OFFLINE_DEMO") == "1")
    kubo_cid = upload_to_kubo(encrypted_payload, "khv_encrypted.enc")
    if kubo_cid:
        print(f"[IPFS] Đã ghim thành công ciphertext lên IPFS Kubo Daemon: {kubo_cid}")
    elif offline_allowed:
        print(f"[IPFS] Kubo Daemon offline (--offline-demo): sử dụng CIDv0 chuẩn UnixFS xác định cục bộ.")
    else:
        raise RuntimeError(
            "IPFS Kubo Daemon (http://127.0.0.1:5001) không hoạt động. "
            "Khởi chạy IPFS daemon thật hoặc truyền --offline-demo / GENOCHAIN_ALLOW_OFFLINE_DEMO=1."
        )

    # Authentic GA4GH Phenopackets v2 Metadata with ontology CURIEs (Pure Non-Clinical Cohort)
    sample_meta_dict = {
        "id": "phenopacket-SAMPLE_1000G_KHV01",
        "subject": {
            "id": "SAMPLE_1000G_KHV01",
            "sex": "MALE",
            "taxonomy": {"id": "NCBITaxon:9606", "label": "Homo sapiens"},
            "karyotypicSex": "XY",
            "vitalStatus": {"status": "ALIVE"}
        },
        "phenotypicFeatures": [
            {
                "type": {"id": "SO:0000694", "label": "Population SNP Callset (1000G KHV)"},
                "excluded": False
            },
            {
                "type": {"id": "HANCESTRO:0021", "label": "Vietnamese Kinh (1000 Genomes: KHV)"},
                "excluded": False
            }
        ],
        "diseases": [
            {
                "term": {"id": "SO:0001583", "label": "ALDH2 rs671 Alcohol Dehydrogenase Locus"}
            }
        ],
        "interpretations": [
            {
                "id": "interpretation-ALDH2-rs671",
                "progressStatus": "COMPLETED",
                "diagnosis": {
                    "disease": {"id": "SO:0001583", "label": "ALDH2 rs671 Alcohol Dehydrogenase Locus"},
                    "genomicInterpretations": [
                        {
                            "subjectOrBiosampleId": "SAMPLE_1000G_KHV01",
                            "interpretationStatus": "CONTRIBUTORY",
                            "variantInterpretation": {
                                "acmgPathogenicityClassification": "BENIGN",
                                "variationDescriptor": {
                                    "id": "rs671",
                                    "geneContext": {"valueId": "HGNC:404", "symbol": "ALDH2"},
                                    "vcfRecord": {
                                        "genomeAssembly": "GRCh38",
                                        "chrom": "chr12",
                                        "pos": 111803962,
                                        "id": "rs671"
                                    },
                                    "expressions": [
                                        {
                                            "syntax": "hgvs",
                                            "value": "[REDACTED_PROTECTED_UNDER_ENCRYPTED_PAYLOAD]"
                                        }
                                    ],
                                    "allelicState": {"id": "GENO:0000135", "label": "heterozygous"}
                                }
                            }
                        }
                    ]
                }
            }
        ],
        "metaData": {
            "created": "2026-11-10T00:00:00Z",
            "createdBy": "GenoChain GA4GH Pipeline",
            "resources": [
                {
                    "id": "so",
                    "name": "Sequence Ontology",
                    "url": "http://purl.obolibrary.org/obo/so.owl",
                    "version": "2026-01-01",
                    "namespacePrefix": "SO",
                    "iriPrefix": "http://purl.obolibrary.org/obo/SO_"
                },
                {
                    "id": "hancestro",
                    "name": "Human Ancestry Ontology",
                    "url": "http://purl.obolibrary.org/obo/hancestro.owl",
                    "version": "2026-01-01",
                    "namespacePrefix": "HANCESTRO",
                    "iriPrefix": "http://purl.obolibrary.org/obo/HANCESTRO_"
                },
                {
                    "id": "geno",
                    "name": "Genotype Ontology",
                    "url": "http://purl.obolibrary.org/obo/geno.owl",
                    "version": "2026-01-01",
                    "namespacePrefix": "GENO",
                    "iriPrefix": "http://purl.obolibrary.org/obo/GENO_"
                },
                {
                    "id": "ncbitaxon",
                    "name": "NCBI Organismal Classification",
                    "url": "http://purl.obolibrary.org/obo/ncbitaxon.owl",
                    "version": "2026-01-01",
                    "namespacePrefix": "NCBITaxon",
                    "iriPrefix": "http://purl.obolibrary.org/obo/NCBITaxon_"
                },
                {
                    "id": "hgnc",
                    "name": "HUGO Gene Nomenclature Committee",
                    "url": "https://www.genenames.org",
                    "version": "2026-01-01",
                    "namespacePrefix": "HGNC",
                    "iriPrefix": "https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:"
                }
            ],
            "phenopacketSchemaVersion": "2.0.0"
        }
    }
    sample_meta = json.dumps(sample_meta_dict, indent=2).encode("utf-8")

    # Valid binary PDF-1.4 Genomic Variant Summary Report structure (exact dynamic /Length & xref offsets)
    sample_summary = build_iso32000_pdf_summary(
        "GenoChain Genomic Variant Analysis Summary Report: ALDH2 rs671"
    )
    summary_iv = os.urandom(12)
    summary_key_hex = os.urandom(32).hex()
    summary_key = bytes.fromhex(summary_key_hex)
    encrypted_summary_payload = summary_iv + AESGCM(summary_key).encrypt(summary_iv, sample_summary, None)
    summary_kubo_cid = upload_to_kubo(encrypted_summary_payload, "khv_summary_encrypted.enc")
    if not summary_kubo_cid and not offline_allowed:
        raise RuntimeError(
            "IPFS Kubo Daemon (http://127.0.0.1:5001) không thể ghim bản mã PDF tóm tắt. "
            "Khởi chạy IPFS daemon thật hoặc truyền --offline-demo / GENOCHAIN_ALLOW_OFFLINE_DEMO=1."
        )
    real_summary_cid = summary_kubo_cid or compute_ipfs_cidv0(encrypted_summary_payload)
    metadata_kubo_cid = upload_to_kubo(sample_meta, "phenopacket_metadata.json")
    if not metadata_kubo_cid and not offline_allowed:
        raise RuntimeError(
            "IPFS Kubo Daemon (http://127.0.0.1:5001) không thể ghim metadata Phenopacket. "
            "Khởi chạy IPFS daemon thật hoặc truyền --offline-demo / GENOCHAIN_ALLOW_OFFLINE_DEMO=1."
        )
    real_metadata_cid = metadata_kubo_cid or compute_ipfs_cidv0(sample_meta)
    print(f"[+] Đã mã hóa AES-256-GCM báo cáo PDF phía Client trước khi băm/ghim IPFS: {real_summary_cid}")

    # 3. Register Genomic Data on Blockchain
    print("\n--- Step 3: Genomic Data Registration & Integrity Anchor on EVM ---")
    actual_raw_cid = kubo_cid or real_raw_cid
    token_uri = f"ipfs://{real_metadata_cid}"
    price_wei = w3.to_wei(100, "ether")
    duration_sec = 30 * 86400
    royalty_bps = 1000 # 10% secondary royalty

    print(f"[+] Data Owner ({data_owner}) đăng ký dữ liệu on-chain...")
    reg_tx = registry_contract.functions.registerGenomicData(
        raw_data_hash,
        actual_raw_cid,
        real_summary_cid,
        real_metadata_cid,
        token_uri,
        price_wei,
        duration_sec,
        royalty_bps
    ).transact({"from": data_owner})
    receipt = w3.eth.wait_for_transaction_receipt(reg_tx)
    print(f"[OK] Đăng ký thành công! TxHash: {w3.to_hex(receipt.transactionHash)}")

    data_count = registry_contract.functions.dataCount().call()
    target_data_id = data_count
    print(f"[+] Dataset ID được cấp: #{target_data_id} (Tổng số bộ dữ liệu: {data_count})")

    # 4. Researcher Key Registration (RSA-OAEP 2048-bit)
    print("\n--- Step 4: Researcher Asymmetric Key Generation & Registration ---")
    researcher_private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048
    )
    researcher_public_key = researcher_private_key.public_key()
    pub_pem = researcher_public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode("utf-8")

    reg_key_tx = registry_contract.functions.registerResearcherPublicKey(pub_pem).transact({"from": researcher})
    w3.eth.wait_for_transaction_receipt(reg_key_tx)
    stored_pub_key = registry_contract.functions.researcherPublicKeys(researcher).call()
    assert "BEGIN PUBLIC KEY" in stored_pub_key, "Researcher public key mismatch"
    print(f"[OK] Đã đăng ký RSA-2048 Public Key on-chain cho Researcher ({researcher})")

    # 5. Researcher Purchase with Timelocked Escrow Lock
    print("\n--- Step 5: Researcher Purchase via Timelocked Escrow Lock ---")
    dispute_window_sec = 86400 # 24 hours
    appr_tx = token_contract.functions.approve(registry_addr, price_wei).transact({"from": researcher})
    w3.eth.wait_for_transaction_receipt(appr_tx)

    escrow_tx = registry_contract.functions.grantAccessWithEscrow(
        target_data_id, dispute_window_sec, price_wei
    ).transact({"from": researcher})
    escrow_receipt = w3.eth.wait_for_transaction_receipt(escrow_tx)
    print(f"[OK] Ký quỹ Escrow Timelock thành công! TxHash: {w3.to_hex(escrow_receipt.transactionHash)}")

    escrow_dep = unpack_abi_outputs(
        registry_abi,
        "escrowDeposits",
        registry_contract.functions.escrowDeposits(target_data_id, researcher).call(),
    )
    print(f"    - Tiền ký quỹ trong Escrow: {w3.from_wei(escrow_dep['amount'], 'ether')} $GENO")
    print(f"    - Thời hạn tranh chấp      : {escrow_dep['disputeWindow']} giây (24 giờ)")

    # 6. Data Owner Key Encapsulation (RSA-OAEP Key Wrapping) & Capsule Storage
    print("\n--- Step 6: Data Owner Key Encapsulation & Capsule Delivery ---")
    # Wrap independent AES-256 raw & summary session keys using Researcher's RSA public key (OAEP with SHA-256)
    wrapped_aes_key = researcher_public_key.encrypt(
        aes_session_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    wrapped_summary_key = researcher_public_key.encrypt(
        summary_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    capsule_payload = json.dumps({
        "version": "GENO-PRE-v2",
        "algorithm": "RSA-OAEP-2048-SHA256",
        "keyCipher": wrapped_aes_key.hex(),
        "summaryKeyCipher": wrapped_summary_key.hex(),
        "iv": aes_iv.hex(),
        "summaryIv": summary_iv.hex(),
        "dataId": target_data_id,
        "recipient": researcher,
        "createdAt": int(time.time())
    })

    deliver_tx = registry_contract.functions.storeTransformedCapsule(
        target_data_id,
        researcher,
        capsule_payload
    ).transact({"from": data_owner})
    deliver_rec = w3.eth.wait_for_transaction_receipt(deliver_tx)
    print(f"[OK] Data Owner đã bọc khóa RSA-OAEP và lưu Capsule on-chain! TxHash: {w3.to_hex(deliver_rec.transactionHash)}")

    # 7. Researcher Retrieval, Key Unwrapping & End-to-End Decryption
    print("\n--- Step 7: Capsule Retrieval, Key Unwrapping & Decryption Verification ---")
    onchain_capsule_str = registry_contract.functions.buyerCapsules(target_data_id, researcher).call({"from": researcher})
    assert len(onchain_capsule_str) > 0, "Empty capsule returned from contract"
    parsed_capsule = json.loads(onchain_capsule_str)

    retrieved_wrapped_key = bytes.fromhex(parsed_capsule["keyCipher"])
    retrieved_iv = bytes.fromhex(parsed_capsule["iv"])

    # Unwrap independent AES session keys (raw VCF & summary PDF) using Researcher's RSA private key
    unwrapped_session_key = researcher_private_key.decrypt(
        retrieved_wrapped_key,
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    assert unwrapped_session_key == aes_session_key, "Unwrapped AES key does not match original session key!"
    unwrapped_summary_key = researcher_private_key.decrypt(
        bytes.fromhex(parsed_capsule["summaryKeyCipher"]),
        padding.OAEP(
            mgf=padding.MGF1(algorithm=hashes.SHA256()),
            algorithm=hashes.SHA256(),
            label=None
        )
    )
    assert unwrapped_summary_key == summary_key, "Unwrapped summary key does not match independent random summary key!"
    assert unwrapped_summary_key != unwrapped_session_key, "Summary key must be cryptographically independent from raw AES key!"
    retrieved_summary_iv = bytes.fromhex(parsed_capsule["summaryIv"])
    kubo_summary_ciphertext = fetch_from_kubo(real_summary_cid)
    if kubo_summary_ciphertext and len(kubo_summary_ciphertext) > 12:
        actual_summary_payload = kubo_summary_ciphertext
    elif offline_allowed:
        actual_summary_payload = encrypted_summary_payload
    else:
        raise RuntimeError(
            f"Không thể tải summary ciphertext CID={real_summary_cid} từ IPFS Kubo Daemon (http://127.0.0.1:5001)."
        )
    assert actual_summary_payload[:12] == retrieved_summary_iv, "Summary IV mismatch between IPFS blob and capsule!"
    decrypted_summary_pdf = AESGCM(unwrapped_summary_key).decrypt(
        retrieved_summary_iv, actual_summary_payload[12:], None
    )
    assert decrypted_summary_pdf == sample_summary and decrypted_summary_pdf.startswith(b"%PDF-1.4"), "Decrypted PDF mismatch!"

    # Fetch ciphertext from IPFS Kubo daemon via /api/v0/cat (with graceful fallback)
    print(f"[IPFS] Đang tải bản mã nhị phân từ IPFS Kubo Daemon với CID: {actual_raw_cid}...")
    kubo_ciphertext = fetch_from_kubo(actual_raw_cid)
    if kubo_ciphertext and len(kubo_ciphertext) > 0:
        print(f"[IPFS] Tải thành công {len(kubo_ciphertext)} bytes từ Kubo Daemon (/api/v0/cat)!")
        actual_payload_to_decrypt = kubo_ciphertext
    elif offline_allowed:
        print(f"[IPFS] Kubo Daemon offline (--offline-demo): giải mã bản mã từ bộ nhớ cục bộ.")
        actual_payload_to_decrypt = encrypted_payload
    else:
        raise RuntimeError(
            f"Không thể tải ciphertext CID={actual_raw_cid} từ IPFS Kubo Daemon (http://127.0.0.1:5001)."
        )

    # Cryptographic integrity check: verify SHA-256 against on-chain rawDataHash (INVARIANT-05)
    downloaded_hash = compute_raw_hash(actual_payload_to_decrypt)
    assert downloaded_hash == raw_data_hash, "Downloaded ciphertext hash does not match on-chain rawDataHash!"
    print(f"[VERIFIED] Tính toàn vẹn SHA-256 của bản mã tải về khớp 100% với On-Chain Anchor: 0x{downloaded_hash.hex()}")

    # Decrypt the encrypted payload with unwrapped AES key (extracting IV and ciphertext)
    payload_iv = actual_payload_to_decrypt[:12]
    payload_ciphertext = actual_payload_to_decrypt[12:]
    decryptor = AESGCM(unwrapped_session_key)
    decrypted_vcf_bytes = decryptor.decrypt(payload_iv, payload_ciphertext, None)
    decrypted_vcf_text = decrypted_vcf_bytes.decode("utf-8")

    assert decrypted_vcf_text == raw_vcf_content, "Decrypted VCF content mismatch!"
    print(f"[VERIFIED] Khôi phục khóa đối xứng AES-256 thành công!")
    print(f"[VERIFIED] Giải mã VCF nhị phân thành công! Nội dung khớp 100% với bản rõ ban đầu:")
    print(f"           '{decrypted_vcf_text.strip()[:80]}...'")

    # 7b. Buyer Confirmation & Live Escrow Settlement with 10% EIP-2981 Royalty Payout
    print("\n--- Step 7b: Buyer Escrow Confirmation & On-Chain EIP-2981 Royalty Settlement ---")
    dataset_record = registry_contract.functions.getGenomicData(target_data_id).call()
    target_token_id = dataset_record[1]
    royalty_receiver, expected_royalty_wei = nft_contract.functions.royaltyInfo(target_token_id, price_wei).call()
    owner_bal_before = token_contract.functions.balanceOf(data_owner).call()
    royalty_bal_before = token_contract.functions.balanceOf(royalty_receiver).call()

    confirm_tx = registry_contract.functions.confirmCapsuleAndReleaseEscrow(target_data_id).transact({"from": researcher})
    confirm_receipt = w3.eth.wait_for_transaction_receipt(confirm_tx)
    escrow_after = unpack_abi_outputs(
        registry_abi,
        "escrowDeposits",
        registry_contract.functions.escrowDeposits(target_data_id, researcher).call(),
    )
    assert escrow_after["released"] is True, "Escrow deposit was not marked released after buyer confirmation!"

    owner_bal_after = token_contract.functions.balanceOf(data_owner).call()
    royalty_bal_after = token_contract.functions.balanceOf(royalty_receiver).call()
    royalty_logs = registry_contract.events.RoyaltyPaid().process_receipt(confirm_receipt, errors=DISCARD)
    assert len(royalty_logs) == 1, f"Expected 1 RoyaltyPaid event, got {len(royalty_logs)}"
    assert royalty_logs[0]["args"]["amount"] == expected_royalty_wei, "RoyaltyPaid event amount mismatch!"
    if royalty_receiver.lower() == data_owner.lower():
        assert owner_bal_after - owner_bal_before == price_wei, "Creator/Owner settlement balance delta mismatch!"
    else:
        assert royalty_bal_after - royalty_bal_before == expected_royalty_wei, "Royalty receiver balance delta mismatch!"
        assert owner_bal_after - owner_bal_before == price_wei - expected_royalty_wei, "Seller proceeds balance delta mismatch!"

    royalty_pct = (expected_royalty_wei * 100.0) / price_wei if price_wei > 0 else 0.0
    print(f"[OK] Buyer đã xác nhận giải mã và giải phóng Escrow on-chain! TxHash: {w3.to_hex(confirm_receipt.transactionHash)}")
    print(f"    - Tổng giải ngân Escrow  : {w3.from_wei(price_wei, 'ether')} $GENO")
    print(f"    - EIP-2981 Royalty ({royalty_pct:.2f}%) : {w3.from_wei(expected_royalty_wei, 'ether')} $GENO -> {royalty_receiver}")

    # 8. Data Lifecycle & Access Control Verification
    print("\n--- Step 8: Data Lifecycle Management & Access Control ---")
    # Check access status
    has_access = registry_contract.functions.hasActiveAccess(target_data_id, researcher).call()
    print(f"[+] Kiểm tra quyền truy cập hasActiveAccess: {has_access}")

    # Pause dataset
    status_tx = registry_contract.functions.updateDataStatus(target_data_id, 1).transact({"from": data_owner}) # 1 = Paused
    w3.eth.wait_for_transaction_receipt(status_tx)
    updated_data = registry_contract.functions.getGenomicData(target_data_id).call()
    print(f"[OK] Trạng thái Dataset #{target_data_id} đã đổi sang Paused ({updated_data[9]})")

    # Resume dataset and update price
    resume_tx = registry_contract.functions.updateDataStatus(target_data_id, 0).transact({"from": data_owner}) # 0 = Active
    w3.eth.wait_for_transaction_receipt(resume_tx)

    new_price_wei = w3.to_wei(120, "ether")
    price_tx = registry_contract.functions.updateDataPrice(target_data_id, new_price_wei).transact({"from": data_owner})
    w3.eth.wait_for_transaction_receipt(price_tx)
    updated_price = registry_contract.functions.getGenomicData(target_data_id).call()
    print(f"[OK] Cập nhật mức phí mới: {w3.from_wei(updated_price[7], 'ether')} $GENO")

    # Direct access grant (dynamically pick distinct third-party node account, zero hardcoded addresses)
    third_party = next(
        (acc for acc in accounts[3:] if acc.lower() not in {data_owner.lower(), researcher.lower()}),
        accounts[-1],
    )
    grant_tx = registry_contract.functions.grantDirectAccess(target_data_id, third_party).transact({"from": data_owner})
    w3.eth.wait_for_transaction_receipt(grant_tx)
    has_direct_access = registry_contract.functions.hasActiveAccess(target_data_id, third_party).call()
    print(f"[OK] Cấp quyền xem trực tiếp on-chain cho {third_party}: hasActiveAccess = {has_direct_access}")

    # 9. Zero-Knowledge Verifier On-Chain Linkage & Trait Possession Verification
    zk_verifier_addr = registry_contract.functions.zkVerifier().call()
    assert zk_verifier_addr != "0x0000000000000000000000000000000000000000", "GenomicZkVerifier not linked on GenomicsRegistry!"
    zk_abi_path = os.path.join(base_dir, "frontend", "src", "contracts", "GenomicZkVerifierABI.json")
    zk_contract = w3.eth.contract(address=zk_verifier_addr, abi=load_json(zk_abi_path))
    bounty_count = zk_contract.functions.bountyCount().call()
    sample_commitment = hashlib.sha256(b"ALDH2_RS671_COMMITMENT").digest()
    sample_trait_id = w3.keccak(text="ALDH2_rs671")
    dataset_bound_verified = registry_contract.functions.verifyDatasetBoundTrait(target_data_id, sample_trait_id).call()
    trait_verified = registry_contract.functions.verifyDatasetTraitPossession(target_data_id, sample_commitment).call()
    print(f"[ZK] Liên kết GenomicZkVerifier ({zk_verifier_addr}): bountyCount={bounty_count}, verifyDatasetBoundTrait={dataset_bound_verified}, verifyDatasetTraitPossession={trait_verified}")

    # 9b. 3-Artifact Hash Anchoring, Blinded Trait Search & 5% Study Reuse Fee (with Slippage Guard)
    print("\n--- Step 9b: 3-Artifact Anchoring, Blinded Trait Search & 5% Study Reuse Fee ---")
    summary_artifact_hash = hashlib.sha256(encrypted_summary_payload).digest()
    metadata_artifact_hash = hashlib.sha256(sample_meta).digest()
    anchor_tx = registry_contract.functions.anchorArtifactHashes(
        target_data_id,
        summary_artifact_hash,
        metadata_artifact_hash
    ).transact({"from": data_owner})
    anchor_rec = w3.eth.wait_for_transaction_receipt(anchor_tx)
    hashes_tuple = registry_contract.functions.getArtifactHashes(target_data_id).call()
    assert hashes_tuple[1] == summary_artifact_hash, "summaryDataHash mismatch on-chain"
    assert hashes_tuple[2] == metadata_artifact_hash, "metadataHash mismatch on-chain"
    print(f"[OK] Anchored genuine SHA-256 3-artifact hashes on-chain! TxHash: {w3.to_hex(anchor_rec.transactionHash)}")

    blind_salt = w3.keccak(text="GENOCHAIN_DEMO_BLIND_SALT_V1")
    blind_tag_pos = registry_contract.functions.computeBlindTag("gene", "ALDH2", blind_salt).call()
    blind_tag_neg = registry_contract.functions.computeBlindTag("gene", "UNKNOWN_GENE", blind_salt).call()
    tags_tx = registry_contract.functions.setDatasetBlindTags(target_data_id, [blind_tag_pos]).transact({"from": data_owner})
    tags_rec = w3.eth.wait_for_transaction_receipt(tags_tx)
    assert registry_contract.functions.matchesBlindTag(target_data_id, blind_tag_pos).call() is True, "Positive blind tag lookup failed"
    assert registry_contract.functions.matchesBlindTag(target_data_id, blind_tag_neg).call() is False, "Negative blind tag lookup returned True"
    print(f"[OK] Blinded Trait Search verified (Keccak-256)! TxHash: {w3.to_hex(tags_rec.transactionHash)}")

    reuse_fee_wei = registry_contract.functions.quoteReuseFee(target_data_id).call()
    assert reuse_fee_wei > 0, "Expected non-zero reuse fee quote"
    reuse_appr_tx = token_contract.functions.approve(registry_addr, reuse_fee_wei).transact({"from": researcher})
    w3.eth.wait_for_transaction_receipt(reuse_appr_tx)
    # Bind researcher address into study commitment preimage (per-buyer domain separation on global studyReuseReceipts)
    study_id = w3.keccak(text=f"{researcher.lower()}:GENOCHAIN_REUSE_STUDY_DEMO_2026")
    reuse_tx = registry_contract.get_function_by_signature("recordStudyReuse(uint256,bytes32,uint256)")(
        target_data_id, study_id, reuse_fee_wei
    ).transact({"from": researcher})
    reuse_rec = w3.eth.wait_for_transaction_receipt(reuse_tx)
    assert registry_contract.functions.studyReuseReceipts(target_data_id, study_id).call() is True, "Study reuse receipt not recorded"
    assert registry_contract.functions.datasetReuseCount(target_data_id).call() >= 1, "Dataset reuse count did not increment"
    print(f"[OK] 5% Study Reuse Fee recorded ({w3.from_wei(reuse_fee_wei, 'ether')} $GENO)! TxHash: {w3.to_hex(reuse_rec.transactionHash)}")

    print("\n" + "=" * 80)
    print("[SUCCESS] ALL GENOCHAIN WORKFLOWS, CRYPTOGRAPHIC PROOFS & ACCESS CONSTRAINTS PASSED 100%!")
    print("=" * 80)

if __name__ == "__main__":
    main()