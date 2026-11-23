import hre from "hardhat";
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import {
  generateSymmetricKey,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked
} from "../../crypto/client_crypto.js";
import { translations } from "../../frontend/src/i18n/translations.js";

async function runRound2AdversarialSuite() {
  console.log("================================================================================");
  console.log("[AUDIT] STARTING ROUND 2 INDEPENDENT ADVERSARIAL AUDIT SUITE (AGENT 1)");
  console.log("   Target Course: IS355 - Công nghệ Blockchain (Khoa HTTT - UIT)");
  console.log("   Specialized Lens: Economic Vectors, Escrow Timing, Cross-Contract Tokenomics");
  console.log("   Zero-Trust Empirical Verification on Local Hardhat EVM");
  console.log("================================================================================\n");

  const { ethers } = await hre.network.create();
  const [deployer, sellerAlice, buyerBob, buyerCharlie, delegateDave] = await ethers.getSigners();

  let passedTests = 0;
  let totalTests = 0;

  function assertTest(title, condition, detail = "") {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  [PASS #${totalTests}] ${title}`);
      if (detail) console.log(`         ↳ ${detail}`);
    } else {
      console.error(`  [FAIL #${totalTests}] ${title}`);
      if (detail) console.error(`         ↳ ${detail}`);
      throw new Error(`Test failed: ${title}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Deploy fresh contract cluster for testing
  // ---------------------------------------------------------------------------
  console.log("--- MODULE 1: Contract Cluster Deployment & Initial Setup ---");
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const paymentToken = await GenomicToken.deploy(deployer.address);
  await paymentToken.waitForDeployment();

  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const genomicNFT = await GenomicNFT.deploy(deployer.address, 1000); // 10% default royalty
  await genomicNFT.waitForDeployment();

  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(
    await paymentToken.getAddress(),
    await genomicNFT.getAddress(),
    deployer.address
  );
  await registry.waitForDeployment();

  await genomicNFT.setRegistryContract(await registry.getAddress());

  // Fund Bob and Charlie with tokens
  await paymentToken.transfer(buyerBob.address, ethers.parseUnits("5000", 18));
  await paymentToken.transfer(buyerCharlie.address, ethers.parseUnits("5000", 18));
  await paymentToken.connect(buyerBob).approve(await registry.getAddress(), ethers.MaxUint256);
  await paymentToken.connect(buyerCharlie).approve(await registry.getAddress(), ethers.MaxUint256);

  assertTest(
    "Contract cluster initialized with verified ERC-20, ERC-721, and GenomicsRegistry",
    (await paymentToken.getAddress()) !== ethers.ZeroAddress &&
    (await genomicNFT.getAddress()) !== ethers.ZeroAddress &&
    (await registry.getAddress()) !== ethers.ZeroAddress,
    `Registry: ${await registry.getAddress()}`
  );

  // ---------------------------------------------------------------------------
  // 2. Register Dataset 1 by Alice
  // ---------------------------------------------------------------------------
  const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const VALID_PDF_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const VALID_META_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const VALID_CAPSULE = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", keyCipher: "ab".repeat(256) });

  const rawHash1 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_ALICE_CHR12_RAW"));
  const price1 = ethers.parseUnits("100", 18);
  const duration1 = 30 * 86400; // 30 days
  const royalty1 = 1000; // 10%

  await registry.connect(sellerAlice).registerGenomicData(
    rawHash1,
    VALID_RAW_CID,
    VALID_PDF_CID,
    VALID_META_CID,
    `ipfs://${VALID_META_CID}`,
    price1,
    duration1,
    royalty1
  );
  const dataId1 = 1;

  assertTest(
    "Dataset #1 registered by Alice with 10% EIP-2981 royalty",
    (await registry.dataCount()) === 1n &&
    (await genomicNFT.ownerOf(1)) === sellerAlice.address,
    `DataId: ${dataId1}, TokenId: 1, Owner: ${sellerAlice.address}`
  );

  // ---------------------------------------------------------------------------
  // 3. DEF2-1-01 Empirical Test:
  //    Does storeTransformedCapsule check data.status == Active?
  //    If dataset is Revoked, can seller still deliver capsule and drain escrow?
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 2: Economic Attack Vector & Invariant-16 Escrow Lifecycle ---");
  
  // Bob purchases Dataset 1 with escrow
  const disputeWindow1 = 86400; // 1 day
  await registry.connect(buyerBob).grantAccessWithEscrow(dataId1, disputeWindow1);

  const escrowBeforeRevoke = await registry.escrowDeposits(dataId1, buyerBob.address);
  assertTest(
    "Bob deposited 100 GENO into escrow with 1-day dispute window",
    escrowBeforeRevoke.amount === price1 && !escrowBeforeRevoke.released,
    `Escrow amount: ${ethers.formatUnits(escrowBeforeRevoke.amount, 18)} GENO`
  );

  // Alice unilaterally REVOKES the dataset
  await registry.connect(sellerAlice).updateDataStatus(dataId1, 2); // 2 = Revoked
  const dataAfterRevoke = await registry.genomicDataItems(dataId1);
  assertTest(
    "Alice transitioned dataset status to Revoked (Status = 2)",
    dataAfterRevoke.status === 2n,
    "Dataset is now Revoked on-chain"
  );

  // Verify that Bob's access is cut off
  const hasAccessAfterRevoke = await registry.hasActiveAccess(dataId1, buyerBob.address);
  assertTest(
    "Bob active access is immediately false due to Revocation (INVARIANT-16)",
    hasAccessAfterRevoke === false,
    "hasActiveAccess correctly returned false"
  );

  // ADVERSARIAL CHECK: Does storeTransformedCapsule succeed even though status is Revoked?
  let storeCapsuleSucceeded = false;
  try {
    await registry.connect(sellerAlice).storeTransformedCapsule(dataId1, buyerBob.address, VALID_CAPSULE);
    storeCapsuleSucceeded = true;
  } catch (err) {
    storeCapsuleSucceeded = false;
  }

  const escrowAfterStore = await registry.escrowDeposits(dataId1, buyerBob.address);
  assertTest(
    "EMPIRICAL PROOF DEF2-1-01: storeTransformedCapsule rejects delivery on Revoked data",
    !storeCapsuleSucceeded && !escrowAfterStore.released,
    `storeTransformedCapsule execution on Revoked data: ${storeCapsuleSucceeded ? "SUCCEEDED (VULNERABILITY CONFIRMED: Seller drained escrow on revoked data)" : "BLOCKED"}`
  );

  if (storeCapsuleSucceeded) {
    console.log(`         [!] VULNERABILITY CONFIRMED: Escrow released = ${escrowAfterStore.released}. Alice received tokens while dataset is Revoked!`);
  }

  // ---------------------------------------------------------------------------
  // 4. DEF2-1-02 Empirical Test:
  //    Escrow proceeds misdirection on NFT secondary transfer
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 3: Escrow Counterparty & Secondary NFT Transfer ---");
  
  // Register Dataset 2 by Alice
  const rawHash2 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_ALICE_CHR19_RAW"));
  await registry.connect(sellerAlice).registerGenomicData(
    rawHash2,
    VALID_RAW_CID,
    VALID_PDF_CID,
    VALID_META_CID,
    `ipfs://${VALID_META_CID}`,
    price1,
    duration1,
    royalty1
  );
  const dataId2 = 2;

  // Charlie deposits into escrow for Dataset 2
  await registry.connect(buyerCharlie).grantAccessWithEscrow(dataId2, disputeWindow1);

  const aliceBalBeforeTransfer = await paymentToken.balanceOf(sellerAlice.address);
  const daveBalBeforeTransfer = await paymentToken.balanceOf(delegateDave.address);

  // Alice sells/transfers GenomicNFT #2 to Dave before delivering capsule!
  await genomicNFT.connect(sellerAlice).transferFrom(sellerAlice.address, delegateDave.address, 2);

  assertTest(
    "GenomicNFT #2 transferred from Alice to Dave while Charlie's escrow is pending",
    (await genomicNFT.ownerOf(2)) === delegateDave.address,
    `New NFT owner: ${delegateDave.address}`
  );

  // Now, capsule is delivered for Charlie and Charlie confirms decryption to settle fair-exchange escrow
  await registry.connect(delegateDave).storeTransformedCapsule(dataId2, buyerCharlie.address, VALID_CAPSULE);
  await registry.connect(buyerCharlie).confirmCapsuleAndReleaseEscrow(dataId2);

  const aliceBalAfter = await paymentToken.balanceOf(sellerAlice.address);
  const daveBalAfter = await paymentToken.balanceOf(delegateDave.address);

  const aliceDiff = aliceBalAfter - aliceBalBeforeTransfer;
  const daveDiff = daveBalAfter - daveBalBeforeTransfer;

  assertTest(
    "REGRESSION PROOF DEF2-1-02: Escrow snapshot preserves original seller proceeds (100%) on pre-delivery NFT transfer",
    aliceDiff + daveDiff === price1 && aliceDiff === price1 && daveDiff === 0n,
    `Alice (escrow seller & creator) received: ${ethers.formatUnits(aliceDiff, 18)} GENO, Dave (post-deposit NFT transferee) received: ${ethers.formatUnits(daveDiff, 18)} GENO`
  );

  // ---------------------------------------------------------------------------
  // 5. DEF2-1-05 Empirical Test:
  //    authorizedCapsuleWorkers persistence across ownership transfer
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 4: Access Control Persistence across NFT Transfer ---");
  
  // Register Dataset 3 by Alice
  const rawHash3 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_ALICE_CHR21_RAW"));
  await registry.connect(sellerAlice).registerGenomicData(
    rawHash3,
    VALID_RAW_CID,
    VALID_PDF_CID,
    VALID_META_CID,
    `ipfs://${VALID_META_CID}`,
    price1,
    duration1,
    royalty1
  );
  const dataId3 = 3;

  // Alice authorizes Dave as a capsule worker for Dataset 3
  await registry.connect(sellerAlice).setAuthorizedCapsuleWorker(dataId3, delegateDave.address, true);

  assertTest(
    "Alice authorized Dave as capsule worker for Dataset #3",
    (await registry.authorizedCapsuleWorkers(dataId3, delegateDave.address)) === true,
    `Worker: ${delegateDave.address}`
  );

  // Alice transfers NFT #3 to Bob (Bob is now new data owner)
  await genomicNFT.connect(sellerAlice).transferFrom(sellerAlice.address, buyerBob.address, 3);

  // Check if Dave's authorized worker status was reset upon NFT transfer (DEF2-1-05 fix)
  const isDaveStillAuthorized = await registry.authorizedCapsuleWorkers(dataId3, delegateDave.address);
  assertTest(
    "REGRESSION PROOF DEF2-1-05: Dave worker authorization is cleared upon NFT transfer",
    isDaveStillAuthorized === false,
    `Dangling authorization status: ${isDaveStillAuthorized} (Correctly revoked)`
  );

  // ---------------------------------------------------------------------------
  // 6. DEF2-1-06 Regression Test:
  //    grantDirectAccess self-granting prevented and duplicate accessCount blocked
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 5: Metric Integrity & grantDirectAccess Fix Verification ---");
  
  // Bob (owner) tries to call grantDirectAccess to himself -> must revert with SelfAccessNotAllowed
  let selfGrantReverted = false;
  let selfGrantError = "";
  try {
    await registry.connect(buyerBob).grantDirectAccess(dataId3, buyerBob.address);
  } catch (err) {
    selfGrantReverted = true;
    selfGrantError = err.message;
  }

  assertTest(
    "REGRESSION PROOF DEF2-1-06: Owner cannot call grantDirectAccess to self",
    selfGrantReverted === true && (selfGrantError.includes("SelfAccessNotAllowed") || selfGrantError.includes("reverted")),
    `Self grant reverted as expected: ${selfGrantError.slice(0, 60)}...`
  );

  // Grant to Dave once, then grant again -> accessCount should only increment once
  const accessCountBefore = (await registry.genomicDataItems(dataId3)).accessCount;
  await registry.connect(buyerBob).grantDirectAccess(dataId3, delegateDave.address);
  await registry.connect(buyerBob).grantDirectAccess(dataId3, delegateDave.address);
  const accessCountAfter = (await registry.genomicDataItems(dataId3)).accessCount;

  assertTest(
    "REGRESSION PROOF DEF2-1-06: Duplicate grantDirectAccess does not inflate accessCount",
    accessCountAfter === accessCountBefore + 1n,
    `accessCount strictly incremented by 1 (from ${accessCountBefore} to ${accessCountAfter})`
  );

  // ---------------------------------------------------------------------------
  // 7. DEF2-1-08 Empirical Test:
  //    Crypt4GH Chunked Header Boundary Handling & 500MB Safety Ceiling
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 6: Cryptographic Boundary & Allocation Safety ---");

  const validPlaintext = "TCGA-LUAD-SAMPLE-GENOMIC-SEQUENCE-CHUNKING-TEST-001";
  const validEnc = await encryptGenomicDataChunked(validPlaintext, { chunkSize: 16 });

  // Tamper totalPlaintextSize in header to 50GB (exceeds 500MB limit)
  const tamperedHeaderPayload = new Uint8Array(validEnc.payload);
  const dataView = new DataView(tamperedHeaderPayload.buffer, tamperedHeaderPayload.byteOffset, tamperedHeaderPayload.byteLength);
  dataView.setBigUint64(12, 50000000000n, false);

  let caughtError = null;
  try {
    await decryptGenomicDataChunked(tamperedHeaderPayload, validEnc.keyHex);
  } catch (err) {
    caughtError = err;
  }

  assertTest(
    "REGRESSION PROOF DEF2-1-08: Untrusted totalPlaintextSize in Crypt4GH header caught by safety ceiling",
    caughtError !== null && caughtError.message.includes("exceeds maximum allowed safe limit"),
    `Safety limit enforced: ${caughtError?.message}`
  );

  // ---------------------------------------------------------------------------
  // 8. DEF2-1-03 Regression Test:
  //    Immediate escrow refund allowed when dataset is revoked
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 7: Escrow Dispute Window & Instant Refund on Revocation ---");

  // Bob claims refund for Dataset 1 immediately after Alice revoked it (must succeed now!)
  let bobRefundSucceeded = false;
  let bobRefundError = null;
  try {
    await registry.connect(buyerBob).claimEscrowRefund(dataId1);
    bobRefundSucceeded = true;
  } catch (err) {
    bobRefundSucceeded = false;
    bobRefundError = err;
  }

  assertTest(
    "REGRESSION PROOF DEF2-1-03: Immediate refund succeeds when dataset status is Revoked",
    bobRefundSucceeded === true,
    `claimEscrowRefund succeeded immediately on revoked dataset! Refunded: ${bobRefundSucceeded}`
  );

  // ---------------------------------------------------------------------------
  // 9. DEF2-1-04 Regression Test:
  //    emitTransformedCapsule automatically releases escrow
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 8: Event-Based Capsule Emission & Automatic Escrow Release ---");

  // Register Dataset 4 by Alice
  const rawHash4 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_ALICE_CHR22_RAW"));
  await registry.connect(sellerAlice).registerGenomicData(
    rawHash4,
    VALID_RAW_CID,
    VALID_PDF_CID,
    VALID_META_CID,
    `ipfs://${VALID_META_CID}`,
    price1,
    duration1,
    royalty1
  );
  const dataId4 = 4;

  // Charlie deposits into escrow for Dataset 4
  await registry.connect(buyerCharlie).grantAccessWithEscrow(dataId4, disputeWindow1);

  // Alice delivers capsule via emitTransformedCapsule (fair-exchange: holds escrow until buyer confirmation or window expiry)
  await registry.connect(sellerAlice).emitTransformedCapsule(dataId4, buyerCharlie.address, VALID_CAPSULE);
  const deposit4BeforeConfirm = await registry.escrowDeposits(dataId4, buyerCharlie.address);
  assertTest(
    "REGRESSION PROOF DEF2-1-04a: emitTransformedCapsule marks capsuleDelivered while fair-exchange escrow holds funds until buyer confirmation",
    deposit4BeforeConfirm.capsuleDelivered === true && deposit4BeforeConfirm.released === false,
    `Capsule delivered: ${deposit4BeforeConfirm.capsuleDelivered}, Escrow held: ${!deposit4BeforeConfirm.released}`
  );
  await registry.connect(buyerCharlie).confirmCapsuleAndReleaseEscrow(dataId4);

  const deposit4 = await registry.escrowDeposits(dataId4, buyerCharlie.address);
  assertTest(
    "REGRESSION PROOF DEF2-1-04b: confirmDecryptionAndRelease settles escrow cleanly after emitTransformedCapsule",
    deposit4.capsuleDelivered === true && deposit4.released === true,
    `Capsule delivered: ${deposit4.capsuleDelivered}, Escrow released: ${deposit4.released}`
  );



  // ---------------------------------------------------------------------------
  // 10. Bilingual UI Dictionary (i18n) Parity & Completeness
  // ---------------------------------------------------------------------------
  console.log("\n--- MODULE 10: Bilingual UI Dictionary (i18n) Full Parity Audit ---");
  


  const viKeys = new Set(Object.keys(translations.vi));
  const enKeys = new Set(Object.keys(translations.en));

  const missingInEn = [...viKeys].filter((k) => !enKeys.has(k));
  const missingInVi = [...enKeys].filter((k) => !viKeys.has(k));

  assertTest(
    "Bilingual Dictionary Parity: All Vietnamese keys must have exact English counterparts",
    missingInEn.length === 0,
    `Keys in VI missing in EN: ${missingInEn.length} (${missingInEn.join(", ")})`
  );

  assertTest(
    "Bilingual Dictionary Parity: All English keys must have exact Vietnamese counterparts",
    missingInVi.length === 0,
    `Keys in EN missing in VI: ${missingInVi.length} (${missingInVi.join(", ")})`
  );

  console.log(`         ↳ Total verified bilingual translation pairs: ${viKeys.size}`);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("[AUDIT] ROUND 2 ADVERSARIAL AUDIT SUITE EXECUTION SUMMARY (AGENT 1)");
  console.log("================================================================================");
  console.log(`Total Adversarial Scenarios Executed : ${totalTests}`);
  console.log(`Total Successfully Proven / Passed  : ${passedTests}`);
  console.log(`Defect Reproduction Verification   : 100% EMPIRICAL CONFIRMATION`);
  console.log("================================================================================\n");
  return { totalTests, passedTests };
}

runRound2AdversarialSuite()
  .then((res) => process.exit(res.passedTests === res.totalTests ? 0 : 1))
  .catch((err) => {
    console.error("Adversarial Suite Execution Aborted:", err);
    process.exit(1);
  });
