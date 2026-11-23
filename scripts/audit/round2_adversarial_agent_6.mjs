import hre from "hardhat";
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  generateSymmetricKey,
  encryptGenomicData,
  decryptGenomicPayload,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  unpackCiphertextPayload,
  packCiphertextPayload,
  generateAsymmetricKeyPair,
  exportPublicKey,
  importPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  importKeyFromHex,
  computeDataHash,
  generateClinicalPdfReport
} from "../../crypto/client_crypto.js";
import { computeIpfsCidV0 } from "../../ipfs/pinata_uploader.js";
import { translations } from "../../frontend/src/i18n/translations.js";

async function runRound2AdversarialSuite() {
  console.log("================================================================================");
  console.log("[AUDIT] ROUND 2 ADVERSARIAL DISCOVERY AUDIT SUITE - AUDIT AGENT 6");
  console.log("   Học phần: IS355 - Công nghệ Blockchain (Khoa HTTT - Trường ĐH CNTT / UIT)");
  console.log("   Giảng viên hướng dẫn: ThS. Hà Lê Hoài Trung");
  console.log("   Sinh viên thực hiện : Nguyễn Trọng Khôi (MSSV: 23520783)");
  console.log("   Quy chuẩn quản trị  : AGENTS.md v2.1 Enterprise Standard (Workflow 08)");
  console.log("================================================================================\n");

  let passedTests = 0;
  let totalTests = 0;
  const findings = [];

  function assertTest(title, condition, detail = "", findingCode = null) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  [PASS #${totalTests}] ${title}`);
      if (detail) console.log(`         ↳ ${detail}`);
    } else {
      console.error(`  [DEFECT DETECTED #${totalTests}] ${title}`);
      if (detail) console.error(`         ↳ ${detail}`);
      if (findingCode) findings.push({ code: findingCode, title, detail });
    }
  }

  // ==============================================================================
  // MODULE 1: Course Alignment & Academic Hygiene (Task 1 & Task 8)
  // ==============================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("MODULE 1: Course Alignment, Academic Hygiene & Web3.py Script Audit");
  console.log("--------------------------------------------------------------------------------");

  // Test 1.1: Academic attribution in web3_demo.py banner
  const web3DemoPath = path.resolve("scripts/demo/web3_demo.py");
  const web3DemoContent = fs.readFileSync(web3DemoPath, "utf-8");
  const hasCourseId = web3DemoContent.includes("IS355");
  const hasInstructor = web3DemoContent.includes("ThS. Hà Lê Hoài Trung") || web3DemoContent.includes("Ha Le Hoai Trung");
  const hasStudent = web3DemoContent.includes("23520783");

  assertTest(
    "Course Identity in web3_demo.py: Includes IS355, ThS. Hà Lê Hoài Trung, and 23520783",
    hasCourseId && hasInstructor && hasStudent,
    hasCourseId && hasInstructor && hasStudent
      ? "Course metadata fully present in web3_demo.py banner"
      : `Missing attribution in web3_demo.py: IS355=${hasCourseId}, Instructor=${hasInstructor}, Student=${hasStudent}`,
    "DEF2-6-04"
  );

  // Test 1.2: Escrow Timelock Workflow exercised in web3_demo.py
  const hasEscrowInWeb3Demo = web3DemoContent.includes("grantAccessWithEscrow");
  assertTest(
    "Workflow Completeness in web3_demo.py: Executes grantAccessWithEscrow timelock",
    hasEscrowInWeb3Demo,
    hasEscrowInWeb3Demo
      ? "grantAccessWithEscrow demonstrated on Web3.py"
      : "web3_demo.py only executes simple grantAccess(); grantAccessWithEscrow timelock flow is omitted",
    "DEF2-6-04"
  );

  // Test 1.3: Academic Hygiene Toolkit zip filter excludes .agents and .gemini
  const toolkitPath = path.resolve("scripts/audit/academic_hygiene_toolkit.py");
  const toolkitContent = fs.readFileSync(toolkitPath, "utf-8");
  const excludesAgentsDir = toolkitContent.includes("'.agents'") || toolkitContent.includes('".agents"');
  const excludesGeminiDir = toolkitContent.includes("'.gemini'") || toolkitContent.includes('".gemini"');
  assertTest(
    "Academic Hygiene Packaging Guard: FORBIDDEN_DIRECTORIES strictly rejects .agents and .gemini",
    excludesAgentsDir && excludesGeminiDir,
    excludesAgentsDir && excludesGeminiDir
      ? ".agents and .gemini forbidden from clean student submission zips"
      : `academic_hygiene_toolkit.py lacks AI artifact exclusion: .agents=${excludesAgentsDir}, .gemini=${excludesGeminiDir}`,
    "DEF2-6-04"
  );

  // Test 1.4: Strict 0x Hex format preservation in Python scripts
  const patternBareHex = /tx_hash\.hex\(\)/;
  const hasBareTxHex = patternBareHex.test(web3DemoContent);
  assertTest(
    "Strict 0x Hex Preservation: web3_demo.py uses Web3.to_hex(tx_hash) without bare tx_hash.hex()",
    !hasBareTxHex,
    !hasBareTxHex ? "Zero instances of bare tx_hash.hex() found in web3_demo.py" : "Detected bare tx_hash.hex() violating Invariant 12",
    "DEF2-6-04"
  );

  // ==============================================================================
  // MODULE 2: Smart Contract Lifecycle Symmetry & Escrow Siphoning (Task 2 & Task 4)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 2: Smart Contract Lifecycle Symmetry & Escrow Siphoning (Invariant 16)");
  console.log("--------------------------------------------------------------------------------");

  const { ethers } = await hre.network.create();
  const [deployer, owner, buyer, attacker] = await ethers.getSigners();

  // Deploy GenomicToken ($GENO)
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();

  // Deploy GenomicNFT (GNFT)
  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(deployer.address, 1000); // 10% royalty
  await nft.waitForDeployment();

  // Deploy GenomicsRegistry
  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(
    await token.getAddress(),
    await nft.getAddress(),
    deployer.address
  );
  await registry.waitForDeployment();

  // Authorize Registry to mint NFTs
  await nft.connect(deployer).setRegistryContract(await registry.getAddress());

  // Fund owner and buyer with $GENO
  await token.connect(deployer).mint(owner.address, ethers.parseEther("5000"));
  await token.connect(deployer).mint(buyer.address, ethers.parseEther("5000"));

  // Register Dataset #1
  const rawHash = ethers.keccak256(ethers.toUtf8Bytes("GENOME_VCF_TEST_PAYLOAD_01"));
  const regTx = await registry.connect(owner).registerGenomicData(
    rawHash,
    "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
    "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
    "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
    "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
    ethers.parseEther("100"),
    30 * 86400,
    1000 // 10%
  );
  await regTx.wait();

  // Buyer approves tokens and purchases access with Escrow
  await token.connect(buyer).approve(await registry.getAddress(), ethers.parseEther("100"));
  const escrowTx = await registry.connect(buyer).grantAccessWithEscrow(1, 86400); // 24h dispute window
  await escrowTx.wait();

  // Verify buyer has active access initially
  const hasAccessBefore = await registry.hasActiveAccess(1, buyer.address);
  assertTest(
    "Escrow Initialization: Buyer has active access grant upon escrow deposit",
    hasAccessBefore === true,
    `Buyer access granted for Dataset #1, 100 $GENO locked in escrow contract`
  );

  // Data Owner PAUSES or REVOKES the dataset
  await registry.connect(owner).updateDataStatus(1, 2); // 2 = Revoked
  const hasAccessAfterRevoke = await registry.hasActiveAccess(1, buyer.address);
  assertTest(
    "Revocation Enforcement: hasActiveAccess immediately returns false when Revoked",
    hasAccessAfterRevoke === false,
    `Dataset #1 status set to Revoked; buyer active access blocked`
  );

  // Attempting to read transformed capsule reverts with DataNotActive
  let getCapsuleReverted = false;
  try {
    await registry.connect(buyer).getTransformedCapsule(1);
  } catch (err) {
    getCapsuleReverted = err.message.includes("DataNotActive");
  }
  assertTest(
    "Revocation Guard: getTransformedCapsule reverts with DataNotActive()",
    getCapsuleReverted === true,
    `Buyer cannot retrieve capsule for Revoked dataset`
  );

  // ATTACK / BUG DEMONSTRATION (DEF2-6-01):
  // Can owner or dispatcher call storeTransformedCapsule on Revoked dataset and siphon locked escrow tokens?
  const fakeCapsule = JSON.stringify({ version: "v2", keyCipher: "deadbeef" });
  let storeCapsuleOnRevokedSucceeded = false;
  const ownerBalBefore = await token.balanceOf(owner.address);

  try {
    const tx = await registry.connect(owner).storeTransformedCapsule(1, buyer.address, fakeCapsule);
    await tx.wait();
    storeCapsuleOnRevokedSucceeded = true;
  } catch (err) {
    storeCapsuleOnRevokedSucceeded = false;
  }

  const ownerBalAfter = await token.balanceOf(owner.address);
  const transferredTokens = ownerBalAfter - ownerBalBefore;

  // Under INVARIANT-16, storeTransformedCapsule on Revoked dataset SHOULD REVERT with DataNotActive!
  // If it succeeds and transfers tokens, that's DEF2-6-01!
  assertTest(
    "INVARIANT-16 Lifecycle Symmetry: storeTransformedCapsule must reject calls when dataset is Revoked/Paused",
    storeCapsuleOnRevokedSucceeded === false,
    storeCapsuleOnRevokedSucceeded
      ? `CRITICAL BUG: storeTransformedCapsule succeeded on Revoked dataset and released ${ethers.formatEther(transferredTokens)} $GENO to seller while buyer cannot access data!`
      : "storeTransformedCapsule correctly rejected delivery on non-active dataset",
    "DEF2-6-01"
  );

  // Also test emitTransformedCapsule on Revoked dataset
  let emitCapsuleOnRevokedSucceeded = false;
  try {
    const tx = await registry.connect(owner).emitTransformedCapsule(1, buyer.address, fakeCapsule);
    await tx.wait();
    emitCapsuleOnRevokedSucceeded = true;
  } catch (err) {
    emitCapsuleOnRevokedSucceeded = false;
  }
  assertTest(
    "INVARIANT-16 Lifecycle Symmetry: emitTransformedCapsule must reject calls when dataset is Revoked/Paused",
    emitCapsuleOnRevokedSucceeded === false,
    emitCapsuleOnRevokedSucceeded
      ? "CRITICAL BUG: emitTransformedCapsule succeeded on Revoked dataset without checking status == Active!"
      : "emitTransformedCapsule correctly rejected delivery on non-active dataset",
    "DEF2-6-01"
  );

  // ==============================================================================
  // MODULE 3: Crypt4GH Stream Chunk Parsing & Boundary Safety (Task 3)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 3: Crypt4GH Stream Chunk Parsing & Boundary Safety (WebCrypto GCM)");
  console.log("--------------------------------------------------------------------------------");

  // Test 3.1: Minimum ciphertext length for authenticated payload unpacking
  let unpack15BytesFailed = false;
  let unpack15ErrorMsg = "";
  try {
    const shortPayload = new Uint8Array(15); // > 12 IV bytes, but < 28 bytes (missing 16-byte GMAC tag)
    unpackCiphertextPayload(shortPayload);
  } catch (err) {
    unpack15BytesFailed = true;
    unpack15ErrorMsg = err.message;
  }

  // unpackCiphertextPayload only checks < 12 instead of < 28 (12 IV + 16 Tag)
  assertTest(
    "Ciphertext Minimum Tag Boundary: unpackCiphertextPayload enforces 28-byte minimum (12 IV + 16 Tag)",
    unpack15BytesFailed && unpack15ErrorMsg.includes("tag"),
    unpack15BytesFailed && unpack15ErrorMsg.includes("tag")
      ? "Strict boundary validation enforces full IV + GMAC tag minimum length"
      : `Lax check: unpackCiphertextPayload accepts 15 bytes (allows incomplete ciphertext with missing GMAC tag)`,
    "DEF2-6-02"
  );

  // Test 3.2: Malformed Chunked Header Handling in decryptGenomicDataChunked
  // Create a truncated payload with valid GNC1 magic but truncated chunk data
  const corruptChunkPayload = new Uint8Array(24);
  corruptChunkPayload.set([0x47, 0x4e, 0x43, 0x31], 0); // 'GNC1'
  const view = new DataView(corruptChunkPayload.buffer);
  view.setUint32(4, 65536, false); // chunkSize
  view.setUint32(8, 2, false);     // chunkCount = 2
  view.setBigUint64(12, 1000n, false); // totalPlaintextSize
  view.setUint32(20, 500, false);  // chunkLen = 500 (but payload only has 24 bytes!)

  let chunkedTruncationError = null;
  try {
    const dummyKey = await generateSymmetricKey();
    await decryptGenomicDataChunked(corruptChunkPayload, dummyKey);
  } catch (err) {
    chunkedTruncationError = err;
  }

  const isHandledGracefully = chunkedTruncationError && !chunkedTruncationError.message.includes("outside the bounds");
  assertTest(
    "Crypt4GH Chunk Boundary Safety: Truncated stream rejected with descriptive error instead of RangeError",
    isHandledGracefully,
    isHandledGracefully
      ? "Graceful error on truncated chunk payload"
      : `Unhandled V8 RangeError during chunk parsing: ${chunkedTruncationError?.message}`,
    "DEF2-6-02"
  );

  // ==============================================================================
  // MODULE 4: PDF 1.4 PostScript Injection & Mojibake (Task 3 & Task 7)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 4: PDF 1.4 PostScript String Syntax & Unicode Encoding Integrity");
  console.log("--------------------------------------------------------------------------------");

  // Test 4.1: Unescaped parenthesis injection in clinical PDF
  const testVariantWithParen = "rs671 (c.1510G>A (unmatched_parenthesis_note";
  const pdfBytes = generateClinicalPdfReport({
    subjectId: "TEST_SAMPLE_01",
    disease: "1000 Genomes Project - Population Variation",
    gene: "ALDH2",
    variant: testVariantWithParen
  });
  const pdfString = new TextDecoder("latin1").decode(pdfBytes);

  // In PDF literal strings, an unmatched '(' breaks the string balance unless escaped like '\('
  // Let's check if the variant line escaped the parentheses or left raw injection
  const variantLineMatch = pdfString.match(/\(Identified Molecular Variant: ([^\)]+)\) Tj/);
  const isPostscriptSanitized = !pdfString.includes(`(Identified Molecular Variant: ${testVariantWithParen}) Tj`);

  assertTest(
    "PDF 1.4 PostScript Literal Escaping: Parentheses inside variant strings must be escaped (\\( / \\))",
    isPostscriptSanitized,
    isPostscriptSanitized
      ? "Parentheses properly escaped in PDF literal strings"
      : "Unescaped literal parenthesis injected into PDF PostScript stream (causes syntax error in strict PDF readers)",
    "DEF2-6-03"
  );

  // Test 4.2: Em-dash UTF-8 multibyte in Helvetica Type 1 font
  const hasRawUtf8EmDash = pdfString.includes("\xe2\x80\x94");
  assertTest(
    "PDF 1.4 Font Encoding: No raw UTF-8 multibyte sequences (like em-dash) in standard Type 1 Helvetica",
    !hasRawUtf8EmDash,
    !hasRawUtf8EmDash
      ? "Clean font encoding without raw UTF-8 multibyte mojibake"
      : "Raw UTF-8 em-dash sequence (\\xe2\\x80\\x94) found in PDF stream without encoding mapping (renders as â€” mojibake)",
    "DEF2-6-03"
  );

  // ==============================================================================
  // MODULE 5: IPFS Dual-Engine & Anti-Mockup AST (Task 5)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 5: Decentralized IPFS Storage, RFC Multihash & Anti-Mockup AST");
  console.log("--------------------------------------------------------------------------------");

  // Test 5.1: Real CIDv0 Base58 Multihash format
  const sampleData = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA";
  const cid = await computeIpfsCidV0(sampleData);
  const isValidCid = cid.startsWith("Qm") && cid.length === 46;
  assertTest(
    "RFC Multihash Integrity: computeIpfsCidV0 produces genuine 46-char Base58 CIDv0",
    isValidCid,
    `Generated CID: ${cid} (length: ${cid.length})`
  );

  // Test 5.2: Static grep scan for fake QmGeno prefix in source directories
  const filesToScan = [
    "frontend/src/App.jsx",
    "frontend/src/services/datasetService.js",
    "frontend/src/services/vcfService.js",
    "crypto/client_crypto.js",
    "ipfs/pinata_uploader.js"
  ];
  let mockPrefixFound = false;
  for (const f of filesToScan) {
    const fullPath = path.resolve(f);
    if (fs.existsSync(fullPath)) {
      const c = fs.readFileSync(fullPath, "utf-8");
      if (c.includes("QmGeno")) {
        mockPrefixFound = true;
      }
    }
  }
  assertTest(
    "INVARIANT-02 Anti-Mockup AST: Zero fake 'QmGeno' prefixes in active production source",
    !mockPrefixFound,
    !mockPrefixFound ? "Scanned core files: 0 mock CID occurrences" : "Found fake QmGeno mock prefix"
  );

  // ==============================================================================
  // MODULE 6: UI/UX i18n & Activity Feed Localization (Task 7)
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 6: UI/UX i18n & Activity Feed Localization Parity");
  console.log("--------------------------------------------------------------------------------");

  // Test 6.1: Full key parity between Vietnamese and English
  const viKeys = Object.keys(translations.vi);
  const enKeys = Object.keys(translations.en);
  const diffViEn = viKeys.filter((k) => !(k in translations.en));
  const diffEnVi = enKeys.filter((k) => !(k in translations.vi));
  assertTest(
    "Bilingual Translation Parity: 100% key parity between translations.vi and translations.en",
    diffViEn.length === 0 && diffEnVi.length === 0,
    `VI keys: ${viKeys.length}, EN keys: ${enKeys.length}, Missing in EN: ${diffViEn.length}, Missing in VI: ${diffEnVi.length}`
  );

  // Test 6.2: OpenSea Activity Feed Timestamp Localization
  const activityFeedPath = path.resolve("frontend/src/features/researcher/OpenSeaActivityFeed.jsx");
  const activityContent = fs.readFileSync(activityFeedPath, "utf-8");
  const hasHardcodedAgo = activityContent.includes('"5m ago"') || activityContent.includes('"1h ago"');
  assertTest(
    "Activity Feed Timestamp Localization: Timestamps in OpenSeaActivityFeed are localized via i18n",
    !hasHardcodedAgo,
    !hasHardcodedAgo
      ? "Activity feed uses localized timestamp helper"
      : 'Hardcoded English relative timestamps ("5m ago", "1h ago") bypass Vietnamese localization',
    "DEF2-6-05"
  );

  // ==============================================================================
  // AUDIT SUITE SUMMARY
  // ==============================================================================
  console.log("\n================================================================================");
  console.log("[AUDIT] ROUND 2 AUDIT SUITE EXECUTION SUMMARY");
  console.log("================================================================================");
  console.log(`Total Adversarial Invariants Tested : ${totalTests}`);
  console.log(`Passed Invariants                  : ${passedTests}`);
  console.log(`Defect / Vulnerability Findings    : ${findings.length}`);
  console.log("================================================================================");

  if (findings.length > 0) {
    console.log("\n[WARN] NEW DEFECT CANDIDATES IDENTIFIED IN ROUND 2:");
    findings.forEach((f, idx) => {
      console.log(`  [${f.code}] ${f.title}`);
      console.log(`        ↳ Evidence: ${f.detail}`);
    });
  }
  console.log("================================================================================\n");

  return { totalTests, passedTests, findings };
}

runRound2AdversarialSuite()
  .then((res) => {
    const failed = res.findings.length > 0 || res.passedTests !== res.totalTests;
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error("Audit Suite Crash:", err);
    process.exit(1);
  });
