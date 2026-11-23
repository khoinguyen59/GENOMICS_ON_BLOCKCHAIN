import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

function parseEnvFlag(name) {
  const val = String(process.env[name] || "").trim().toLowerCase();
  return val === "1" || val === "true" || val === "yes";
}

async function main() {
  const targetNetwork = hre.network?.name || hre.globalOptions?.network || "localhost";
  const connection = await hre.network.connect(targetNetwork);
  const { ethers } = connection;
  const [signer] = await ethers.getSigners();
  const fastForwardLocal = parseEnvFlag("TIMELOCK_LOCAL_FAST_FORWARD");

  const localVaultDir = path.resolve(process.env.LOCAL_VAULT_DIR || ".local");
  const contractsDir = path.resolve(process.env.OUTPUT_CONTRACTS_DIR || "frontend/src/contracts");
  const handoffPath = path.join(localVaultDir, "timelock_handoff.json");
  const addrPath = path.join(contractsDir, "contractAddresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error(`Missing ${addrPath}. Deploy contracts first.`);
  }
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const handoff = fs.existsSync(handoffPath) ? JSON.parse(fs.readFileSync(handoffPath, "utf8")) : null;

  const timelockAddress = handoff?.timelockAddress || addresses.GenomicTimelock;
  if (!timelockAddress || !ethers.isAddress(timelockAddress)) {
    throw new Error("No GenomicTimelock address found. Deploy with ENABLE_TIMELOCK=1 first.");
  }

  const timelock = await ethers.getContractAt("GenomicTimelock", timelockAddress, signer);
  const acceptIface = new ethers.Interface(["function acceptOwnership()"]);
  const acceptCalldata = acceptIface.encodeFunctionData("acceptOwnership", []);

  const targets = handoff?.targets || [
    addresses.GenomicToken,
    addresses.GenomicNFT,
    addresses.GenomicsRegistry,
    addresses.GenomicZkVerifier,
  ];
  const values = (handoff?.values || targets.map(() => 0)).map((v) => BigInt(v));
  const payloads = handoff?.payloads || targets.map(() => acceptCalldata);
  const predecessor = handoff?.predecessor || ethers.ZeroHash;
  const salt = handoff?.salt || ethers.id(`GENOCHAIN_TIMELOCK_HANDOFF_${timelockAddress.toLowerCase()}`);
  const minDelay = BigInt(await timelock.getMinDelay());
  const handoffDelay = handoff?.minDelaySec !== undefined ? BigInt(handoff.minDelaySec) : 0n;
  const delay = handoffDelay > minDelay ? handoffDelay : minDelay;

  const opId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
  console.log("==================================================");
  console.log("[GOV] GenomicTimelock Ownable2Step Accept Ownership");
  console.log("==================================================");
  console.log(`Network           : ${targetNetwork}`);
  console.log(`Signer            : ${signer.address}`);
  console.log(`GenomicTimelock   : ${timelockAddress}`);
  console.log(`Operation ID      : ${opId}`);
  console.log(`Min Delay (sec)   : ${minDelay.toString()}`);

  const isDone = await timelock.isOperationDone(opId);
  if (isDone) {
    console.log("[GOV] Operation already executed.");
  } else {
    const isPending = await timelock.isOperationPending(opId);
    if (!isPending) {
      console.log("[GOV] Scheduling acceptOwnership() batch on GenomicTimelock...");
      const schedTx = await timelock.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
      await schedTx.wait();
      console.log(`[OK] Batch scheduled (tx=${schedTx.hash}).`);
    } else {
      console.log("[GOV] Batch operation is already scheduled and pending.");
    }

    let isReady = await timelock.isOperationReady(opId);
    if (!isReady) {
      const readyTs = Number(await timelock.getTimestamp(opId));
      const latestBlock = await ethers.provider.getBlock("latest");
      const nowTs = Number(latestBlock?.timestamp || Math.floor(Date.now() / 1000));
      const remaining = Math.max(0, readyTs - nowTs);

      if (fastForwardLocal && (targetNetwork === "localhost" || targetNetwork === "hardhat")) {
        console.log(`[GOV] TIMELOCK_LOCAL_FAST_FORWARD=1 -> advancing local EVM time by ${remaining + 2}s...`);
        await ethers.provider.send("evm_increaseTime", [remaining + 2]);
        await ethers.provider.send("evm_mine", []);
        isReady = await timelock.isOperationReady(opId);
      } else {
        console.log(`[WAIT] Operation not ready yet. Remaining delay: ${remaining}s (ready at UNIX ${readyTs}).`);
        console.log("[WAIT] Re-run this script after the timelock delay elapses to execute acceptOwnership().");
        return;
      }
    }

    if (!isReady) {
      throw new Error("Timelock operation is still not ready after fast-forward.");
    }

    console.log("[GOV] Executing acceptOwnership() batch on GenomicTimelock...");
    const execTx = await timelock.executeBatch(targets, values, payloads, predecessor, salt);
    await execTx.wait();
    console.log(`[OK] Batch executed (tx=${execTx.hash}).`);
  }

  // Verify final ownership across all 4 Ownable2Step contracts
  const labels = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier"];
  for (let i = 0; i < targets.length; i++) {
    const ownable = new ethers.Contract(
      targets[i],
      ["function owner() view returns (address)", "function pendingOwner() view returns (address)"],
      ethers.provider
    );
    const currentOwner = await ownable.owner();
    const pendingOwner = await ownable.pendingOwner();
    const label = labels[i] || targets[i];
    console.log(`[VERIFY] ${label} (${targets[i]}): owner=${currentOwner}, pendingOwner=${pendingOwner}`);
    if (currentOwner.toLowerCase() !== timelockAddress.toLowerCase()) {
      throw new Error(`[GOV] Ownership verification failed for ${label}: expected ${timelockAddress}, got ${currentOwner}`);
    }
  }
  console.log("[SUCCESS] All 4 protocol contracts are now owned by GenomicTimelock.");
}

main().catch((err) => {
  console.error("[GOV] Timelock acceptOwnership failed:", err);
  process.exit(1);
});