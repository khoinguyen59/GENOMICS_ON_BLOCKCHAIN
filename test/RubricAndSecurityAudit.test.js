import { expect } from "chai";
import hre from "hardhat";
import {
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
} from "../crypto/client_crypto.js";

const CID_RAW = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_SUMMARY = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
const CID_METADATA = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
const TOKEN_URI = `ipfs://${CID_METADATA}`;

describe("Assignment 06 Rubric & Security Audit Suite", function () {
  this.timeout(120000);

  let ethers;
  let deployer, creator, newOwner, buyer, buyer2, stranger;
  let token, nft, registry, zkVerifier;

  const PRICE = 100n * 10n ** 18n;
  const DURATION = 30 * 24 * 3600;
  const DISPUTE_WINDOW = 24 * 3600;
  const DEFAULT_ROYALTY_BPS = 1000n; // 10% creator share of payments / secondary royalty

  async function advanceTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await ethers.provider.send("evm_mine", []);
  }

  async function makeAuthenticCapsule(buyerSigner, sellerAddr, keyHex = "ab".repeat(32)) {
    const kp = await generateAsymmetricKeyPair(false);
    const pubJwk = await exportPublicKey(kp.publicKey);
    await (await registry.connect(buyerSigner).registerResearcherPublicKey(pubJwk)).wait();
    const capsule = await packageKeyCapsule(keyHex, pubJwk, buyerSigner.address, sellerAddr);
    return { kp, pubJwk, capsule };
  }

  async function registerSampleDataset(ownerSigner = creator, saltTag = "dataset-1") {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes(`raw:${saltTag}`));
    const tx = await registry
      .connect(ownerSigner)
      .registerGenomicData(
        rawHash,
        CID_RAW,
        CID_SUMMARY,
        CID_METADATA,
        TOKEN_URI,
        PRICE,
        DURATION,
        DEFAULT_ROYALTY_BPS
      );
    await tx.wait();
    const dataId = await registry.dataCount();
    const record = await registry.getGenomicData(dataId);
    return { dataId, tokenId: record.tokenId, rawHash, record };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, creator, newOwner, buyer, buyer2, stranger] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("GenomicToken");
    token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();

    const NftFactory = await ethers.getContractFactory("GenomicNFT");
    nft = await NftFactory.deploy(deployer.address, DEFAULT_ROYALTY_BPS);
    await nft.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
    registry = await RegistryFactory.deploy(token.target, nft.target, deployer.address);
    await registry.waitForDeployment();
    await (await nft.connect(deployer).setRegistryContract(registry.target)).wait();

    const ZkFactory = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkFactory.deploy(token.target);
    await zkVerifier.waitForDeployment();
    await (await registry.connect(deployer).setZkVerifier(zkVerifier.target)).wait();

    await (await token.connect(deployer).transfer(buyer.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(deployer).transfer(buyer2.address, ethers.parseEther("5000"))).wait();
  });

  // =========================================================================
  // Group 1: 3 Core Functions (Criterion 1)
  // =========================================================================
  describe("Group 1: Core Lifecycle Functions (Criterion 1)", function () {
    it("registerGenomicData() & registerGenomicDataBundle() anchor hashes, mint GenomicNFT, and block duplicate hashes", async function () {
      const { dataId, tokenId, rawHash } = await registerSampleDataset(creator, "core-reg-1");

      expect(dataId).to.equal(1n);
      expect(await nft.ownerOf(tokenId)).to.equal(creator.address);

      const stored = await registry.getGenomicData(dataId);
      expect(stored.rawDataHash).to.equal(rawHash);
      expect(stored.rawCiphertextCid).to.equal(CID_RAW);
      expect(stored.summaryCiphertextCid).to.equal(CID_SUMMARY);
      expect(stored.metadataCid).to.equal(CID_METADATA);
      expect(stored.price).to.equal(PRICE);
      expect(stored.status).to.equal(0n); // DataStatus.Active

      // Anti-clone guard: registering the same rawDataHash again must revert
      await expect(
        registry
          .connect(creator)
          .registerGenomicData(
            rawHash,
            CID_RAW,
            CID_SUMMARY,
            CID_METADATA,
            TOKEN_URI,
            PRICE,
            DURATION,
            DEFAULT_ROYALTY_BPS
          )
      ).to.be.revertedWithCustomError(registry, "DataAlreadyRegistered");

      // Atomic bundle registration with 3 artifact hashes + blind tags
      const hRaw = ethers.keccak256(ethers.toUtf8Bytes("bundle-raw"));
      const hSummary = ethers.keccak256(ethers.toUtf8Bytes("bundle-summary"));
      const hMeta = ethers.keccak256(ethers.toUtf8Bytes("bundle-meta"));
      const blindTags = [ethers.keccak256(ethers.toUtf8Bytes("BRCA1")), ethers.keccak256(ethers.toUtf8Bytes("VN"))];

      await (
        await registry
          .connect(creator)
          .registerGenomicDataBundle(
            [hRaw, hSummary, hMeta],
            [CID_RAW, CID_SUMMARY, CID_METADATA, TOKEN_URI],
            PRICE,
            DURATION,
            DEFAULT_ROYALTY_BPS,
            blindTags
          )
      ).wait();

      const bundleId = await registry.dataCount();
      expect(bundleId).to.equal(2n);
      const bundleStored = await registry.getGenomicData(bundleId);
      expect(bundleStored.rawDataHash).to.equal(hRaw);
      expect(await nft.ownerOf(bundleStored.tokenId)).to.equal(creator.address);
    });

    it("grantAccess() grants time-bounded access upon $GENO payment and expires after accessDuration", async function () {
      const { dataId } = await registerSampleDataset(creator, "core-grant-1");

      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(false);

      await (await token.connect(buyer).approve(registry.target, PRICE)).wait();
      await (await registry.connect(buyer)["grantAccess(uint256)"](dataId)).wait();

      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(true);
      expect(await token.balanceOf(creator.address)).to.equal(PRICE);

      // Advance past license duration -> access expires
      await advanceTime(DURATION + 1);
      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(false);
    });

    it("updateDataStatus() supports Active <-> Paused and permanently locks Revoked datasets", async function () {
      const { dataId } = await registerSampleDataset(creator, "core-status-1");

      // Active -> Paused
      await (await registry.connect(creator).updateDataStatus(dataId, 1)).wait();
      expect((await registry.getGenomicData(dataId)).status).to.equal(1n);

      await (await token.connect(buyer).approve(registry.target, PRICE)).wait();
      await expect(
        registry.connect(buyer)["grantAccess(uint256)"](dataId)
      ).to.be.revertedWithCustomError(registry, "DataNotActive");

      // Paused -> Active
      await (await registry.connect(creator).updateDataStatus(dataId, 0)).wait();
      expect((await registry.getGenomicData(dataId)).status).to.equal(0n);

      // Active -> Revoked (irreversible)
      await (await registry.connect(creator).updateDataStatus(dataId, 2)).wait();
      expect((await registry.getGenomicData(dataId)).status).to.equal(2n);

      await expect(
        registry.connect(creator).updateDataStatus(dataId, 0)
      ).to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");

      await expect(
        registry.connect(buyer)["grantAccess(uint256)"](dataId)
      ).to.be.revertedWithCustomError(registry, "DataNotActive");
    });
  });

  // =========================================================================
  // Group 2: Security & Logic Constraints (Criterion 1)
  // =========================================================================
  describe("Group 2: Access Control & Payment Validity Constraints (Criterion 1)", function () {
    it("restricts updateDataPrice(), updateDataStatus(), and grantDirectAccess() strictly to the current NFT owner", async function () {
      const { dataId, tokenId } = await registerSampleDataset(creator, "auth-constraint-1");

      await expect(
        registry.connect(stranger).updateDataPrice(dataId, PRICE * 2n)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      await expect(
        registry.connect(stranger).updateDataStatus(dataId, 1)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      await expect(
        registry.connect(stranger).grantDirectAccess(dataId, buyer.address)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      // Transfer GenomicNFT to newOwner -> creator loses authority, newOwner gains authority
      await (await nft.connect(creator).transferFrom(creator.address, newOwner.address, tokenId)).wait();

      await expect(
        registry.connect(creator).updateDataPrice(dataId, PRICE * 2n)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      await (await registry.connect(newOwner).updateDataPrice(dataId, PRICE * 2n)).wait();
      expect((await registry.getGenomicData(dataId)).price).to.equal(PRICE * 2n);

      await (await registry.connect(newOwner).grantDirectAccess(dataId, buyer2.address)).wait();
      expect(await registry.hasActiveAccess(dataId, buyer2.address)).to.equal(true);
    });

    it("rejects access purchase without $GENO allowance/balance and prevents owners from buying their own data", async function () {
      const { dataId } = await registerSampleDataset(creator, "pay-constraint-1");

      // Buyer without approval fails with ERC20InsufficientAllowance
      await expect(
        registry.connect(buyer)["grantAccess(uint256)"](dataId)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");

      // Stranger with approval but 0 $GENO balance fails with ERC20InsufficientBalance
      await (await token.connect(stranger).approve(registry.target, PRICE)).wait();
      await expect(
        registry.connect(stranger)["grantAccess(uint256)"](dataId)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");

      // Owner cannot buy their own dataset
      await expect(
        registry.connect(creator)["grantAccess(uint256)"](dataId)
      ).to.be.revertedWithCustomError(registry, "OwnerCannotBuyOwnData");
    });
  });

  // =========================================================================
  // Group 3: Timelocked Escrow & Dispute Resolution Lifecycle
  // =========================================================================
  describe("Group 3: Escrow Deposit, Capsule Delivery, Refund & Dispute Lifecycle", function () {
    it("settles escrow payout upon capsule delivery and buyer confirmation", async function () {
      const { dataId } = await registerSampleDataset(creator, "escrow-happy-1");
      const { capsule } = await makeAuthenticCapsule(buyer, creator.address);

      const buyerBefore = await token.balanceOf(buyer.address);
      await (await token.connect(buyer).approve(registry.target, PRICE)).wait();
      await (await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW)).wait();

      // Funds held inside GenomicsRegistry escrow
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);
      expect(await token.balanceOf(buyer.address)).to.equal(buyerBefore - PRICE);

      // Seller delivers buyer-specific encrypted capsule
      await (await registry.connect(creator).storeTransformedCapsule(dataId, buyer.address, capsule)).wait();
      expect(await registry.connect(buyer).getTransformedCapsule(dataId)).to.equal(capsule);

      // Buyer confirms satisfactory decryption -> funds released immediately to creator
      await (await registry.connect(buyer).confirmCapsuleAndReleaseEscrow(dataId)).wait();
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect(await token.balanceOf(creator.address)).to.equal(PRICE);
      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(true);
    });

    it("refunds 100% $GENO to buyer via claimEscrowRefund() when seller fails to deliver before dispute window", async function () {
      const { dataId } = await registerSampleDataset(creator, "escrow-refund-1");
      const buyerBefore = await token.balanceOf(buyer.address);

      await (await token.connect(buyer).approve(registry.target, PRICE)).wait();
      await (await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW)).wait();

      // Cannot refund while delivery/dispute window is still open
      await expect(
        registry.connect(buyer).claimEscrowRefund(dataId)
      ).to.be.revertedWithCustomError(registry, "DisputeWindowActive");

      // Advance past disputeWindow without capsule delivery -> 100% refund succeeds
      await advanceTime(DISPUTE_WINDOW + 1);
      await (await registry.connect(buyer).claimEscrowRefund(dataId)).wait();

      expect(await token.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(false);
    });

    it("freezes disputed escrow for arbiter resolution and enforces 30-day claimDisputeTimeoutRefund() safety valve", async function () {
      const { dataId } = await registerSampleDataset(creator, "escrow-dispute-1");
      const { capsule } = await makeAuthenticCapsule(buyer, creator.address, "cd".repeat(32));
      const { capsule: capsule2 } = await makeAuthenticCapsule(buyer2, creator.address, "ef".repeat(32));

      // Case A: Buyer disputes delivered capsule -> Arbiter resolves with 100% buyer refund
      const buyerBefore = await token.balanceOf(buyer.address);
      await (await token.connect(buyer).approve(registry.target, PRICE)).wait();
      await (await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW)).wait();
      await (await registry.connect(creator).storeTransformedCapsule(dataId, buyer.address, capsule)).wait();
      await (await registry.connect(buyer).disputeCapsule(dataId)).wait();

      await (await registry.connect(deployer).resolveEscrowDispute(dataId, buyer.address, true)).wait();
      expect(await token.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(false);

      // Case B: Buyer2 disputes and governance stalls -> 30-day timeout safety valve allows unilateral refund
      const buyer2Before = await token.balanceOf(buyer2.address);
      await (await token.connect(buyer2).approve(registry.target, PRICE)).wait();
      await (await registry.connect(buyer2)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW)).wait();
      await (await registry.connect(creator).storeTransformedCapsule(dataId, buyer2.address, capsule2)).wait();
      await (await registry.connect(buyer2).disputeCapsule(dataId)).wait();

      // Must fail before 30 days elapse
      await expect(
        registry.connect(buyer2).claimDisputeTimeoutRefund(dataId)
      ).to.be.revertedWithCustomError(registry, "DisputeArbitrationActive");

      // Advance past DISPUTE_ARBITRATION_TIMEOUT (30 days) -> buyer2 recovers 100%
      await advanceTime(30 * 24 * 3600 + 1);
      await (await registry.connect(buyer2).claimDisputeTimeoutRefund(dataId)).wait();

      expect(await token.balanceOf(buyer2.address)).to.equal(buyer2Before);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });
  });
});
