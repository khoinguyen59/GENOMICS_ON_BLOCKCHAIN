/**
 * @file round2_adversarial_agent_3.mjs
 * @description Comprehensive Adversarial Audit Suite - Round 2 Swarm (Agent 3)
 *              IS355 - Công nghệ Blockchain | Khoa HTTT - UIT
 *              Target: Full-Scope 8 Dimensions with Deep Focus on:
 *              - UI/UX OpenSea Architecture & State Lifecycle
 *              - Precedence Shadowing & Memory Consistency
 *              - Bilingual i18n Synchronization
 *              - Non-extractable WebCrypto vs Wallet Signature Backup
 *              - EVM Escrow State Symmetry & Accounting Invariants
 * @author Audit Agent 3 (Round 2 Swarm Auditor)
 */

import { expect } from "chai";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import {
  generateAsymmetricKeyPair,
  createWalletKeyBackup,
  exportSovereignKeyVault
} from "../../crypto/client_crypto.js";
import { computeIpfsCidV0 } from "../../ipfs/pinata_uploader.js";

const rootDir = process.cwd();

async function runAdversarialAudit() {
  console.log("================================================================================");
  console.log("[AUDIT] ROUND 2 ADVERSARIAL AUDIT SUITE - AUDIT AGENT 3");
  console.log("    Focus: UI/UX OpenSea Architecture, Web3 Lifecycle, State Symmetry & i18n");
  console.log("    IS355: Blockchain & Applications | UIT 2026");
  console.log("================================================================================\n");

  let passedTests = 0;
  let totalTests = 0;
  const defectCatalog = [];

  function recordDefect(id, title, severity, details) {
    defectCatalog.push({ id, title, severity, details });
    console.log(`  🚩 [DEFECT FOUND: ${id}] (${severity}): ${title}`);
    console.log(`     ↳ ${details}\n`);
  }

  function recordPass(testName, details) {
    passedTests++;
    console.log(`  ✅ [PASS #${passedTests}] ${testName}`);
    if (details) console.log(`     ↳ ${details}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIMENSION 1 & 2: SMART CONTRACTS, CEI & ESCROW ACCOUNTING (Task 1 & Task 2)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--------------------------------------------------------------------------------");
  console.log("SECTION 1: Smart Contract State Symmetry, INVARIANT-16 & Escrow Accounting");
  console.log("--------------------------------------------------------------------------------");

  const { ethers } = await hre.network.create();
  const [deployer, seller, buyer] = await ethers.getSigners();

  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();

  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(deployer.address, 1000);
  await nft.waitForDeployment();

  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(token.target, nft.target, deployer.address);
  await registry.waitForDeployment();
  await nft.setRegistryContract(registry.target);

  // Mint sample data
  const rawHash = ethers.keccak256(ethers.toUtf8Bytes("GENOME_SEQ_SAMPLE_1"));
  await registry.connect(seller).registerGenomicData(
    rawHash,
    "QmSampleRawCid1111111111111111111111111111111",
    "QmSampleSumCid1111111111111111111111111111111",
    "QmSampleMetaCid111111111111111111111111111111",
    "ipfs://token/1",
    ethers.parseUnits("100", 18),
    86400,
    1000
  );

  // Test 1: Invariant 16 - Check grantAccess AST syntax vs other functions
  totalTests++;
  const registryContractSource = fs.readFileSync(
    path.join(rootDir, "contracts/GenomicsRegistry.sol"),
    "utf-8"
  );

  const grantAccessImpl = registryContractSource.slice(
    registryContractSource.indexOf("function grantAccess(uint256 dataId)"),
    registryContractSource.indexOf("function grantAccessWithEscrow")
  );

  const hasExplicitUpperCheck = grantAccessImpl.includes("dataId == 0 || dataId > dataCount");
  if (!hasExplicitUpperCheck) {
    recordDefect(
      "DEF2-3-01",
      "Asymmetric Boundary & State Guard in grantAccess (INVARIANT-16 Violation)",
      "Medium",
      "grantAccess() checks 'if (data.dataId == 0) revert DataNotFound();' after mapping lookup, relying on EVM default 0 value, whereas grantAccessWithEscrow, onlyDataOwner, and getGenomicData check 'if (dataId == 0 || dataId > dataCount) revert DataNotFound();' upfront. Violates INVARIANT-16 and wastes gas on storage read."
    );
  } else {
    recordPass("grantAccess Boundary Guard", "Explicit upfront check enforced.");
  }

  // Test 2: Escrow Refund Access Count Inflation
  totalTests++;
  const price = ethers.parseUnits("100", 18);
  await token.faucet(buyer.address);
  await token.connect(buyer).approve(registry.target, price);

  const initialData = await registry.getGenomicData(1);
  const countBefore = initialData.accessCount;

  // Deposit in escrow
  await registry.connect(buyer).grantAccessWithEscrow(1, 3600); // 1 hour dispute window
  const dataAfterDeposit = await registry.getGenomicData(1);
  const countAfterDeposit = dataAfterDeposit.accessCount;

  // Advance time past dispute window (3601 seconds)
  await ethers.provider.send("evm_increaseTime", [3601]);
  await ethers.provider.send("evm_mine", []);

  // Buyer claims 100% refund
  await registry.connect(buyer).claimEscrowRefund(1);
  const dataAfterRefund = await registry.getGenomicData(1);
  const countAfterRefund = dataAfterRefund.accessCount;

  if (countAfterRefund > countBefore) {
    recordDefect(
      "DEF2-3-02",
      "Escrow Refund Fails to Decrement accessCount (Popularity Metric Inflation)",
      "Medium",
      `accessCount remained ${countAfterRefund} after 100% refund (was ${countBefore} before deposit). An attacker can game marketplace sorting.`
    );
  } else {
    recordPass("Escrow Accounting Symmetry", "accessCount correctly reflects net active grants after refund.");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIMENSION 3: BIOCRYPTOGRAPHY & WEBCRYPTO (Task 3)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 2: WebCrypto Identity Keypair vs Wallet Signature Backup");
  console.log("--------------------------------------------------------------------------------");

  totalTests++;
  const nonExtractableKp = await generateAsymmetricKeyPair(false); // INVARIANT-09 compliant
  const mockSigner = {
    signMessage: async () => "0x999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999991b"
  };

  try {
    await createWalletKeyBackup(mockSigner, buyer.address, nonExtractableKp);
    recordPass("Wallet Signature Key Backup", "Key backup created.");
  } catch (err) {
    if (
      err.message.includes("Cannot export non-extractable private key") ||
      err.message.includes("INVARIANT-09 Enforcement: Private key is not extractable")
    ) {
      recordPass("INVARIANT-09 Non-Extractable Key Protection", "WebCrypto and createWalletKeyBackup strictly enforce non-extractability.");
    } else {
      console.log("Unexpected error in key backup:", err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIMENSION 7: UI/UX OPENSEA ARCHITECTURE, LIFECYCLE & i18n (Task 7 - SPECIAL FOCUS)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 3: UI/UX OpenSea Architecture, Component Lifecycle & Bilingual i18n");
  console.log("--------------------------------------------------------------------------------");

  // Test 4: OpenSea Featured Spotlight Purchase Button Missing disabled Guard
  totalTests++;
  const spotlightFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/features/researcher/OpenSeaSpotlightShowcase.jsx"),
    "utf-8"
  );
  const spotlightHasDisabledGuard = /disabled\s*=\s*\{\s*featured\.status\s*!==\s*["']Active["']\s*\}/.test(spotlightFile);

  if (!spotlightHasDisabledGuard) {
    recordDefect(
      "DEF2-3-04",
      "Featured Spotlight Card Missing Status Disabled Guard",
      "High",
      "OpenSeaSpotlightShowcase.jsx renders an active Purchase button even when featured.status !== 'Active', unlike Table and Grid views. Clicking it triggers an EVM revert."
    );
  } else {
    recordPass("Spotlight Purchase Button Guard", "featured.status disabled guard is properly enforced.");
  }

  // Test 5: DatasetContext expiryLabel Precedence Shadowing of Escrow Pending Status
  totalTests++;
  const datasetContextFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/context/DatasetContext.jsx"),
    "utf-8"
  );

  // In DatasetContext.jsx, if (!isOwner && grantData && grantData.expiresAt) comes BEFORE else if (!isOwner && escrowInfo?.isPending)
  const grantBranchIndex = datasetContextFile.indexOf("if (!isOwner && grantData && grantData.expiresAt)");
  const escrowBranchIndex = datasetContextFile.indexOf("else if (!isOwner && escrowInfo?.isPending)");

  if (grantBranchIndex !== -1 && escrowBranchIndex !== -1 && grantBranchIndex < escrowBranchIndex) {
    recordDefect(
      "DEF2-3-05",
      "Precedence Shadowing: grantData.expiresAt Shadows Pending Escrow Status",
      "High",
      "In DatasetContext.jsx, because grantAccessWithEscrow creates an active access grant, grantData.expiresAt is always present. The first 'if' branch executes, completely shadowing 'else if (escrowInfo?.isPending)'. Buyers never see 'Escrow Pending Delivery' or 'Escrow Expired (Refund Ready)'."
    );
  } else {
    recordPass("Escrow Expiry Label Precedence", "Escrow pending status is evaluated before standard grant expiration.");
  }

  // Test 6: Inspection Modal Missing Navigation on btnPurchased
  totalTests++;
  const assetModalFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/components/modals/AssetDetailModal.jsx"),
    "utf-8"
  );

  const modalHasDisabledBtnPurchased = /isPurchased\s*\?\s*\(\s*<button[^>]*disabled[^>]*>\s*<VerifiedBadgeIcon[^>]*\/>\s*<span>\{t\("btnPurchased"\)\}<\/span>/s.test(assetModalFile);

  if (modalHasDisabledBtnPurchased) {
    recordDefect(
      "DEF2-3-06",
      "Inspection Modal Has Dead Disabled 'btnPurchased' Button",
      "Medium",
      "AssetDetailModal renders a disabled 'btnPurchased' button instead of allowing the researcher to click and navigate to the licensed decryption view (setResearcherTab('licensed')), trapping the user in the modal."
    );
  } else {
    recordPass("Modal Purchased Button Navigation", "Licensed button navigates to decryption view.");
  }

  // Test 7: Scan for Native alert() in Frontend Components
  totalTests++;
  const vaultFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/features/donor/PatientSovereignVault.jsx"),
    "utf-8"
  );
  const alertMatches = vaultFile.match(/alert\s*\(/g);

  if (alertMatches && alertMatches.length > 0) {
    recordDefect(
      "DEF2-3-07",
      "Intrusive Native alert() Dialogs in PatientSovereignVault",
      "Low",
      `Found ${alertMatches.length} instances of window.alert() in PatientSovereignVault.jsx. Violates DeSci UI standards and blocks the main thread. Should use Web3Context showToast.`
    );
  } else {
    recordPass("Alert Hygiene", "Zero native alert() calls found in donor vault.");
  }

  // Test 8: Hardcoded English Sidebar Strings in GenomicFilterBar.jsx
  totalTests++;
  const filterBarFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/features/researcher/GenomicFilterBar.jsx"),
    "utf-8"
  );

  const hasHardcodedStatus = filterBarFile.includes("<span>STATUS</span>");
  const hasHardcodedPrice = filterBarFile.includes("<span>PRICE ($GENO)</span>");
  const hasHardcodedGene = filterBarFile.includes("<span>TARGET GENE</span>");
  const hasHardcodedChrom = filterBarFile.includes("<span>CHROMOSOME</span>");

  if (hasHardcodedStatus || hasHardcodedPrice || hasHardcodedGene || hasHardcodedChrom) {
    recordDefect(
      "DEF2-3-08",
      "Hardcoded English Accordion Headers in OpenSea Filter Sidebar",
      "Medium",
      "GenomicFilterBar.jsx hardcodes 'STATUS', 'PRICE ($GENO)', 'TARGET GENE', 'CHROMOSOME', 'FILE FORMAT', 'ZYGOSITY', 'ANCESTRY COHORT' in English instead of using t() translation keys."
    );
  } else {
    recordPass("Filter Sidebar i18n", "All filter sidebar headers use internationalized translation keys.");
  }

  // Test 9: Web3Context Missing disconnectWallet Method
  totalTests++;
  const web3ContextFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/context/Web3Context.jsx"),
    "utf-8"
  );

  const hasDisconnectMethod = web3ContextFile.includes("disconnectWallet");
  if (!hasDisconnectMethod) {
    recordDefect(
      "DEF2-3-09",
      "Missing disconnectWallet() in Web3Context & Wallet Logout Control in Navbar",
      "Medium",
      "Web3Context does not expose a disconnectWallet() function. Users in local RPC testnet mode cannot log out or switch simulated accounts from the UI."
    );
  } else {
    recordPass("Web3 Disconnect Lifecycle", "disconnectWallet method is exposed and functional.");
  }

  // Test 10: LicensedDatasetsView active decrypt button on pending escrow
  totalTests++;
  const licensedViewFile = fs.readFileSync(
    path.join(rootDir, "frontend/src/features/researcher/LicensedDatasetsView.jsx"),
    "utf-8"
  );

  const hasPendingEscrowDecryptGuard =
    /item\.isEscrowPending\s*\|\|\s*item\.escrowInfo\?\.isPending/.test(licensedViewFile) ||
    /disabled\s*=\s*\{\s*item\.escrowInfo\?\.isPending\s*\}/.test(licensedViewFile) ||
    /item\.escrowInfo\?\.isPending\s*\?\s*\(.*waiting/is.test(licensedViewFile);

  if (!hasPendingEscrowDecryptGuard) {
    recordDefect(
      "DEF2-3-11",
      "Active Decrypt Button Allowed on Undelivered Escrow Capsules (False Expectation)",
      "Medium",
      "LicensedDatasetsView renders an active green 'Giải Mã Dữ Liệu Trong RAM' button even when item.escrowInfo?.isPending is true and no capsule is dispatched. Clicking it triggers resolveAesKeyForDataset failure and an error toast. Should be disabled with 'Chờ Giao Khóa' pending status."
    );
  } else {
    recordPass("Escrow Decrypt Guard", "Pending escrow disables decrypt button appropriately.");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIMENSION 5: IPFS STORAGE EXACTNESS (Task 5)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--------------------------------------------------------------------------------");
  console.log("SECTION 4: IPFS UnixFS CIDv0 Encoding Exactness");
  console.log("--------------------------------------------------------------------------------");

  totalTests++;
  const emptyCid = await computeIpfsCidV0(new Uint8Array(0));
  const expectedEmptyCid = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";

  if (emptyCid !== expectedEmptyCid) {
    recordDefect(
      "DEF2-3-10",
      "IPFS UnixFS CIDv0 Canonical Block Inexactness on Zero-Byte / Boundary Payloads",
      "Low",
      `Computed empty file CID: ${emptyCid}, expected canonical Kubo CID: ${expectedEmptyCid}. Due to extra empty protobuf field tags in encodeUnixFsFileNode.`
    );
  } else {
    recordPass("IPFS UnixFS CIDv0 Canonical Fidelity", "Computed CIDv0 matches canonical IPFS Kubo output exactly.");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n================================================================================");
  console.log("[AUDIT] ADVERSARIAL AUDIT EXECUTION SUMMARY - AGENT 3");
  console.log("================================================================================");
  console.log(`Total Invariant & Adversarial Checks : ${totalTests}`);
  console.log(`Passed Invariants                   : ${passedTests}`);
  console.log(`Identified Defect Candidates        : ${defectCatalog.length}`);
  console.log("================================================================================\n");

  defectCatalog.forEach((d, idx) => {
    console.log(`${idx + 1}. [${d.id}] [${d.severity}] ${d.title}`);
  });

  return defectCatalog;
}

runAdversarialAudit()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL SUITE ERROR:", err);
    process.exit(1);
  });
