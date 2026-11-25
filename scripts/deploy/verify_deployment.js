import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Post-deployment health, wiring, tokenomics, and governance verification script.
 * Reads deployed addresses from `frontend/src/contracts/contractAddresses.json`
 * (or `OUTPUT_CONTRACTS_DIR/contractAddresses.json`) and exits non-zero on failure.
 */
async function main() {
  const targetNetwork =
    process.env.DEPLOY_TARGET_NETWORK || hre.network?.name || hre.globalOptions?.network || "localhost";
  const connection = await hre.network.connect(targetNetwork);
  const { ethers } = connection;

  const contractsDir = path.resolve(process.env.OUTPUT_CONTRACTS_DIR || "frontend/src/contracts");
  const addrPath = path.join(contractsDir, "contractAddresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error(`Missing ${addrPath}. Run deployment before verify_deployment.js.`);
  }

  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const networkInfo = await ethers.provider.getNetwork();
  const actualChainId = BigInt(networkInfo.chainId);

  let failures = 0;
  let warnings = 0;

  function check(label, ok, detail = "") {
    if (ok) {
      console.log(`[PASS] ${label}${detail ? ` (${detail})` : ""}`);
    } else {
      failures += 1;
      console.error(`[FAIL] ${label}${detail ? ` (${detail})` : ""}`);
    }
    return ok;
  }

  function warn(label, detail = "") {
    warnings += 1;
    console.warn(`[WARN] ${label}${detail ? ` (${detail})` : ""}`);
  }

  function sameAddress(a, b) {
    if (!a || !b || !ethers.isAddress(a) || !ethers.isAddress(b)) return false;
    return ethers.getAddress(a) === ethers.getAddress(b);
  }

  console.log("==================================================");
  console.log("[VERIFY] GenoChain Post-Deployment Verification");
  console.log("==================================================");
  console.log(`Target Network : ${targetNetwork}`);
  console.log(`RPC Chain ID   : ${actualChainId.toString()}`);
  console.log(`Addresses File : ${addrPath}`);

  if (addresses.chainId !== undefined && addresses.chainId !== null) {
    check(
      "Chain ID matches contractAddresses.json",
      BigInt(addresses.chainId) === actualChainId,
      `expected=${addresses.chainId}, actual=${actualChainId.toString()}`
    );
  }

  const requiredNames = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier"];
  for (const name of requiredNames) {
    const addr = addresses[name];
    const validAddr = Boolean(addr && ethers.isAddress(addr) && addr !== ethers.ZeroAddress);
    if (!check(`${name} address valid`, validAddr, addr || "missing")) {
      continue;
    }
    const code = await ethers.provider.getCode(addr);
    check(`${name} has on-chain bytecode`, code && code !== "0x", addr);
  }

  if (addresses.GenomicTimelock && ethers.isAddress(addresses.GenomicTimelock)) {
    const timelockCode = await ethers.provider.getCode(addresses.GenomicTimelock);
    check("GenomicTimelock has on-chain bytecode", timelockCode && timelockCode !== "0x", addresses.GenomicTimelock);
  } else {
    console.log("[INFO] GenomicTimelock not configured in contractAddresses.json (optional on local dev).");
  }

  if (failures > 0) {
    console.error(`\n[SUMMARY] Aborting deeper checks due to ${failures} address/bytecode failure(s).`);
    process.exitCode = 1;
    return;
  }

  const token = await ethers.getContractAt("GenomicToken", addresses.GenomicToken);
  const nft = await ethers.getContractAt("GenomicNFT", addresses.GenomicNFT);
  const registry = await ethers.getContractAt("GenomicsRegistry", addresses.GenomicsRegistry);
  const zkVerifier = await ethers.getContractAt("GenomicZkVerifier", addresses.GenomicZkVerifier);

  console.log("\n--- 1. Cross-Contract Wiring ---");
  const nftRegistry = await nft.registryContract();
  check("GenomicNFT.registryContract() == GenomicsRegistry", sameAddress(nftRegistry, addresses.GenomicsRegistry), nftRegistry);

  const regToken = await registry.paymentToken();
  check("GenomicsRegistry.paymentToken() == GenomicToken", sameAddress(regToken, addresses.GenomicToken), regToken);

  const regNft = await registry.genomicNFT();
  check("GenomicsRegistry.genomicNFT() == GenomicNFT", sameAddress(regNft, addresses.GenomicNFT), regNft);

  const regZk = await registry.zkVerifier();
  check("GenomicsRegistry.zkVerifier() == GenomicZkVerifier", sameAddress(regZk, addresses.GenomicZkVerifier), regZk);

  console.log("\n--- 2. Tokenomics & Faucet Policy ($GENO) ---");
  const [totalSupply, maxSupply, faucetEnabled, faucetVoucherRequired] = await Promise.all([
    token.totalSupply(),
    token.MAX_TOTAL_SUPPLY(),
    token.faucetEnabled(),
    token.faucetVoucherRequired(),
  ]);
  check(
    "GenomicToken.totalSupply() <= MAX_TOTAL_SUPPLY",
    totalSupply <= maxSupply,
    `${ethers.formatEther(totalSupply)} / ${ethers.formatEther(maxSupply)} GENO`
  );
  console.log(`[INFO] Faucet status: faucetEnabled=${faucetEnabled}, faucetVoucherRequired=${faucetVoucherRequired}`);
  if (actualChainId !== 31337n && faucetEnabled && !faucetVoucherRequired) {
    warn(
      "Public network has open faucet without voucher requirement",
      `chainId=${actualChainId.toString()}; consider DISABLE_FAUCET=1 or FAUCET_VOUCHER_SIGNER`
    );
  }

  console.log("\n--- 3. Governance & Operational Safety ---");
  const governed = [
    ["GenomicToken", token],
    ["GenomicNFT", nft],
    ["GenomicsRegistry", registry],
    ["GenomicZkVerifier", zkVerifier],
  ];
  for (const [name, contract] of governed) {
    const [ownerAddr, pendingOwnerAddr] = await Promise.all([contract.owner(), contract.pendingOwner()]);
    check(`${name}.owner() is non-zero`, ownerAddr !== ethers.ZeroAddress, ownerAddr);
    const timelockOwned = addresses.GenomicTimelock && sameAddress(ownerAddr, addresses.GenomicTimelock);
    console.log(
      `[INFO] ${name} owner=${ownerAddr}${timelockOwned ? " (GenomicTimelock)" : ""}, pendingOwner=${pendingOwnerAddr}`
    );
  }

  const [dispatcher, commitReveal] = await Promise.all([
    registry.capsuleDispatcher(),
    registry.commitRevealRequired(),
  ]);
  console.log(`[INFO] GenomicsRegistry.capsuleDispatcher=${dispatcher}, commitRevealRequired=${commitReveal}`);

  console.log("\n--- 4. Dataset & ZK State Sanity ---");
  const [dataCount, vkEpoch] = await Promise.all([registry.dataCount(), zkVerifier.vkEpoch()]);
  console.log(`[INFO] GenomicsRegistry.dataCount=${dataCount.toString()}, GenomicZkVerifier.vkEpoch=${vkEpoch.toString()}`);
  if (dataCount > 0n) {
    const firstRecord = await registry.getGenomicData(1n);
    check(
      "Sample dataset #1 has valid owner and rawDataHash",
      firstRecord.currentOwner !== ethers.ZeroAddress && firstRecord.rawDataHash !== ethers.ZeroHash,
      `currentOwner=${firstRecord.currentOwner}`
    );
  }

  console.log("\n==================================================");
  console.log(`[SUMMARY] Verification complete: failures=${failures}, warnings=${warnings}`);
  console.log("==================================================");
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[ERROR] Verification script failed:", err);
  process.exitCode = 1;
});
