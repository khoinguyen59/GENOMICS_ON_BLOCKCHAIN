/**
 * @file round2_adversarial_agent_5.mjs
 * @description Round 2 Independent Adversarial Audit Suite - Audit Agent 5
 *              Genomics on Blockchain (IS355 - ĐHQG-HCM / UIT)
 *              Specialized Focus: IPFS Storage Engine, RFC Multihash CID Integrity,
 *              rawDataHash Package Integrity, Escrow Timelock & Anti-Mockup Verification.
 * @author Audit Agent 5 (Round 2 Swarm)
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  computeIpfsCidV0,
  encodeUnixFsFileNode,
  base58Encode
} from "../../ipfs/pinata_uploader.js";
import {
  encryptGenomicData,
  decryptGenomicData,
  decryptGenomicPayload,
  unpackCiphertextPayload,
  packageKeyCapsule,
  decryptKeyCapsule,
  generateAsymmetricKeyPair,
  exportPublicKey,
  computeDataHash,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked
} from "../../crypto/client_crypto.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const findings = [];

function assert(condition, testName, details = "") {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ${ANSI_GREEN}[PASS #${totalTests}]${ANSI_RESET} ${testName}`);
    if (details) console.log(`         ↳ ${details}`);
  } else {
    failedTests++;
    console.log(`  ${ANSI_RED}[FAIL #${totalTests}]${ANSI_RESET} ${testName}`);
    if (details) console.log(`         ↳ ${ANSI_RED}REASON:${ANSI_RESET} ${details}`);
    findings.push({ testName, details });
  }
}

async function runAudit() {
  console.log("================================================================================");
  console.log(`${ANSI_CYAN}[AUDIT] STARTING ROUND 2 ADVERSARIAL INTEGRITY SUITE (AGENT 5 SPECIALIZED AUDIT)${ANSI_RESET}`);
  console.log("   Target: IS355 - Blockchain & Applications | Instructor: ThS. Hà Lê Hoài Trung");
  console.log("   Student: Nguyễn Trọng Khôi (23520783)");
  console.log("   Specialized Lens: IPFS Dual-Engine, Multihash RFC CIDv0/v1, rawDataHash & Anti-Mockup");
  console.log("================================================================================\n");

  // ===========================================================================
  // SECTION 1: IPFS RFC Multihash CIDv0, UnixFS DAG-PB & Type Robustness
  // ===========================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("SECTION 1: IPFS RFC Multihash CIDv0, UnixFS DAG-PB & Type Robustness");
  console.log("--------------------------------------------------------------------------------");

  // Test 1: Empty File CIDv0 Standard Exactness
  // Official IPFS / Kubo standard CIDv0 for an empty file (0 bytes):
  // UnixFS Data: Type = File (2), filesize = 0 -> Protobuf: 08 02 18 00 -> DAG-PB: 0a 04 08 02 18 00
  // SHA-256: bfccda787baba32b59c78450ac3d20b633360b43992c77289f9ed46d843561e6
  // Multihash CIDv0: QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH
  const emptyBytes = new Uint8Array(0);
  const computedEmptyCid = await computeIpfsCidV0(emptyBytes);
  const STANDARD_EMPTY_CID = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";
  
  // Note: We test whether current computeIpfsCidV0 matches the RFC standard
  const matchesEmptyRfc = computedEmptyCid === STANDARD_EMPTY_CID;
  assert(
    matchesEmptyRfc,
    "IPFS RFC Compliance: computeIpfsCidV0(0-bytes) produces standard CID QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH",
    matchesEmptyRfc 
      ? `Computed: ${computedEmptyCid} (Exact RFC Match)`
      : `Computed: ${computedEmptyCid} vs Standard: ${STANDARD_EMPTY_CID} (Protobuf tag 0x12 0x00 deviation in encodeUnixFsFileNode)`
  );

  // Test 2: computeIpfsCidV0 ArrayBuffer Type Tolerance
  let arrayBufferCrashed = false;
  let arrayBufferError = "";
  try {
    const rawBuffer = new ArrayBuffer(64);
    await computeIpfsCidV0(rawBuffer);
  } catch (err) {
    arrayBufferCrashed = true;
    arrayBufferError = err.message;
  }
  assert(
    !arrayBufferCrashed,
    "IPFS Robustness: computeIpfsCidV0 gracefully handles ArrayBuffer without RangeError crash",
    arrayBufferCrashed
      ? `CRASHED with ${arrayBufferError} (Failed to normalize ArrayBuffer to Uint8Array before reading .length)`
      : "ArrayBuffer safely converted to Uint8Array"
  );

  // Test 3: computeIpfsCidV0 TypedArray Subarray / Slicing Tolerance
  let subarrayOk = false;
  try {
    const bigBuf = new Uint8Array(100);
    bigBuf.fill(65);
    const sub = bigBuf.subarray(10, 40); // 30 bytes with byteOffset = 10
    const subCid = await computeIpfsCidV0(sub);
    subarrayOk = subCid && subCid.startsWith("Qm") && subCid.length === 46;
  } catch (e) {
    subarrayOk = false;
  }
  assert(
    subarrayOk,
    "IPFS Robustness: computeIpfsCidV0 safely handles Uint8Array with non-zero byteOffset",
    subarrayOk ? "Subarray with non-zero byteOffset correctly encoded" : "Subarray caused encoding error"
  );

  // Test 4: Genuine Multihash CIDv0 Structure Validation
  const sampleVcfText = "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\nchr12\t111803962\trs671\tG\tA";
  const vcfCid = await computeIpfsCidV0(sampleVcfText);
  const isValidCidV0 = vcfCid.startsWith("Qm") && vcfCid.length === 46;
  assert(
    isValidCidV0,
    "IPFS Invariant 02: Generated CID is a valid RFC Base58 Multihash (starts with 'Qm', exactly 46 chars)",
    `Computed CID: ${vcfCid} (Length: ${vcfCid.length})`
  );

  // ===========================================================================
  // SECTION 2: Cryptographic Package Integrity, rawDataHash & WebCrypto
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 2: Cryptographic Package Integrity, rawDataHash & WebCrypto");
  console.log("--------------------------------------------------------------------------------");

  // Test 5: rawDataHash is computed over authentic Ciphertext Package (IV || Ciphertext)
  const encResult = await encryptGenomicData(sampleVcfText);
  const expectedHash = await computeDataHash(encResult.payload);
  const hashMatches = encResult.rawDataHash.toLowerCase() === expectedHash.toLowerCase();
  assert(
    hashMatches,
    "INVARIANT-05: rawDataHash strictly equals SHA-256 of authentic binary package (IV || Ciphertext)",
    `On-chain Hash Anchor: ${encResult.rawDataHash}`
  );

  // Test 6: packageKeyCapsule Type Tolerance with Uint8Array Raw Key
  let rawKeyPackageCrashed = false;
  let rawKeyPackageError = "";
  try {
    const kp = await generateAsymmetricKeyPair(true);
    const pubJwk = await exportPublicKey(kp.publicKey);
    const rawKeyBytes = crypto.randomBytes(32);
    await packageKeyCapsule(new Uint8Array(rawKeyBytes), pubJwk, "0x123", "0x456");
  } catch (err) {
    rawKeyPackageCrashed = true;
    rawKeyPackageError = err.message;
  }
  assert(
    !rawKeyPackageCrashed,
    "Crypto Robustness: packageKeyCapsule accepts raw Uint8Array/ArrayBuffer key bytes without SubtleCrypto error",
    rawKeyPackageCrashed
      ? `CRASHED with ${rawKeyPackageError} (Assumes non-string is CryptoKey, calling exportKey on Uint8Array)`
      : "Uint8Array key successfully encapsulated into RSA-OAEP capsule"
  );

  // Test 7: unpackCiphertextPayload Minimum Length Guard (12 bytes IV + 16 bytes GMAC = 28 bytes)
  let unpackBoundaryCaught = false;
  try {
    const truncated16 = new Uint8Array(16); // Has 12 bytes IV, but only 4 bytes ciphertext (insufficient for 16-byte GMAC)
    unpackCiphertextPayload(truncated16);
  } catch (e) {
    unpackBoundaryCaught = true;
  }
  // Currently unpackCiphertextPayload only checks length < 12!
  assert(
    unpackBoundaryCaught,
    "Crypto Boundary Guard: unpackCiphertextPayload rejects payloads smaller than 28 bytes (IV 12 + GMAC 16)",
    unpackBoundaryCaught
      ? "Truncated payload < 28 bytes safely caught at boundary"
      : "INSUFFICIENT GUARD: Payload < 28 bytes unpacked without checking minimum 16-byte GMAC tag size"
  );

  // Test 8: Tamper Detection on Downloaded IPFS Blob
  const tamperedPayload = new Uint8Array(encResult.payload);
  tamperedPayload[tamperedPayload.length - 1] ^= 0x01; // flip 1 bit in GMAC tag
  const tamperedHash = await computeDataHash(tamperedPayload);
  const hashTamperDetected = tamperedHash.toLowerCase() !== encResult.rawDataHash.toLowerCase();
  assert(
    hashTamperDetected,
    "Integrity Verification: SHA-256 on-chain anchor traps 1-bit corruption in ciphertext package BEFORE decryption",
    `Tampered Hash: ${tamperedHash} vs Expected: ${encResult.rawDataHash}`
  );

  // ===========================================================================
  // SECTION 3: GA4GH Crypt4GH Streaming Chunk Boundary & Memory Safety
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 3: GA4GH Crypt4GH Streaming Chunk Boundary & Memory Safety");
  console.log("--------------------------------------------------------------------------------");

  // Test 9: 0-Byte Input Chunked Encryption
  const emptyChunked = await encryptGenomicDataChunked(new Uint8Array(0));
  const emptyDecrypted = await decryptGenomicDataChunked(emptyChunked.payload, emptyChunked.keyHex, { asString: false });
  assert(
    emptyDecrypted.length === 0,
    "GA4GH Crypt4GH: 0-byte streaming encryption round-trips to exact 0-byte buffer",
    `Header magic: GNC1, Chunk Count: ${emptyChunked.chunkCount}`
  );

  // Test 10: Multi-chunk Boundary Integrity (64KB Exact Chunk Boundary)
  const exact64kb = new Uint8Array(64 * 1024);
  for (let i = 0; i < exact64kb.length; i++) exact64kb[i] = i % 256;
  const chunked64 = await encryptGenomicDataChunked(exact64kb, { chunkSize: 64 * 1024 });
  const decrypted64 = await decryptGenomicDataChunked(chunked64.payload, chunked64.keyHex, { asString: false });
  const matches64 = Buffer.compare(Buffer.from(exact64kb), Buffer.from(decrypted64)) === 0;
  assert(
    matches64,
    "GA4GH Crypt4GH: Exact 64KB chunk boundary preserves 100% byte fidelity without truncation",
    `Verified: ${decrypted64.length} bytes (1 chunk)`
  );

  // Test 11: Fault Localization on Arbitrary Chunk
  const multiChunkData = new Uint8Array(150 * 1024); // 3 chunks (64KB + 64KB + 22KB)
  crypto.randomFillSync(multiChunkData);
  const multiEnc = await encryptGenomicDataChunked(multiChunkData, { chunkSize: 64 * 1024 });
  // Tamper middle chunk (chunk 2)
  const tamperedMulti = new Uint8Array(multiEnc.payload);
  tamperedMulti[70 * 1024] ^= 0xff; // flip bits inside chunk 2
  let decryptTrapped = false;
  try {
    await decryptGenomicDataChunked(tamperedMulti, multiEnc.keyHex);
  } catch (err) {
    decryptTrapped = true;
  }
  assert(
    decryptTrapped,
    "Byzantine Fault Trapping: 1-byte alteration in chunk #2 payload halts chunked decryption with MAC error",
    decryptTrapped ? "Decryption aborted gracefully on corrupted chunk" : "Corrupted chunk was not trapped"
  );

  // ===========================================================================
  // SECTION 4: OpenSea UI Layer, Activity Feed & Anti-Mockup AST Audit
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 4: OpenSea UI Layer, Activity Feed & Anti-Mockup AST Audit");
  console.log("--------------------------------------------------------------------------------");

  const frontendSrcDir = path.resolve("frontend/src");

  // Test 12: Zero Fake 'QmGeno' Multihash Prefixes across all frontend/src files
  const qmGenoMatches = [];
  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(full);
      } else if (/\.(jsx?|tsx?|json)$/.test(ent.name)) {
        const content = fs.readFileSync(full, "utf-8");
        if (content.includes("QmGeno")) {
          qmGenoMatches.push(full);
        }
      }
    }
  }
  scanDir(frontendSrcDir);
  assert(
    qmGenoMatches.length === 0,
    "INVARIANT-02 Anti-Mockup: Zero fake 'QmGeno' CID prefixes across all frontend/src source files",
    qmGenoMatches.length === 0 ? "Clean: 0 occurrences" : `Violations in: ${qmGenoMatches.join(", ")}`
  );

  // Test 13: OpenSea Activity Feed Real On-Chain Event Integration Check
  const activityFeedPath = path.join(frontendSrcDir, "features/researcher/OpenSeaActivityFeed.jsx");
  const activityContent = fs.existsSync(activityFeedPath) ? fs.readFileSync(activityFeedPath, "utf-8") : "";
  const hasHardcodedFakeTx = activityContent.includes("0x9a8f273b4d1c3e5a7b9c2d1e0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a");
  const hasContractEventQuery = activityContent.includes("queryFilter") || activityContent.includes(".on(");
  assert(
    !hasHardcodedFakeTx && hasContractEventQuery,
    "INVARIANT-03 / INVARIANT-12: OpenSea Activity Feed queries genuine on-chain event logs instead of hardcoded pseudo-events",
    hasHardcodedFakeTx
      ? "DEFECT DETECTED: OpenSeaActivityFeed.jsx contains hardcoded mock tx hashes (0x9a8f...) and lacks queryFilter integration"
      : "Real-time event query active"
  );

  // Test 14: OpenSea Showcase Volume Calculation State Faking Check
  const showcasePath = path.join(frontendSrcDir, "features/researcher/OpenSeaSpotlightShowcase.jsx");
  const showcaseContent = fs.existsSync(showcasePath) ? fs.readFileSync(showcasePath, "utf-8") : "";
  const hasArtificiallyInflatedVolume = showcaseContent.includes("accessCount || 0) + 1");
  const hasHardcodedTrendingDeltas = showcaseContent.includes('["+28.4%", "+21.2%", "+16.5%", "+12.8%", "+9.5%"]');
  assert(
    !hasArtificiallyInflatedVolume && !hasHardcodedTrendingDeltas,
    "INVARIANT-03: OpenSea Spotlight Showcase reflects authentic trading volume without +1 artificial inflation or hardcoded deltas",
    hasArtificiallyInflatedVolume || hasHardcodedTrendingDeltas
      ? "DEFECT DETECTED: OpenSeaSpotlightShowcase.jsx has artificial volume inflation '(accessCount + 1)' and static deltas"
      : "Volume and market stats derived truthfully"
  );

  // Test 15: LicensedDatasetsView Decrypt Button State During Pending Escrow
  const licensedViewPath = path.join(frontendSrcDir, "features/researcher/LicensedDatasetsView.jsx");
  const licensedContent = fs.existsSync(licensedViewPath) ? fs.readFileSync(licensedViewPath, "utf-8") : "";
  // Check if Decrypt button is disabled or handles pending escrow delivery by replacing with pending banner
  const handlesEscrowInDecryptButton = (licensedContent.includes("item.escrowInfo?.isPending") || licensedContent.includes("item.isEscrowPending")) &&
    (licensedContent.includes("disabled={item.escrowInfo?.isPending") || licensedContent.includes("escrowPendingDelivery"));
  assert(
    handlesEscrowInDecryptButton,
    "UI/UX Integrity: LicensedDatasetsView disables Decrypt button when key capsule is pending seller escrow delivery",
    handlesEscrowInDecryptButton
      ? "Decrypt button appropriately guarded during pending escrow delivery (amber pending badge active)"
      : "DEFECT DETECTED: Decrypt button is active during pending escrow, triggering premature decryption error toast"
  );

  // ===========================================================================
  // SECTION 5: Smart Contract Event & Interface Completeness
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 5: Smart Contract Event & Interface Completeness");
  console.log("--------------------------------------------------------------------------------");

  // Test 16: GenomicNFTMinted Event Completeness for Summary PDF Report CID
  const genomicNftPath = path.resolve("contracts/GenomicNFT.sol");
  const nftSolContent = fs.existsSync(genomicNftPath) ? fs.readFileSync(genomicNftPath, "utf-8") : "";
  const eventHasSummaryCid = /event\s+GenomicNFTMinted\s*\([^)]*summaryCiphertextCid[^)]*\)/.test(nftSolContent) ||
                             /event\s+GenomicNFTMinted\s*\([^)]*summaryCid[^)]*\)/.test(nftSolContent);
  assert(
    eventHasSummaryCid,
    "Event Emission & Off-Chain Indexing: GenomicNFTMinted event includes summaryCiphertextCid parameter",
    eventHasSummaryCid
      ? "Event contains summaryCiphertextCid for complete off-chain indexing"
      : "DEFECT DETECTED: GenomicNFTMinted event omits summaryCiphertextCid, hindering off-chain PDF indexing"
  );

  // ===========================================================================
  // SUMMARY REPORT
  // ===========================================================================
  console.log("\n================================================================================");
  console.log(`${ANSI_CYAN}[AUDIT] AGENT 5 INDEPENDENT AUDIT SUITE EXECUTION SUMMARY${ANSI_RESET}`);
  console.log("================================================================================");
  console.log(`Total Adversarial Invariants Tested: ${totalTests}`);
  console.log(`Passed Invariants                  : ${ANSI_GREEN}${passedTests}${ANSI_RESET}`);
  console.log(`Identified Defect Candidates       : ${ANSI_RED}${failedTests}${ANSI_RESET}`);
  console.log("================================================================================\n");

  if (findings.length > 0) {
    console.log(`${ANSI_YELLOW}[FINDINGS] AUTHENTIC DEFECT CANDIDATES FOR ROUND 2 PHASE 1 FINDINGS:${ANSI_RESET}`);
    findings.forEach((f, idx) => {
      console.log(`  [DEF2-5-0${idx + 1}] ${f.testName}`);
      console.log(`              ↳ ${f.details}`);
    });
    console.log("");
  }
  return { totalTests, passedTests, failedTests, findings };
}

runAudit()
  .then((res) => process.exit(res.failedTests > 0 || res.findings.length > 0 ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
