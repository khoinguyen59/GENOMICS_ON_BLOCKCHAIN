import hre from "hardhat";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
  generateAsymmetricKeyPair,
  exportPublicKey,
  encryptGenomicData,
  packageKeyCapsule,
  generateClinicalPdfReport
} from "../../crypto/client_crypto.js";

async function main() {
  console.log("=".repeat(88));
  console.log("[AUDIT] ROUND 3 INDEPENDENT ADVERSARIAL STRESS SUITE - AUDIT AGENT 3");
  console.log("   Focus: State Machine Invariants, Reentrancy & Cross-Function Lifecycle Asymmetry,");
  console.log("          ZK-Verifier Mock Backdoor, PDF Offset Desync, and Clinical Data Leakage (INVARIANT-11)");
  console.log("=".repeat(88));

  const { ethers } = await hre.network.create();
  const [deployer, patientOwner, researcherBuyer, maliciousAttacker, thirdParty] = await ethers.getSigners();

  let passCount = 0;
  let defectCount = 0;

  // ---------------------------------------------------------------------------
  // 1. DEPLOY INFRASTRUCTURE
  // ---------------------------------------------------------------------------
  console.log("\n[DEPLOY] Deploying Ecosystem Contracts...");
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

  const GenomicZkVerifier = await ethers.getContractFactory("GenomicZkVerifier");
  const zkVerifier = await GenomicZkVerifier.deploy(token.target);
  await zkVerifier.waitForDeployment();

  console.log("  ✓ Contracts deployed successfully.");

  // ---------------------------------------------------------------------------
  // TEST 1: ZK-VERIFIER SYNTHETIC FALLBACK BACKDOOR (DEF3-3-01)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 1: ZkVerifier Groth16 Proof Bypass / Mock Backdoor (DEF3-3-01) ---");
  try {
    // Fund sponsor and create a bounty of 500 GENO (5 claims of 100 GENO)
    await token.connect(deployer).transfer(patientOwner.address, ethers.parseUnits("500", 18));
    await token.connect(patientOwner).approve(zkVerifier.target, ethers.parseUnits("500", 18));
    
    const traitId = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
    const bountyId = await zkVerifier.connect(patientOwner).createZkBounty.staticCall(
      traitId,
      "Aldehyde Dehydrogenase 2 Deficiency rs671",
      ethers.parseUnits("100", 18),
      5,
      86400
    );
    await zkVerifier.connect(patientOwner).createZkBounty(
      traitId,
      "Aldehyde Dehydrogenase 2 Deficiency rs671",
      ethers.parseUnits("100", 18),
      5,
      86400
    );

    // Attacker crafts a 100% BOGUS proof (arbitrary numbers that DO NOT satisfy pairing)
    const bogusProof = {
      a: [1n, 2n],
      b: [[1n, 2n], [3n, 4n]],
      c: [5n, 6n]
    };
    const fakeCommitment = ethers.keccak256(ethers.toUtf8Bytes("ATTACKER_FAKE_WITNESS"));

    const attackerBalBefore = await token.balanceOf(maliciousAttacker.address);

    // Call claimZkBounty with the bogus proof
    await zkVerifier.connect(maliciousAttacker).claimZkBounty(bountyId, bogusProof, fakeCommitment);

    const attackerBalAfter = await token.balanceOf(maliciousAttacker.address);
    const stolenAmount = attackerBalAfter - attackerBalBefore;

    if (stolenAmount === ethers.parseUnits("100", 18)) {
      defectCount++;
      console.log("  [CRITICAL DEFECT CONFIRMED: DEF3-3-01]");
      console.log(`  ↳ Attacker stole ${ethers.formatUnits(stolenAmount, 18)} GENO using arbitrary fake proof!`);
      console.log("  ↳ Root cause: verifyProofInternal falls back to synthetic mock check when precompile fails.");
    }
  } catch (err) {
    console.log("  [PASS #1] ZkVerifier rejected bogus proof:", err.message);
    passCount++;
  }

  // ---------------------------------------------------------------------------
  // TEST 2: INVARIANT-16 MAPPING OUT-OF-BOUNDS ASYMMETRY (DEF3-3-02)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: INVARIANT-16 Mapping Out-Of-Bounds State Symmetry (DEF3-3-02) ---");
  try {
    const invalidDataId = 9999; // Out of bounds
    let buyerCapsulesReverted = false;
    let hasActiveAccessReverted = false;

    try {
      const caps = await registry.buyerCapsules(invalidDataId, researcherBuyer.address);
      if (caps === "") {
        console.log("  ↳ buyerCapsules(9999) returned '' without reverting!");
      }
    } catch {
      buyerCapsulesReverted = true;
    }

    try {
      const access = await registry.hasActiveAccess(invalidDataId, researcherBuyer.address);
      if (access === false) {
        console.log("  ↳ hasActiveAccess(9999) returned false without reverting!");
      }
    } catch {
      hasActiveAccessReverted = true;
    }

    let getGenomicDataReverted = false;
    try {
      await registry.getGenomicData(invalidDataId);
    } catch (e) {
      if (e.message.includes("DataNotFound")) getGenomicDataReverted = true;
    }

    if (!buyerCapsulesReverted || !hasActiveAccessReverted) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-02 (INVARIANT-16 Violation)]");
      console.log(`  ↳ buyerCapsules reverted: ${buyerCapsulesReverted}, hasActiveAccess reverted: ${hasActiveAccessReverted}`);
      console.log(`  ↳ In contrast, getGenomicData properly reverted with DataNotFound(): ${getGenomicDataReverted}`);
      console.log("  ↳ Violation of INVARIANT-16: All functions must revert DataNotFound() on out-of-bounds mapping query.");
    } else {
      passCount++;
      console.log("  [PASS #2] Out-of-bounds queries uniformly revert.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 2 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 3: KEY CAPSULE LEAKAGE TO REFUNDED ESCROW BUYERS (DEF3-3-03)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: Key Capsule Leakage via buyerCapsules to Refunded Buyers (DEF3-3-03) ---");
  try {
    // 1. Register a dataset
    const price = ethers.parseUnits("100", 18);
    const duration = 30 * 86400;
    const rawDataHash = ethers.keccak256(ethers.toUtf8Bytes("CONFIDENTIAL_GENOME_1"));
    const dataId = await registry.connect(patientOwner).registerGenomicData.staticCall(
      rawDataHash,
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://QmTokenUriMeta",
      price,
      duration,
      1000
    );
    await registry.connect(patientOwner).registerGenomicData(
      rawDataHash,
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://QmTokenUriMeta",
      price,
      duration,
      1000
    );

    // 2. Researcher deposits in escrow
    await token.connect(deployer).transfer(researcherBuyer.address, price);
    await token.connect(researcherBuyer).approve(registry.target, price);
    await registry.connect(researcherBuyer).grantAccessWithEscrow(dataId, 3600); // 1-hour dispute window

    // 3. Fast-forward past dispute window WITHOUT capsule delivered
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    // 4. Researcher claims 100% refund
    await registry.connect(researcherBuyer).claimEscrowRefund(dataId);

    // 5. Check access grant status
    const grant = await registry.accessGrants(dataId, researcherBuyer.address);
    console.log(`  ↳ Grant status after refund: isGranted = ${grant[0]}, expiresAt = ${grant[2]}`);

    // 6. Now suppose a rogue capsule was emitted or stored in mapping
    // Let's test if buyerCapsules would return it to the refunded researcher if populated
    // Even if never populated, check if the function logic allows refunded caller:
    // Notice: if msg.sender == researcher, it checks block.timestamp >= grant.expiresAt, but NOT isGranted!
    const grantIsGranted = grant[0];
    const grantExpiresAt = Number(grant[2]);
    const currentBlock = await ethers.provider.getBlock("latest");
    const currentTime = currentBlock.timestamp;

    if (!grantIsGranted && currentTime < grantExpiresAt) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-03]");
      console.log("  ↳ Grant is NOT granted (isGranted=false), but expiresAt is still active in the future!");
      console.log("  ↳ In buyerCapsules, check `if (msg.sender == researcher)` fails to verify `grant.isGranted`.");
      console.log("  ↳ Any stored capsule would be leaked to the refunded buyer!");
    } else {
      passCount++;
      console.log("  [PASS #3] Grant state cleaned up symmetrically.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 3 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 4: SECONDARY NFT SALE LOCKS ESCROW FOR SELLER (DEF3-3-04)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 4: Secondary NFT Sale Locks Escrow Settlement for Seller (DEF3-3-04) ---");
  try {
    const price = ethers.parseUnits("100", 18);
    const duration = 30 * 86400;
    const rawDataHash = ethers.keccak256(ethers.toUtf8Bytes("CONFIDENTIAL_GENOME_2"));
    
    // PatientOwner registers dataset #2
    await registry.connect(patientOwner).registerGenomicData(
      rawDataHash,
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://QmTokenUriMeta2",
      price,
      duration,
      1000
    );
    const dataId = await registry.dataCount();
    const tokenId = (await registry.genomicDataItems(dataId)).tokenId;

    // Researcher deposits in escrow
    await token.connect(deployer).transfer(researcherBuyer.address, price);
    await token.connect(researcherBuyer).approve(registry.target, price);
    await registry.connect(researcherBuyer).grantAccessWithEscrow(dataId, 86400);

    // PatientOwner transfers/sells NFT to ThirdParty BEFORE delivering capsule
    await nft.connect(patientOwner).transferFrom(patientOwner.address, thirdParty.address, tokenId);

    // PatientOwner tries to deliver capsule to release escrowed funds
    let patientDeliverFailed = false;
    try {
      await registry.connect(patientOwner).storeTransformedCapsule(dataId, researcherBuyer.address, "VALID_CAPSULE");
    } catch (err) {
      if (err.message.includes("NotDataOwner")) {
        patientDeliverFailed = true;
      }
    }

    if (patientDeliverFailed) {
      // Now the new NFT owner (thirdParty) delivers the capsule!
      const thirdPartyBalBefore = await token.balanceOf(thirdParty.address);
      const creatorBalBefore = await token.balanceOf(patientOwner.address);

      await registry.connect(thirdParty).storeTransformedCapsule(dataId, researcherBuyer.address, "VALID_CAPSULE_FROM_NEW_OWNER");

      const thirdPartyBalAfter = await token.balanceOf(thirdParty.address);
      const creatorBalAfter = await token.balanceOf(patientOwner.address);

      expect(thirdPartyBalAfter - thirdPartyBalBefore).to.equal(ethers.parseUnits("90", 18));
      expect(creatorBalAfter - creatorBalBefore).to.equal(ethers.parseUnits("10", 18));

      passCount++;
      console.log("  [PASS #4] Secondary NFT Sale Resolved: New NFT owner successfully delivers capsule and receives 90 GENO proceeds (10 GENO royalty to creator).");
    } else {
      defectCount++;
      console.log("  [FAIL #4] Expected original seller delivery to revert with NotDataOwner.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 4 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 5: PDF REPORT MULTIBYTE XREF OFFSET DESYNCHRONIZATION (DEF3-3-08)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 5: PDF Generator Byte vs String Length Desync (DEF3-3-08) ---");
  try {
    const vietnameseDisease = "Quần thể Hệ Gen Người Kinh TP.HCM (Đặc tính di truyền phân tử)";
    const pdfBytes = generateClinicalPdfReport({
      subjectId: "1000G_KHV_VN_01",
      disease: vietnameseDisease,
      gene: "ALDH2",
      variant: "rs671"
    });

    const pdfString = new TextDecoder("latin1").decode(pdfBytes);
    // Find xref offset declared in trailer
    const startXrefMatch = pdfString.match(/startxref\s+(\d+)\s+%%EOF/);
    const declaredStartXref = parseInt(startXrefMatch[1], 10);
    const actualStartXref = pdfString.indexOf("xref");

    if (declaredStartXref !== actualStartXref) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-08]");
      console.log(`  ↳ Declared startxref: ${declaredStartXref}, Actual byte offset: ${actualStartXref}`);
      console.log(`  ↳ Desync delta: ${actualStartXref - declaredStartXref} bytes!`);
      console.log("  ↳ Root cause: obj4.length measures UTF-16 code units instead of UTF-8 byte count.");
    } else {
      passCount++;
      console.log("  [PASS #5] PDF xref offsets match byte boundaries perfectly.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 5 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 6: TAUTOLOGICAL ASSERTIONS & FALSE 100% REPORTING (DEF3-3-05)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 6: Audit test_diverse_datasets_e2e.mjs for False 100% Reporting (DEF3-3-05) ---");
  try {
    const scriptPath = path.resolve("scripts/audit/test_diverse_datasets_e2e.mjs");
    const scriptContent = fs.readFileSync(scriptPath, "utf-8");

    const hasMissingContinue = scriptContent.includes("if (!fs.existsSync(fullPath))") &&
                               scriptContent.includes("console.error(`[FAIL] File missing: ${t.filePath}`);") &&
                               scriptContent.includes("continue;");
    const hasFalsePassClaim = scriptContent.includes("${passedCount}/${testTargets.length} Diverse Datasets 100% Passed!");

    if (hasMissingContinue && hasFalsePassClaim) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-05]");
      console.log("  ↳ scripts/audit/test_diverse_datasets_e2e.mjs skips missing files via continue,");
      console.log("    logs [FAIL], yet outputs '100% Passed!' and exits with code 0!");
      console.log("  ↳ Confirmed tautological / masked test reporting defect.");
    } else {
      passCount++;
      console.log("  [PASS #6] No false pass claims found.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 6 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 7: INVARIANT-11 CLINICAL DISEASE LEAKAGE IN STATIC DATA FILES (DEF3-3-07)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 7: INVARIANT-11 Clinical Disease Leakage in Data Files (DEF3-3-07) ---");
  try {
    const phenoPath = path.resolve("data/sample_phenopacket.json");
    const reportPath = path.resolve("data/sample_summary_report.txt");
    const vcfPath = path.resolve("data/sample_metabolic_traits.vcf");

    let leaksFound = [];

    if (fs.existsSync(phenoPath)) {
      const phenoText = fs.readFileSync(phenoPath, "utf-8");
      if (phenoText.includes("Breast carcinoma") || phenoText.includes("cancer")) {
        leaksFound.push("data/sample_phenopacket.json: Contains 'Breast carcinoma' / cancer term");
      }
    }
    if (fs.existsSync(reportPath)) {
      const repText = fs.readFileSync(reportPath, "utf-8");
      if (repText.includes("breast and ovarian cancer syndrome") || repText.includes("cancer")) {
        leaksFound.push("data/sample_summary_report.txt: Contains 'breast and ovarian cancer syndrome'");
      }
    }
    if (fs.existsSync(vcfPath)) {
      const vcfText = fs.readFileSync(vcfPath, "utf-8");
      if (vcfText.includes("PATIENT_VN_9042") && vcfText.includes("BRCA1")) {
        leaksFound.push("data/sample_metabolic_traits.vcf: Contains clinical BRCA1 patient callset");
      }
    }

    if (leaksFound.length > 0) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-07 (INVARIANT-11 Violation)]");
      leaksFound.forEach((l) => console.log(`  ↳ ${l}`));
    } else {
      passCount++;
      console.log("  [PASS #7] Pure molecular genetics enforced across data files.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 7 error:", err);
  }

  // ---------------------------------------------------------------------------
  // TEST 8: INVARIANT-02 FAKE CIDS IN TEST SUITES (DEF3-3-09)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 8: INVARIANT-02 Fake CID Prefixes (QmTokenUri...) in Tests (DEF3-3-09) ---");
  try {
    const testFiles = [
      "test/DiverseDatasetsCompatibility.test.js",
      "test/GenomicsSystem.test.js",
      "test/WorldClassProtocolUpgrades.test.js"
    ];

    let fakeCidOccurrences = [];
    for (const tf of testFiles) {
      const fullP = path.resolve(tf);
      if (fs.existsSync(fullP)) {
        const content = fs.readFileSync(fullP, "utf-8");
        if (content.includes("QmTokenUri")) {
          fakeCidOccurrences.push(tf);
        }
      }
    }

    if (fakeCidOccurrences.length > 0) {
      defectCount++;
      console.log("  [DEFECT CONFIRMED: DEF3-3-09 (INVARIANT-02 Violation)]");
      console.log(`  ↳ Found fake 'QmTokenUri...' CIDs in: ${fakeCidOccurrences.join(", ")}`);
      console.log("  ↳ Invariant-02 mandates authentic IPFS multihashes (base58 encoded sha256).");
    } else {
      passCount++;
      console.log("  [PASS #8] Zero fake CIDs found in test suites.");
    }
  } catch (err) {
    defectCount++;
    console.error("Test 8 error:", err);
  }

  console.log("\n" + "=".repeat(88));
  console.log(`ADVERSARIAL STRESS SUITE SUMMARY: ${passCount} Passed, ${defectCount} Verified Defect Candidates Found`);
  console.log("=".repeat(88));
  if (defectCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test execution aborted:", err);
  process.exit(1);
});
