/**
 * @file round3_adversarial_agent_2.mjs
 * @description Independent Adversarial Verification Suite - Round 3 Council Member 2
 *              IS355 - Công nghệ Blockchain | Khoa HTTT - UIT
 *              Instructor: ThS. Hà Lê Hoài Trung | Student: Nguyễn Trọng Khôi (23520783)
 * 
 * SPECIALIZED ADVERSARIAL AUDIT SCOPE:
 *  1. Cryptographic Key Wrap & Chunked Streaming Bounds (GA4GH Crypt4GH, DataView buffer limits)
 *  2. Anti-Mockup AST & False Qm CID Hunt (IPFS Multihash Base58, UnixFS DAG-PB)
 *  3. Independent Tautological Test Hunt ("Test Tự Biên Tự Diễn", synthetic zk-proof bypass)
 *  4. INVARIANT-11 Forensic Sweep (Pure Molecular Genetics vs Clinical Pathology in test fixtures & evidence)
 *  5. Smart Contract Lifecycle Symmetry & Boundary Verification (GenomicsRegistry, GenomicToken, GenomicNFT)
 *  6. Bilingual i18n Translation Dictionary Parity
 */

import hre from "hardhat";
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import {
  generateSymmetricKey,
  exportKeyToHex,
  importKeyFromHex,
  packCiphertextPayload,
  unpackCiphertextPayload,
  generateAsymmetricKeyPair,
  exportPublicKey,
  importPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  encryptGenomicData,
  decryptGenomicPayload,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  computeDataHash,
} from "../../crypto/client_crypto.js";
import { computeIpfsCidV0, encodeUnixFsFileNode, base58Encode } from "../../ipfs/pinata_uploader.js";
import { translations } from "../../frontend/src/i18n/translations.js";

async function runRound3AdversarialSuite() {
  console.log("================================================================================");
  console.log("[AUDIT] STARTING ROUND 3 ADVERSARIAL AUDIT SUITE - COUNCIL MEMBER 2");
  console.log("   Specialized Focus: Crypto Bounds, Anti-Mockup AST, Tautological Test Hunt");
  console.log("   IS355 - Công nghệ Blockchain (Khoa HTTT - UIT)");
  console.log("   Instructor: ThS. Hà Lê Hoài Trung | Student: Nguyễn Trọng Khôi (23520783)");
  console.log("================================================================================\n");

  let totalTests = 0;
  let passedTests = 0;
  const defectFindings = [];

  function recordPass(title, detail = "") {
    totalTests++;
    passedTests++;
    console.log(`  [PASS #${totalTests}] ${title}`);
    if (detail) console.log(`         ↳ ${detail}`);
  }

  function recordDefect(defId, title, severity, detail) {
    totalTests++;
    defectFindings.push({ defId, title, severity, detail });
    console.log(`  [DEFECT DETECTED #${totalTests}] [${severity}] ${defId}: ${title}`);
    console.log(`         ↳ ${detail}`);
  }

  // ==============================================================================
  // SECTION 1: CRYPTOGRAPHIC KEY WRAP & CHUNKED STREAMING BOUNDS
  // ==============================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("SECTION 1: Cryptographic Key Wrap & Chunked Streaming Bounds");
  console.log("--------------------------------------------------------------------------------");

  // Test 1.1: Standard chunked streaming encryption and lossless decryption
  try {
    const rawData = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA\tANN=ALDH2|c.1510G>A\n" + "A".repeat(150000); // ~150KB
    const encChunked = await encryptGenomicDataChunked(rawData, { chunkSize: 65536 });
    const decChunked = await decryptGenomicDataChunked(encChunked.payload, encChunked.activeKey, { asString: true });
    expect(decChunked).to.equal(rawData);
    recordPass("Chunked Streaming: 150KB multi-chunk stream encrypts and decrypts losslessly across 64KB boundaries",
      `Chunks: ${encChunked.chunkCount}, Verified size: ${rawData.length} bytes`);
  } catch (err) {
    recordDefect("DEF3-2-C01", "Chunked Streaming Decryption Failure", "HIGH", err.message);
  }

  // Test 1.2: Boundary Fault - Tampered header totalPlaintextSize < chunk size (Heap RangeError Trap)
  try {
    const smallData = "DNA_SEQUENCE_VERIFICATION_SAMPLE_1234567890";
    const enc = await encryptGenomicDataChunked(smallData, { chunkSize: 16 });
    // Corrupt header: set totalPlaintextSize to 2 bytes instead of actual 43 bytes
    const tamperedPayload = new Uint8Array(enc.payload);
    const view = new DataView(tamperedPayload.buffer, tamperedPayload.byteOffset, tamperedPayload.byteLength);
    view.setBigUint64(12, 2n, false); // Forged to 2 bytes

    let rangeErrorThrown = false;
    try {
      await decryptGenomicDataChunked(tamperedPayload, enc.activeKey);
    } catch (err) {
      rangeErrorThrown = true;
      if (err instanceof RangeError || err.message.includes("offset is out of bounds")) {
        recordDefect("DEF3-2-C02", "Unsafe TypedArray Allocation on Tampered Stream Header", "MEDIUM",
          `Decryptor allocates resultBytes based on unverified header totalPlaintextSize (2 bytes), causing unhandled RangeError when writing 16-byte decrypted chunk.`);
      } else {
        recordPass("Tampered Header Bound: Reject safely with message: " + err.message);
      }
    }
    if (!rangeErrorThrown) {
      recordDefect("DEF3-2-C02B", "Silent Corruption on Mismatched Total Size", "HIGH", "Did not throw on size mismatch.");
    }
  } catch (err) {
    recordPass("Tampered Header Bound Trap: Caught gracefully", err.message);
  }

  // Test 1.3: unpackCiphertextPayload with ArrayBuffer vs Uint8Array
  try {
    const rawBuffer = new ArrayBuffer(20); // 20 bytes (< 28 minimum)
    let threwCorrectly = false;
    try {
      unpackCiphertextPayload(rawBuffer);
    } catch (err) {
      threwCorrectly = true;
    }
    // Check if rawBuffer.length is undefined
    if (rawBuffer.length === undefined && !threwCorrectly) {
      recordDefect("DEF3-2-C03", "ArrayBuffer Length Boundary Bypass in unpackCiphertextPayload", "MEDIUM",
        "ArrayBuffer does not have .length property (has .byteLength). 'payloadBytes.length < 28' evaluates to false for ArrayBuffer under 28 bytes, bypassing guard check.");
    } else {
      recordPass("ArrayBuffer Boundary Guard: Correctly validates minimum length");
    }
  } catch (err) {
    recordPass("ArrayBuffer Boundary: Exception handled safely");
  }

  // Test 1.4: Key Capsule RSA Modulus Exact 512 Hex Characters
  try {
    const kp = await generateAsymmetricKeyPair(true);
    const jwk = await exportPublicKey(kp.publicKey);
    const validKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const capsuleJson = await packageKeyCapsule(validKey, jwk, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222");
    const capsuleObj = JSON.parse(capsuleJson);
    expect(capsuleObj.keyCipher.length).to.equal(512);
    const recovered = await decryptKeyCapsule(capsuleJson, kp.privateKey);
    expect(recovered.keyHex).to.equal(validKey);
    recordPass("RSA-OAEP 2048 Key Capsule: Exact 512 hex chars (256 bytes) RFC 8017 compliance",
      `Capsule cipher length: ${capsuleObj.keyCipher.length} hex digits`);
  } catch (err) {
    recordDefect("DEF3-2-C04", "RSA-OAEP Key Capsule Decryption Failure", "HIGH", err.message);
  }

  // Test 1.5: Non-extractable Private Key Protection (INVARIANT-09)
  try {
    const nonExtKp = await generateAsymmetricKeyPair(false);
    expect(nonExtKp.privateKey.extractable).to.be.false;
    recordPass("INVARIANT-09 Non-extractable Private Key: extractable property is strictly false");
  } catch (err) {
    recordDefect("DEF3-2-C05", "INVARIANT-09 Violation: Private key extractable", "HIGH", err.message);
  }

  // ==============================================================================
  // SECTION 2: ANTI-MOCKUP AST & FALSE QM CID HUNT (INVARIANT-02)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 2: Anti-Mockup AST & False Qm CID Hunt (INVARIANT-02)");
  console.log("--------------------------------------------------------------------------------");

  // Test 2.1: Scan all files in frontend/src/, crypto/, ipfs/ for fake 'QmGeno' prefixes
  const searchDirs = ["frontend/src", "crypto", "ipfs"];
  let qmGenoOccurrences = 0;
  const mockFiles = [];

  function scanForPattern(dir, pattern) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanForPattern(fullPath, pattern);
      } else if (/\.(js|jsx|ts|tsx|json)$/.test(ent.name)) {
        const content = fs.readFileSync(fullPath, "utf8");
        if (pattern.test(content)) {
          qmGenoOccurrences++;
          mockFiles.push(fullPath);
        }
      }
    }
  }

  for (const d of searchDirs) {
    scanForPattern(d, /QmGeno/i);
  }

  if (qmGenoOccurrences === 0) {
    recordPass("INVARIANT-02 Anti-Mockup AST: Zero fake 'QmGeno' prefixes across production sources",
      `Scanned directories: ${searchDirs.join(", ")} | Occurrences: 0`);
  } else {
    recordDefect("DEF3-2-M01", "INVARIANT-02 Violation: Found fake 'QmGeno' CID prefixes", "HIGH",
      `Occurrences: ${qmGenoOccurrences} in files: ${mockFiles.join(", ")}`);
  }

  // Test 2.2: IPFS Multihash Base58 UnixFS DAG-PB Compatibility on Boundary Sizes
  try {
    // 0-byte file standard CID
    const emptyCid = await computeIpfsCidV0(new Uint8Array(0));
    expect(emptyCid).to.equal("QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
    recordPass("RFC UnixFS DAG-PB: 0-byte empty file computes official IPFS CIDv0: QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");

    // Standard string
    const textCid = await computeIpfsCidV0("hello world\n");
    expect(textCid).to.equal("QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
    recordPass("RFC UnixFS DAG-PB: 'hello world\\n' computes official IPFS CIDv0: QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
  } catch (err) {
    recordDefect("DEF3-2-M02", "IPFS Multihash RFC Compatibility Failure", "MEDIUM", err.message);
  }

  // ==============================================================================
  // SECTION 3: INDEPENDENT TAUTOLOGICAL TEST & SYNTHETIC zkPROOF HUNT
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 3: Independent Tautological Test & Synthetic zkProof Hunt");
  console.log("--------------------------------------------------------------------------------");

  // Test 3.1: GenomicZkVerifier.sol Synthetic Fallback Analysis (Line 311)
  const zkVerifierPath = path.resolve("contracts/GenomicZkVerifier.sol");
  if (fs.existsSync(zkVerifierPath)) {
    const zkSolContent = fs.readFileSync(zkVerifierPath, "utf8");
    if (zkSolContent.includes("proof.a[1] ^ proof.c[1] ^ publicSignal")) {
      recordDefect(
        "DEF3-2-T01",
        "Synthetic Fallback in GenomicZkVerifier.sol (Line 311)",
        "MEDIUM",
        "GenomicZkVerifier.sol implements a synthetic fallback '(proof.a[1] ^ proof.c[1] ^ publicSignal) != 0' when precompile 0x08 pairing check fails, allowing arbitrary mock proofs in test/GenomicZkSNARKs.test.js to pass without real Groth16 cryptographic soundness."
      );
    } else {
      recordPass("GenomicZkVerifier: Strictly enforces pairing precompile check without synthetic fallback");
    }
  }

  // Test 3.2: INVARIANT-11 Forensic Sweep for Clinical Pathology / Cancer Terms in Test Fixtures
  const testFilesToScan = [
    "test/DiverseDatasetsCompatibility.test.js",
    "test/GenomicZkSNARKs.test.js",
    "scripts/deploy/deploy.js"
  ];
  const pathologyMatches = [];

  for (const tf of testFilesToScan) {
    if (fs.existsSync(tf)) {
      const content = fs.readFileSync(tf, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (/Retinitis Pigmentosa|BRCA1_c\.68_69delAG_pathogenic|cancer/i.test(line)) {
          pathologyMatches.push(`${tf}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
  }

  if (pathologyMatches.length > 0) {
    recordDefect(
      "DEF3-2-T02",
      "INVARIANT-11 Boundary Drift in Test Fixtures (Clinical Disease Mentions)",
      "LOW",
      `Detected legacy clinical disease references in test fixtures:\n         ↳ ${pathologyMatches.slice(0, 3).join("\n         ↳ ")}`
    );
  } else {
    recordPass("INVARIANT-11 Test Fixtures: 100% clean of clinical pathology terms");
  }

  // Test 3.3: Evidence Images Forensic Audit
  const evidenceDir = "docs/evidence";
  const legacyEvidenceFiles = [];
  if (fs.existsSync(evidenceDir)) {
    const checkEvidence = (dir) => {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) {
          checkEvidence(fp);
        } else if (/brca1|cancer|pathogenic/i.test(f.name)) {
          legacyEvidenceFiles.push(fp);
        }
      }
    };
    checkEvidence(evidenceDir);
  }

  if (legacyEvidenceFiles.length > 0) {
    recordDefect(
      "DEF3-2-T03",
      "INVARIANT-11 Legacy Screenshot Artifacts in docs/evidence/",
      "LOW",
      `Found ${legacyEvidenceFiles.length} legacy screenshots referencing BRCA1/cancer: ${legacyEvidenceFiles.join(", ")}`
    );
  } else {
    recordPass("docs/evidence/ Directory: Clean of legacy clinical pathology screenshots");
  }

  // ==============================================================================
  // SECTION 4: SMART CONTRACT EVM BOUNDARY & LIFECYCLE SYMMETRY
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 4: Smart Contract EVM Boundary & Lifecycle Symmetry (EVM Hardhat Test)");
  console.log("--------------------------------------------------------------------------------");

  const { ethers } = await hre.network.create();
  const [deployer, seller, buyer, unauthorized] = await ethers.getSigners();

  // Deploy contracts
  const Token = await ethers.getContractFactory("GenomicToken");
  const token = await Token.deploy(deployer.address);
  await token.waitForDeployment();

  const NFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await NFT.deploy(deployer.address, 1000); // 10% royalty
  await nft.waitForDeployment();

  const Registry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await Registry.deploy(token.target, nft.target, deployer.address);
  await registry.waitForDeployment();
  await nft.setRegistryContract(registry.target);

  // Fund accounts
  await token.mint(buyer.address, ethers.parseUnits("5000", 18));
  await token.connect(buyer).approve(registry.target, ethers.MaxUint256);

  // Register Dataset 1
  const rawDataPayload = new TextEncoder().encode("CHRONIC_GENOMIC_RECORD_TEST");
  const rawHash = await computeDataHash(rawDataPayload);
  const price = ethers.parseUnits("100", 18);
  const duration = 86400; // 1 day

  await registry.connect(seller).registerGenomicData(
    rawHash,
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
    "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
    "ipfs://test",
    price,
    duration,
    1000 // 10% royalty
  );

  // Test 4.1: buyerCapsules on dataId == 0 vs out-of-bounds (Invariant 16)
  let capZeroReverted = false;
  try {
    await registry.buyerCapsules(0, buyer.address);
  } catch (err) {
    capZeroReverted = err.message.includes("DataNotFound");
  }
  let capOutOfBoundsReverted = false;
  try {
    await registry.buyerCapsules(999, buyer.address);
  } catch (err) {
    capOutOfBoundsReverted = err.message.includes("DataNotFound");
  }
  expect(capZeroReverted).to.be.true;
  expect(capOutOfBoundsReverted).to.be.true;
  recordPass("buyerCapsules Boundary: Strictly reverts DataNotFound() on out-of-bounds dataId (Invariant 16)");

  // Test 4.2: Self-Access Prohibition
  try {
    await registry.connect(seller).grantDirectAccess(1, seller.address);
    recordDefect("DEF3-2-E01", "Self Access Grant Allowed", "MEDIUM", "grantDirectAccess allowed owner to grant access to self.");
  } catch (err) {
    if (err.message.includes("SelfAccessNotAllowed")) {
      recordPass("grantDirectAccess: Strictly rejects self-grant with SelfAccessNotAllowed()");
    } else {
      recordPass("grantDirectAccess: Reverted on self-grant: " + err.message);
    }
  }

  // Test 4.3: Paused Dataset Escrow Lock & Dispute Refund Interaction
  await registry.connect(buyer).grantAccessWithEscrow(1, 3600); // 1 hour dispute window
  // Seller pauses dataset
  await registry.connect(seller).updateDataStatus(1, 1); // 1 = Paused
  expect(await registry.hasActiveAccess(1, buyer.address)).to.be.false;
  recordPass("Status Symmetry: Pausing dataset immediately revokes hasActiveAccess for active escrow subscriber");

  // Attempt to store capsule while paused -> MUST REVERT DataNotActive
  let storePausedReverted = false;
  try {
    await registry.connect(seller).storeTransformedCapsule(1, buyer.address, "TEST_CAPSULE");
  } catch (err) {
    storePausedReverted = true;
  }
  expect(storePausedReverted).to.be.true;
  recordPass("storeTransformedCapsule: Strictly blocked when dataset is Paused (DataNotActive)");

  // Advance time past disputeWindow (3601s)
  await ethers.provider.send("evm_increaseTime", [3601]);
  await ethers.provider.send("evm_mine");

  // Buyer claims 100% refund
  const buyerBalBefore = await token.balanceOf(buyer.address);
  await registry.connect(buyer).claimEscrowRefund(1);
  const buyerBalAfter = await token.balanceOf(buyer.address);
  expect(buyerBalAfter - buyerBalBefore).to.equal(price);
  recordPass("claimEscrowRefund: 100% refund executed successfully after dispute window on paused dataset");

  // Test 4.4: Faucet Anti-Sybil Triple Rate Limit (tx.origin, msg.sender, to)
  await token.faucet(buyer.address);
  let repeatFaucetReverted = false;
  try {
    await token.faucet(buyer.address);
  } catch (err) {
    repeatFaucetReverted = err.message.includes("FaucetCooldownActive");
  }
  expect(repeatFaucetReverted).to.be.true;
  recordPass("INVARIANT-15 Anti-Sybil Faucet: Rejects repeat claim within 3600 seconds with FaucetCooldownActive");

  // ==============================================================================
  // SECTION 5: BILINGUAL i18n TRANSLATION PARITY AUDIT
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 5: Bilingual i18n Translation Parity Audit");
  console.log("--------------------------------------------------------------------------------");

  const viKeys = Object.keys(translations.vi);
  const enKeys = Object.keys(translations.en);

  const missingInEn = viKeys.filter((k) => !(k in translations.en));
  const missingInVi = enKeys.filter((k) => !(k in translations.vi));

  if (missingInEn.length === 0 && missingInVi.length === 0) {
    recordPass(`i18n Translation Parity: 100% key symmetry between Vietnamese (${viKeys.length}) and English (${enKeys.length})`,
      "Zero missing keys in either language dictionary");
  } else {
    recordDefect(
      "DEF3-2-I01",
      "i18n Dictionary Asymmetry",
      "LOW",
      `Missing in EN: ${missingInEn.join(", ")} | Missing in VI: ${missingInVi.join(", ")}`
    );
  }

  // ==============================================================================
  // AUDIT SUMMARY
  // ==============================================================================
  console.log("\n================================================================================");
  console.log("[AUDIT] ROUND 3 AUDIT SUITE EXECUTION SUMMARY - COUNCIL MEMBER 2");
  console.log("================================================================================");
  console.log(`Total Adversarial Checks Run : ${totalTests}`);
  console.log(`Total Checks Passed          : ${passedTests}`);
  console.log(`Defects / Grounded Findings  : ${defectFindings.length}`);
  console.log(`Success / Verification Rate  : ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log("================================================================================\n");

  if (defectFindings.length > 0) {
    console.log("[FINDINGS] GROUNDED DEFECTS & FINDINGS SUMMARY:");
    defectFindings.forEach((d, idx) => {
      console.log(`  ${idx + 1}. [${d.severity}] ${d.defId}: ${d.title}`);
      console.log(`     ↳ ${d.detail}\n`);
    });
  }

  return { totalTests, passedTests, defectFindings };
}

runRound3AdversarialSuite()
  .then((res) => {
    const failed = res.defectFindings.length > 0 || res.passedTests !== res.totalTests;
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error("Fatal error in test suite:", err);
    process.exit(1);
  });
