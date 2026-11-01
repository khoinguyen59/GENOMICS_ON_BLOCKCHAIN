/**
 * Dataset Service
 * Orchestrates client-side encryption, IPFS decentralization, smart contract transactions,
 * ECIES/PRE key capsule exchange, and in-memory cryptographic verification.
 */
import { ethers } from "ethers";
import {
  encryptGenomicData,
  encryptGenomicDataChunked,
  decryptGenomicPayload,
  decryptGenomicDataChunked,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash,
  generateClinicalPdfReport,
  loadPersistentKeyPair,
  saveOwnerCapsulePersistent,
  loadOwnerCapsulePersistent,
  exportSovereignKeyVault,
  importSovereignKeyVault
} from "../../../crypto/client_crypto.js";
import { buildPhenopacket } from "../../../ipfs/phenopacket_builder.js";
import {
  uploadEncryptedRawData,
  uploadEncryptedSummaryReport,
  uploadPhenopacketMetadata,
  retrieveFromIpfs,
  computeIpfsCidV0
} from "../../../ipfs/pinata_uploader.js";
import contractAddresses from "../contracts/contractAddresses.json";
import GenomicsRegistryABI from "../contracts/GenomicsRegistryABI.json";
import GenomicTokenABI from "../contracts/GenomicTokenABI.json";
import { executeSerializedTx, smartReadWithRetry } from "../utils/asyncResilience.js";

/**
 * 3-Step Client-Side Encryption, IPFS Storage, and Smart Contract Registration Pipeline
 */
export async function publishGenomicDataset({
  rawFileText,
  rawFileBlob,
  isChunked = false,
  subjectId,
  disease,
  geneSymbol,
  hpoCode,
  ancestryRegion,
  priceGeno,
  durationDays,
  account,
  signer,
  onStepProgress,
  onChunkProgress
}) {
  if (!account || !signer) {
    throw new Error("Wallet not connected.");
  }

  // Step 1: Client-Side WebCrypto Encryption (Chunked Streaming or Standard)
  onStepProgress?.(1);
  let encryptedRaw;
  const isLargeOrChunked =
    isChunked ||
    Boolean(rawFileBlob) ||
    (typeof rawFileText === "string" && rawFileText.length > 10 * 1024 * 1024);

  if (isLargeOrChunked) {
    const inputData = rawFileBlob || rawFileText;
    encryptedRaw = await encryptGenomicDataChunked(inputData, {
      onProgress: onChunkProgress
    });
  } else {
    encryptedRaw = await encryptGenomicData(rawFileText);
  }

  const clinicalPdf = generateClinicalPdfReport({
    subjectId,
    disease,
    gene: geneSymbol,
    variant: "Verified Next-Gen Sequencing Variant"
  });
  const encryptedSummary = await encryptGenomicData(
    clinicalPdf,
    encryptedRaw.activeKey || encryptedRaw.keyHex
  );

  // Step 2: IPFS Decentralized Pinning
  onStepProgress?.(2);
  const rawUpload = await uploadEncryptedRawData(encryptedRaw.payload, `${subjectId}_raw.enc`);
  const rawCid = rawUpload?.cid || rawUpload;

  const summaryUpload = await uploadEncryptedSummaryReport(encryptedSummary.payload, `${subjectId}_report.enc`);
  const summaryCid = summaryUpload?.cid || summaryUpload;

  const phenopacket = buildPhenopacket({
    subjectId,
    disease,
    phenotypes: [{ id: hpoCode.split(/\s*-\s*/)[0], label: hpoCode.split(/\s*-\s*/)[1] || disease }],
    variants: [{ gene: geneSymbol, hgvs: "c.3454G>A", zygosity: "heterozygous" }],
    rawDataHash: encryptedRaw.rawDataHash,
    rawCid: rawCid,
    summaryCid: summaryCid,
    summaryDataHash: encryptedSummary.rawDataHash,
    ancestry: ancestryRegion
  });
  const metaUpload = await uploadPhenopacketMetadata(phenopacket);
  const metadataCid = metaUpload?.cid || metaUpload;

  // Secure creator key locally (dual-layer: persistent IndexedDB + localStorage)
  try {
    const ownerKeyPair = await loadPersistentKeyPair(account);
    if (ownerKeyPair) {
      const ownerPubJwk = await exportPublicKey(ownerKeyPair.publicKey);
      const ownerCapsule = await packageKeyCapsule(encryptedRaw.keyHex, ownerPubJwk, account, account);
      await saveOwnerCapsulePersistent(rawCid, ownerCapsule);
    }
  } catch (e) {
    console.warn("Owner capsule packaging note:", e);
  }

  // Step 3: Smart Contract Mint & Escrow Registration
  onStepProgress?.(3);
  const registryWithSigner = new ethers.Contract(
    contractAddresses.GenomicsRegistry,
    GenomicsRegistryABI,
    signer
  );

  const priceWei = ethers.parseUnits(priceGeno.toString(), 18);
  const durationSeconds = durationDays * 86400;
  const royaltyBps = 1000; // 10% EIP-2981

  const tx = await registryWithSigner.registerGenomicData(
    encryptedRaw.rawDataHash,
    rawCid,
    summaryCid,
    metadataCid,
    `ipfs://${metadataCid}`,
    priceWei,
    durationSeconds,
    royaltyBps
  );
  await tx.wait();

  return {
    rawDataHash: encryptedRaw.rawDataHash,
    rawCid,
    summaryCid,
    metadataCid
  };
}

/**
 * Data Status Updates (Pause / Resume / Revoke) - Enforces onlyDataOwner
 */
export async function updateDatasetStatus({ dataId, newStatusNum, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
  const tx = await registry.updateDataStatus(dataId, newStatusNum);
  await tx.wait();
  return tx;
}

/**
 * Data Access Fee Update - Enforces onlyDataOwner Access Control
 */
export async function updateDatasetPrice({ dataId, newPriceGeno, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
  const newPriceWei = ethers.parseUnits(newPriceGeno.toString(), 18);
  const tx = await registry.updateDataPrice(dataId, newPriceWei);
  await tx.wait();
  return tx;
}

/**
 * Grant Direct Viewing Access without payment - Enforces onlyDataOwner Access Control
 */
export async function grantDirectDatasetAccess({ dataId, recipientAddress, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  if (!ethers.isAddress(recipientAddress)) throw new Error("Invalid recipient EVM address.");
  const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
  const tx = await registry.grantDirectAccess(dataId, recipientAddress);
  await tx.wait();
  return tx;
}

/**
 * Dispatch Key Capsule to a buyer on-chain via storeTransformedCapsule or gas-optimized emitTransformedCapsule
 */
export async function dispatchCapsuleToBuyer({
  dataId,
  recipientAddress,
  recipientPublicKeyJwk,
  rawCid,
  ownerAddress,
  signer,
  useEventOnly = false
}) {
  if (!signer) throw new Error("Wallet not connected.");
  const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);

  let keyHex = null;
  const ownerCapsule = await loadOwnerCapsulePersistent(rawCid);
  if (ownerCapsule) {
    const ownerKeyPair = await loadPersistentKeyPair(ownerAddress);
    if (ownerKeyPair) {
      const recovered = await decryptKeyCapsule(ownerCapsule, ownerKeyPair.privateKey);
      keyHex = recovered?.keyHex;
    }
  }

  // Clean up legacy unencrypted key if present
  if (typeof window !== "undefined" && window.localStorage) {
    if (window.localStorage.getItem(`GENO_DATA_KEY_${rawCid}`)) {
      window.localStorage.removeItem(`GENO_DATA_KEY_${rawCid}`);
    }
  }

  if (!keyHex) {
    throw new Error("Dataset decryption key not found on this device.");
  }

  const capsule = await packageKeyCapsule(keyHex, recipientPublicKeyJwk, recipientAddress, ownerAddress);

  let tx;
  if (useEventOnly && typeof registry.emitTransformedCapsule === "function") {
    // Gas-optimized path: emit CapsuleStored event log (~6,000 gas vs ~550,000 gas)
    tx = await registry.emitTransformedCapsule(dataId, recipientAddress, capsule);
  } else {
    tx = await registry.storeTransformedCapsule(dataId, recipientAddress, capsule);
  }
  await tx.wait();
  return tx;
}

/**
 * Purchase Access via Escrow and Auto-disburse 10% Royalty
 */
export async function purchaseDatasetAccess({ dataset, account, signer, researcherKeyPair }) {
  if (!account || !signer) throw new Error("Wallet not connected.");

  return executeSerializedTx(account, async () => {
    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, signer);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);

    const priceWei = ethers.parseUnits(dataset.price.toString(), 18);
    const balWei = await token.balanceOf(account);

    if (balWei < priceWei) {
      throw new Error("Insufficient $GENO balance. Use +1,000 Faucet to fund wallet.");
    }

    // 1/2: Check and approve allowance if needed
    const currentAllowance = await token.allowance(account, contractAddresses.GenomicsRegistry);
    if (currentAllowance < priceWei) {
      const approveTx = await token.approve(contractAddresses.GenomicsRegistry, priceWei);
      await approveTx.wait();
    }

    // 2/2: Grant access with escrow settlement
    const buyTx = await registry.grantAccess(dataset.dataId);
    await buyTx.wait();
    return buyTx;
  });
}

/**
 * Purchase Access with Timelocked Escrow Protection & Dispute Window Refund Guarantee
 */
export async function purchaseDatasetWithEscrow({ dataset, disputeWindowDays = 1, account, signer }) {
  if (!account || !signer) throw new Error("Wallet not connected.");

  return executeSerializedTx(account, async () => {
    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, signer);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);

    const priceWei = ethers.parseUnits(dataset.price.toString(), 18);
    const balWei = await token.balanceOf(account);

    if (balWei < priceWei) {
      throw new Error("Insufficient $GENO balance. Use +1,000 Faucet to fund wallet.");
    }

    const currentAllowance = await token.allowance(account, contractAddresses.GenomicsRegistry);
    if (currentAllowance < priceWei) {
      const approveTx = await token.approve(contractAddresses.GenomicsRegistry, priceWei);
      await approveTx.wait();
    }

    const disputeWindowSeconds = Math.max(3600, disputeWindowDays * 86400);
    const buyTx = await registry.grantAccessWithEscrow(dataset.dataId, disputeWindowSeconds);
    await buyTx.wait();
    return buyTx;
  });
}

/**
 * Claim 100% Escrow Refund if capsule is not delivered within the dispute window
 */
export async function claimDatasetEscrowRefund({ dataId, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
  const tx = await registry.claimEscrowRefund(dataId);
  await tx.wait();
  return tx;
}

/**
 * Query active escrow deposit details for a dataset purchase
 */
export async function checkDatasetEscrowStatus({ dataId, account, contracts }) {
  if (!contracts?.registry || !account) return null;
  try {
    const dep = await contracts.registry.escrowDeposits(dataId, account);
    return {
      buyer: dep.buyer,
      amount: Number(ethers.formatUnits(dep.amount, 18)),
      amountWei: dep.amount,
      depositTime: Number(dep.depositTime),
      disputeWindow: Number(dep.disputeWindow),
      released: dep.released,
      refunded: dep.refunded,
      isPending: dep.amount > 0n && !dep.released && !dep.refunded,
    };
  } catch (e) {
    console.warn("Escrow status query error:", e);
    return null;
  }
}

/**
 * Internal helper to resolve the symmetric AES key via on-chain buyer capsule,
 * event-driven logs, or persistent owner capsule (zero-knowledge, non-extractable)
 */
async function resolveAesKeyForDataset({ dataset, account, contracts, researcherKeyPair }) {
  // 1. Try to fetch on-chain capsule stored for buyer from contract storage
  let capsuleJson = "";
  try {
    capsuleJson = await contracts.registry.getTransformedCapsule(dataset.dataId, { from: account });
  } catch (_) {
    try {
      capsuleJson = await contracts.registry.getTransformedCapsule.staticCall(dataset.dataId, { from: account });
    } catch {
      try {
        capsuleJson = await contracts.registry.buyerCapsules(dataset.dataId, account);
      } catch {
        try {
          capsuleJson = await contracts.registry.getCapsuleForBuyer(dataset.dataId, account);
        } catch {
          capsuleJson = "";
        }
      }
    }
  }

  // 1b. Event-driven retrieval fallback if mapping is empty (Gas-optimized retrieval)
  if ((!capsuleJson || capsuleJson.trim().length === 0) && contracts?.registry?.filters?.CapsuleStored) {
    try {
      const filter = contracts.registry.filters.CapsuleStored(dataset.dataId, account);
      const events = await contracts.registry.queryFilter(filter, 0, "latest");
      if (events && events.length > 0) {
        const latestEvent = events[events.length - 1];
        capsuleJson = latestEvent.args?.capsule || latestEvent.args?.[2] || "";
      }
    } catch (evErr) {
      console.warn("Event-driven capsule retrieval note:", evErr);
    }
  }

  if (capsuleJson && capsuleJson.trim().length > 0) {
    try {
      const recovered = await decryptKeyCapsule(capsuleJson, researcherKeyPair.privateKey);
      if (recovered?.keyHex) return recovered.keyHex;
    } catch (e) {
      console.warn("Buyer capsule decryption error:", e);
    }
  }

  // 2. Check if caller is data owner with persistent capsule in IndexedDB or localStorage
  const ownerCapsule = await loadOwnerCapsulePersistent(dataset.rawCid);
  if (ownerCapsule) {
    try {
      const isOwner = account && dataset.owner && account.toLowerCase() === dataset.owner.toLowerCase();
      const ownerKp = isOwner ? researcherKeyPair : await loadPersistentKeyPair(dataset.owner);
      if (ownerKp?.privateKey) {
        const recovered = await decryptKeyCapsule(ownerCapsule, ownerKp.privateKey);
        if (recovered?.keyHex) return recovered.keyHex;
      }
    } catch (e) {
      console.warn("Owner capsule recovery note:", e);
    }
  }

  throw new Error("Access capsule pending distribution from data owner or capsule dispatcher.");
}

/**
 * In-Memory Decryption: Download Ciphertext -> Verify SHA-256 Hash -> Resolve Capsule -> AES-256-GCM
 * Supports both standard single-payload and GA4GH Crypt4GH chunked streaming packages!
 */
export async function decryptDatasetPayload({ dataset, account, contracts, researcherKeyPair, onProgress }) {
  if (!researcherKeyPair) {
    throw new Error("Decryption keypair not initialized.");
  }

  // 1/4: Fetch ciphertext blob from IPFS with resilient exponential backoff (p-retry)
  const downloadedBlob = await smartReadWithRetry(() => retrieveFromIpfs(dataset.rawCid));

  // 2/4: Cryptographic integrity check against on-chain anchor
  const computedHash = await computeDataHash(downloadedBlob);
  if (computedHash.toLowerCase() !== dataset.rawDataHash.toLowerCase()) {
    throw new Error("Cryptographic tamper detected: Downloaded blob hash does not match On-Chain Anchor!");
  }

  // 3/4: Resolve ECIES Key Capsule
  const recoveredAesKey = await resolveAesKeyForDataset({ dataset, account, contracts, researcherKeyPair });

  // 4/4: In-Memory AES-256-GCM Decryption (Auto-detects chunked streaming GNC1 packages with fallback)
  const decryptedPlaintext = await decryptGenomicDataChunked(downloadedBlob, recoveredAesKey, { onProgress });

  return decryptedPlaintext;
}

/**
 * Export Sovereign Encrypted Key Vault Backup (.json)
 */
export async function exportSovereignVault({ signer, account, password }) {
  return await exportSovereignKeyVault({ signer, account, password });
}

/**
 * Import Sovereign Encrypted Key Vault Backup (.json)
 */
export async function importSovereignVault({ signer, account, backupData, password }) {
  return await importSovereignKeyVault({ signer, account, backupData, password });
}

/**
 * Decrypt Clinical Summary Report (.pdf) using on-chain capsule and return Uint8Array bytes
 */
export async function decryptSummaryReport({ dataset, account, contracts, researcherKeyPair }) {
  if (!researcherKeyPair) {
    throw new Error("Decryption keypair not initialized.");
  }
  if (!dataset.summaryCid) {
    throw new Error("No clinical summary report CID associated with this dataset.");
  }

  // 1. Fetch ciphertext blob from IPFS with resilient exponential backoff (p-retry)
  const downloadedBlob = await smartReadWithRetry(() => retrieveFromIpfs(dataset.summaryCid));

  // 1b. Cryptographic SHA-256 integrity check & Dual-Anchor Verification (Invariant 05 & DEF2-2-06)
  const computedHash = await computeDataHash(downloadedBlob);
  if (!computedHash || !/^0x[0-9a-fA-F]{64}$/.test(computedHash)) {
    throw new Error("Integrity check failed: Computed SHA-256 hash is invalid.");
  }

  if (dataset.summaryDataHash) {
    const expectedHash = (dataset.summaryDataHash.startsWith("0x")
      ? dataset.summaryDataHash
      : "0x" + dataset.summaryDataHash
    ).toLowerCase();
    if (computedHash.toLowerCase() !== expectedHash) {
      throw new Error("Cryptographic tamper detected: Downloaded summary report hash does not match On-Chain Anchor!");
    }
  }

  if (dataset.summaryCid && dataset.summaryCid.startsWith("Qm")) {
    const computedCid = await computeIpfsCidV0(downloadedBlob);
    if (computedCid !== dataset.summaryCid) {
      throw new Error("Cryptographic tamper detected: Downloaded summary CID does not match On-Chain Anchor CID!");
    }
  }

  // 2. Resolve ECIES Key Capsule
  const recoveredAesKey = await resolveAesKeyForDataset({ dataset, account, contracts, researcherKeyPair });

  // 3. Decrypt binary PDF payload (asString = false)
  const decryptedPdfBytes = await decryptGenomicPayload(downloadedBlob, recoveredAesKey, false);
  return decryptedPdfBytes;
}

/**
 * Retrieve and parse GA4GH Phenopacket v2 JSON metadata from IPFS
 */
export async function fetchPhenopacketMetadata({ metadataCid }) {
  if (!metadataCid) throw new Error("Metadata CID is missing.");
  const bytes = await smartReadWithRetry(() => retrieveFromIpfs(metadataCid));
  const jsonText = new TextDecoder().decode(bytes);
  return JSON.parse(jsonText);
}
