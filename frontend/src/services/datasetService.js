/**
 * Dataset Service
 * Orchestrates client-side encryption, IPFS decentralization, smart contract transactions,
 * ECIES/PRE key capsule exchange, and in-memory cryptographic verification.
 */
import { ethers } from "ethers";
import {
  computeDonorWitnessCommitment,
  generateGroth16ProofWithZkey,
  parseExternalGroth16Proof,
} from "../../../crypto/zk/groth16_prover.js";
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
  saveBuyerCapsulePersistent,
  loadBuyerCapsulePersistent,
  exportSovereignKeyVault,
  importSovereignKeyVault
} from "../../../crypto/client_crypto.js";

let cachedZkeyBytesPromise = null;
async function loadBrowserZkeyBytes() {
  if (!cachedZkeyBytesPromise) {
    cachedZkeyBytesPromise = fetch("/zk/genomic_variant.zkey")
      .then(async (resp) => {
        if (!resp.ok) {
          throw new Error(`Unable to fetch Groth16 proving key /zk/genomic_variant.zkey (HTTP ${resp.status}).`);
        }
        return new Uint8Array(await resp.arrayBuffer());
      })
      .catch((err) => {
        cachedZkeyBytesPromise = null;
        throw err;
      });
  }
  return cachedZkeyBytesPromise;
}
import { buildPhenopacket } from "../../../ipfs/phenopacket_builder.js";
import {
  uploadEncryptedRawData,
  uploadEncryptedSummaryReport,
  uploadPhenopacketMetadata,
  retrieveFromIpfs,
  verifySummaryCidIntegrity
} from "../../../ipfs/pinata_uploader.js";
import contractAddresses from "../contracts/contractAddresses.json" with { type: "json" };
import GenomicsRegistryABI from "../contracts/GenomicsRegistryABI.json" with { type: "json" };
import GenomicTokenABI from "../contracts/GenomicTokenABI.json" with { type: "json" };
import GenomicZkVerifierABI from "../contracts/GenomicZkVerifierABI.json" with { type: "json" };
import {
  executeSerializedTx,
  smartReadWithRetry,
  sanitizeGenomicMetadata,
  sanitizeMetadataTree,
  queryFilterChunked,
  isBlockRangeLimitError,
  runWithConcurrency
} from "../utils/asyncResilience.js";

export { queryFilterChunked, isBlockRangeLimitError, verifySummaryCidIntegrity, computeDonorWitnessCommitment };

async function resolveGatewayAuthContext({ signer = null, account = "", contracts = null, dataId = null } = {}) {
  const resolvedSigner = signer || contracts?.signer || null;
  const registryAddress =
    contracts?.registry?.target ||
    contracts?.registry?.address ||
    contractAddresses.GenomicsRegistry ||
    "";
  let chainId = Number(contractAddresses.chainId || 31337);
  try {
    const prov = resolvedSigner?.provider || contracts?.provider || contracts?.registry?.runner?.provider;
    if (prov && typeof prov.getNetwork === "function") {
      const net = await prov.getNetwork();
      if (net?.chainId) chainId = Number(net.chainId);
    }
  } catch {}
  return {
    signer: resolvedSigner,
    account: account || "",
    dataId: dataId !== null && dataId !== undefined ? Number(dataId) : null,
    chainId,
    registryAddress
  };
}

/**
 * Return the deployment block floor from contractAddresses.json so eth_getLogs scans
 * never storm public RPC endpoints starting at genesis block 0.
 * @param {object} [addresses=contractAddresses]
 * @returns {number}
 */
export function getDeploymentStartBlock(addresses = contractAddresses) {
  const raw = Number(addresses?.deployedBlock);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Compute Domain-Separated Blinded Trait Tag (matches GenomicsRegistry.computeBlindTag)
 */
export function computeBlindTagHex(traitKey, traitValue, datasetSaltHex = "GENOCHAIN_COHORT_SALT_V1") {
  const k = String(traitKey || "").trim();
  const v = String(traitValue || "").trim();
  const salt =
    datasetSaltHex && /^0x[0-9a-fA-F]{64}$/.test(datasetSaltHex)
      ? datasetSaltHex
      : ethers.id(String(datasetSaltHex || "GENOCHAIN_COHORT_SALT_V1"));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "bytes32"],
      ["GENOCHAIN_BLIND_TAG_V1", k, v, salt]
    )
  );
}

/**
 * Wait until the EVM chain advances strictly past `commitBlock` before submitting
 * a Commit-Reveal `revealAndRegisterGenomicData*` transaction.
 * Tolerates transient `getBlockNumber()` RPC blips during polling, attempts `evm_mine`
 * once on local dev chains, and throws an actionable timeout error if the chain has NOT
 * advanced past `commitBlock` within `timeoutMs` (never blindly sends a reverting reveal tx).
 * @param {object} provider - Ethers v6 Provider
 * @param {number} commitBlock - Block number in which `commitGenomicData` was mined
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {Promise<number>} Confirmed block number strictly greater than `commitBlock`
 */
export async function waitForCommitRevealNextBlock(
  provider,
  commitBlock,
  { timeoutMs = 15000, pollIntervalMs = 400 } = {}
) {
  const targetCommitBlock = Number(commitBlock);
  if (!Number.isInteger(targetCommitBlock) || targetCommitBlock <= 0) {
    throw new Error(
      `Commit-reveal receipt missing a valid positive blockNumber (got ${commitBlock}). Aborting reveal to avoid a reverting transaction.`
    );
  }
  if (!provider || typeof provider.getBlockNumber !== "function") {
    throw new Error("Commit-reveal block wait requires a provider supporting getBlockNumber().");
  }

  let curBlock = NaN;
  const readHeadSafe = async () => {
    try {
      const val = Number(await provider.getBlockNumber());
      if (Number.isFinite(val)) curBlock = val;
    } catch {
      // Transient RPC blip during polling; keep polling until timeoutMs expires
    }
    return curBlock;
  };

  await readHeadSafe();
  if ((!Number.isFinite(curBlock) || curBlock <= targetCommitBlock) && typeof provider.send === "function") {
    await provider.send("evm_mine", []).catch(() => {});
    await readHeadSafe();
  }

  const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
  const safePoll = Math.max(10, Number(pollIntervalMs) || 400);
  const deadline = Date.now() + safeTimeout;
  while ((!Number.isFinite(curBlock) || curBlock <= targetCommitBlock) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(safePoll, Math.max(10, deadline - Date.now()))));
    await readHeadSafe();
  }

  if (!Number.isFinite(curBlock) || curBlock <= targetCommitBlock) {
    const headLabel = Number.isFinite(curBlock) ? `#${curBlock}` : "unknown";
    throw new Error(
      `Commit-reveal block wait timed out: chain head (${headLabel}) has not advanced past commit block #${targetCommitBlock}. Please wait for the next block before retrying reveal.`
    );
  }
  return curBlock;
}

/**
 * 3-Step Client-Side Encryption, IPFS Storage, and Smart Contract Registration Pipeline
 */
export async function publishGenomicDataset({
  rawFileText,
  rawFileBlob,
  isChunked = false,
  fileSize = 0,
  subjectId,
  disease,
  geneSymbol,
  hpoCode,
  fileFormat = "",
  format = "",
  ancestryRegion,
  bloodGroup = "",
  clinicalSignificance = "Physiological Traits",
  zygosity = "0/1 Heterozygous",
  priceGeno,
  durationDays,
  royaltyBps = 1000,
  blindTagSalt = "GENOCHAIN_COHORT_SALT_V1",
  blindTraits = null,
  account,
  signer,
  onStepProgress,
  onChunkProgress
}) {
  if (!account || !signer) {
    throw new Error("Wallet not connected.");
  }

  // Fail-fast parameter & creator keypair checks BEFORE encrypting or pinning blobs to IPFS
  const trimmedPrice = String(priceGeno ?? "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmedPrice)) {
    throw new Error("Access fee ($GENO) must be a valid positive decimal number (up to 18 decimals).");
  }
  const priceWei = ethers.parseUnits(trimmedPrice, 18);
  if (priceWei <= 0n) {
    throw new Error("Access fee ($GENO) must be greater than 0.");
  }
  const trimmedDuration = String(durationDays ?? "").trim();
  const parsedDurationDays = /^\d+$/.test(trimmedDuration) ? Number(trimmedDuration) : NaN;
  if (!Number.isInteger(parsedDurationDays) || parsedDurationDays < 1 || parsedDurationDays > 365) {
    throw new Error("Access duration must be an integer between 1 and 365 days.");
  }
  const parsedRoyaltyBps =
    royaltyBps === undefined || royaltyBps === null || String(royaltyBps).trim() === ""
      ? 1000
      : Number(royaltyBps);
  if (!Number.isInteger(parsedRoyaltyBps) || parsedRoyaltyBps < 500 || parsedRoyaltyBps > 1000) {
    throw new Error("EIP-2981 royaltyBps must be an integer between 500 (5%) and 1000 (10%).");
  }

  let ownerKeyPair = null;
  try {
    ownerKeyPair = await loadPersistentKeyPair(account);
  } catch (e) {
    throw new Error(
      `Không thể nạp cặp khóa RSA-OAEP của chủ sở hữu từ IndexedDB; đã hủy đúc on-chain để tránh mất khóa giải mã / Failed to load owner RSA-OAEP keypair from IndexedDB; aborted on-chain mint to prevent AES key loss: ${e?.message || e}`
    );
  }
  if (!ownerKeyPair?.publicKey || !ownerKeyPair?.privateKey) {
    throw new Error(
      "Thiếu cặp khóa RSA-OAEP cục bộ của chủ sở hữu trong IndexedDB; đã hủy giao dịch đúc NFT để tránh mất khóa giải mã AES / Missing local owner RSA-OAEP keypair in IndexedDB; aborted on-chain mint to prevent permanent AES key loss."
    );
  }

  // Step 1: Client-Side WebCrypto Encryption (Chunked Streaming or Standard)
  onStepProgress?.(1);
  let encryptedRaw;
  const isLargeOrChunked =
    isChunked ||
    Boolean(rawFileBlob) ||
    fileFormat === "Crypt4GH" ||
    format === "Crypt4GH" ||
    (typeof rawFileText === "string" && rawFileText.length > 64 * 1024);

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
  const cryptoApi = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
  const summaryKeyBytes = new Uint8Array(32);
  cryptoApi.getRandomValues(summaryKeyBytes);
  const summaryKeyHex = Array.from(summaryKeyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const encryptedSummary = await encryptGenomicData(clinicalPdf, summaryKeyHex);

  // Step 2: IPFS Decentralized Pinning (Pinata -> SIWE Private IPFS Gateway -> Local Kubo)
  onStepProgress?.(2);
  const uploadAuthCtx = await resolveGatewayAuthContext({ signer, account });
  const rawUpload = await uploadEncryptedRawData(
    encryptedRaw.payload,
    `${subjectId}_raw`,
    null,
    uploadAuthCtx
  );
  const rawCid = rawUpload?.cid || rawUpload;

  const summaryUpload = await uploadEncryptedSummaryReport(
    encryptedSummary.payload,
    `${subjectId}_report`,
    null,
    uploadAuthCtx
  );
  const summaryCid = summaryUpload?.cid || summaryUpload;

  const actualFileSize = fileSize || (rawFileBlob ? rawFileBlob.size : (encryptedRaw.totalPlaintextSize || (typeof rawFileText === "string" ? new TextEncoder().encode(rawFileText).length : 0)));

  const hpoParts = String(hpoCode || "").split(/\s*-\s*/);
  const resolvedClinicalSig = String(clinicalSignificance || "").trim() || "Physiological Traits";
  const resolvedZygosity = String(zygosity || "").trim() || "0/1 Heterozygous";
  const phenopacket = buildPhenopacket({
    subjectId,
    disease,
    clinicalSignificance: resolvedClinicalSig,
    zygosity: resolvedZygosity,
    phenotypes: [{ id: (hpoParts[0] || "SO:0000694").trim(), label: (hpoParts[1] || disease || "Genomic Variant").trim() }],
    variants: [{ gene: geneSymbol, hgvs: "[REDACTED_PROTECTED_UNDER_ENCRYPTED_PAYLOAD]", zygosity: resolvedZygosity }],
    rawDataHash: encryptedRaw.rawDataHash,
    rawCid: rawCid,
    summaryCid: summaryCid,
    summaryDataHash: encryptedSummary.rawDataHash,
    ancestry: ancestryRegion,
    bloodGroup: bloodGroup && bloodGroup !== "N/A" ? bloodGroup : "",
    fileFormat: fileFormat || format || "VCF",
    format: format || fileFormat || "VCF",
    fileSize: actualFileSize
  });
  const metaUpload = await uploadPhenopacketMetadata(phenopacket, null, uploadAuthCtx);
  const metadataCid = metaUpload?.cid || metaUpload;
  const phenopacketBytes = new TextEncoder().encode(JSON.stringify(phenopacket, null, 2));
  const metadataHash = await computeDataHash(phenopacketBytes);

  // Build deduplicated blinded trait tags across all 6 canonical keys (up to MAX_BLIND_TAGS_PER_DATASET = 16)
  const cleanGeneSym = String(geneSymbol || "")
    .trim()
    .split(/[\s(/,:]/)[0];
  const rsIdMatch =
    String(geneSymbol || "").match(/\b(rs\d+)\b/i) ||
    String(hpoCode || "").match(/\b(rs\d+)\b/i) ||
    (typeof rawFileText === "string" ? rawFileText.match(/\b(rs\d+)\b/i) : null);
  const cleanHpo = hpoCode ? hpoCode.split(/\s*-\s*/)[0].trim() : "";
  const rawTraits = [
    ["gene", cleanGeneSym],
    ["gene", geneSymbol],
    ["disease", disease],
    ["trait", disease],
    ...(clinicalSignificance ? [["trait", clinicalSignificance]] : []),
    ["hpo", cleanHpo],
    ["ancestry", ancestryRegion],
    ["rsid", rsIdMatch ? rsIdMatch[1] : ""],
    ...(Array.isArray(blindTraits) ? blindTraits.map((item) => [item?.key, item?.value]) : [])
  ];
  const blindTagSet = new Set();
  for (const [k, v] of rawTraits) {
    if (k && v && String(v).trim().length > 0 && blindTagSet.size < 16) {
      blindTagSet.add(computeBlindTagHex(k, v, blindTagSalt));
    }
  }
  const blindTags = Array.from(blindTagSet);

  // Fail-closed creator key persistence BEFORE on-chain mint (prevents permanent AES key loss)
  try {
    const ownerPubJwk = await exportPublicKey(ownerKeyPair.publicKey);
    const ownerCapsule = await packageKeyCapsule(
      encryptedRaw.keyHex,
      ownerPubJwk,
      account,
      account,
      { summaryKeyHex }
    );
    await saveOwnerCapsulePersistent(rawCid, ownerCapsule, account);
  } catch (e) {
    throw new Error(
      `Không thể lưu bản sao khóa AES của chủ sở hữu vào IndexedDB; đã hủy giao dịch đúc on-chain để tránh mất khóa / Failed to persist owner AES capsule in IndexedDB; aborted on-chain mint: ${e?.message || e}`
    );
  }

  // Step 3: Smart Contract Bundle Mint (supports both direct and Commit-Reveal mode)
  onStepProgress?.(3);
  const durationSeconds = parsedDurationDays * 86400;
  const resolvedRoyaltyBps = parsedRoyaltyBps; // Configurable 5%-10% EIP-2981
  const hashesBundle = [encryptedRaw.rawDataHash, encryptedSummary.rawDataHash, metadataHash];
  const cidsBundle = [rawCid, summaryCid, metadataCid, `ipfs://${metadataCid}`];

  await executeSerializedTx(account, async () => {
    const registryWithSigner = new ethers.Contract(
      contractAddresses.GenomicsRegistry,
      GenomicsRegistryABI,
      signer
    );

    let tx;
    let useCommitReveal = false;
    try {
      if (typeof registryWithSigner.commitRevealRequired === "function") {
        useCommitReveal = Boolean(await registryWithSigner.commitRevealRequired());
      }
    } catch {}

    if (useCommitReveal && typeof registryWithSigner.revealAndRegisterGenomicDataBundle === "function") {
      const secretSalt = ethers.hexlify(ethers.randomBytes(32));
      const commitHash = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "address"],
        [encryptedRaw.rawDataHash, secretSalt, account]
      );
      const commitTx = await registryWithSigner.commitGenomicData(commitHash);
      const commitRec = await commitTx.wait();
      await waitForCommitRevealNextBlock(signer.provider, commitRec?.blockNumber);
      tx = await registryWithSigner.revealAndRegisterGenomicDataBundle(
        hashesBundle,
        secretSalt,
        cidsBundle,
        priceWei,
        durationSeconds,
        resolvedRoyaltyBps,
        blindTags
      );
    } else if (typeof registryWithSigner.registerGenomicDataBundle === "function") {
      tx = await registryWithSigner.registerGenomicDataBundle(
        hashesBundle,
        cidsBundle,
        priceWei,
        durationSeconds,
        resolvedRoyaltyBps,
        blindTags
      );
    } else {
      tx = await registryWithSigner.registerGenomicData(
        encryptedRaw.rawDataHash,
        rawCid,
        summaryCid,
        metadataCid,
        `ipfs://${metadataCid}`,
        priceWei,
        durationSeconds,
        resolvedRoyaltyBps
      );
    }
    await tx.wait();
  });

  return {
    rawDataHash: encryptedRaw.rawDataHash,
    summaryDataHash: encryptedSummary.rawDataHash,
    metadataHash,
    rawCid,
    summaryCid,
    metadataCid,
    blindTagsCount: blindTags.length
  };
}

/**
 * Data Status Updates (Pause / Resume / Revoke) - Enforces onlyDataOwner
 */
export async function updateDatasetStatus({ dataId, newStatusNum, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.updateDataStatus(dataId, newStatusNum);
    await tx.wait();
    return tx;
  });
}

/**
 * Data Access Fee Update - Enforces onlyDataOwner Access Control
 */
export async function updateDatasetPrice({ dataId, newPriceGeno, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const trimmedPrice = String(newPriceGeno ?? "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmedPrice)) {
    throw new Error("Access fee ($GENO) must be a valid positive decimal number (up to 18 decimals).");
  }
  const newPriceWei = ethers.parseUnits(trimmedPrice, 18);
  if (newPriceWei <= 0n) {
    throw new Error("Access fee ($GENO) must be greater than 0.");
  }
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.updateDataPrice(dataId, newPriceWei);
    await tx.wait();
    return tx;
  });
}

/**
 * Grant Direct Viewing Access without payment - Enforces onlyDataOwner Access Control
 */
export async function grantDirectDatasetAccess({ dataId, recipientAddress, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  if (!ethers.isAddress(recipientAddress)) throw new Error("Invalid recipient EVM address.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.grantDirectAccess(dataId, recipientAddress);
    await tx.wait();
    return tx;
  });
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
  account,
  signer,
  useEventOnly = false
}) {
  if (!signer) throw new Error("Wallet not connected.");

  let keyHex = null;
  let summaryKeyHex = null;
  const ownerCapsule = await loadOwnerCapsulePersistent(rawCid, ownerAddress);
  if (ownerCapsule) {
    const ownerKeyPair = await loadPersistentKeyPair(ownerAddress);
    if (ownerKeyPair) {
      const recovered = await decryptKeyCapsule(ownerCapsule, ownerKeyPair.privateKey);
      keyHex = recovered?.keyHex;
      summaryKeyHex = recovered?.summaryKeyHex || null;
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

  const capsule = await packageKeyCapsule(
    keyHex,
    recipientPublicKeyJwk,
    recipientAddress,
    ownerAddress,
    summaryKeyHex ? { summaryKeyHex } : null
  );

  const activeAccount = account || ownerAddress || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    let tx;
    if (useEventOnly && typeof registry.emitTransformedCapsule === "function") {
      // Persists capsule in on-chain storage AND emits CapsuleStored event log for off-chain indexers
      tx = await registry.emitTransformedCapsule(dataId, recipientAddress, capsule);
    } else {
      tx = await registry.storeTransformedCapsule(dataId, recipientAddress, capsule);
    }
    await tx.wait();
    return tx;
  });
}

/**
 * Purchase Access via Escrow and Auto-disburse EIP-2981 Royalty
 */
export async function purchaseDatasetAccess({ dataset, account, signer, researcherKeyPair }) {
  if (!account || !signer) throw new Error("Wallet not connected.");

  return executeSerializedTx(account, async () => {
    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, signer);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);

    const priceWei =
      dataset.priceWei !== undefined && dataset.priceWei !== null && String(dataset.priceWei).trim() !== ""
        ? BigInt(dataset.priceWei)
        : ethers.parseUnits(String(dataset.priceFormatted ?? dataset.price), 18);
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

    // 2/2: Grant access with escrow settlement and slippage protection
    const buyTx = await (registry["grantAccess(uint256,uint256)"]
      ? registry["grantAccess(uint256,uint256)"](dataset.dataId, priceWei)
      : registry.grantAccess(dataset.dataId));
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

    const priceWei =
      dataset.priceWei !== undefined && dataset.priceWei !== null && String(dataset.priceWei).trim() !== ""
        ? BigInt(dataset.priceWei)
        : ethers.parseUnits(String(dataset.priceFormatted ?? dataset.price), 18);
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
    const buyTx = await (registry["grantAccessWithEscrow(uint256,uint256,uint256)"]
      ? registry["grantAccessWithEscrow(uint256,uint256,uint256)"](dataset.dataId, disputeWindowSeconds, priceWei)
      : registry.grantAccessWithEscrow(dataset.dataId, disputeWindowSeconds));
    await buyTx.wait();
    return buyTx;
  });
}

/**
 * Claim 100% Escrow Refund if capsule is not delivered within the dispute window
 */
export async function claimDatasetEscrowRefund({ dataId, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.claimEscrowRefund(dataId);
    await tx.wait();
    return tx;
  });
}

/**
 * Claim 100% Buyer Refund if a disputed escrow remains unresolved past DISPUTE_ARBITRATION_TIMEOUT (30 days)
 */
export async function claimDisputeTimeoutRefund({ dataId, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.claimDisputeTimeoutRefund(dataId);
    await tx.wait();
    return tx;
  });
}

/**
 * Buyer explicitly confirms satisfactory capsule delivery and releases escrow immediately
 */
export async function confirmCapsuleAndReleaseEscrow({ dataId, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.confirmCapsuleAndReleaseEscrow(dataId);
    await tx.wait();
    return tx;
  });
}

/**
 * Dispute a delivered or undelivered capsule during the active dispute window
 */
export async function disputeCapsule({ dataId, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.disputeCapsule(dataId);
    await tx.wait();
    return tx;
  });
}

/**
 * Buyer toggles manual confirmation release for their escrow
 */
export async function setManualEscrowRelease({ dataId, manual, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.setManualEscrowRelease(dataId, manual);
    await tx.wait();
    return tx;
  });
}

/**
 * Manually release escrowed payment to seller once capsule is verified/delivered and dispute window passes
 */
export async function releaseEscrow({ dataId, buyer, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.releaseEscrow(dataId, buyer);
    await tx.wait();
    return tx;
  });
}

/**
 * Arbiter admin resolves a post-delivery escrow dispute (refund buyer 100% or release to seller + EIP-2981 royalty)
 */
export async function resolveEscrowDispute({ dataId, buyer, refundBuyer, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.resolveEscrowDispute(dataId, buyer, Boolean(refundBuyer));
    await tx.wait();
    return tx;
  });
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
 * Internal helper to resolve the symmetric AES keys (raw + optional independent summaryKeyHex)
 * via on-chain buyer capsule, event-driven logs, portable buyer vault capsule, or persistent owner capsule.
 */
async function resolveDatasetKeys({ dataset, account, contracts, researcherKeyPair }) {
  // 1. Try to fetch on-chain capsule stored for buyer from contract storage
  let capsuleJson = "";
  try {
    capsuleJson = await contracts.registry.getTransformedCapsule(dataset.dataId, { from: account });
  } catch (_) {
    try {
      capsuleJson = await contracts.registry.getTransformedCapsule.staticCall(dataset.dataId, { from: account });
    } catch {
      try {
        capsuleJson = await contracts.registry.buyerCapsules(dataset.dataId, account, { from: account });
      } catch {
        try {
          capsuleJson = await contracts.registry.getCapsuleForBuyer(dataset.dataId, account, { from: account });
        } catch {
          capsuleJson = "";
        }
      }
    }
  }

  // 1b. Event-driven retrieval fallback if mapping is empty AND dataset is active
  if ((!capsuleJson || capsuleJson.trim().length === 0) && contracts?.registry?.filters?.CapsuleStored) {
    try {
      const hasActive = await contracts.registry.hasActiveAccess(dataset.dataId, account);
      if (hasActive) {
        const filter = contracts.registry.filters.CapsuleStored(dataset.dataId, account);
        const events = await queryFilterChunked(contracts.registry, filter, getDeploymentStartBlock(), "latest");
        if (events && events.length > 0) {
          const latestEvent = events[events.length - 1];
          capsuleJson = latestEvent.args?.capsule || latestEvent.args?.[2] || "";
        }
      }
    } catch (evErr) {
      console.warn("Event-driven capsule retrieval note:", evErr);
    }
  }

  let buyerCapsuleDecryptError = null;
  if (capsuleJson && capsuleJson.trim().length > 0) {
    try {
      const recovered = await decryptKeyCapsule(capsuleJson, researcherKeyPair.privateKey);
      if (recovered?.keyHex) {
        // Persist encrypted buyer capsule locally (zero plaintext) for cross-device Sovereign Vault backup
        try {
          await saveBuyerCapsulePersistent(dataset.rawCid, capsuleJson, account);
        } catch {}
        return { keyHex: recovered.keyHex, summaryKeyHex: recovered.summaryKeyHex || null };
      }
    } catch (e) {
      buyerCapsuleDecryptError = e;
      console.warn("Buyer capsule decryption error:", e);
    }
  }

  // 1c. Cross-device Sovereign Vault restored buyer capsule fallback (strictly gated by on-chain active access)
  if (account && dataset.rawCid && researcherKeyPair?.privateKey) {
    try {
      const hasActive = contracts?.registry?.hasActiveAccess
        ? Boolean(await contracts.registry.hasActiveAccess(dataset.dataId, account))
        : false;
      if (hasActive) {
        const localBuyerCapsule = await loadBuyerCapsulePersistent(dataset.rawCid, account);
        if (localBuyerCapsule) {
          const recovered = await decryptKeyCapsule(localBuyerCapsule, researcherKeyPair.privateKey);
          if (recovered?.keyHex) {
            return { keyHex: recovered.keyHex, summaryKeyHex: recovered.summaryKeyHex || null };
          }
        }
      }
    } catch (e) {
      console.warn("Restored buyer vault capsule note:", e);
    }
  }

  // 2. Check if caller is strictly the data owner with persistent capsule in IndexedDB or localStorage (HIGH-06 tenant isolation)
  let ownerCapsuleDecryptError = null;
  const isOwner = Boolean(account && dataset.owner && account.toLowerCase() === dataset.owner.toLowerCase());
  if (isOwner) {
    const ownerCapsule = await loadOwnerCapsulePersistent(dataset.rawCid, account);
    if (ownerCapsule && researcherKeyPair?.privateKey) {
      try {
        const recovered = await decryptKeyCapsule(ownerCapsule, researcherKeyPair.privateKey);
        if (recovered?.keyHex) {
          return { keyHex: recovered.keyHex, summaryKeyHex: recovered.summaryKeyHex || null };
        }
      } catch (e) {
        ownerCapsuleDecryptError = e;
        console.warn("Owner capsule recovery note:", e);
      }
    }
  }

  const unwrapErr = buyerCapsuleDecryptError || ownerCapsuleDecryptError;
  if (unwrapErr) {
    throw new Error(
      `Delivered key capsule could not be unwrapped by this device's RSA-OAEP private key (key mismatch or cross-device key rotation: ${unwrapErr.name || unwrapErr.message}). Import your Sovereign Vault backup or request capsule re-dispatch.`
    );
  }

  throw new Error("Access capsule pending distribution from data owner or capsule dispatcher.");
}

async function resolveAesKeyForDataset(params) {
  const { keyHex } = await resolveDatasetKeys(params);
  return keyHex;
}

export function isBinaryGenomicPayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
  // GZIP / BGZF (.vcf.gz, .fastq.gz): 0x1f 0x8b
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  // BAM uncompressed magic: "BAM\1"
  if (bytes.length >= 4 && bytes[0] === 0x42 && bytes[1] === 0x41 && bytes[2] === 0x4d && bytes[3] === 0x01) return true;
  // Crypt4GH container magic: "crypt4gh"
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x63 && bytes[1] === 0x72 && bytes[2] === 0x79 && bytes[3] === 0x70 &&
    bytes[4] === 0x74 && bytes[5] === 0x34 && bytes[6] === 0x67 && bytes[7] === 0x68
  ) {
    return true;
  }
  const checkLen = Math.min(bytes.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0x00) return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/**
 * In-Memory Decryption: Download Ciphertext -> Verify SHA-256 Hash -> Resolve Capsule -> AES-256-GCM
 * Preserves 100% raw byte fidelity for binary genomic formats (.vcf.gz, .bam, .c4gh) while decoding UTF-8 text formats.
 */
export async function decryptDatasetPayload({ dataset, account, contracts, signer = null, researcherKeyPair, onProgress }) {
  if (!researcherKeyPair) {
    throw new Error("Decryption keypair not initialized.");
  }

  // 1/4: Fetch ciphertext blob from IPFS with resilient exponential backoff & SIWE auth headers for private gateway
  const gatewayAuthOpts = await resolveGatewayAuthContext({
    signer,
    account,
    contracts,
    dataId: dataset.dataId
  });
  const downloadedBlob = await smartReadWithRetry(() =>
    retrieveFromIpfs(dataset.rawCid, undefined, gatewayAuthOpts)
  );

  // 2/4: Cryptographic integrity check against on-chain anchor
  const computedHash = await computeDataHash(downloadedBlob);
  if (computedHash.toLowerCase() !== dataset.rawDataHash.toLowerCase()) {
    throw new Error("Cryptographic tamper detected: Downloaded blob hash does not match On-Chain Anchor!");
  }

  // 3/4: Resolve RSA-OAEP Key Capsule
  const recoveredAesKey = await resolveAesKeyForDataset({ dataset, account, contracts, researcherKeyPair });

  // 4/4: In-Memory AES-256-GCM Decryption as lossless Uint8Array first
  const rawBytes = await decryptGenomicDataChunked(downloadedBlob, recoveredAesKey, {
    onProgress,
    asString: false
  });
  if (isBinaryGenomicPayload(rawBytes)) {
    return rawBytes;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
}

/**
 * Fetch all registry data items pagination-first (getDataItemsPaginated) to stay well within
 * public RPC gas limits on large catalogs, falling back to getAllDataItems() only when unavailable.
 */
export async function fetchAllRegistryDataItems(registry, pageSize = 100) {
  if (!registry) return [];
  if (typeof registry.getDataItemsPaginated === "function") {
    const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 100));
    const collected = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const res = await registry.getDataItemsPaginated(offset, safePageSize);
      const pageItems = res?.[0] || [];
      total = Number(res?.[1] ?? 0n);
      if (!pageItems || pageItems.length === 0) break;
      collected.push(...pageItems);
      offset += pageItems.length;
    }
    return collected;
  }
  const rawItems = await registry.getAllDataItems();
  return Array.from(rawItems || []);
}

/**
 * Harvest active on-chain buyer capsules for an account so cross-device Sovereign Key Vault
 * exports capture all purchased datasets even before the researcher clicks "Decrypt" on Device A.
 */
export async function collectActiveBuyerCapsulesForAccount({ account, contracts, datasets = null }) {
  if (!account || !contracts?.registry) return [];
  const normAccount = account.toLowerCase();
  const collected = [];
  let items = Array.isArray(datasets) ? datasets : null;
  if (!items) {
    try {
      const rawItems = await fetchAllRegistryDataItems(contracts.registry, 100);
      items = rawItems.map((r) => ({
        dataId: Number(r.dataId),
        owner: r.currentOwner,
        rawCid: r.rawCiphertextCid,
        statusNum: Number(r.status),
      }));
    } catch {
      return [];
    }
  }
  const eligibleItems = items.filter((d) => {
    const dataId = Number(d?.dataId || 0);
    const rawCid = d?.rawCid || d?.rawCiphertextCid || "";
    const ownerAddr = String(d?.owner || d?.currentOwner || "").toLowerCase();
    return Boolean(dataId && rawCid && ownerAddr !== normAccount);
  });
  const harvested = await runWithConcurrency(
    eligibleItems,
    async (d) => {
      const dataId = Number(d?.dataId || 0);
      const rawCid = d?.rawCid || d?.rawCiphertextCid || "";
      try {
        const hasActive = Boolean(await contracts.registry.hasActiveAccess(dataId, account));
        if (!hasActive) return null;
        let capsuleJson = "";
        try {
          capsuleJson = await contracts.registry.getTransformedCapsule(dataId, { from: account });
        } catch {
          try {
            capsuleJson = await contracts.registry.getTransformedCapsule.staticCall(dataId, { from: account });
          } catch {
            try {
              capsuleJson = await contracts.registry.buyerCapsules(dataId, account, { from: account });
            } catch {
              capsuleJson = "";
            }
          }
        }
        if ((!capsuleJson || !capsuleJson.trim()) && contracts.registry?.filters?.CapsuleStored) {
          try {
            const evs = await queryFilterChunked(
              contracts.registry,
              contracts.registry.filters.CapsuleStored(dataId, account),
              getDeploymentStartBlock(),
              "latest"
            );
            if (evs && evs.length > 0) {
              const latest = evs[evs.length - 1];
              capsuleJson = latest.args?.capsule || latest.args?.[2] || "";
            }
          } catch {}
        }
        if (capsuleJson && capsuleJson.trim().length > 0) {
          try {
            await saveBuyerCapsulePersistent(rawCid, capsuleJson, account);
          } catch {}
          return { rawCid, capsule: capsuleJson };
        }
      } catch {}
      return null;
    },
    6
  );
  for (const entry of harvested) {
    if (entry) collected.push(entry);
  }
  return collected;
}

/**
 * Export Sovereign Encrypted Key Vault Backup (.json)
 */
export async function exportSovereignVault({
  signer,
  account,
  password,
  contracts = null,
  datasets = null,
  extraBuyerCapsules = []
}) {
  const harvested = contracts?.registry
    ? await collectActiveBuyerCapsulesForAccount({ account, contracts, datasets })
    : [];
  const mergedExtra = [...harvested, ...(Array.isArray(extraBuyerCapsules) ? extraBuyerCapsules : [])];
  return await exportSovereignKeyVault({ signer, account, password, extraBuyerCapsules: mergedExtra });
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
export async function decryptSummaryReport({ dataset, account, contracts, signer = null, researcherKeyPair }) {
  if (!researcherKeyPair) {
    throw new Error("Decryption keypair not initialized.");
  }
  if (!dataset.summaryCid) {
    throw new Error("No clinical summary report CID associated with this dataset.");
  }

  // 1. Fetch ciphertext blob from IPFS with resilient exponential backoff & SIWE auth headers for private gateway
  const gatewayAuthOpts = await resolveGatewayAuthContext({
    signer,
    account,
    contracts,
    dataId: dataset.dataId
  });
  const downloadedBlob = await smartReadWithRetry(() =>
    retrieveFromIpfs(dataset.summaryCid, undefined, gatewayAuthOpts)
  );

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

  if (dataset.summaryCid) {
    await verifySummaryCidIntegrity(dataset.summaryCid, downloadedBlob, computedHash);
  }

  // 2. Resolve RSA-OAEP Key Capsule (raw key + optional independent random summaryKeyHex)
  const { keyHex: recoveredAesKey, summaryKeyHex: capsuleSummaryKeyHex } = await resolveDatasetKeys({
    dataset,
    account,
    contracts,
    researcherKeyPair
  });

  // 3. Decrypt binary PDF payload: prefer independent random summaryKeyHex packaged inside capsule;
  //    fall back to deterministic domain-separated / base key ONLY for legacy capsules omitting summaryKeyHex.
  if (capsuleSummaryKeyHex && /^[0-9a-fA-F]{64}$/.test(capsuleSummaryKeyHex)) {
    return await decryptGenomicPayload(downloadedBlob, capsuleSummaryKeyHex, false);
  }
  const cleanKeyHex = typeof recoveredAesKey === "string" ? recoveredAesKey.replace(/^0x/, "").toLowerCase() : "";
  if (cleanKeyHex.length === 64) {
    const legacySummaryKeyHex = ethers
      .sha256(ethers.toUtf8Bytes(`GENOCHAIN_SUMMARY_PDF_DOMAIN_V1:${cleanKeyHex}`))
      .slice(2);
    try {
      return await decryptGenomicPayload(downloadedBlob, legacySummaryKeyHex, false);
    } catch {
      // Fallback for legacy datasets encrypted prior to domain separation
    }
  }
  const decryptedPdfBytes = await decryptGenomicPayload(downloadedBlob, recoveredAesKey, false);
  return decryptedPdfBytes;
}

/**
 * Authorize or revoke a delegated capsule delivery worker for a dataset (onlyDataOwner)
 */
export async function setDatasetCapsuleWorker({ dataId, workerAddress, authorized = true, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  if (!ethers.isAddress(workerAddress)) throw new Error("Invalid worker EVM address.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.setAuthorizedCapsuleWorker(dataId, workerAddress, authorized);
    await tx.wait();
    return tx;
  });
}

/**
 * Toggle global Capsule Dispatcher opt-out for a specific dataset (onlyMutableDataOwner)
 */
export async function setDatasetDispatcherOptOut({ dataId, disabled, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.setDispatcherOptOut(dataId, Boolean(disabled));
    await tx.wait();
    return tx;
  });
}

/**
 * Replace Privacy-Preserving Blinded Trait Tags on-chain (onlyDataOwner, max 16)
 */
export async function updateDatasetBlindTags({ dataId, blindTags, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const tx = await registry.setDatasetBlindTags(dataId, blindTags);
    await tx.wait();
    return tx;
  });
}

/**
 * Query datasets matching a privacy-preserving blinded Keccak-256 trait tag on-chain
 */
export async function searchDatasetsByBlindTag({
  traitKey,
  traitValue,
  datasetSalt = "GENOCHAIN_COHORT_SALT_V1",
  datasets = [],
  contracts
}) {
  if (!contracts?.registry) throw new Error("Registry contract not initialized.");
  const blindTag = computeBlindTagHex(traitKey, traitValue, datasetSalt);
  const checks = await runWithConcurrency(
    datasets || [],
    async (d) => {
      try {
        const matched = await contracts.registry.matchesBlindTag(d.dataId, blindTag);
        return matched ? Number(d.dataId) : null;
      } catch {
        return null;
      }
    },
    6
  );
  return {
    blindTag,
    matchingIds: checks.filter((id) => id !== null)
  };
}

/**
 * Quote on-chain Study Reuse Fee (5% of access price, min 1 wei)
 */
export async function quoteStudyReuse({ dataId, contracts }) {
  if (!contracts?.registry) throw new Error("Registry contract not initialized.");
  const feeWei = await contracts.registry.quoteReuseFee(dataId);
  return {
    feeWei,
    feeGeno: Number(ethers.formatUnits(feeWei, 18))
  };
}

/**
 * Pay 5% Study Reuse Fee (with EIP-2981 royalty split) and anchor unique study commitment on-chain
 */
export async function recordDatasetStudyReuse({ dataId, studyTitleOrId, account, signer }) {
  if (!signer) throw new Error("Wallet not connected.");
  const activeAccount = account || (await signer.getAddress());
  return executeSerializedTx(activeAccount, async () => {
    const token = new ethers.Contract(contractAddresses.GenomicToken, GenomicTokenABI, signer);
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);

    const feeWei = await registry.quoteReuseFee(dataId);
    const balWei = await token.balanceOf(activeAccount);
    if (balWei < feeWei) {
      throw new Error("Insufficient $GENO balance to pay 5% Study Reuse Fee.");
    }

    const allowance = await token.allowance(activeAccount, contractAddresses.GenomicsRegistry);
    if (allowance < feeWei) {
      const approveTx = await token.approve(contractAddresses.GenomicsRegistry, feeWei);
      await approveTx.wait();
    }

    const label = String(studyTitleOrId || "").trim() || `${Date.now()}`;
    const studyCommitment = ethers.keccak256(
      ethers.toUtf8Bytes(`GENOCHAIN_STUDY_REUSE_V1:${dataId}:${activeAccount.toLowerCase()}:${label}`)
    );
    const tx =
      typeof registry["recordStudyReuse(uint256,bytes32,uint256)"] === "function"
        ? await registry["recordStudyReuse(uint256,bytes32,uint256)"](dataId, studyCommitment, feeWei)
        : await registry.recordStudyReuse(dataId, studyCommitment);
    await tx.wait();
    return {
      tx,
      feeWei,
      feeGeno: Number(ethers.formatUnits(feeWei, 18)),
      studyCommitment
    };
  });
}

/**
 * Retrieve and parse GA4GH Phenopacket v2 JSON metadata from IPFS with optional On-Chain Hash Check
 */
export async function fetchPhenopacketMetadata({ metadataCid, expectedMetadataHash = null }) {
  if (!metadataCid) throw new Error("Metadata CID is missing.");
  const bytes = await smartReadWithRetry(() => retrieveFromIpfs(metadataCid));
  if (expectedMetadataHash && /^0x[0-9a-fA-F]{64}$/.test(expectedMetadataHash) && expectedMetadataHash !== ethers.ZeroHash) {
    const computedHash = await computeDataHash(bytes);
    if (computedHash.toLowerCase() !== expectedMetadataHash.toLowerCase()) {
      throw new Error("Cryptographic tamper detected: Downloaded Phenopacket JSON hash does not match On-Chain Anchor!");
    }
  } else {
    await verifySummaryCidIntegrity(metadataCid, bytes);
  }
  const jsonText = new TextDecoder().decode(bytes);
  return sanitizeMetadataTree(JSON.parse(jsonText));
}

/**
 * Query live GenomicZkVerifier linkage and trait possession proof status via GenomicsRegistry & ZkProofVerified events.
 * Prioritizes dataset-bound verification (verifyDatasetBoundTrait) over donor-level fallback (verifyDatasetTraitPossession).
 */
export async function verifyDatasetTraitZkStatus({
  dataId,
  contracts,
  rawDataHash = null,
  variantCommitment = null,
  targetTraitId = null,
  bountyTargetTraitId = null,
  geneSymbol = "",
  rsId = "",
  clinvarId = "",
  owner = "",
  originalCreator = ""
}) {
  const result = {
    linked: false,
    verifierAddress: ethers.ZeroAddress,
    bountyCount: 0,
    verified: false,
    datasetBound: false,
    verificationScope: "none",
    matchedTraitId: null,
    matchedCommitment: null,
  };
  if (!contracts?.registry || !dataId) return result;
  try {
    const verifierAddr = await smartReadWithRetry(() => contracts.registry.zkVerifier());
    result.verifierAddress = verifierAddr || ethers.ZeroAddress;
    result.linked = Boolean(verifierAddr && verifierAddr !== ethers.ZeroAddress);

    const readProvider = contracts.registry.runner?.provider || contracts.registry.runner;
    let zkContract = null;
    if (result.linked && readProvider) {
      zkContract = new ethers.Contract(verifierAddr, GenomicZkVerifierABI, readProvider);
      try {
        result.bountyCount = Number(await smartReadWithRetry(() => zkContract.bountyCount()));
      } catch {
        // Optional view query
      }
    }

    if (!result.linked) return result;

    // Build candidate targetTraitId bytes32 hashes from dataset metadata
    const candidateTraits = new Set();
    const addTraitCandidate = (raw) => {
      const s = String(raw || "").trim();
      if (!s) return;
      if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
        candidateTraits.add(s.toLowerCase());
      } else {
        candidateTraits.add(ethers.id(s).toLowerCase());
      }
    };
    if (targetTraitId) addTraitCandidate(targetTraitId);
    if (bountyTargetTraitId) addTraitCandidate(bountyTargetTraitId);

    const rsMatch =
      String(rsId || "").match(/\b(rs\d+)\b/i) ||
      String(geneSymbol || "").match(/\b(rs\d+)\b/i) ||
      String(clinvarId || "").match(/\b(rs\d+)\b/i);
    const cleanRs = rsMatch ? rsMatch[1] : (rsId && !String(rsId).startsWith("var-") && rsId !== "N/A" ? String(rsId).trim() : "");
    const geneTokens = String(geneSymbol || "")
      .replace(/^var-/i, "")
      .split(/[\s(/,:]+/)
      .map((t) => t.trim())
      .filter((t) => t && !/^rs\d+$/i.test(t) && !/^c\./i.test(t) && !/^p\./i.test(t));

    for (const g of geneTokens) {
      addTraitCandidate(g);
      if (cleanRs) addTraitCandidate(`${g}_${cleanRs}`);
    }
    if (cleanRs) {
      addTraitCandidate(cleanRs);
      if (cleanRs.toLowerCase() === "rs671") {
        addTraitCandidate("ALDH2_rs671");
      }
    }

    const candidateDonors = Array.from(
      new Set(
        [owner, originalCreator]
          .filter((addr) => addr && ethers.isAddress(addr) && addr !== ethers.ZeroAddress)
          .map((addr) => addr.toLowerCase())
      )
    );

    // 0. Dataset-bound ZK verification FIRST (binds proof cryptographically to this exact dataset's rawDataHash)
    if (typeof contracts.registry.verifyDatasetBoundTrait === "function") {
      for (const traitHex of candidateTraits) {
        try {
          const boundVerified = Boolean(
            await smartReadWithRetry(() => contracts.registry.verifyDatasetBoundTrait(dataId, traitHex))
          );
          if (boundVerified) {
            result.verified = true;
            result.datasetBound = true;
            result.verificationScope = "dataset";
            result.matchedTraitId = traitHex;
            return result;
          }
        } catch {}
      }
      // Also inspect DatasetTraitAttested events so custom trait hashes bound to this exact dataset are detected
      if (zkContract?.filters?.DatasetTraitAttested) {
        for (const donorLower of candidateDonors) {
          const donorChecksum = ethers.getAddress(donorLower);
          try {
            const boundLogs = await smartReadWithRetry(() =>
              queryFilterChunked(
                zkContract,
                zkContract.filters.DatasetTraitAttested(null, donorChecksum),
                getDeploymentStartBlock(),
                "latest"
              )
            );
            for (const ev of boundLogs || []) {
              const evTraitId = ev.args?.targetTraitId || ev.args?.[2];
              const evRawHash = ev.args?.rawDataHash || ev.args?.[3];
              const evCommitment = ev.args?.variantCommitment || ev.args?.[4];
              if (!evTraitId) continue;
              if (rawDataHash && evRawHash && String(evRawHash).toLowerCase() !== String(rawDataHash).toLowerCase()) {
                continue;
              }
              const boundVerified = Boolean(
                await smartReadWithRetry(() => contracts.registry.verifyDatasetBoundTrait(dataId, evTraitId))
              );
              if (boundVerified) {
                result.verified = true;
                result.datasetBound = true;
                result.verificationScope = "dataset";
                result.matchedTraitId = evTraitId;
                result.matchedCommitment = evCommitment || null;
                return result;
              }
            }
          } catch {}
        }
      }
    }

    const checkTraitPossessionOnChain = async (tId, comm, donorAddr) => {
      try {
        const checkTraitFn =
          contracts.registry["verifyDatasetTraitPossession(uint256,bytes32,bytes32)"] || null;
        if (typeof checkTraitFn === "function") {
          return Boolean(await smartReadWithRetry(() => checkTraitFn(dataId, tId, comm)));
        }
        if (zkContract && donorAddr && ethers.isAddress(donorAddr)) {
          return Boolean(
            await smartReadWithRetry(() => zkContract.hasVerifiedTraitVariant(tId, comm, donorAddr))
          );
        }
      } catch {
        return false;
      }
      return false;
    };

    // 1. Donor-level fallback: Direct commitment verification if provided on dataset
    const explicitComm =
      variantCommitment && /^0x[0-9a-fA-F]{64}$/.test(variantCommitment)
        ? variantCommitment
        : null;
    if (explicitComm) {
      for (const traitHex of candidateTraits) {
        if (await checkTraitPossessionOnChain(traitHex, explicitComm, owner || originalCreator)) {
          result.verified = true;
          result.datasetBound = false;
          result.verificationScope = "donor";
          result.matchedTraitId = traitHex;
          result.matchedCommitment = explicitComm;
          return result;
        }
      }
      try {
        const checkAnyFn =
          contracts.registry["verifyDatasetTraitPossession(uint256,bytes32)"] ||
          contracts.registry.verifyDatasetTraitPossession;
        if (checkAnyFn && Boolean(await smartReadWithRetry(() => checkAnyFn(dataId, explicitComm)))) {
          result.verified = true;
          result.datasetBound = false;
          result.verificationScope = "donor";
          result.matchedCommitment = explicitComm;
          return result;
        }
      } catch {}
    }

    // 2. Donor-level fallback: Query ZkProofVerified (and ZkBountyClaimed if present) events on GenomicZkVerifier
    if (zkContract) {
      const eventLogs = [];
      for (const donorLower of candidateDonors) {
        const donorChecksum = ethers.getAddress(donorLower);
        if (zkContract.filters?.ZkProofVerified) {
          try {
            const logs = await smartReadWithRetry(() =>
              queryFilterChunked(
                zkContract,
                zkContract.filters.ZkProofVerified(null, donorChecksum),
                getDeploymentStartBlock(),
                "latest"
              )
            );
            if (Array.isArray(logs)) eventLogs.push(...logs);
          } catch {}
        }
        if (zkContract.filters?.ZkBountyClaimed) {
          try {
            const logs = await smartReadWithRetry(() =>
              queryFilterChunked(
                zkContract,
                zkContract.filters.ZkBountyClaimed(null, donorChecksum),
                getDeploymentStartBlock(),
                "latest"
              )
            );
            if (Array.isArray(logs)) eventLogs.push(...logs);
          } catch {}
        }
      }

      for (const ev of eventLogs) {
        const evTraitId = ev.args?.targetTraitId || ev.args?.[2];
        const evCommitment = ev.args?.variantCommitment || ev.args?.[3];
        const evDonor = ev.args?.donor || ev.args?.claimer || ev.args?.[1];
        if (!evTraitId || !evCommitment) continue;
        if (candidateTraits.size > 0 && !candidateTraits.has(String(evTraitId).toLowerCase())) {
          continue;
        }
        const verifiedOnChain = await checkTraitPossessionOnChain(evTraitId, evCommitment, evDonor);
        if (verifiedOnChain) {
          result.verified = true;
          result.datasetBound = false;
          result.verificationScope = "donor";
          result.matchedTraitId = evTraitId;
          result.matchedCommitment = evCommitment;
          return result;
        }
      }
    }
  } catch (err) {
    console.warn("[ZK-Verify] Status check warning:", err?.message || err);
  }
  return result;
}

export const verifyDatasetZkBadge = verifyDatasetTraitZkStatus;

export { parseExternalGroth16Proof };

/**
 * Resolve and submit an authentic BN254 Groth16 ZK Trait Bounty claim for a Data Provider.
 * Supports open demo bounties (claimZkBounty), donor-level lab-attested bounties (claimAttestedZkBounty),
 * and dataset-bound lab-attested bounties (claimDatasetAttestedZkBounty) when rawDataHash is provided.
 */
export async function claimZkTraitBounty({
  bountyId,
  targetTraitId,
  witnessSecret = "",
  explicitProof = null,
  explicitCommitment = null,
  rawDataHash = null,
  attestationDeadline = null,
  labSignature = null,
  account,
  signer
}) {
  if (!signer) throw new Error("Wallet signer required to claim ZK bounty.");
  const donorAddress = account || (await signer.getAddress());
  const cleanSecret = String(witnessSecret || "").trim();
  if (!explicitProof && !cleanSecret) {
    throw new Error("Private witness secret or external Groth16 proof JSON is required.");
  }
  const trimmedRawDataHash = typeof rawDataHash === "string" ? rawDataHash.trim() : "";
  const hasDatasetBinding =
    trimmedRawDataHash.length > 0 && trimmedRawDataHash !== ethers.ZeroHash;
  if (hasDatasetBinding && !/^0x[0-9a-fA-F]{64}$/.test(trimmedRawDataHash)) {
    throw new Error("Invalid dataset rawDataHash (expected 32-byte 0x hex string).");
  }
  const cleanExplicitComm = typeof explicitCommitment === "string" ? explicitCommitment.trim() : "";
  const hasExplicitCommitment = Boolean(
    cleanExplicitComm &&
    /^0x[0-9a-fA-F]{64}$/.test(cleanExplicitComm) &&
    cleanExplicitComm !== ethers.ZeroHash
  );
  const parsedExternal = explicitProof ? parseExternalGroth16Proof(explicitProof) : null;
  if (parsedExternal) {
    if (parsedExternal.bountyId !== null && parsedExternal.bountyId !== Number(bountyId)) {
      throw new Error(`External proof bountyId (${parsedExternal.bountyId}) does not match selected Bounty #${bountyId}.`);
    }
    if (parsedExternal.donorAddress && parsedExternal.donorAddress.toLowerCase() !== donorAddress.toLowerCase()) {
      throw new Error(`External proof donorAddress (${parsedExternal.donorAddress}) does not match connected wallet (${donorAddress}).`);
    }
    if (parsedExternal.targetTraitId && targetTraitId && parsedExternal.targetTraitId.toLowerCase() !== targetTraitId.toLowerCase()) {
      throw new Error(`External proof targetTraitId (${parsedExternal.targetTraitId}) does not match Bounty #${bountyId} (${targetTraitId}).`);
    }
    if (
      !hasExplicitCommitment &&
      !(
        parsedExternal.variantCommitment &&
        /^0x[0-9a-fA-F]{64}$/.test(parsedExternal.variantCommitment) &&
        parsedExternal.variantCommitment !== ethers.ZeroHash
      )
    ) {
      throw new Error(
        "External Groth16 proof must include a valid non-zero 32-byte variantCommitment or publicSignals[0] field."
      );
    }
  }
  return executeSerializedTx(donorAddress, async () => {
    const registry = new ethers.Contract(contractAddresses.GenomicsRegistry, GenomicsRegistryABI, signer);
    const zkAddrOnChain = await registry.zkVerifier().catch(() => ethers.ZeroAddress);
    const targetZkAddr =
      zkAddrOnChain && zkAddrOnChain !== ethers.ZeroAddress
        ? zkAddrOnChain
        : contractAddresses.GenomicZkVerifier;
    const zk = new ethers.Contract(targetZkAddr, GenomicZkVerifierABI, signer);
    const vkEpoch = Number(await zk.vkEpoch());
    const requiredAttestor = await zk.bountyRequiredAttestor(bountyId).catch(() => ethers.ZeroAddress);
    const isAttested = Boolean(requiredAttestor && requiredAttestor !== ethers.ZeroAddress);

    let variantCommitment = hasExplicitCommitment ? cleanExplicitComm : null;

    let proof = null;
    if (parsedExternal) {
      if (parsedExternal.vkEpoch !== null && parsedExternal.vkEpoch !== vkEpoch) {
        throw new Error(`External proof vkEpoch (${parsedExternal.vkEpoch}) does not match on-chain vkEpoch (${vkEpoch}).`);
      }
      if (!variantCommitment) {
        variantCommitment = parsedExternal.variantCommitment;
      }
      proof = parsedExternal.proof;
    } else {
      variantCommitment =
        variantCommitment || computeDonorWitnessCommitment(donorAddress, targetTraitId, cleanSecret);
      // Browser-native trapdoor-free Groth16 proving via snarkjs (identical in vite dev & production/preview builds)
      const net = await signer.provider?.getNetwork?.().catch(() => null);
      const chainId = net?.chainId ? Number(net.chainId) : Number(contractAddresses.chainId || 31337);
      const [snarkjsModule, zkeyBytes] = await Promise.all([
        import("snarkjs"),
        loadBrowserZkeyBytes()
      ]);
      const snarkjs = snarkjsModule?.groth16 ? snarkjsModule : snarkjsModule?.default || snarkjsModule;
      const generated = await generateGroth16ProofWithZkey({
        snarkjs,
        zkeySource: zkeyBytes,
        donorAddress,
        targetTraitId,
        witnessSecret: cleanSecret,
        variantCommitment,
        bountyId: Number(bountyId),
        verifierAddress: targetZkAddr,
        chainId,
        vkEpoch
      });
      proof = generated.proof;
      if (generated.variantCommitment && /^0x[0-9a-fA-F]{64}$/.test(generated.variantCommitment)) {
        variantCommitment = generated.variantCommitment;
      }
    }
    if (!proof || !proof.a || !proof.b || !proof.c) {
      throw new Error("Valid Groth16 proof (a, b, c) is required.");
    }
    let tx;
    let datasetBound = false;
    if (isAttested) {
      const sigStr = String(labSignature || "").trim();
      const deadlineNum = Number(attestationDeadline);
      if (!sigStr || !/^0x[0-9a-fA-F]{130}$/.test(sigStr)) {
        throw new Error("Certified Lab-Attested Bounty requires a valid 65-byte ECDSA lab attestation signature (0x...).");
      }
      if (!Number.isFinite(deadlineNum) || deadlineNum <= 0) {
        throw new Error("Certified Lab-Attested Bounty requires a valid Unix attestation deadline timestamp.");
      }
      if (hasDatasetBinding && typeof zk.claimDatasetAttestedZkBounty === "function") {
        datasetBound = true;
        tx = await zk.claimDatasetAttestedZkBounty(
          bountyId,
          proof.a,
          proof.b,
          proof.c,
          variantCommitment,
          trimmedRawDataHash,
          BigInt(Math.floor(deadlineNum)),
          sigStr
        );
      } else {
        tx = await zk.claimAttestedZkBounty(
          bountyId,
          proof.a,
          proof.b,
          proof.c,
          variantCommitment,
          BigInt(Math.floor(deadlineNum)),
          sigStr
        );
      }
    } else {
      tx = await zk.claimZkBounty(bountyId, proof, variantCommitment);
    }
    const receipt = await tx.wait();
    return { tx, receipt, variantCommitment, proof, datasetBound };
  });
}

export {
  encryptGenomicDataChunked,
  decryptGenomicDataChunked
};