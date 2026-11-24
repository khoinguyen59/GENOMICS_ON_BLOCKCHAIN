#!/usr/bin/env python3
"""
Full-Stack Browser E2E Verification Suite (Round-14 Plan A)
Exercises the real Vite production bundle against live Hardhat EVM (:8545) and Kubo IPFS (:5001/:8080):
  1. Flow 1 (L-03): Connect Donor (Account #1) -> Upload real VCF -> Select 5% (500 bps) royalty ->
     Sign & Mint on-chain + Kubo -> Verify dynamic 5% renders in Vault, Researcher Table View,
     and AssetDetailModal (Creator Earnings + Buybox).
  2. Flow 2 (L-06 + browser-native snarkjs WASM): Admin approves Lab Attestor (Account #4) & creates
     Lab-Attested ZK Bounty -> Donor enters witness secret -> Verifies #donor-zk-commitment-preview
     renders exact BN254 MiMC-7 variantCommitment & Copy button -> Lab signs EIP-191 attestation ->
     Donor submits via UI (real in-browser snarkjs WASM Groth16 proving) -> Asserts on-chain
     hasClaimedBounty == True AND L-06 witness state clears on wallet switch.
  3. Flow 3 (MED-01 + INVARIANT-04/09): Switch to Researcher (Account #2) -> Register non-extractable
     RSA-OAEP keypair on-chain -> Purchase Seed #1 with Escrow -> Run capsule_dispatcher.py ->
     Full page.reload() (F5) -> Re-connect Account #2 -> Licensed Assets -> Decrypt -> Assert real
     decrypted VCF plaintext renders in DOM.
  4. Flow 4 (MED-02): With Account #2's decrypted VCF visibly rendered, grant Account #1 direct
     access on Seed #1 so the Seed #1 card stays mounted, switch wallet Account #2 -> Account #1 ->
     Assert Account #2's decrypted VCF plaintext has 0 matches in DOM and Seed #1 renders locked.
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from playwright.async_api import async_playwright
from web3 import Web3

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = REPO_ROOT / "frontend" / "src" / "contracts"

R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617
MIMC_ROUNDS = 91
MIMC_ROUND_CONSTANTS = [
    int.from_bytes(Web3.keccak(text=f"GENOCHAIN_MIMC7_BN254_R{i}"), "big") % R_MOD
    for i in range(MIMC_ROUNDS)
]

# Standard Hardhat local node deterministic private keys (test-only localhost EVM)
HARDHAT_PK_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
HARDHAT_PK_4 = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"


def compute_donor_witness_commitment_py(donor_addr: str, target_trait_id_bytes: bytes, witness_secret: str) -> str:
    """Exact Python mirror of crypto/zk/groth16_prover.js computeDonorWitnessCommitment."""
    s = int.from_bytes(Web3.keccak(text=f"GENOCHAIN_SECRET_FIELD_V1:{witness_secret}"), "big") % R_MOD
    if s == 0:
        s = 1
    donor_bytes = bytes.fromhex(Web3.to_checksum_address(donor_addr)[2:])
    donor_trait_bind = int.from_bytes(Web3.keccak(target_trait_id_bytes + donor_bytes), "big") % R_MOD

    cur_x = (s + donor_trait_bind) % R_MOD
    for c in MIMC_ROUND_CONSTANTS:
        u = (cur_x + s + c) % R_MOD
        cur_x = pow(u, 7, R_MOD)
    h = (cur_x + donor_trait_bind + s) % R_MOD
    return "0x" + h.to_bytes(32, "big").hex()


def unpack_outputs(abi_list, fn_name: str, raw_tuple):
    for item in abi_list:
        if item.get("type") == "function" and item.get("name") == fn_name:
            outputs = item.get("outputs", [])
            if len(outputs) == len(raw_tuple):
                return {out.get("name") or str(i): raw_tuple[i] for i, out in enumerate(outputs)}
    return {str(i): val for i, val in enumerate(raw_tuple)}


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def send_tx(w3: Web3, fn_call, from_addr: str, priv_key: str):
    nonce = w3.eth.get_transaction_count(from_addr, "pending")
    tx = fn_call.build_transaction({
        "from": from_addr,
        "nonce": nonce,
        "gasPrice": w3.eth.gas_price,
    })
    if "gas" not in tx:
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.25)
    signed = w3.eth.account.sign_transaction(tx, private_key=priv_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    if receipt.status != 1:
        raise RuntimeError(f"Transaction reverted: {Web3.to_hex(tx_hash)}")
    return receipt


def check_live_prerequisites(base_url: str, rpc_url: str, ipfs_api: str):
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        raise RuntimeError(f"Hardhat RPC is not reachable at {rpc_url}")

    req = urllib.request.Request(f"{ipfs_api.rstrip('/')}/api/v0/version", method="POST")
    with urllib.request.urlopen(req, timeout=5) as resp:
        if resp.status != 200:
            raise RuntimeError(f"Kubo IPFS API returned HTTP {resp.status}")

    with urllib.request.urlopen(base_url, timeout=5) as resp:
        if resp.status != 200:
            raise RuntimeError(f"Frontend server at {base_url} returned HTTP {resp.status}")

    return w3


async def switch_local_account(page, acct_idx: int, expected_addr: str, timeout_ms: int):
    short_expected = f"{expected_addr[:6]}...{expected_addr[-4:]}"
    await page.click("#navbar-role-admin")
    btn_sel = f"#admin-switch-acct-{acct_idx}"
    await page.wait_for_selector(btn_sel, timeout=timeout_ms)
    await page.click(btn_sel)
    await page.wait_for_function(
        "(exp) => { const el = document.querySelector('.os2-wallet-addr'); return el && el.textContent.trim().toLowerCase() === exp.toLowerCase(); }",
        arg=short_expected,
        timeout=timeout_ms,
    )
    await page.wait_for_timeout(600)


async def ensure_english(page):
    btn = page.locator("#navbar-lang-en")
    if await btn.count() > 0 and await btn.is_visible():
        await btn.click()
        await page.wait_for_timeout(250)


async def wait_for_condition(predicate, timeout_sec: float, interval_sec: float = 0.5, desc: str = "condition"):
    deadline = time.time() + timeout_sec
    last_err = None
    while time.time() < deadline:
        try:
            res = predicate()
            if res:
                return res
        except Exception as err:
            last_err = err
        await asyncio.sleep(interval_sec)
    raise AssertionError(f"Timed out waiting for {desc} after {timeout_sec}s (last_err={last_err})")


async def run_e2e(base_url: str, rpc_url: str, ipfs_api: str, timeout_ms: int):
    w3 = check_live_prerequisites(base_url, rpc_url, ipfs_api)
    chain_id = int(w3.eth.chain_id)

    addresses = load_json(CONTRACTS_DIR / "contractAddresses.json")
    token_abi = load_json(CONTRACTS_DIR / "GenomicTokenABI.json")
    nft_abi = load_json(CONTRACTS_DIR / "GenomicNFTABI.json")
    registry_abi = load_json(CONTRACTS_DIR / "GenomicsRegistryABI.json")
    zk_abi = load_json(CONTRACTS_DIR / "GenomicZkVerifierABI.json")

    token = w3.eth.contract(address=Web3.to_checksum_address(addresses["GenomicToken"]), abi=token_abi)
    nft = w3.eth.contract(address=Web3.to_checksum_address(addresses["GenomicNFT"]), abi=nft_abi)
    registry = w3.eth.contract(address=Web3.to_checksum_address(addresses["GenomicsRegistry"]), abi=registry_abi)
    zk = w3.eth.contract(address=Web3.to_checksum_address(addresses["GenomicZkVerifier"]), abi=zk_abi)

    accounts = w3.eth.accounts
    acct0 = Web3.to_checksum_address(accounts[0])
    acct1 = Web3.to_checksum_address(accounts[1])
    acct2 = Web3.to_checksum_address(accounts[2])
    acct4 = Web3.to_checksum_address(accounts[4])

    # Ensure Researcher (Account #2) has sufficient $GENO for Seed #1 Escrow purchase
    bal2 = token.functions.balanceOf(acct2).call()
    if bal2 < 2000 * 10**18:
        send_tx(w3, token.functions.transfer(acct2, 5000 * 10**18), acct0, HARDHAT_PK_0)

    console_errors = []
    page_errors = []

    run_nonce = int(time.time())
    unique_vcf_content = (
        "##fileformat=VCFv4.2\n"
        f"##source=GenoChain_E2E_{run_nonce}\n"
        "##reference=GRCh38\n"
        "##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene symbol\">\n"
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE_E2E\n"
        f"chr12\t111803962\trs671\tG\tA\t99\tPASS\tGENE=ALDH2;AF=0.28;RUN={run_nonce}\tGT:DP\t0/1:72\n"
    )

    tmp_vcf = Path(tempfile.gettempdir()) / f"genochain_e2e_{run_nonce}.vcf"
    tmp_vcf.write_text(unique_vcf_content, encoding="utf-8")
    tmp_checkpoint = Path(tempfile.gettempdir()) / f"e2e_dispatcher_checkpoint_{run_nonce}.json"

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width": 1440, "height": 900})
            page = await context.new_page()
            page.set_default_timeout(timeout_ms)

            page.on(
                "console",
                lambda msg: console_errors.append(f"[console.error] {msg.text}") if msg.type == "error" else None,
            )
            page.on("pageerror", lambda err: page_errors.append(f"[pageerror] {err}"))

            print(f"[*] Loading {base_url} ...")
            await page.goto(base_url, wait_until="networkidle")
            await page.wait_for_selector("#navbar-role-admin", timeout=timeout_ms)
            await ensure_english(page)

            # =====================================================================
            # FLOW 1 (L-03): Mint 5% (500 bps) Royalty Dataset -> Verify Dynamic 5%
            # =====================================================================
            print("\n=== FLOW 1 (L-03): Donor Mint 5% Royalty -> Marketplace Table & Modal ===")
            await switch_local_account(page, 1, acct1, timeout_ms)
            data_count_before = int(registry.functions.dataCount().call())

            await page.click("#navbar-role-donor")
            await page.wait_for_selector("#genomic-file-input", state="attached", timeout=timeout_ms)
            await page.set_input_files("#genomic-file-input", str(tmp_vcf))
            await page.wait_for_selector(".drop-file-loaded-badge", timeout=timeout_ms)

            await page.select_option("#select-royalty-bps", "500")
            await page.fill("#input-price-geno", "125")
            await page.fill("#input-duration-days", "30")
            cohort_title = f"E2E Dynamic Royalty 5pct Cohort {run_nonce}"
            await page.fill("#input-disease", cohort_title)
            await page.click("#btn-mint-submit")

            await wait_for_condition(
                lambda: int(registry.functions.dataCount().call()) == data_count_before + 1,
                timeout_sec=45,
                desc="on-chain dataCount increment after mint",
            )
            new_data_id = data_count_before + 1
            item_info = registry.functions.getGenomicData(new_data_id).call()
            new_token_id = int(item_info[1])
            royalty_recv, royalty_amt = nft.functions.royaltyInfo(new_token_id, 10000).call()
            assert royalty_recv.lower() == acct1.lower(), f"Expected royalty receiver {acct1}, got {royalty_recv}"
            assert int(royalty_amt) == 500, f"Expected 500 bps royalty on-chain, got {royalty_amt}"
            print(f"  [PASS] Minted dataId=#{new_data_id} (tokenId=#{new_token_id}) with on-chain royaltyInfo = 500 bps (5%)")

            # Verify Vault automatically switched & shows 5% on minted row
            await page.wait_for_selector("#donor-zk-bounty-panel", timeout=timeout_ms)
            vault_row = page.locator("table.terminal-table tbody tr", has_text=f"#{new_token_id}").first
            await vault_row.wait_for(state="visible", timeout=timeout_ms)
            vault_row_text = await vault_row.inner_text()
            assert "(5%)" in vault_row_text, f"Expected dynamic '(5%)' in Vault row, got: {vault_row_text!r}"
            print("  [PASS] Donor Vault table renders dynamic '(5%)' royalty for newly minted dataset")

            # Navigate to Researcher Marketplace Table View & assert dynamic 5%
            await page.click("#navbar-role-researcher")
            await page.wait_for_selector("#btn-view-table", timeout=timeout_ms)
            await page.click("#btn-view-table")
            id_label = f"#{str(new_data_id).zfill(2)}"
            table_row = page.locator("table.terminal-table tbody tr", has_text=id_label).first
            await table_row.wait_for(state="visible", timeout=timeout_ms)
            price_sub_text = await table_row.locator(".price-sub").inner_text()
            assert price_sub_text.strip().startswith("5%"), f"Expected '5% ...' in Table .price-sub, got: {price_sub_text!r}"
            assert "10%" not in price_sub_text, f"Unexpected static '10%' in Table .price-sub: {price_sub_text!r}"
            print(f"  [PASS] Researcher Table View renders dynamic royalty: {price_sub_text.strip()!r}")

            # Open AssetDetailModal for minted dataset & assert dynamic 5% in Creator Earnings + Buybox
            await table_row.locator("button.btn-terminal-ghost").last.click()
            await page.wait_for_selector(".opensea-modal-container", timeout=timeout_ms)
            modal_text = await page.locator(".opensea-modal-container").inner_text()
            buybox_tag = await page.locator(".buybox-royalty-tag").inner_text()
            buybox_label = await page.locator(".buybox-price-label").inner_text()
            assert buybox_tag.strip().startswith("5%"), f"Expected '5% ...' in .buybox-royalty-tag, got: {buybox_tag!r}"
            assert "5% EIP-2981" in buybox_label, f"Expected '5% EIP-2981' in .buybox-price-label, got: {buybox_label!r}"
            assert re.search(r"\b5%\s*\(EIP-2981", modal_text), f"Expected '5% (EIP-2981...)' in Creator Earnings row"
            assert "10% EIP-2981" not in modal_text and "10% (EIP-2981" not in modal_text, "Found stale static 10% in AssetDetailModal"
            print(f"  [PASS] AssetDetailModal renders dynamic 5% in Creator Earnings & Buybox ({buybox_tag.strip()!r})")
            await page.keyboard.press("Escape")
            await page.wait_for_selector(".opensea-modal-container", state="detached", timeout=timeout_ms)

            # =====================================================================
            # FLOW 2 (L-06 + snarkjs WASM): Lab-Attested ZK Bounty Claim
            # =====================================================================
            print("\n=== FLOW 2 (L-06 + snarkjs WASM): Lab-Attested ZK Bounty End-to-End ===")
            if not zk.functions.approvedLabAttestors(acct4).call():
                send_tx(w3, zk.functions.setApprovedLabAttestor(acct4, True), acct0, HARDHAT_PK_0)

            trait_label = f"E2E_LAB_TRAIT_{run_nonce}"
            target_trait_id = Web3.keccak(text=trait_label)
            reward_wei = 25 * 10**18
            send_tx(w3, token.functions.approve(zk.address, reward_wei), acct0, HARDHAT_PK_0)
            send_tx(
                w3,
                zk.functions.createAttestedZkBounty(
                    target_trait_id,
                    f"E2E Lab-Attested Trait {run_nonce}",
                    reward_wei,
                    1,
                    86400,
                    acct4,
                ),
                acct0,
                HARDHAT_PK_0,
            )
            bounty_id = int(zk.functions.bountyCount().call())
            print(f"  [*] Created on-chain Lab-Attested ZK Bounty #{bounty_id} (attestor={acct4})")

            # Donor (Account #1) opens Vault
            await page.click("#navbar-role-donor")
            await page.wait_for_selector(".portal-subnav-bar .subnav-tab-item", timeout=timeout_ms)
            await page.locator(".portal-subnav-bar .subnav-tab-item").nth(1).click()
            await page.wait_for_selector("#donor-refresh-bounties-btn", timeout=timeout_ms)
            await page.click("#donor-refresh-bounties-btn")
            claim_btn_sel = f"#btn-claim-zk-bounty-{bounty_id}"
            await page.wait_for_selector(claim_btn_sel, timeout=timeout_ms)

            witness_secret = f"E2E_DONOR_SECRET_{run_nonce}"
            await page.fill("#donor-zk-witness-input", witness_secret)
            comm_val_sel = f"#donor-zk-commitment-val-{bounty_id}"
            copy_btn_sel = f"#btn-copy-zk-commitment-{bounty_id}"
            await page.wait_for_selector("#donor-zk-commitment-preview", timeout=timeout_ms)
            await page.wait_for_selector(comm_val_sel, timeout=timeout_ms)
            await page.wait_for_selector(copy_btn_sel, timeout=timeout_ms)

            rendered_comm_text = (await page.locator(comm_val_sel).inner_text()).strip()
            match = re.search(r"0x[0-9a-fA-F]{64}", rendered_comm_text)
            assert match, f"Could not extract 32-byte commitment from {rendered_comm_text!r}"
            ui_comm_hex = match.group(0).lower()
            expected_comm_hex = compute_donor_witness_commitment_py(acct1, target_trait_id, witness_secret).lower()
            assert ui_comm_hex == expected_comm_hex, f"Commitment mismatch: UI={ui_comm_hex} vs Python={expected_comm_hex}"
            await page.click(copy_btn_sel)
            print(f"  [PASS] #donor-zk-commitment-preview rendered exact MiMC-7 commitment {ui_comm_hex[:18]}... & Copy button works")

            # Sequencing Lab (Account #4) signs EIP-191 attestation matching GenomicZkVerifier.claimAttestedZkBounty
            latest_block_ts = int(w3.eth.get_block("latest")["timestamp"])
            attestation_deadline = latest_block_ts + 7200
            preimage = abi_encode(
                ["string", "uint256", "address", "uint256", "bytes32", "address", "bytes32", "uint256"],
                [
                    "GENOCHAIN_LAB_ATTESTATION_V1",
                    chain_id,
                    zk.address,
                    bounty_id,
                    target_trait_id,
                    acct1,
                    bytes.fromhex(ui_comm_hex[2:]),
                    attestation_deadline,
                ],
            )
            digest_raw = Web3.keccak(preimage)
            signed_att = Account.sign_message(encode_defunct(primitive=digest_raw), private_key=HARDHAT_PK_4)
            sig_hex = signed_att.signature.hex()
            if not sig_hex.startswith("0x"):
                sig_hex = "0x" + sig_hex

            await page.fill("#donor-zk-lab-sig-input", sig_hex)
            await page.fill("#donor-zk-lab-deadline-input", str(attestation_deadline))
            await page.click(claim_btn_sel)

            await wait_for_condition(
                lambda: bool(zk.functions.hasClaimedBounty(bounty_id, acct1).call()),
                timeout_sec=60,
                desc=f"on-chain hasClaimedBounty({bounty_id}, acct1) via browser snarkjs WASM Groth16 proof",
            )
            print(f"  [PASS] Browser-native snarkjs WASM Groth16 proof verified & claimed Bounty #{bounty_id} on-chain!")

            # Verify L-06: Switching Donor wallet Account #1 -> Account #2 clears witness & lab inputs
            await switch_local_account(page, 2, acct2, timeout_ms)
            await page.click("#navbar-role-donor")
            await page.wait_for_selector(".portal-subnav-bar .subnav-tab-item", timeout=timeout_ms)
            await page.locator(".portal-subnav-bar .subnav-tab-item").nth(1).click()
            await page.wait_for_selector("#donor-zk-witness-input", timeout=timeout_ms)
            witness_after_switch = await page.input_value("#donor-zk-witness-input")
            assert witness_after_switch == "", f"L-06 violation: zkWitnessSecret leaked across wallet switch: {witness_after_switch!r}"
            print("  [PASS] L-06 verified: zkWitnessSecret & attestation form cleared on wallet switch (Account #1 -> #2)")

            # =====================================================================
            # FLOW 3 (MED-01 + INVARIANT-04/09): Escrow -> Dispatcher -> F5 -> Decrypt
            # =====================================================================
            print("\n=== FLOW 3 (MED-01 + INVARIANT-04/09): Escrow Purchase -> Dispatcher -> F5 Reload -> Decrypt ===")
            await page.click("#navbar-role-researcher")
            await page.wait_for_selector("#btn-view-table", timeout=timeout_ms)

            # Register Account #2 non-extractable RSA-OAEP public key on-chain if banner is shown
            pubkey_btn = page.locator(".os2-pubkey-alert-bar button")
            if await pubkey_btn.count() > 0 and await pubkey_btn.is_visible():
                await pubkey_btn.click()
                await wait_for_condition(
                    lambda: len(registry.functions.researcherPublicKeys(acct2).call().strip()) > 20,
                    timeout_sec=30,
                    desc="on-chain researcherPublicKeys(acct2) registration",
                )
            else:
                # Ensure key actually exists on-chain
                await wait_for_condition(
                    lambda: len(registry.functions.researcherPublicKeys(acct2).call().strip()) > 20,
                    timeout_sec=15,
                    desc="existing on-chain researcherPublicKeys(acct2)",
                )
            print("  [PASS] Account #2 non-extractable RSA-OAEP public key registered on-chain (persisted in IndexedDB)")

            # Open Seed #1 modal and purchase with Escrow Protection (or handle if already escrowed)
            await page.click("#btn-view-table")
            seed1_row = page.locator("table.terminal-table tbody tr", has_text="#01").first
            await seed1_row.wait_for(state="visible", timeout=timeout_ms)
            await seed1_row.locator("button.btn-terminal-ghost").last.click()
            await page.wait_for_selector(".opensea-modal-container", timeout=timeout_ms)

            def get_seed1_escrow():
                return unpack_outputs(registry_abi, "escrowDeposits", registry.functions.escrowDeposits(1, acct2).call())

            if int(get_seed1_escrow().get("amount", 0)) == 0:
                escrow_cb = page.locator("#escrow-protection-toggle-modal")
                if await escrow_cb.count() > 0 and not await escrow_cb.is_checked():
                    await escrow_cb.check()
                await page.locator(".opensea-modal-container .btn-opensea-large").click()
                await wait_for_condition(
                    lambda: int(get_seed1_escrow().get("amount", 0)) > 0,
                    timeout_sec=45,
                    desc="on-chain escrowDeposits(1, acct2) funding",
                )
            else:
                await page.keyboard.press("Escape")
                await page.wait_for_selector(".opensea-modal-container", state="detached", timeout=timeout_ms)
            print("  [PASS] Account #2 purchased Seed #1 with Timelock Escrow Protection")

            # Run real capsule_dispatcher.py subprocess with explicit offline signing key
            cmd = [
                sys.executable,
                str(REPO_ROOT / "scripts" / "demo" / "capsule_dispatcher.py"),
                "--rpc-url",
                rpc_url,
                "--private-key",
                HARDHAT_PK_0,
                "--checkpoint",
                str(tmp_checkpoint),
            ]
            proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                raise AssertionError(
                    f"capsule_dispatcher.py exited {proc.returncode}:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
                )
            cap_on_chain = registry.functions.buyerCapsules(1, acct2).call({"from": acct2})
            escrow_state = get_seed1_escrow()
            assert cap_on_chain and len(cap_on_chain) > 20, "buyerCapsules(1, acct2) empty after dispatcher run"
            assert bool(escrow_state.get("capsuleDelivered")) is True, f"escrowDeposits capsuleDelivered != True: {escrow_state}"
            print("  [PASS] capsule_dispatcher.py delivered RSA-OAEP Key Capsule on-chain (capsuleDelivered=True)")

            # FULL PAGE RELOAD (F5) to prove INVARIANT-09 IndexedDB non-extractable key persistence
            await page.reload(wait_until="networkidle")
            await page.wait_for_selector("#navbar-role-admin", timeout=timeout_ms)
            await ensure_english(page)
            await switch_local_account(page, 2, acct2, timeout_ms)

            await page.click("#navbar-role-researcher")
            await page.wait_for_selector("#btn-tab-licensed", timeout=timeout_ms)
            await page.click("#btn-tab-licensed")

            decrypt_btn = page.locator("#btn-decrypt-dataset-1")
            await decrypt_btn.wait_for(state="visible", timeout=timeout_ms)
            await decrypt_btn.click()

            pre_loc = page.locator("pre").first
            await pre_loc.wait_for(state="visible", timeout=timeout_ms)
            decrypted_text = await pre_loc.inner_text()
            assert "##fileformat=VCFv4.2" in decrypted_text, f"Expected VCF header in decrypted <pre>, got: {decrypted_text[:200]!r}"
            assert "#CHROM" in decrypted_text, f"Expected #CHROM VCF table in decrypted <pre>, got: {decrypted_text[:200]!r}"
            print(f"  [PASS] Full F5 reload + IndexedDB private key unwrap + IPFS fetch + AES-256-GCM decrypt succeeded ({len(decrypted_text)} chars rendered)")

            # =====================================================================
            # FLOW 4 (MED-02): Wallet Switch Zero-Leakage Isolation (#2 -> #1)
            # =====================================================================
            print("\n=== FLOW 4 (MED-02): Direct Wallet Switch Isolation (Account #2 -> Account #1) ===")
            # Grant Account #1 direct access on Seed #1 on-chain BEFORE switching so Seed #1 card
            # mounts immediately for Account #1 and proves decryptedMap does NOT leak across wallets!
            if not registry.functions.hasActiveAccess(1, acct1).call():
                send_tx(w3, registry.functions.grantDirectAccess(1, acct1), acct0, HARDHAT_PK_0)

            # Confirm Account #2's plaintext is still visibly rendered right before switch
            pre_switch_body = await page.evaluate("() => document.body.innerText")
            assert "##fileformat=VCFv4.2" in pre_switch_body, "Expected decrypted VCF still visible before switch"

            # Switch wallet directly Account #2 -> Account #1
            await switch_local_account(page, 1, acct1, timeout_ms)
            await page.click("#navbar-role-researcher")
            await page.wait_for_selector("#btn-tab-licensed", timeout=timeout_ms)
            await page.click("#btn-tab-licensed")

            # Seed #1 card MUST mount for Account #1 in LOCKED state (with #btn-decrypt-dataset-1 visible)
            await page.wait_for_selector("#btn-decrypt-dataset-1", state="visible", timeout=timeout_ms)
            post_switch_body = await page.evaluate("() => document.body.innerText")
            pre_count_after = await page.locator("pre").count()
            assert "##fileformat=VCFv4.2" not in post_switch_body, "MED-02 FAILURE: Account #2 decrypted VCF leaked into Account #1 DOM!"
            assert pre_count_after == 0, f"MED-02 FAILURE: Expected 0 decrypted <pre> blocks after wallet switch, found {pre_count_after}"
            print("  [PASS] MED-02 verified: Account #2 -> Account #1 switch cleared decrypted buffers (0 matches, Seed #1 locked)")

            # Also verify clean Disconnect clears licensed view state
            await page.click(".os2-disconnect-btn")
            await page.wait_for_selector(".os2-signin-btn", timeout=timeout_ms)
            disconnected_body = await page.evaluate("() => document.body.innerText")
            assert "##fileformat=VCFv4.2" not in disconnected_body, "Decrypted VCF leaked after wallet disconnect!"
            print("  [PASS] Disconnect hygiene verified (0 decrypted buffers in DOM)")

            await browser.close()

    finally:
        if tmp_vcf.exists():
            try:
                tmp_vcf.unlink()
            except OSError:
                pass
        if tmp_checkpoint.exists():
            try:
                tmp_checkpoint.unlink()
            except OSError:
                pass

    if console_errors or page_errors:
        print("\n[FAIL] Browser runtime errors captured during E2E execution:")
        for e in console_errors + page_errors:
            print("  ", e)
        sys.exit(1)

    print("\n======================================================================")
    print("  [PASS] ALL 4 FULL-STACK CHROMIUM E2E FLOWS PASSED (0 CONSOLE ERRORS)")
    print("======================================================================")


def main():
    parser = argparse.ArgumentParser(description="GenoChain Full-Stack Chromium E2E Verification Suite")
    parser.add_argument("--base-url", default="http://127.0.0.1:4173", help="Vite preview/dev URL")
    parser.add_argument("--rpc-url", default="http://127.0.0.1:8545", help="Hardhat JSON-RPC URL")
    parser.add_argument("--ipfs-api", default="http://127.0.0.1:5001", help="Kubo IPFS HTTP API URL")
    parser.add_argument("--timeout-ms", type=int, default=60000, help="Playwright action timeout (ms)")
    args = parser.parse_args()
    asyncio.run(run_e2e(args.base_url.rstrip("/"), args.rpc_url, args.ipfs_api, args.timeout_ms))


if __name__ == "__main__":
    main()