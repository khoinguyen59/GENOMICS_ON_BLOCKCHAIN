#!/usr/bin/env python3
"""
===========================================================================
GENOMICS ON BLOCKCHAIN - INDEPENDENT LIVE NODE AUDIT & PENETRATION SUITE
===========================================================================
Thực hiện kiểm thử đối kháng TRỰC TIẾP trên cổng RPC 8545 qua giao thức
HTTP JSON-RPC thô (Raw JSON-RPC).
Không sử dụng bất kỳ mock nào trong RAM hay mocha in-memory.
===========================================================================
"""

import os
import sys
import json
import urllib.request
import hashlib
from web3 import Web3
from web3.exceptions import ContractLogicError

# Force UTF-8 encoding on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

RPC_URL = "http://127.0.0.1:8545"

def raw_rpc_call(method, params=None):
    """Gửi trực tiếp raw JSON-RPC request qua HTTP socket tới node 8545"""
    if params is None:
        params = []
    req_data = json.dumps({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1
    }).encode("utf-8")
    
    req = urllib.request.Request(RPC_URL, data=req_data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    print("=" * 80)
    print("[AUDIT] GENOMICS ON BLOCKCHAIN - RAW EVM & ADVERSARIAL PENETRATION AUDIT")
    print("=" * 80)

    # 1. Raw Node Ping & Chain Attributes
    print("\n[PHASE 1] KIỂM TRA ĐẶC TÍNH MẠNG EVM QUA RAW JSON-RPC HTTP:")
    try:
        block_num_res = raw_rpc_call("eth_blockNumber")
        chain_id_res = raw_rpc_call("eth_chainId")
        client_ver_res = raw_rpc_call("web3_clientVersion")
        
        current_block = int(block_num_res["result"], 16)
        chain_id = int(chain_id_res["result"], 16)
        client_version = client_ver_res["result"]
        
        print(f"  ✔ Node RPC Target      : {RPC_URL}")
        print(f"  ✔ Client Version       : {client_version}")
        print(f"  ✔ Chain ID             : {chain_id} (Expected 31337 - Hardhat EVM)")
        print(f"  ✔ Current Block Height : #{current_block}")
    except Exception as e:
        print(f"  [FAIL] Không thể kết nối tới RPC 8545: {e}")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    assert w3.is_connected(), "Web3 connection failed!"

    # Load contract addresses & ABIs
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    contracts_dir = os.path.join(base_dir, "frontend", "src", "contracts")
    with open(os.path.join(contracts_dir, "contractAddresses.json"), "r", encoding="utf-8") as f:
        addresses = json.load(f)
    with open(os.path.join(contracts_dir, "GenomicTokenABI.json"), "r", encoding="utf-8") as f:
        token_abi = json.load(f)
    with open(os.path.join(contracts_dir, "GenomicNFTABI.json"), "r", encoding="utf-8") as f:
        nft_abi = json.load(f)
    with open(os.path.join(contracts_dir, "GenomicsRegistryABI.json"), "r", encoding="utf-8") as f:
        registry_abi = json.load(f)

    token = w3.eth.contract(address=addresses["GenomicToken"], abi=token_abi)
    nft = w3.eth.contract(address=addresses["GenomicNFT"], abi=nft_abi)
    registry = w3.eth.contract(address=addresses["GenomicsRegistry"], abi=registry_abi)

    accounts = w3.eth.accounts
    deployer = accounts[0]
    data_owner = accounts[1]
    researcher = accounts[2]
    attacker = accounts[5]

    print("\n[PHASE 2] KIỂM THỬ TẤN CÔNG ĐỐI KHÁNG (RED-TEAM ATTACK SCENARIOS):")

    # ATTACK 1: Double-claim Faucet (Anti-Drain attack)
    print("\n  [ATTACK #1] Tấn công rút cạn Token Faucet liên tiếp:")
    print(f"    - Attacker: {attacker}")
    try:
        # First claim (might revert if cooldown active from previous run)
        tx = token.functions.faucet(attacker).transact({"from": attacker})
        w3.eth.wait_for_transaction_receipt(tx)
        print("    - Lần 1: Claim thành công 1,000 $GENO.")
    except (ContractLogicError, ValueError):
        print("    - Lần 1: Đang trong cooldown từ phiên trước.")

    reverted = False
    try:
        # Immediate second claim (MUST REVERT ON-CHAIN)
        tx2 = token.functions.faucet(attacker).transact({"from": attacker})
        rc2 = w3.eth.wait_for_transaction_receipt(tx2)
        reverted = (rc2.status == 0)
    except (ContractLogicError, ValueError):
        reverted = True
    assert reverted, "Faucet Cooldown bypassed! Immediate second faucet claim succeeded."
    print("    ✔ EVM ĐÃ CHẶN THÀNH CÔNG (On-chain Revert): Cooldown 1 giờ được thực thi nghiêm ngặt.")

    # ATTACK 2: Unauthorized Direct NFT Mint (Bypass Registry)
    print("\n  [ATTACK #2] Kẻ tấn công tự mint NFT dữ liệu không qua Registry:")
    reverted = False
    try:
        fake_hash = hashlib.sha256(b"fake_dna").digest()
        bad_tx = nft.functions.mintGenomicNFT(
            attacker, "ipfs://fake", fake_hash, "QmFake", "QmFake", "QmFake", 1000
        ).transact({"from": attacker})
        bad_rc = w3.eth.wait_for_transaction_receipt(bad_tx)
        reverted = (bad_rc.status == 0)
    except (ContractLogicError, ValueError):
        reverted = True
    assert reverted, "GenomicNFT access control violated! Non-registry minted NFT."
    print("    ✔ EVM ĐÃ CHẶN THÀNH CÔNG: Chỉ hợp đồng GenomicsRegistry mới được phép gọi mintGenomicNFT (OnlyRegistry).")

    # ATTACK 3: Unauthorized Price Tampering
    print("\n  [ATTACK #3] Kẻ tấn công tự ý đổi phí truy cập (updateDataPrice) của bộ dữ liệu #1:")
    reverted = False
    try:
        tamper_tx = registry.functions.updateDataPrice(1, w3.to_wei(99999, "ether")).transact({"from": attacker})
        tamper_rc = w3.eth.wait_for_transaction_receipt(tamper_tx)
        reverted = (tamper_rc.status == 0)
    except (ContractLogicError, ValueError):
        reverted = True
    assert reverted, "updateDataPrice onlyDataOwner bypassed!"
    print("    ✔ EVM ĐÃ CHẶN THÀNH CÔNG: Ràng buộc onlyDataOwner ngăn chặn kẻ tấn công đổi giá.")

    # ATTACK 4: Unauthorized Status Revocation
    print("\n  [ATTACK #4] Kẻ tấn công tìm cách Revoke dataset #1:")
    reverted = False
    try:
        revoke_tx = registry.functions.updateDataStatus(1, 2).transact({"from": attacker})
        revoke_rc = w3.eth.wait_for_transaction_receipt(revoke_tx)
        reverted = (revoke_rc.status == 0)
    except (ContractLogicError, ValueError):
        reverted = True
    assert reverted, "updateDataStatus onlyDataOwner bypassed!"
    print("    ✔ EVM ĐÃ CHẶN THÀNH CÔNG: Ràng buộc onlyDataOwner ngăn chặn kẻ tấn công đổi status.")

    # ATTACK 5: Theft of Access Capsule
    print("\n  [ATTACK #5] Kẻ tấn công đánh cắp Key Capsule khi chưa trả tiền mua:")
    reverted = False
    stolen_capsule = None
    try:
        stolen_capsule = registry.functions.getTransformedCapsule(1).call({"from": attacker})
    except (ContractLogicError, ValueError):
        reverted = True
    assert reverted, f"getTransformedCapsule leak! Expected on-chain revert, got: {stolen_capsule!r}"
    print("    ✔ EVM ĐÃ CHẶN THÀNH CÔNG (Revert on-chain): Access denied or expired.")

    print("\n[PHASE 3] ĐỐI SOÁT DÒNG TIỀN ESCROW & CHI TRẢ ROYALTY THỰC TẾ:")
    # Check balances before
    dataset_info = registry.functions.getGenomicData(1).call()
    token_id = dataset_info[1]
    owner_addr = dataset_info[2]
    price = dataset_info[7]

    royalty_info = nft.functions.royaltyInfo(token_id, price).call()
    royalty_receiver = royalty_info[0]
    royalty_amount = royalty_info[1]
    seller_expected = price - royalty_amount

    royalty_pct = (royalty_amount * 100.0) / price if price > 0 else 0.0
    print(f"  - Dataset Target        : ID #1 (Token #{token_id})")
    print(f"  - Giá niêm yết          : {w3.from_wei(price, 'ether')} $GENO")
    print(f"  - Tỷ lệ Royalty EIP-2981: {royalty_pct:.2f}% ({w3.from_wei(royalty_amount, 'ether')} $GENO cho {royalty_receiver})")
    print(f"  - Thực nhận cho Người bán: {w3.from_wei(seller_expected, 'ether')} $GENO")

    # Select a researcher account that does not already have an active access grant
    buyer_account = None
    for acc in accounts[3:15]:
        if not registry.functions.hasActiveAccess(1, acc).call():
            buyer_account = acc
            break
    if not buyer_account:
        # Fast-forward time dynamically past the dataset's on-chain accessDuration (+1 day buffer)
        warp_sec = int(dataset_info[8]) + 86400
        w3.provider.make_request("evm_increaseTime", [warp_sec])
        w3.provider.make_request("evm_mine", [])
        buyer_account = accounts[3]

    researcher = buyer_account
    bal_buyer_before = token.functions.balanceOf(researcher).call()
    bal_owner_before = token.functions.balanceOf(owner_addr).call()
    bal_royalty_before = token.functions.balanceOf(royalty_receiver).call()

    # Ensure researcher has enough tokens
    if bal_buyer_before < price:
        mint_tx_phase3 = token.functions.mint(researcher, price * 2).transact({"from": deployer})
        w3.eth.wait_for_transaction_receipt(mint_tx_phase3)
        bal_buyer_before = token.functions.balanceOf(researcher).call()

    # Approve & Buy
    approve_tx = token.functions.approve(addresses["GenomicsRegistry"], price).transact({"from": researcher})
    approve_receipt = w3.eth.wait_for_transaction_receipt(approve_tx)

    # Buy access
    buy_tx = registry.functions.grantAccess(1).transact({"from": researcher})
    buy_receipt = w3.eth.wait_for_transaction_receipt(buy_tx)
    assert buy_receipt.status == 1, "grantAccess transaction failed on-chain!"

    bal_buyer_after = token.functions.balanceOf(researcher).call()
    bal_owner_after = token.functions.balanceOf(owner_addr).call()
    bal_royalty_after = token.functions.balanceOf(royalty_receiver).call()

    buyer_delta = bal_buyer_before - bal_buyer_after
    owner_delta = bal_owner_after - bal_owner_before
    royalty_delta = bal_royalty_after - bal_royalty_before
    assert buyer_delta == price, f"Buyer balance delta mismatch: expected {price}, got {buyer_delta}"
    if owner_addr.lower() == royalty_receiver.lower():
        assert owner_delta == price, f"Creator-owner balance delta mismatch: expected {price}, got {owner_delta}"
    else:
        assert owner_delta == seller_expected, f"Seller balance delta mismatch: expected {seller_expected}, got {owner_delta}"
        assert royalty_delta == royalty_amount, f"Royalty receiver delta mismatch: expected {royalty_amount}, got {royalty_delta}"
    has_access = registry.functions.hasActiveAccess(1, researcher).call()
    assert has_access is True, "Researcher does not have active access after grantAccess!"

    print(f"\n  [ON-CHAIN RECEIPT ĐƯỢC ĐÀO THỰC TẾ TRÊN BLOCK #{buy_receipt.blockNumber}]:")
    print(f"  ✔ TxHash                : {Web3.to_hex(buy_receipt.transactionHash)}")
    print(f"  ✔ Gas Used              : {buy_receipt.gasUsed:,} gas")
    print(f"  ✔ Effective Gas Price   : {w3.from_wei(buy_receipt.effectiveGasPrice, 'gwei')} Gwei")
    print(f"  ✔ Số dư Người mua giảm  : -{w3.from_wei(buyer_delta, 'ether')} $GENO")
    print(f"  ✔ Số dư Người bán tăng  : +{w3.from_wei(owner_delta, 'ether')} $GENO")
    print(f"  ✔ Quyền truy cập cấp mới: hasActiveAccess = {has_access}")

    print("\n[PHASE 4] XÁC MINH CƠ CHẾ ĐỐT TOKEN DEFLATIONARY:")
    burn_amount = w3.to_wei(25, "ether")
    if token.functions.balanceOf(researcher).call() < burn_amount:
        mint_tx = token.functions.mint(researcher, burn_amount).transact({"from": deployer})
        w3.eth.wait_for_transaction_receipt(mint_tx)
    supply_before = token.functions.totalSupply().call()
    burn_tx = token.functions.burn(burn_amount).transact({"from": researcher})
    burn_receipt = w3.eth.wait_for_transaction_receipt(burn_tx)
    assert burn_receipt.status == 1, "ERC20Burnable burn transaction failed!"
    supply_after = token.functions.totalSupply().call()
    assert (supply_before - supply_after) == burn_amount, (
        f"Total supply decrease mismatch: expected {burn_amount}, got {supply_before - supply_after}"
    )
    print(f"  ✔ Burn TxHash           : {Web3.to_hex(burn_receipt.transactionHash)}")
    print(f"  ✔ Tổng cung giảm chính xác 25 $GENO: {w3.from_wei(supply_before - supply_after, 'ether')} $GENO")

    print("\n" + "=" * 80)
    print("[VERIFICATION] BẰNG CHỨNG HỌC THUẬT: 100% CÁC CUỘC TẤN CÔNG ĐỐI KHÁNG THỰC TẾ BỊ CHẶN ĐỨNG TRÊN EVM!")
    print("=" * 80)

if __name__ == "__main__":
    main()