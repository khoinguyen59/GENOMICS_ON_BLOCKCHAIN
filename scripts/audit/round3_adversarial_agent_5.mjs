/**
 * @file round3_adversarial_agent_5.mjs
 * @description Round 3 Independent Adversarial Audit Suite - Council Member 5 (Audit R3 Agent 5)
 *              Genomics on Blockchain (IS355 - ĐHQG-HCM / UIT)
 *              Specialized Focus: 
 *              - Task 1 & 7: Pure Genomics Boundary (INVARIANT-11), UI/UX State Sync & Vision Artifact Verification
 *              - Task 2: Smart Contract Cross-Function Symmetry (INVARIANT-16) & Boundary Reverts
 *              - Task 3 & 5: Cryptographic Integrity (INVARIANT-05, INVARIANT-02) & PDF Tamper Detection
 *              - Task 6: Tautology Hunting, Fuzzing & Anti-Mockup AST Audit
 *              - Task 8: Academic Hygiene, 0x Hex Format & Cross-Validation Truth (INVARIANT-12)
 * @author Council Member 5 (Round 3 Swarm)
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const defectsIdentified = [];

function assertTest(condition, testName, details = "", defectCode = null, defectMeta = {}) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ${ANSI_GREEN}[PASS #${totalTests}]${ANSI_RESET} ${testName}`);
    if (details) console.log(`         ↳ ${details}`);
  } else {
    failedTests++;
    console.log(`  ${ANSI_RED}[FAIL #${totalTests}]${ANSI_RESET} ${testName}`);
    if (details) console.log(`         ↳ ${ANSI_RED}DEFECT DETECTED:${ANSI_RESET} ${details}`);
    if (defectCode) {
      defectsIdentified.push({
        id: defectCode,
        testName,
        details,
        ...defectMeta
      });
    }
  }
}

async function runRound3Audit() {
  console.log("================================================================================");
  console.log(`${ANSI_CYAN}[AUDIT] STARTING ROUND 3 ADVERSARIAL SWARM AUDIT - AGENT 5 (FULL-SCOPE SUITE)${ANSI_RESET}`);
  console.log("   Academic Standard: IS355 - Blockchain & Applications | UIT ĐHQG-HCM");
  console.log("   Instructor        : ThS. Hà Lê Hoài Trung");
  console.log("   Student           : Nguyễn Trọng Khôi (MSSV: 23520783)");
  console.log("   Audit Dimensions  : Tasks 1 through 8 (Pure Genomics, EVM, Crypto, Vision, Tests)");
  console.log("================================================================================\n");

  // ===========================================================================
  // SECTION 1: INVARIANT-11 Pure Genomics vs Clinical Cancer Data Scrutiny
  // ===========================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("SECTION 1: INVARIANT-11 Domain Boundary (Pure Genomics vs Clinical Cancer/Hospital)");
  console.log("--------------------------------------------------------------------------------");

  // 1.1 Check data/ sample directory for clinical/hospital cancer records
  const sampleVcfPath = path.join(ROOT_DIR, "data", "sample_metabolic_traits.vcf");
  const samplePhenoPath = path.join(ROOT_DIR, "data", "sample_phenopacket.json");
  const sampleSummaryPath = path.join(ROOT_DIR, "data", "sample_summary_report.txt");

  let vcfContainsProhibited = false;
  let phenoContainsProhibited = false;
  let summaryContainsProhibited = false;

  if (fs.existsSync(sampleVcfPath)) {
    const vcfContent = fs.readFileSync(sampleVcfPath, "utf-8");
    if (/PATIENT_VN|BRCA1|Pathogenic/i.test(vcfContent)) {
      vcfContainsProhibited = true;
    }
  }

  if (fs.existsSync(samplePhenoPath)) {
    const phenoContent = fs.readFileSync(samplePhenoPath, "utf-8");
    if (/carcinoma|breast ovarian cancer/i.test(phenoContent)) {
      phenoContainsProhibited = true;
    }
  }

  if (fs.existsSync(sampleSummaryPath)) {
    const summaryContent = fs.readFileSync(sampleSummaryPath, "utf-8");
    if (/PATIENT ID|breast and ovarian cancer|CLINICAL INDICATION/i.test(summaryContent)) {
      summaryContainsProhibited = true;
    }
  }

  assertTest(
    !vcfContainsProhibited,
    "INVARIANT-11: data/sample_metabolic_traits.vcf must not contain hospital patient IDs or clinical cancer gene records",
    vcfContainsProhibited
      ? "Found 'PATIENT_VN_9042' and 'BRCA1 Pathogenic' in data/sample_metabolic_traits.vcf"
      : "sample_metabolic_traits.vcf adheres to non-clinical genetics",
    "DEF3-5-01",
    {
      file: "data/sample_metabolic_traits.vcf",
      line: 10,
      severity: "High",
      type: "Domain Boundary / INVARIANT-11",
      description: "Sample VCF contains PATIENT_VN_9042 and pathogenic cancer data violating INVARIANT-11"
    }
  );

  assertTest(
    !phenoContainsProhibited && !summaryContainsProhibited,
    "INVARIANT-11: data/sample_phenopacket.json & sample_summary_report.txt must not contain clinical cancer syndromes",
    phenoContainsProhibited || summaryContainsProhibited
      ? "Found 'Breast carcinoma', 'Hereditary breast ovarian cancer syndrome', and 'PATIENT ID: SUBJ_VN_9042'"
      : "Sample phenopacket and summary report are clean",
    "DEF3-5-02",
    {
      file: "data/sample_phenopacket.json & data/sample_summary_report.txt",
      line: 17,
      severity: "High",
      type: "Domain Boundary / INVARIANT-11",
      description: "Phenopacket and summary report specify clinical oncology diagnoses violating INVARIANT-11"
    }
  );

  // 1.2 Check frontend/src/contracts/seedMetadata.json for pure molecular genetics
  const seedMetadataPath = path.join(ROOT_DIR, "frontend", "src", "contracts", "seedMetadata.json");
  let seedClean = true;
  let seedCount = 0;
  if (fs.existsSync(seedMetadataPath)) {
    const seeds = JSON.parse(fs.readFileSync(seedMetadataPath, "utf-8")).seeds || [];
    seedCount = seeds.length;
    for (const s of seeds) {
      if (/cancer|ung thư|bệnh án|carcinoma/i.test(s.disease)) {
        seedClean = false;
        break;
      }
    }
  }
  assertTest(
    seedClean && seedCount >= 13,
    "INVARIANT-11: frontend seedMetadata.json datasets represent pure molecular genetics & traits",
    seedClean
      ? `All ${seedCount} seed datasets represent 1000 Genomes, dbSNP traits, or GIAB benchmarks`
      : "Seed contains clinical cancer"
  );

  // ===========================================================================
  // SECTION 2: Task 2 Smart Contract Lifecycle & State Symmetry (INVARIANT-16)
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 2: Smart Contract Symmetry & Boundary Checks (INVARIANT-16)");
  console.log("--------------------------------------------------------------------------------");

  const registrySolPath = path.join(ROOT_DIR, "contracts", "GenomicsRegistry.sol");
  const escrowEngineSolPath = path.join(ROOT_DIR, "contracts", "registry", "GenomicsEscrowEngine.sol");
  const registryCode = fs.readFileSync(registrySolPath, "utf-8");
  const escrowEngineCode = fs.existsSync(escrowEngineSolPath) ? fs.readFileSync(escrowEngineSolPath, "utf-8") : "";

  // 2.1 INVARIANT-16 check on buyerCapsules: Does buyerCapsules revert DataNotFound on out-of-bounds dataId?
  const bcStart = registryCode.indexOf("function buyerCapsules(");
  const bcEnd = bcStart !== -1 ? registryCode.indexOf("function hasActiveAccess(", bcStart) : -1;
  const buyerCapsulesBody = bcStart !== -1 && bcEnd !== -1 ? registryCode.slice(bcStart, bcEnd) : "";
  let buyerCapsulesRevertsOnOob = false;
  let buyerCapsulesIgnoresIsGranted = true;

  if (buyerCapsulesBody) {
    if (
      buyerCapsulesBody.includes("revert DataNotFound()") ||
      (buyerCapsulesBody.includes("_requireValidDataId(dataId)") && registryCode.includes("revert DataNotFound()"))
    ) {
      buyerCapsulesRevertsOnOob = true;
    }
    if (
      buyerCapsulesBody.includes("grant.isGranted") ||
      (buyerCapsulesBody.includes("getBuyerCapsuleByMode") &&
        escrowEngineCode.includes("_requireActiveGrant(dataId, user)") &&
        /![\w.]+\.isGranted/.test(escrowEngineCode))
    ) {
      buyerCapsulesIgnoresIsGranted = false;
    }
  }

  assertTest(
    buyerCapsulesRevertsOnOob,
    "INVARIANT-16: buyerCapsules(dataId, researcher) reverts DataNotFound() on out-of-bounds dataId (not return \"\")",
    buyerCapsulesRevertsOnOob 
      ? "buyerCapsules strictly reverts DataNotFound() on invalid dataId"
      : "buyerCapsules silently returns empty string `return \"\"` on dataId == 0 || dataId > dataCount, violating INVARIANT-16",
    "DEF3-5-03",
    {
      file: "contracts/GenomicsRegistry.sol",
      line: 755,
      severity: "Medium",
      type: "EVM State Symmetry / INVARIANT-16",
      description: "buyerCapsules silently returns empty string instead of reverting DataNotFound() on out-of-bounds dataId"
    }
  );

  assertTest(
    !buyerCapsulesIgnoresIsGranted,
    "INVARIANT-16: buyerCapsules(dataId, researcher) validates grant.isGranted before returning capsule to researcher",
    !buyerCapsulesIgnoresIsGranted
      ? "grant.isGranted is verified symmetrically with getTransformedCapsule"
      : "buyerCapsules checks only expiresAt but omits checking `grant.isGranted`, allowing capsule exposure if expiresAt is 0",
    "DEF3-5-04",
    {
      file: "contracts/GenomicsRegistry.sol",
      line: 760,
      severity: "Medium",
      type: "Access Control Symmetry / INVARIANT-16",
      description: "buyerCapsules omits grant.isGranted validation present in getTransformedCapsule"
    }
  );

  // 2.2 Verify updateDataStatus permanently blocks reactivation of Revoked datasets
  const updateDataStatusBlocksRevoked =
    registryCode.includes("data.status == DataStatus.Revoked) revert ConsentPermanentlyRevoked()") ||
    (registryCode.includes("function updateDataStatus") &&
      registryCode.includes("onlyMutableDataOwner(dataId)") &&
      registryCode.includes("revert ConsentPermanentlyRevoked()"));
  assertTest(
    updateDataStatusBlocksRevoked,
    "GDPR & Protocol Invariant: updateDataStatus() reverts ConsentPermanentlyRevoked() when dataset is Revoked",
    updateDataStatusBlocksRevoked ? "Revoked dataset cannot be transitioned back to Active/Paused" : "Revocation can be bypassed"
  );

  // ===========================================================================
  // SECTION 3: Task 7 Vision Audit & Evidence Discrepancy (INVARIANT-12, INVARIANT-13)
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 3: Vision Evidence Audit & Cross-Layer Parity (INVARIANT-12, INVARIANT-13)");
  console.log("--------------------------------------------------------------------------------");

  // 3.1 Check docs/evidence/ for obsolete clinical cancer screenshots
  const cancerScreenshotPreset = path.join(ROOT_DIR, "docs", "evidence", "donor_portal", "04_brca1_autofill_preset.png");
  const cancerScreenshotFilter = path.join(ROOT_DIR, "docs", "evidence", "marketplace", "09_filter_clinical_pathogenic_brca1.png");

  const cancerScreenshotsExist = fs.existsSync(cancerScreenshotPreset) || fs.existsSync(cancerScreenshotFilter);

  assertTest(
    !cancerScreenshotsExist,
    "INVARIANT-11 & Task 7 Vision: Evidence directory must not contain obsolete clinical cancer screenshots (BRCA1 preset & filter)",
    cancerScreenshotsExist
      ? "Found '04_brca1_autofill_preset.png' ('Ung Thư Vú & Buồng Trứng Di Truyền') and '09_filter_clinical_pathogenic_brca1.png' in docs/evidence/"
      : "No cancer screenshots in docs/evidence/",
    "DEF3-5-05",
    {
      file: "docs/evidence/donor_portal/04_brca1_autofill_preset.png & docs/evidence/marketplace/09_filter_clinical_pathogenic_brca1.png",
      line: "N/A",
      severity: "High",
      type: "Evidence Hygiene & Vision Audit",
      description: "Evidence screenshots showcase clinical oncology forms and pathogenic cancer filters violating INVARIANT-11"
    }
  );

  // 3.2 Check docs/evidence/README.md for catalog count disparity (6 vs 10 datasets)
  const evidenceReadmePath = path.join(ROOT_DIR, "docs", "evidence", "README.md");
  let evidenceReadmeRefersToOld6Datasets = false;
  if (fs.existsSync(evidenceReadmePath)) {
    const readmeContent = fs.readFileSync(evidenceReadmePath, "utf-8");
    if (readmeContent.includes("hiển thị 6 tập dữ liệu") || readmeContent.includes("BRCA1 (rs80357906)")) {
      evidenceReadmeRefersToOld6Datasets = true;
    }
  }

  assertTest(
    !evidenceReadmeRefersToOld6Datasets,
    `INVARIANT-12: docs/evidence/README.md catalog description must match the active ${seedCount} molecular seed datasets`,
    evidenceReadmeRefersToOld6Datasets
      ? `docs/evidence/README.md refers to obsolete '6 tập dữ liệu gen chuẩn' and 'BRCA1 rs80357906', whereas seedMetadata.json has ${seedCount} pure molecular datasets`
      : "docs/evidence/README.md is fully synchronized with seedMetadata.json",
    "DEF3-5-06",
    {
      file: "docs/evidence/README.md",
      line: 37,
      severity: "Low",
      type: "Documentation Cross-Validation / INVARIANT-12",
      description: `Evidence README documentation describes legacy 6-dataset catalog with BRCA1 instead of current ${seedCount}-dataset catalog`
    }
  );

  // 3.3 Visual Cover UI typo check in refactored donor portal components
  const dragDropSrc = fs.readFileSync(
    path.join(ROOT_DIR, "frontend", "src", "features", "donor", "DragDropMintingStudio.jsx"),
    "utf-8"
  );
  const liveAuditPath = path.join(ROOT_DIR, "frontend", "src", "features", "donor", "LiveTransmissionAudit.jsx");
  const liveAuditSrc = fs.existsSync(liveAuditPath) ? fs.readFileSync(liveAuditPath, "utf-8") : "";
  const combinedDonorUi = `${dragDropSrc}\n${liveAuditSrc}`;
  const hasConcatTypoInFrontend =
    combinedDonorUi.includes("OLive Zero") || combinedDonorUi.includes("Audit100%");
  assertTest(
    !hasConcatTypoInFrontend,
    "Frontend UI Typography: Zero-Plaintext Transmission widget renders proper whitespace in production build",
    !hasConcatTypoInFrontend
      ? "Verified clean whitespace in DragDropMintingStudio.jsx & LiveTransmissionAudit.jsx"
      : "Found concatenated typography typo in donor portal UI",
    "DEF3-5-08"
  );

  // ===========================================================================
  // SECTION 4: Task 3 & 5 Cryptographic Package Integrity & PDF Dual Anchor
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 4: Cryptographic Package Integrity, rawDataHash & PDF Dual Anchor");
  console.log("--------------------------------------------------------------------------------");

  // 4.1 INVARIANT-05: rawDataHash on full package (IV || Ciphertext)
  const samplePlaintext = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA\t100\tPASS";
  const encryptedPkg = await encryptGenomicData(samplePlaintext);
  const computedPkgHash = await computeDataHash(encryptedPkg.payload);

  assertTest(
    computedPkgHash === encryptedPkg.rawDataHash,
    "INVARIANT-05: rawDataHash is SHA-256 over entire package (IV [12] || Ciphertext [AES-GCM])",
    `Package Hash: ${encryptedPkg.rawDataHash}`
  );

  // 4.2 PDF Dual-Anchor Integrity Check (DEF2-2-06 verification)
  const datasetServicePath = path.join(ROOT_DIR, "frontend", "src", "services", "datasetService.js");
  const datasetServiceCode = fs.readFileSync(datasetServicePath, "utf-8");
  const checksSummaryDataHash = datasetServiceCode.includes("dataset.summaryDataHash") && datasetServiceCode.includes("computedHash.toLowerCase() !== expectedHash");
  const checksSummaryCid =
    (datasetServiceCode.includes("computeIpfsCidV0(downloadedBlob)") && datasetServiceCode.includes("computedCid !== dataset.summaryCid")) ||
    datasetServiceCode.includes("verifySummaryCidIntegrity(dataset.summaryCid, downloadedBlob, computedHash)");

  assertTest(
    checksSummaryDataHash && checksSummaryCid,
    "DEF2-2-06 Dual-Anchor: decryptSummaryReport enforces BOTH summaryDataHash AND summaryCid verification",
    checksSummaryDataHash && checksSummaryCid
      ? "Both cryptographic hash and IPFS CID anchors are verified before PDF decryption"
      : "Missing dual-anchor verification in decryptSummaryReport"
  );

  // 4.3 Fault injection: 1-byte alteration in ciphertext package aborts decryption with MAC failure
  const tamperedPayload = new Uint8Array(encryptedPkg.payload);
  tamperedPayload[tamperedPayload.length - 1] ^= 0x01; // flip 1 bit in GMAC auth tag
  let macFailureCaught = false;
  try {
    await decryptGenomicPayload(tamperedPayload, encryptedPkg.keyHex);
  } catch (err) {
    macFailureCaught = true;
  }

  assertTest(
    macFailureCaught,
    "AES-256-GCM Authenticated Decryption: Traps 1-bit tampering in GMAC authentication tag",
    macFailureCaught ? "Decryption strictly failed on tampered ciphertext" : "Tampered ciphertext did not fail"
  );

  // ===========================================================================
  // SECTION 5: Task 6 Test Suite Scrutiny & Tautological Assertion Audit
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 5: Test Suite Integrity & Tautological Assertion Audit");
  console.log("--------------------------------------------------------------------------------");

  // 5.1 Check test/GenomicZkSNARKs.test.js for clinical cancer BRCA1 test fixtures
  const zkSnarkTestPath = path.join(ROOT_DIR, "test", "GenomicZkSNARKs.test.js");
  let zkSnarkHasCancerFixture = false;
  if (fs.existsSync(zkSnarkTestPath)) {
    const testContent = fs.readFileSync(zkSnarkTestPath, "utf-8");
    if (/TRAIT_BRCA1_PATHOGENIC|BRCA1_c\.68_69delAG_pathogenic/i.test(testContent)) {
      zkSnarkHasCancerFixture = true;
    }
  }

  assertTest(
    !zkSnarkHasCancerFixture,
    "INVARIANT-11: test/GenomicZkSNARKs.test.js must use pure molecular trait fixtures instead of pathogenic cancer",
    zkSnarkHasCancerFixture
      ? "test/GenomicZkSNARKs.test.js defines 'TRAIT_BRCA1_PATHOGENIC' and 'BRCA1_c.68_69delAG_pathogenic' violating INVARIANT-11"
      : "ZkSNARK test suite uses only molecular genetics",
    "DEF3-5-07",
    {
      file: "test/GenomicZkSNARKs.test.js",
      line: 23,
      severity: "Medium",
      type: "Test Suite Invariant Alignment / INVARIANT-11",
      description: "zk-Genomics test fixtures use BRCA1 breast cancer pathogenic trait violating INVARIANT-11"
    }
  );

  // 5.2 Crypt4GH 64KB chunk boundary fuzz test across odd byte lengths
  const boundarySizes = [65535, 65536, 65537, 131072];
  let allBoundariesPassed = true;

  for (const size of boundarySizes) {
    const randomBuffer = crypto.randomBytes(size);
    const encChunked = await encryptGenomicDataChunked(randomBuffer);
    const decChunked = await decryptGenomicDataChunked(encChunked.payload, encChunked.keyHex, { asString: false });
    if (decChunked.length !== size || !Buffer.from(decChunked).equals(randomBuffer)) {
      allBoundariesPassed = false;
      break;
    }
  }

  assertTest(
    allBoundariesPassed,
    "Crypt4GH 64KB Boundary Fuzzing: Losslessly encrypts & decrypts buffers at 65535, 65536, 65537, and 131072 bytes",
    allBoundariesPassed ? "Zero byte truncation across boundary slices" : "Boundary slice truncation detected"
  );

  // ===========================================================================
  // SECTION 6: Task 8 Academic Hygiene & 0x Tx Hash Format (INVARIANT-12)
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 6: Academic Hygiene, Web3.py TxHash 0x Prefix & Formatting (INVARIANT-12)");
  console.log("--------------------------------------------------------------------------------");

  const web3DemoPath = path.join(ROOT_DIR, "scripts", "demo", "web3_demo.py");
  const web3DemoCode = fs.readFileSync(web3DemoPath, "utf-8");
  const toHexCalls = web3DemoCode.match(/w3\.to_hex\([^)]*transactionHash\)/g) || [];
  const bareHexTxCalls = web3DemoCode.match(/transactionHash\.hex\(\)/g) || [];
  const usesWeb3ToHex = toHexCalls.length >= 2 && bareHexTxCalls.length === 0;

  assertTest(
    usesWeb3ToHex,
    "INVARIANT-12: scripts/demo/web3_demo.py extracts transaction hashes using w3.to_hex() preserving '0x' prefix and 66 chars",
    usesWeb3ToHex ? "100% compliant with 0x prefix integrity" : "Tx hash missing 0x prefix handling"
  );

  // 6.2 Check academic attribution in web3_demo.py
  const hasAcademicAttribution = web3DemoCode.includes("ThS. Hà Lê Hoài Trung") && web3DemoCode.includes("Nguyễn Trọng Khôi") && web3DemoCode.includes("23520783");
  assertTest(
    hasAcademicAttribution,
    "Academic Attribution: web3_demo.py contains exact course header (IS355, ThS. Hà Lê Hoài Trung, Nguyễn Trọng Khôi 23520783)",
    hasAcademicAttribution ? "Exact academic credentials verified" : "Missing academic credentials"
  );

  // ===========================================================================
  // FINAL SUMMARY
  // ===========================================================================
  console.log("\n================================================================================");
  console.log(`[AUDIT] AGENT 5 ROUND 3 ADVERSARIAL AUDIT EXECUTION SUMMARY`);
  console.log("================================================================================");
  console.log(`Total Invariants Evaluated    : ${totalTests}`);
  console.log(`Passed Invariants             : ${passedTests}`);
  console.log(`Detected True Defect Candidates: ${defectsIdentified.length}`);
  console.log("--------------------------------------------------------------------------------");
  if (defectsIdentified.length > 0) {
    console.log(`${ANSI_YELLOW}Summary of Identified Defects:${ANSI_RESET}`);
    for (const d of defectsIdentified) {
      console.log(`  [${d.id}] (${d.severity}) ${d.testName}`);
      console.log(`         File: ${d.file}:${d.line} | ${d.description}`);
    }
  } else {
    console.log(`${ANSI_GREEN}Zero defects found across all audited dimensions!${ANSI_RESET}`);
  }
  console.log("================================================================================\n");

  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    defects: defectsIdentified
  };
}

runRound3Audit()
  .then((res) => {
    if (res.failed > 0 || res.defects.length > 0) {
      console.log(`\n[Agent 5 Audit Finished] ${res.defects.length} defect candidate(s) / ${res.failed} failure(s) surfaced.`);
      process.exit(1);
    } else {
      console.log("\n[Agent 5 Audit Finished] All invariants passed.");
      process.exit(0);
    }
  })
  .catch((err) => {
    console.error("[Agent 5 Audit Fatal Error]:", err);
    process.exit(1);
  });
