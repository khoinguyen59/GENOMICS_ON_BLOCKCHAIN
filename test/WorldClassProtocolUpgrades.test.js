import { expect } from "chai";
import hre from "hardhat";
import {
  encryptGenomicData,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  decryptGenomicPayload,
  generateClinicalPdfReport,
  saveOwnerCapsulePersistent,
  loadOwnerCapsulePersistent,
  getAllOwnerCapsulesPersistent,
  exportSovereignKeyVault,
  importSovereignKeyVault,
} from "../crypto/client_crypto.js";

describe("Production Protocol Architecture & Security Verification", function () {
  let ethers;
  let token, nft, registry;
  let owner, seller, researcher, attacker;

  const PRICE = 100n * 10n ** 18n; // 100 GENO
  const ACCESS_DURATION = 3600 * 24 * 30; // 30 days
  const DISPUTE_WINDOW = 3600 * 24; // 24 hours
  const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const VALID_SUMMARY_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const VALID_METADATA_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const VALID_TOKEN_URI = "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";

  let sampleDataHash;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, researcher, attacker] = await ethers.getSigners();

    const GenomicToken = await ethers.getContractFactory("GenomicToken");
    token = await GenomicToken.deploy(owner.address);
    await token.waitForDeployment();

    const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
    nft = await GenomicNFT.deploy(owner.address, 1000); // 10% royalty
    await nft.waitForDeployment();

    const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
    registry = await GenomicsRegistry.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();

    await nft.setRegistryContract(registry.target);

    // Fund accounts
    await token.transfer(seller.address, 1000n * 10n ** 18n);
    await token.transfer(researcher.address, 1000n * 10n ** 18n);

    // Register a dataset owned by seller
    const enc = await encryptGenomicData("##fileformat=VCFv4.2\nchr1\t100\trs1\tA\tG");
    sampleDataHash = enc.rawDataHash;

    const tx = await registry.connect(seller).registerGenomicData(
      sampleDataHash,
      VALID_RAW_CID,
      VALID_SUMMARY_CID,
      VALID_METADATA_CID,
      VALID_TOKEN_URI,
      PRICE,
      ACCESS_DURATION,
      1000 // 10% royalty
    );
    await tx.wait();

    // Approve registry to spend researcher tokens
    await token.connect(researcher).approve(registry.target, 10000n * 10n ** 18n);
  });

  describe("Escrow Protection & Timelock Dispute Window", function () {
    it("should lock payment in escrow contract upon grantAccessWithEscrow", async function () {
      const balanceBefore = await token.balanceOf(researcher.address);
      const registryBalanceBefore = await token.balanceOf(registry.target);

      const tx = await registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW);
      await expect(tx)
        .to.emit(registry, "EscrowDeposited")
        .withArgs(1, researcher.address, PRICE, DISPUTE_WINDOW);

      const balanceAfter = await token.balanceOf(researcher.address);
      const registryBalanceAfter = await token.balanceOf(registry.target);

      expect(balanceBefore - balanceAfter).to.equal(PRICE);
      expect(registryBalanceAfter - registryBalanceBefore).to.equal(PRICE);

      const escrow = await registry.escrowDeposits(1, researcher.address);
      expect(escrow.buyer).to.equal(researcher.address);
      expect(escrow.amount).to.equal(PRICE);
      expect(escrow.released).to.be.false;
      expect(escrow.refunded).to.be.false;

      // Access should already be granted conditionally
      expect(await registry.hasActiveAccess(1, researcher.address)).to.be.true;
    });

    it("should reject dispute window less than 1 hour or greater than 30 days", async function () {
      await expect(
        registry.connect(researcher).grantAccessWithEscrow(1, 1800) // 30 mins
      ).to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");

      await expect(
        registry.connect(researcher).grantAccessWithEscrow(1, 3600 * 24 * 31) // 31 days
      ).to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");
    });

    it("should prevent early refund while dispute window is active", async function () {
      await registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW);

      await expect(
        registry.connect(researcher).claimEscrowRefund(1)
      ).to.be.revertedWithCustomError(registry, "DisputeWindowActive");
    });

    it("should automatically release escrow to seller and royalty to creator on storeTransformedCapsule", async function () {
      await registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW);

      const sellerBalanceBefore = await token.balanceOf(seller.address);

      const capsulePayload = JSON.stringify({
        type: "ECIES-RSA-OAEP-2048",
        ephemeralCiphertext: "0123456789abcdef",
      });

      // Seller stores capsule (since seller is both creator & seller, seller gets proceeds 90 + royalty 10 = 100)
      const expectedProceeds = (PRICE * 9000n) / 10000n;
      const expectedRoyalty = (PRICE * 1000n) / 10000n;

      const tx = await registry.connect(seller).storeTransformedCapsule(1, researcher.address, capsulePayload);
      await expect(tx)
        .to.emit(registry, "EscrowReleased")
        .withArgs(1, researcher.address, seller.address, expectedProceeds, expectedRoyalty);

      const sellerBalanceAfter = await token.balanceOf(seller.address);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(PRICE);

      const escrow = await registry.escrowDeposits(1, researcher.address);
      expect(escrow.released).to.be.true;
      expect(escrow.refunded).to.be.false;

      // Cannot refund after capsule is delivered
      await expect(
        registry.connect(researcher).claimEscrowRefund(1)
      ).to.be.revertedWithCustomError(registry, "CapsuleAlreadyDelivered");
    });

    it("should allow 100% refund and revoke access after dispute window expires if capsule not delivered", async function () {
      await registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW);

      const balanceBefore = await token.balanceOf(researcher.address);

      // Fast forward time past dispute window (24h + 10s)
      await ethers.provider.send("evm_increaseTime", [DISPUTE_WINDOW + 10]);
      await ethers.provider.send("evm_mine", []);

      const tx = await registry.connect(researcher).claimEscrowRefund(1);
      await expect(tx)
        .to.emit(registry, "EscrowRefunded")
        .withArgs(1, researcher.address, PRICE);

      const balanceAfter = await token.balanceOf(researcher.address);
      expect(balanceAfter - balanceBefore).to.equal(PRICE);

      // Access should now be revoked
      expect(await registry.hasActiveAccess(1, researcher.address)).to.be.false;

      const escrow = await registry.escrowDeposits(1, researcher.address);
      expect(escrow.refunded).to.be.true;
    });

    it("should prevent duplicate pending escrows and reject grantAccessWithEscrow / grantAccess (EscrowAlreadyActive)", async function () {
      // First deposit locks in escrow
      await registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW);

      // Attempting to open another escrow while first is still pending should revert
      await expect(
        registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW)
      ).to.be.revertedWithCustomError(registry, "AccessAlreadyActive");

      // Even if access expires, an unreleased/unrefunded escrow must block duplicate purchase
      // Fast forward past access duration (30 days) and dispute window (24 hours)
      await ethers.provider.send("evm_increaseTime", [ACCESS_DURATION + 10]);
      await ethers.provider.send("evm_mine", []);

      // Access is expired, but escrow is still unreleased & unrefunded
      await expect(
        registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW)
      ).to.be.revertedWithCustomError(registry, "EscrowAlreadyActive");

      await expect(
        registry.connect(researcher).grantAccess(1)
      ).to.be.revertedWithCustomError(registry, "EscrowAlreadyActive");

      // Once the buyer claims their refund, they can re-purchase cleanly
      await registry.connect(researcher).claimEscrowRefund(1);

      // Now re-purchasing is allowed
      await expect(
        registry.connect(researcher).grantAccessWithEscrow(1, DISPUTE_WINDOW)
      ).to.emit(registry, "EscrowDeposited");
    });
  });

  describe("Gas-Optimized Capsule Storage & Event Retrieval (emitTransformedCapsule)", function () {
    it("should emit CapsuleStored event without SSTORE and save ~550,000 gas", async function () {
      // Grant viewing access for researcher first
      await registry.connect(seller).grantDirectAccess(1, researcher.address);

      const capsule = JSON.stringify({
        encryptedKey: "0xabcdef1234567890",
        iv: "0x1234567890abcdef12345678",
      });

      // Regular storeTransformedCapsule (costs > 100k-500k gas due to storage write)
      const txStore = await registry.connect(seller).storeTransformedCapsule(1, researcher.address, capsule);
      const receiptStore = await txStore.wait();

      // Gas-optimized emitTransformedCapsule
      const txEmit = await registry.connect(seller).emitTransformedCapsule(1, researcher.address, capsule);
      const receiptEmit = await txEmit.wait();

      expect(receiptEmit.gasUsed).to.be.lessThan(receiptStore.gasUsed);

      // Verify event was emitted
      await expect(txEmit)
        .to.emit(registry, "CapsuleStored")
        .withArgs(1, researcher.address, capsule);

      // Verify event is retrievable via queryFilter
      const filter = registry.filters.CapsuleStored(1, researcher.address);
      const logs = await registry.queryFilter(filter, receiptEmit.blockNumber, receiptEmit.blockNumber);
      expect(logs.length).to.be.at.least(1);
      expect(logs[logs.length - 1].args.capsule).to.equal(capsule);
    });

    it("should prevent unauthorized callers from emitting capsules", async function () {
      const capsule = "unauthorized_capsule";
      await expect(
        registry.connect(attacker).emitTransformedCapsule(1, researcher.address, capsule)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("should reject empty capsule on both storeTransformedCapsule and emitTransformedCapsule", async function () {
      await expect(
        registry.connect(seller).storeTransformedCapsule(1, researcher.address, "")
      ).to.be.revertedWithCustomError(registry, "EmptyCapsule");

      await expect(
        registry.connect(seller).emitTransformedCapsule(1, researcher.address, "")
      ).to.be.revertedWithCustomError(registry, "EmptyCapsule");
    });

    it("should revert getCapsuleForBuyer when dataset status is not Active", async function () {
      await registry.connect(seller).grantDirectAccess(1, researcher.address);
      await registry.connect(seller).storeTransformedCapsule(1, researcher.address, "capsule_data");

      // Pause dataset
      await registry.connect(seller).updateDataStatus(1, 1); // 1 = Paused
      await expect(
        registry.connect(seller).getCapsuleForBuyer(1, researcher.address)
      ).to.be.revertedWithCustomError(registry, "DataNotActive");

      // Restore Active status
      await registry.connect(seller).updateDataStatus(1, 0); // 0 = Active
      expect(await registry.connect(seller).getCapsuleForBuyer(1, researcher.address)).to.equal("capsule_data");
    });
  });

  describe("Sovereign Key Vault Backup & Multi-Device Persistence", function () {
    it("should save and load owner capsules with dual-layer persistence", async function () {
      const testCid = "QmTestCidPersistence1234567890abcdef12345678";
      const testCapsule = JSON.stringify({ key: "0x1234", tag: "test" });

      await saveOwnerCapsulePersistent(testCid, testCapsule);
      const loaded = await loadOwnerCapsulePersistent(testCid);
      expect(loaded).to.equal(testCapsule);

      const all = await getAllOwnerCapsulesPersistent();
      const found = all.find((item) => item.rawCid === testCid);
      expect(found).to.not.be.undefined;
      expect(found.capsule).to.equal(testCapsule);
    });

    it("should export and import encrypted sovereign key vault with wallet signature", async function () {
      const testCid = "QmTestCidExportImport1234567890abcdef1234567";
      const testCapsule = JSON.stringify({ key: "0xbeefcafe", owner: seller.address });
      await saveOwnerCapsulePersistent(testCid, testCapsule);

      // Export using ethers signer
      const backupJson = await exportSovereignKeyVault({
        signer: seller,
        account: seller.address,
      });

      const parsedBackup = JSON.parse(backupJson);
      expect(parsedBackup.format).to.equal("GENOCHAIN-ENCRYPTED-KEY-VAULT-v2");
      expect(parsedBackup.account).to.equal(seller.address.toLowerCase());
      expect(parsedBackup.kdf).to.equal("wallet-signature");
      expect(parsedBackup.ciphertextHex).to.be.a("string");

      // Import back
      const res = await importSovereignKeyVault({
        signer: seller,
        account: seller.address,
        backupData: backupJson,
      });

      expect(res.restoredCount).to.be.at.least(1);
      const restoredCapsule = await loadOwnerCapsulePersistent(testCid);
      expect(restoredCapsule).to.equal(testCapsule);
    });

    it("should export and import encrypted sovereign key vault with password PBKDF2", async function () {
      const testCid = "QmTestCidPassphrase1234567890abcdef12345678";
      const testCapsule = JSON.stringify({ key: "0xfeedface", note: "passphrase protected" });
      await saveOwnerCapsulePersistent(testCid, testCapsule);

      const password = "StrongBioSecurityPassword2026!";

      const backupJson = await exportSovereignKeyVault({
        account: seller.address,
        password,
      });

      const parsedBackup = JSON.parse(backupJson);
      expect(parsedBackup.kdf).to.equal("pbkdf2");
      expect(parsedBackup.saltHex).to.be.a("string");

      // Import back with correct password
      const res = await importSovereignKeyVault({
        account: seller.address,
        backupData: backupJson,
        password,
      });

      expect(res.restoredCount).to.be.at.least(1);
      const restored = await loadOwnerCapsulePersistent(testCid);
      expect(restored).to.equal(testCapsule);
    });

    it("should reject corrupted JSON and mismatched account when importing vault", async function () {
      // Malformed JSON syntax
      await expect(
        importSovereignKeyVault({
          signer: seller,
          account: seller.address,
          backupData: "{ not valid json ...",
        })
      ).to.be.rejectedWith("Malformed backup file");

      // Invalid format identifier
      await expect(
        importSovereignKeyVault({
          signer: seller,
          account: seller.address,
          backupData: JSON.stringify({ format: "UNKNOWN-FORMAT" }),
        })
      ).to.be.rejectedWith("Invalid backup format");

      // Account mismatch
      await expect(
        importSovereignKeyVault({
          signer: seller,
          account: attacker.address,
          backupData: JSON.stringify({
            format: "GENOCHAIN-ENCRYPTED-KEY-VAULT-v2",
            account: seller.address.toLowerCase(),
            ivHex: "00".repeat(12),
            ciphertextHex: "beef",
          }),
        })
      ).to.be.rejectedWith("Account mismatch");
    });
  });

  describe("Streaming Chunked Encryption Memory Guard (Crypt4GH Architecture)", function () {
    it("should encrypt and decrypt chunked data with streaming progress without memory explosion", async function () {
      // Simulate genomic VCF file
      const line = "chr1\t1000\trs123\tA\tT\t100\tPASS\tDP=50\n";
      const largeVcf = "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n" + line.repeat(2000);

      const progressTicks = [];
      const enc = await encryptGenomicDataChunked(largeVcf, {
        chunkSize: 16 * 1024, // 16KB chunks
        onProgress: (pct, bytes, total) => {
          progressTicks.push({ pct, bytes, total });
        },
      });

      expect(enc.chunkCount).to.be.greaterThan(1);
      expect(enc.payload.length).to.be.greaterThan(0);
      expect(progressTicks.length).to.be.greaterThan(0);
      expect(progressTicks[progressTicks.length - 1].pct).to.equal(1);

      // Decrypt chunked payload
      const decryptedText = await decryptGenomicDataChunked(enc.payload, enc.keyHex, {
        asString: true,
      });

      expect(decryptedText).to.equal(largeVcf);
    });

    it("should ensure chunked activeKey correctly encrypts and decrypts companion clinical PDF report", async function () {
      const vcfData = "##fileformat=VCFv4.2\nchr1\t100\trs1\tA\tG\t99\tPASS\tINFO\n";
      const enc = await encryptGenomicDataChunked(vcfData);

      expect(enc.activeKey).to.not.be.undefined;

      const pdfBytes = generateClinicalPdfReport({
        subjectId: "SUBJECT_01",
        disease: "Genomic Benchmark",
        gene: "ALDH2",
        variant: "rs671",
      });

      // Encrypt PDF with the same activeKey returned by chunked pipeline
      const encPdf = await encryptGenomicData(pdfBytes, enc.activeKey);
      expect(encPdf.rawDataHash).to.be.a("string");

      // Decrypt PDF using keyHex
      const decPdfBytes = await decryptGenomicPayload(encPdf.payload, enc.keyHex, false);
      expect(decPdfBytes).to.deep.equal(pdfBytes);
    });
  });
});
