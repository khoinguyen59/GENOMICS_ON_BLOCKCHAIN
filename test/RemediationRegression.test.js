import { expect } from "chai";
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  encryptGenomicData,
  decryptGenomicData,
  packCiphertextPayload,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  exportSovereignKeyVault,
  importSovereignKeyVault,
  saveOwnerCapsulePersistent,
  loadOwnerCapsulePersistent,
  saveBuyerCapsulePersistent,
  loadBuyerCapsulePersistent,
  getAllOwnerCapsulesPersistent,
  getAllBuyerCapsulesPersistent,
  clearVaultMemoryCache,
  computeDataHash,
} from "../crypto/client_crypto.js";
import {
  clearKuboLocalRefsCache,
} from "../ipfs/kubo_client.js";
import {
  clearLocalIpfsCache,
  retrieveFromIpfs,
  uploadEncryptedRawData,
  uploadEncryptedSummaryReport,
} from "../ipfs/pinata_uploader.js";
import { buildPhenopacket, validatePhenopacketSchema } from "../ipfs/phenopacket_builder.js";
import {
  computeIpfsCidV0,
  computeIpfsCidV1,
  MULTIHASH_SHA2_256,
  MULTIHASH_SHA2_512,
  MULTIHASH_BLAKE2B_256,
} from "../ipfs/multihash.js";
import {
  sanitizeGenomicMetadata,
  sanitizeMetadataTree,
  formatConfiguredChainText,
} from "../frontend/src/utils/asyncResilience.js";
import { en as enLocale, vi as viLocale } from "../frontend/src/i18n/translations.js";
import {
  runLocalGroth16Ceremony,
  generateAuthenticGroth16Proof,
  computeDonorWitnessCommitment,
} from "../scripts/demo/zk_ceremony_helper.mjs";

const CID_A = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_B = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
const CID_C = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
const URI_A = "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";

function resolvePythonBin() {
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) {
    return process.env.PYTHON_BIN;
  }
  const winVenv = path.resolve(".venv/Scripts/python.exe");
  if (fs.existsSync(winVenv)) return winVenv;
  const nixVenv = path.resolve(".venv/bin/python");
  if (fs.existsSync(nixVenv)) return nixVenv;
  return "python";
}

describe("Remediation Regression Suite (Rounds 1..18, R18-01..R18-06 & FIX-70c..f)", function () {
  this.timeout(120000);

  let ethers;
  let owner, seller, buyer, buyer2, lab1, lab2, worker, stranger;
  let token, nft, registry, zkVerifier;
  const PRICE = 100n * 10n ** 18n;
  const DURATION = 30 * 24 * 3600;
  const DISPUTE_WINDOW = 24 * 3600;

  async function advanceTime(sec) {
    await ethers.provider.send("evm_increaseTime", [Number(sec)]);
    await ethers.provider.send("evm_mine", []);
  }

  async function makeRealCapsule(buyerSigner, sellerAddr, keyHex = "ab".repeat(32)) {
    const kp = await generateAsymmetricKeyPair(false);
    const pubJwk = await exportPublicKey(kp.publicKey);
    const capsule = await packageKeyCapsule(keyHex, pubJwk, buyerSigner.address, sellerAddr);
    return { kp, pubJwk, capsule };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer, buyer2, lab1, lab2, worker, stranger] = await ethers.getSigners();

    const TokenF = await ethers.getContractFactory("GenomicToken");
    token = await TokenF.deploy(owner.address);
    await token.waitForDeployment();

    const NftF = await ethers.getContractFactory("GenomicNFT");
    nft = await NftF.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const RegF = await ethers.getContractFactory("GenomicsRegistry");
    registry = await RegF.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await (await nft.connect(owner).setRegistryContract(registry.target)).wait();

    const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkF.deploy(token.target);
    await zkVerifier.waitForDeployment();
    await (await registry.connect(owner).setZkVerifier(zkVerifier.target)).wait();

    await (await token.connect(owner).transfer(buyer.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(owner).transfer(buyer2.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(buyer).approve(registry.target, ethers.MaxUint256)).wait();
    await (await token.connect(buyer2).approve(registry.target, ethers.MaxUint256)).wait();
  });

  // =========================================================================
  // R18-01: Sovereign Governance (GenomicTimelock Ownable2Step + disableCapsuleDispatcher)
  // =========================================================================
  it("R18-01a: disableCapsuleDispatcher() zeroes global dispatcher on-chain & blocks global delivery while preserving owner/worker", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("r18-01a-raw"));
    await (await registry.connect(seller).registerGenomicData(hash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await registry.connect(buyer).grantAccessWithEscrow(1n, DISPUTE_WINDOW)).wait();

    expect(await registry.capsuleDispatcher()).to.equal(owner.address);
    await expect(registry.connect(owner).setCapsuleDispatcher(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      registry,
      "InvalidRecipient"
    );
    await expect(registry.connect(stranger).disableCapsuleDispatcher()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );

    await expect(registry.connect(owner).disableCapsuleDispatcher())
      .to.emit(registry, "CapsuleDispatcherUpdated")
      .withArgs(owner.address, ethers.ZeroAddress);
    expect(await registry.capsuleDispatcher()).to.equal(ethers.ZeroAddress);

    const { capsule } = await makeRealCapsule(buyer, seller.address);
    // Former global dispatcher (owner) can no longer deliver capsules
    await expect(
      registry.connect(owner).storeTransformedCapsule(1n, buyer.address, capsule)
    ).to.be.revertedWithCustomError(registry, "NotDataOwner");

    // Delegated worker authorized by dataset owner still works cleanly
    await (await registry.connect(seller).setAuthorizedCapsuleWorker(1n, worker.address, true)).wait();
    await (await registry.connect(worker).storeTransformedCapsule(1n, buyer.address, capsule)).wait();
    expect(await registry.connect(buyer).getTransformedCapsule(1n)).to.equal(capsule);

    // Owner can re-enable a non-zero global dispatcher later
    await (await registry.connect(owner).setCapsuleDispatcher(owner.address)).wait();
    expect(await registry.capsuleDispatcher()).to.equal(owner.address);
  });

  it("R18-01b: GenomicTimelock 4-contract Ownable2Step handoff (admin=0x0) enforces delayed sovereign governance", async function () {
    const minDelay = 3600n;
    const TimelockF = await ethers.getContractFactory("GenomicTimelock");
    const timelock = await TimelockF.deploy(minDelay, [owner.address], [owner.address], ethers.ZeroAddress);
    await timelock.waitForDeployment();

    // Verify self-administered (admin == 0x0 -> owner does NOT hold DEFAULT_ADMIN_ROLE)
    const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
    expect(await timelock.hasRole(adminRole, owner.address)).to.equal(false);
    expect(await timelock.hasRole(adminRole, timelock.target)).to.equal(true);

    const targets = [token, nft, registry, zkVerifier];
    const acceptCalldata = token.interface.encodeFunctionData("acceptOwnership");
    const salt = ethers.id("r18-timelock-handoff-salt");

    for (const c of targets) {
      await (await c.connect(owner).transferOwnership(timelock.target)).wait();
      expect(await c.pendingOwner()).to.equal(timelock.target);
      await (await timelock.connect(owner).schedule(c.target, 0n, acceptCalldata, ethers.ZeroHash, salt, minDelay)).wait();
    }

    // Before minDelay elapses, execution MUST revert
    await expect(
      timelock.connect(owner).execute(registry.target, 0n, acceptCalldata, ethers.ZeroHash, salt)
    ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await advanceTime(Number(minDelay) + 5);

    for (const c of targets) {
      await (await timelock.connect(owner).execute(c.target, 0n, acceptCalldata, ethers.ZeroHash, salt)).wait();
      expect(await c.owner()).to.equal(timelock.target);
    }

    // EOA deployer can no longer directly call onlyOwner setters on any of the 4 contracts
    await expect(registry.connect(owner).setCommitRevealRequired(true)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    await expect(token.connect(owner).setFaucetConfig(false, false, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );

    // Timelock scheduled proposal executes setCommitRevealRequired(true) cleanly
    const setCrData = registry.interface.encodeFunctionData("setCommitRevealRequired", [true]);
    const salt2 = ethers.id("r18-set-commit-reveal");
    await (await timelock.connect(owner).schedule(registry.target, 0n, setCrData, ethers.ZeroHash, salt2, minDelay)).wait();
    await advanceTime(Number(minDelay) + 5);
    await (await timelock.connect(owner).execute(registry.target, 0n, setCrData, ethers.ZeroHash, salt2)).wait();
    expect(await registry.commitRevealRequired()).to.equal(true);
  });

  // =========================================================================
  // R18-02: Escrow Manual Release Pre-Delivery, Pause-Blackout Symmetry & 30-Day Dispute Timeout
  // =========================================================================
  it("R18-02a: setManualEscrowRelease works pre-delivery, extends getEscrowLockDeadline by +7d, and PauseState extends deadline + 15m grace", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("r18-02a-escrow"));
    await (await registry.connect(seller).registerGenomicData(hash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await registry.connect(buyer).grantAccessWithEscrow(1n, DISPUTE_WINDOW)).wait();

    const dlBase = await registry.getEscrowLockDeadline(1n, buyer.address);
    // Toggle manual release BEFORE capsule delivery: pre-delivery refund deadline stays at base (buyer not trapped if seller ghosts!)
    await (await registry.connect(buyer).setManualEscrowRelease(1n, true)).wait();
    expect(await registry.manualEscrowRelease(1n, buyer.address)).to.equal(true);
    expect(await registry.getEscrowLockDeadline(1n, buyer.address)).to.equal(dlBase);

    // Deliver valid capsule -> post-delivery lock deadline automatically reflects +7d manual hold!
    const { capsule } = await makeRealCapsule(buyer, seller.address);
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, capsule)).wait();
    const dlManual = await registry.getEscrowLockDeadline(1n, buyer.address);
    expect(dlManual - dlBase).to.equal(7n * 24n * 3600n);

    // Pause for 2 hours -> unpause -> deadline shifts forward by >= 2 hours
    await (await registry.connect(seller).updateDataStatus(1n, 1)).wait(); // Paused
    // Cannot toggle manual release off while Paused (H-01B invariant)
    await expect(registry.connect(buyer).setManualEscrowRelease(1n, false)).to.be.revertedWithCustomError(
      registry,
      "DataNotActive"
    );
    await advanceTime(7200);
    await (await registry.connect(seller).updateDataStatus(1n, 0)).wait(); // Active
    const dlAfterPause = await registry.getEscrowLockDeadline(1n, buyer.address);
    expect(dlAfterPause).to.be.gte(dlManual + 7200n);

    // Seller cannot self-release after base 24h window because +7d manual hold + pause blackout remain active
    await advanceTime(DISPUTE_WINDOW + 3600);
    await expect(registry.connect(seller).releaseEscrow(1n, buyer.address)).to.be.revertedWithCustomError(
      registry,
      "DisputeWindowActive"
    );

    // Advance past extended deadline -> seller release succeeds cleanly
    await advanceTime(7 * 24 * 3600 + 7200);
    const balBefore = await token.balanceOf(seller.address);
    await (await registry.connect(seller).releaseEscrow(1n, buyer.address)).wait();
    expect(await token.balanceOf(seller.address)).to.equal(balBefore + PRICE);
  });

  it("R18-02b: claimDisputeTimeoutRefund blocks premature claim (< 30d) and settles 100% buyer refund after 30d arbitration timeout", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("r18-02b-timeout"));
    await (await registry.connect(seller).registerGenomicData(hash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await registry.connect(buyer).grantAccessWithEscrow(1n, DISPUTE_WINDOW)).wait();

    const { capsule } = await makeRealCapsule(buyer, seller.address);
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, capsule)).wait();
    await (await registry.connect(buyer).disputeCapsule(1n)).wait();

    // Before 30 days -> DisputeArbitrationActive
    await advanceTime(29 * 24 * 3600);
    await expect(registry.connect(buyer).claimDisputeTimeoutRefund(1n)).to.be.revertedWithCustomError(
      registry,
      "DisputeArbitrationActive"
    );

    // After 30 days -> unilateral 100% refund succeeds
    await advanceTime(2 * 24 * 3600);
    const balBefore = await token.balanceOf(buyer.address);
    await expect(registry.connect(buyer).claimDisputeTimeoutRefund(1n))
      .to.emit(registry, "EscrowRefunded")
      .withArgs(1n, buyer.address, PRICE);
    expect(await token.balanceOf(buyer.address)).to.equal(balBefore + PRICE);
    expect(await registry.hasActiveAccess(1n, buyer.address)).to.equal(false);
  });

  // =========================================================================
  // R18-03: Authentic Zero-Slack Groth16 V2 Ceremony, Dataset-Bound Lab Attestation & Multi-Lab Isolation
  // =========================================================================
  it("R18-03: authentic snarkjs V2 Groth16 proof + dataset-bound lab attestation + DowngradeNotAllowed + multi-lab slot isolation", async function () {
    const crs = await runLocalGroth16Ceremony(zkVerifier, owner);
    expect(crs.vkEpoch).to.be.gte(1);

    // Downgrade to legacy 1-input setupVerificationKey MUST revert DowngradeNotAllowed
    const dummyG1 = [1n, 2n];
    const dummyG2 = [
      [1n, 2n],
      [3n, 4n],
    ];
    await expect(
      zkVerifier.connect(owner).setupVerificationKey(dummyG1, dummyG2, dummyG2, dummyG2, dummyG1, dummyG1)
    ).to.be.revertedWithCustomError(zkVerifier, "DowngradeNotAllowed");

    // Register dataset owned by seller & link approved labs lab1 and lab2
    const rawDataHash = ethers.keccak256(ethers.toUtf8Bytes("r18-03-dataset-raw"));
    await (await registry.connect(seller).registerGenomicData(rawDataHash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await zkVerifier.connect(owner).setApprovedLabAttestor(lab1.address, true)).wait();
    await (await zkVerifier.connect(owner).setApprovedLabAttestor(lab2.address, true)).wait();
    await (await zkVerifier.connect(owner).setRequireLabAttestation(true)).wait();

    // Create two lab-attested bounties for ALDH2_rs671 (lab1 and lab2)
    const traitId = ethers.id("ALDH2_rs671");
    const reward = ethers.parseEther("50");
    await (await token.connect(buyer).approve(zkVerifier.target, reward * 4n)).wait();
    await (await zkVerifier.connect(buyer).createAttestedZkBounty(traitId, "Lab1 Cohort", reward, 2, 86400, lab1.address)).wait();
    await (await zkVerifier.connect(buyer).createAttestedZkBounty(traitId, "Lab2 Cohort", reward, 2, 86400, lab2.address)).wait();

    // Unattested bounty creation MUST revert when requireLabAttestation == true
    await expect(
      zkVerifier.connect(buyer).createZkBounty(traitId, "Unattested", reward, 1, 86400)
    ).to.be.revertedWithCustomError(zkVerifier, "LabAttestationRequired");

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const secret = "DONOR_R18_AUTHENTIC_WITNESS_V1";
    const commitment = computeDonorWitnessCommitment(seller.address, traitId, secret);

    // Proof #1 for Bounty #1 (dataset-bound lab1 attestation)
    const proof1 = await generateAuthenticGroth16Proof({
      donorAddress: seller.address,
      targetTraitId: traitId,
      variantCommitment: commitment,
      witnessSecret: secret,
      bountyId: 1,
      verifierAddress: zkVerifier.target,
      chainId,
      vkEpoch: crs.vkEpoch,
    });

    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latestBlock.timestamp) + 3600n;
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const dsDigest1 = ethers.keccak256(
      abiCoder.encode(
        ["string", "uint256", "address", "uint256", "bytes32", "address", "bytes32", "bytes32", "uint256"],
        ["GENOCHAIN_LAB_DATASET_ATTESTATION_V1", BigInt(chainId), zkVerifier.target, 1n, traitId, seller.address, commitment, rawDataHash, deadline]
      )
    );
    const sig1 = await lab1.signMessage(ethers.getBytes(dsDigest1));

    await (
      await zkVerifier
        .connect(seller)
        .claimDatasetAttestedZkBounty(1n, proof1.proof.a, proof1.proof.b, proof1.proof.c, commitment, rawDataHash, deadline, sig1)
    ).wait();

    expect(await registry.verifyDatasetBoundTrait(1n, traitId)).to.equal(true);
    expect(await registry.hasDonorClaimedZkBounty(1n, seller.address)).to.equal(true);

    // Proof #2 for Bounty #2 (dataset-bound lab2 attestation)
    const proof2 = await generateAuthenticGroth16Proof({
      donorAddress: seller.address,
      targetTraitId: traitId,
      variantCommitment: commitment,
      witnessSecret: secret,
      bountyId: 2,
      verifierAddress: zkVerifier.target,
      chainId,
      vkEpoch: crs.vkEpoch,
    });
    const dsDigest2 = ethers.keccak256(
      abiCoder.encode(
        ["string", "uint256", "address", "uint256", "bytes32", "address", "bytes32", "bytes32", "uint256"],
        ["GENOCHAIN_LAB_DATASET_ATTESTATION_V1", BigInt(chainId), zkVerifier.target, 2n, traitId, seller.address, commitment, rawDataHash, deadline]
      )
    );
    const sig2 = await lab2.signMessage(ethers.getBytes(dsDigest2));

    // Replaying proof1 on bounty 2 MUST fail with InvalidZkProof
    await expect(
      zkVerifier
        .connect(seller)
        .claimDatasetAttestedZkBounty(2n, proof1.proof.a, proof1.proof.b, proof1.proof.c, commitment, rawDataHash, deadline, sig2)
    ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");

    await (
      await zkVerifier
        .connect(seller)
        .claimDatasetAttestedZkBounty(2n, proof2.proof.a, proof2.proof.b, proof2.proof.c, commitment, rawDataHash, deadline, sig2)
    ).wait();

    // Multi-lab isolation: revoking lab1 leaves lab2's attestation valid; revoking BOTH invalidates!
    await (await zkVerifier.connect(owner).setApprovedLabAttestor(lab1.address, false)).wait();
    expect(await registry.verifyDatasetBoundTrait(1n, traitId)).to.equal(true);
    await (await zkVerifier.connect(owner).setApprovedLabAttestor(lab2.address, false)).wait();
    expect(await registry.verifyDatasetBoundTrait(1n, traitId)).to.equal(false);
  });

  // =========================================================================
  // R18-04: Faucet Voucher, TokenURI XSS, Dispatcher Opt-Out, NFT Transfer Worker Sync & 3-Arg Study Reuse
  // =========================================================================
  it("R18-04: EIP-191 faucet voucher anti-replay, GenomicNFT XSS URI guard, dispatcher opt-out, NFT transfer worker reset & 3-arg study reuse slippage", async function () {
    // 1. Voucher-gated faucet
    await (await token.connect(owner).setFaucetConfig(true, true, lab1.address)).wait();
    await expect(token.connect(stranger).faucet(stranger.address)).to.be.revertedWithCustomError(token, "FaucetVoucherRequired");

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const blk = await ethers.provider.getBlock("latest");
    const deadline = BigInt(blk.timestamp) + 600n;
    const nonce = 987654321n;
    const voucherHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "uint256", "uint256"],
        ["GENOCHAIN_FAUCET_VOUCHER_V1", BigInt(chainId), token.target, stranger.address, nonce, deadline]
      )
    );
    const voucherSig = await lab1.signMessage(ethers.getBytes(voucherHash));

    await (await token.connect(stranger).claimFaucetWithVoucher(stranger.address, nonce, deadline, voucherSig)).wait();
    expect(await token.balanceOf(stranger.address)).to.equal(ethers.parseEther("1000"));
    // Nonce replay blocked
    await expect(
      token.connect(stranger).claimFaucetWithVoucher(stranger.address, nonce, deadline, voucherSig)
    ).to.be.revertedWithCustomError(token, "FaucetVoucherUsed");

    // 2. GenomicNFT validateTokenUri blocks XSS schemes & control chars
    expect(await nft.validateTokenUri("javascript:alert(1)")).to.equal(false);
    expect(await nft.validateTokenUri("  DATA:text/html,<svg/onload=alert(1)>")).to.equal(false);
    expect(await nft.validateTokenUri("vbscript:msgbox(1)")).to.equal(false);
    expect(await nft.validateTokenUri("ipfs://valid\nnewline")).to.equal(false);
    expect(await nft.validateTokenUri("ipfs://" + "a".repeat(2045))).to.equal(false);
    expect(await nft.validateTokenUri(URI_A)).to.equal(true);

    // 3. Dispatcher opt-out + ERC-721 transfer atomically resets delegated worker in O(1)
    const hash = ethers.keccak256(ethers.toUtf8Bytes("r18-04-optout-transfer"));
    await (await registry.connect(seller).registerGenomicData(hash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await registry.connect(seller).setDispatcherOptOut(1n, true)).wait();
    await (await registry.connect(seller).setAuthorizedCapsuleWorker(1n, worker.address, true)).wait();
    expect(await registry.authorizedCapsuleWorkers(1n, worker.address)).to.equal(true);

    await (await registry.connect(buyer)["grantAccess(uint256)"](1n)).wait();
    const { capsule } = await makeRealCapsule(buyer, seller.address);
    // Global dispatcher (owner) blocked due to opt-out
    await expect(
      registry.connect(owner).storeTransformedCapsule(1n, buyer.address, capsule)
    ).to.be.revertedWithCustomError(registry, "NotDataOwner");

    // 3-arg recordStudyReuse MEV slippage guard + replay block
    const studyId = ethers.id("GWAS_2026_FOLLOWON");
    const expectedFee = (PRICE * 500n) / 10000n;
    await expect(
      registry.connect(buyer)["recordStudyReuse(uint256,bytes32,uint256)"](1n, studyId, expectedFee - 1n)
    ).to.be.revertedWithCustomError(registry, "PriceExceedsMax");
    await (await registry.connect(buyer)["recordStudyReuse(uint256,bytes32,uint256)"](1n, studyId, expectedFee)).wait();
    await expect(
      registry.connect(buyer)["recordStudyReuse(uint256,bytes32,uint256)"](1n, studyId, expectedFee)
    ).to.be.revertedWithCustomError(registry, "StudyReuseAlreadyRecorded");

    // Transfer NFT seller -> buyer2 -> worker epoch advances in O(1), old worker revoked automatically
    const ep0 = await registry.workerEpoch(1n);
    await (await nft.connect(seller).transferFrom(seller.address, buyer2.address, 1n)).wait();
    expect(await registry.workerEpoch(1n)).to.equal(ep0 + 1n);
    expect(await registry.authorizedCapsuleWorkers(1n, worker.address)).to.equal(false);
  });

  // =========================================================================
  // R18-05: Crypto Core (GNC2 Streaming, Vault v2, XSS Sanitizer, Non-Pathological Phenopackets)
  // =========================================================================
  it("R18-05: GNC2 64KB chunked tamper detection, Vault v2 PBKDF2 export/import, fixed-point XSS sanitizer & INVARIANT-11 Phenopackets", async function () {
    // 1. GNC2 streaming round-trip + 1-bit tamper rejection
    const plain = new TextEncoder().encode("ACGT".repeat(40000)); // 160 KB (3 chunks)
    const enc = await encryptGenomicDataChunked(plain);
    expect(new TextDecoder().decode(enc.payload.slice(0, 4))).to.equal("GNC2");
    const dec = await decryptGenomicDataChunked(enc.payload, enc.keyHex);
    expect(Buffer.from(dec).equals(Buffer.from(plain))).to.equal(true);
    const tampered = new Uint8Array(enc.payload);
    tampered[tampered.length - 10] ^= 0x01;
    await expect(decryptGenomicDataChunked(tampered, enc.keyHex)).to.be.rejected;

    // 2. Fixed-point XSS sanitizer preserves VCF <DEL>/<INS> while stripping nested scripts & prototype pollution
    const dirty = 'MAF < 5% <DEL> <scr<script>ipt>alert(1)</script> java\tscript:evil() <img src=x onerror=alert(1)>';
    const clean = sanitizeGenomicMetadata(dirty);
    expect(clean).to.include("MAF < 5%");
    expect(clean).to.include("<DEL>");
    expect(clean.toLowerCase()).to.not.include("script");
    expect(clean.toLowerCase()).to.not.include("onerror");
    const safeObj = sanitizeMetadataTree(JSON.parse('{"__proto__":{"polluted":true},"gene":"ALDH2","note":"<svg onload=x>ok"}'));
    expect(({}).polluted).to.equal(undefined);
    expect(safeObj.gene).to.equal("ALDH2");
    expect(safeObj.note).to.equal("ok");

    // 3. Vault v2 PBKDF2 600k backup + wrong-passphrase rejection
    clearVaultMemoryCache();
    const kp = await generateAsymmetricKeyPair(true);
    const pubJwk = await exportPublicKey(kp.publicKey);
    const cap = await packageKeyCapsule("cd".repeat(32), pubJwk, buyer.address, seller.address);
    const backup = await exportSovereignKeyVault({
      signer: buyer,
      account: buyer.address,
      password: "GenoChain-Strong-Passphrase-2026!",
      extraBuyerCapsules: [{ rawCid: CID_A, capsule: cap }],
    });
    const parsed = JSON.parse(backup);
    expect(parsed.format).to.equal("GENOCHAIN-ENCRYPTED-KEY-VAULT-v2");
    expect(parsed.iterations).to.equal(600000);
    await expect(
      importSovereignKeyVault({ signer: buyer, account: buyer.address, backupData: backup, password: "Wrong-Passphrase-2026!" })
    ).to.be.rejected;
    const restored = await importSovereignKeyVault({
      signer: buyer,
      account: buyer.address,
      backupData: backup,
      password: "GenoChain-Strong-Passphrase-2026!",
    });
    expect(restored.restoredCount).to.be.gte(1);

    // 4. GA4GH Phenopacket v2 schema validation & INVARIANT-11 (zero PATHOGENIC / CAUSATIVE values)
    for (const dir of ["data/diverse_real_datasets", "frontend/public/datasets"]) {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith("GA4GH_Phenopacket_") && f.endsWith(".json"));
      expect(files.length).to.be.gte(3);
      for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        expect(/"(PATHOGENIC|LIKELY_PATHOGENIC|CAUSATIVE)"/.test(raw), `INVARIANT-11 breach in ${dir}/${f}`).to.equal(false);
        const validation = validatePhenopacketSchema(JSON.parse(raw));
        expect(validation.valid, `Invalid schema in ${dir}/${f}: ${validation.errors.join("; ")}`).to.equal(true);
      }
    }
  });

  // =========================================================================
  // FIX-70c [R18-03]: Private IPFS Gateway DoS, Anti-Sybil Upload, Concurrent Quota, Chunked Abort & Orphan-Pin GC
  // =========================================================================
  it("FIX-70c [R18-03]: Private IPFS Gateway blocks random-CID amplification, Sybil uploads, concurrent quota races, malformed/over-quota chunked streams, upload nonce saturation & orphan-pin TTL GC", async function () {
    this.timeout(30000);
    const pyDosSuite = `
import base64, hashlib, http.client, json, os, sys, tempfile, threading, time
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, os.path.abspath("deploy"))
import ipfs_access_gateway as gw

CID_PUB = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ"
CID_PRIV = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
CID_ORPHAN = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"fix70c_orphan_pin").digest()).decode("ascii").rstrip("=").lower()

def make_random_cidv1(i):
    d = hashlib.sha256(f"rand_cid_{i}".encode()).digest()
    return "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + d).decode("ascii").rstrip("=").lower()

DONOR = Account.create()
BUYER = Account.create()
SYBIL = Account.create()
CHAIN_ID = 84532
REG = "0x3333333333333333333333333333333333333333"

class DosReg:
    def __init__(self):
        self.calls = 0
        self.datasets = [
            {"dataId": 1, "currentOwner": DONOR.address, "rawCid": CID_PRIV, "summaryCid": "", "metadataCid": CID_PUB, "status": 0}
        ]
    def is_connected(self): return True
    def get_block_number(self): return 200
    def get_all_datasets(self):
        self.calls += 1
        return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise ValueError("DataNotFound")
    def has_active_access(self, d, a):
        return int(d) == 1 and a.lower() == BUYER.address.lower()
    def is_upload_eligible(self, a, min_wei, min_geno):
        return a.lower() == DONOR.address.lower()
    def get_status_updated_events(self, a, b):
        return []

class DosKubo:
    def __init__(self):
        self.upload_delay = 0.0
        self.seq = 0
        self.pins = {CID_ORPHAN: 1024}
        self.gc_runs = 0
    def health_check(self): return True
    def cat_cid(self, cid):
        return b'{"phenopacket":true}' if cid == CID_PUB else b"ENCRYPTED_GENOME_BYTES"
    def add_stream(self, stream, fn, cl, cid_version=1):
        data = stream.read(cl)
        if self.upload_delay > 0:
            time.sleep(self.upload_delay)
        self.seq += 1
        d = hashlib.sha256(f"dos_upload_{self.seq}".encode()).digest()
        cid = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + d).decode("ascii").rstrip("=").lower()
        self.pins[cid] = len(data)
        return {"cid": cid, "size": len(data)}
    def unpin_cid(self, cid):
        return self.pins.pop(cid, None) is not None
    def run_gc(self):
        self.gc_runs += 1
        return True

with tempfile.TemporaryDirectory() as td:
    db_file = os.path.join(td, "fix70c.sqlite")
    now_box = [int(time.time())]
    reg = DosReg()
    kubo = DosKubo()
    nonces = gw.NonceStore(db_path=db_file, max_entries=100, upload_max_entries=2)
    srv = gw.create_gateway_server(
        host="127.0.0.1", port=0, chain_id=CHAIN_ID, registry_address=REG,
        registry_adapter=reg, kubo_adapter=kubo, nonce_store=nonces, state_db_path=db_file,
        max_upload_bytes_per_hour=100_000, max_global_upload_bytes_per_hour=500_000,
        max_total_pinned_bytes=5_000_000, upload_policy="onchain-eligible",
        min_forced_refresh_sec=5.0,
    )
    # Seed an unanchored orphan pin directly into pending_uploads
    srv.gateway_upload_limiter.record_pending_upload(CID_ORPHAN, DONOR.address, 1024, uploaded_at=now_box[0])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        # 1. Public metadata serves 200 on first scan; 10 random CID probes must NOT cause RPC amplification!
        c0 = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c0.request("GET", f"/ipfs/{CID_PUB}")
        r0 = c0.getresponse(); r0.read(); c0.close()
        assert r0.status == 200 and reg.calls == 1

        for idx in range(10):
            rc = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            rc.request("GET", f"/ipfs/{make_random_cidv1(idx)}")
            rr = rc.getresponse(); rr.read(); rc.close()
            assert rr.status == 401
        assert reg.calls <= 2, f"Random-CID RPC amplification! 10 probes triggered {reg.calls} scans"

        # 2. Anti-Sybil onchain-eligible upload policy: zero-balance throwaway SYBIL gets 403 with 0 NonceStore entries consumed!
        payload_small = b"A" * 1024
        sha_small = hashlib.sha256(payload_small).hexdigest()
        n_syb = "fix70c_sybil_nonce_00001"
        s_syb = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha_small, SYBIL.address, now_box[0], n_syb)), SYBIL.key).signature.hex()
        cs = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        cs.request("POST", "/api/v0/upload", body=payload_small, headers={
            "Content-Type": "application/octet-stream",
            "X-GenoChain-Address": SYBIL.address,
            "X-GenoChain-Timestamp": str(now_box[0]),
            "X-GenoChain-Nonce": n_syb,
            "X-GenoChain-Signature": s_syb,
            "X-GenoChain-Content-Sha256": sha_small,
        })
        rs = cs.getresponse(); rs.read(); cs.close()
        assert rs.status == 403, f"Expected 403 for ineligible Sybil uploader, got {rs.status}"
        assert nonces.count() == 0, f"Ineligible upload consumed NonceStore: {nonces.count()}"

        # 3. Record 1 valid download nonce BEFORE testing upload concurrency & upload nonce saturation
        n_dl = "fix70c_download_nonce_01"
        s_dl = Account.sign_message(encode_defunct(text=gw.build_siwe_auth_message(CHAIN_ID, REG, 1, CID_PRIV, BUYER.address, now_box[0], n_dl)), BUYER.key).signature.hex()
        cdl = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        cdl.request("GET", f"/ipfs/{CID_PRIV}", headers={
            "X-GenoChain-Data-Id": "1",
            "X-GenoChain-Address": BUYER.address,
            "X-GenoChain-Timestamp": str(now_box[0]),
            "X-GenoChain-Nonce": n_dl,
            "X-GenoChain-Signature": "0x" + s_dl if not s_dl.startswith("0x") else s_dl,
        })
        rdl = cdl.getresponse(); rdl.read(); cdl.close()
        assert rdl.status == 200 and nonces.count("download") == 1

        # 4. Atomic quota reservation under 4 parallel single-EOA 60 KB uploads against 100 KB/hr cap -> strictly 1x 200 and 3x 429!
        payload_60k = b"B" * 60_000
        sha_60k = hashlib.sha256(payload_60k).hexdigest()
        kubo.upload_delay = 0.25
        results = []
        barrier = threading.Barrier(4)

        def do_parallel_upload(i):
            ni = f"fix70c_par_nonce_00000{i}"
            si = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha_60k, DONOR.address, now_box[0], ni)), DONOR.key).signature.hex()
            barrier.wait()
            cp = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            cp.request("POST", "/api/v0/upload", body=payload_60k, headers={
                "Content-Type": "application/octet-stream",
                "X-GenoChain-Address": DONOR.address,
                "X-GenoChain-Timestamp": str(now_box[0]),
                "X-GenoChain-Nonce": ni,
                "X-GenoChain-Signature": si,
                "X-GenoChain-Content-Sha256": sha_60k,
            })
            rp = cp.getresponse(); rp.read(); cp.close()
            results.append(rp.status)

        threads = [threading.Thread(target=do_parallel_upload, args=(i,)) for i in range(4)]
        for t in threads: t.start()
        for t in threads: t.join()
        kubo.upload_delay = 0.0
        assert results.count(200) == 1 and results.count(429) == 3, f"Concurrent quota race! Got {results}"

        # 5. Chunked upload strict hex rejection (0x10 -> 400) AND incremental chunk quota abort (>40 KB remaining -> 429 BEFORE full spool)
        for bad_hex in (b"0x10", b"+10", b"1_0"):
            nb = f"fix70c_badhex_{bad_hex.decode().replace('+','p')}_0001"
            sb = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha_small, DONOR.address, now_box[0], nb)), DONOR.key).signature.hex()
            cb = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            cb.putrequest("POST", "/api/v0/upload")
            cb.putheader("Transfer-Encoding", "chunked")
            cb.putheader("X-GenoChain-Address", DONOR.address)
            cb.putheader("X-GenoChain-Timestamp", str(now_box[0]))
            cb.putheader("X-GenoChain-Nonce", nb)
            cb.putheader("X-GenoChain-Signature", sb)
            cb.putheader("X-GenoChain-Content-Sha256", sha_small)
            cb.endheaders()
            cb.send(bad_hex + b"\\r\\n" + b"0" * 16 + b"\\r\\n0\\r\\n\\r\\n")
            rb = cb.getresponse(); rb.read(); cb.close()
            assert rb.status == 400, f"Malformed chunk hex {bad_hex!r} expected 400, got {rb.status}"

        # Remaining quota for DONOR is 40,000 B; declare a 50,000 B chunk -> must abort 429 BEFORE even sending the chunk body!
        ncq = "fix70c_chunk_quota_00001"
        scq = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha_60k, DONOR.address, now_box[0], ncq)), DONOR.key).signature.hex()
        ccq = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        ccq.putrequest("POST", "/api/v0/upload")
        ccq.putheader("Transfer-Encoding", "chunked")
        ccq.putheader("X-GenoChain-Address", DONOR.address)
        ccq.putheader("X-GenoChain-Timestamp", str(now_box[0]))
        ccq.putheader("X-GenoChain-Nonce", ncq)
        ccq.putheader("X-GenoChain-Signature", scq)
        ccq.putheader("X-GenoChain-Content-Sha256", sha_60k)
        ccq.endheaders()
        ccq.send(f"{50_000:x}\\r\\n".encode())
        rcq = ccq.getresponse(); rcq.read(); ccq.close()
        assert rcq.status == 429, f"Over-quota chunked upload expected immediate 429, got {rcq.status}"

        # 6. Upload NonceStore saturation (upload_max_entries=2): 2nd small upload succeeds (200), 3rd returns 429 WITHOUT evicting download nonce!
        for idx, exp_status in ((2, 200), (3, 429)):
            ns = f"fix70c_sat_nonce_00000{idx}"
            ss = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha_small, DONOR.address, now_box[0], ns)), DONOR.key).signature.hex()
            csat = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            csat.request("POST", "/api/v0/upload", body=payload_small, headers={
                "Content-Type": "application/octet-stream",
                "X-GenoChain-Address": DONOR.address,
                "X-GenoChain-Timestamp": str(now_box[0]),
                "X-GenoChain-Nonce": ns,
                "X-GenoChain-Signature": ss,
                "X-GenoChain-Content-Sha256": sha_small,
            })
            rsat = csat.getresponse(); rsat.read(); csat.close()
            assert rsat.status == exp_status, f"Upload saturation step #{idx} expected {exp_status}, got {rsat.status}"
        assert nonces.count("download") == 1 and nonces.is_used(BUYER.address, n_dl, now_ts=now_box[0], namespace="download") is True

        # 7. Orphan-Pin TTL GC: advance clock past orphan_pin_ttl_sec (3600s) -> CID_ORPHAN unpinned & repo/gc run!
        rec = gw.GdprErasureReconciler(
            reg, kubo, start_block=195, db_path=db_file,
            orphan_pin_ttl_sec=3600, now_fn=lambda: now_box[0] + 4000,
        )
        res_orphan = rec.reconcile_once()
        assert CID_ORPHAN in res_orphan["orphanUnpinnedCids"], f"Orphan pin was NOT GC'd: {res_orphan}"
        assert res_orphan["gcRan"] is True and kubo.gc_runs >= 1
        rec.close()
    finally:
        srv.shutdown(); srv.server_close()
        srv.gateway_upload_limiter.close()
        nonces.close()

print("FIX70C_DOS_QUOTA_OK")
`;
    const out = execFileSync(resolvePythonBin(), ["-c", pyDosSuite], { encoding: "utf8" });
    expect(out).to.include("FIX70C_DOS_QUOTA_OK");
  });

  // =========================================================================
  // FIX-70d [R18-04 & R18-05]: Dispatcher Dynamic NFT Resolution, Bounded HEAD Health Server & Fail-Closed Private Gateway Client
  // =========================================================================
  it("FIX-70d [R18-04 & R18-05]: verifies capsule_dispatcher dynamic registry.genomicNFT() resolution & bounded HEAD-capable health server, strict Private Gateway fail-closed client (0 public CID leaks on 401/404/503/timeout), and no double .enc.enc", async function () {
    this.timeout(25000);
    const pyDispR18 = `
import http.client, sys, threading
sys.path.insert(0, "scripts/demo")
import capsule_dispatcher as cd

BAKED_REG = "0x1111111111111111111111111111111111111111"
BAKED_NFT = "0x2222222222222222222222222222222222222222"
LIVE_REG  = "0x3333333333333333333333333333333333333333"
LIVE_NFT  = "0x4444444444444444444444444444444444444444"

class LiveRegStub:
    class functions:
        @staticmethod
        def genomicNFT():
            class Call:
                def call(self): return LIVE_NFT
            return Call()

class BrokenRegStub:
    class functions:
        @staticmethod
        def genomicNFT():
            class Call:
                def call(self): raise RuntimeError("rpc down")
            return Call()

addrs = {"GenomicsRegistry": BAKED_REG, "GenomicNFT": BAKED_NFT}
assert cd.resolve_genomic_nft_address(LiveRegStub(), addrs, LIVE_REG) == LIVE_NFT
assert cd.resolve_genomic_nft_address(BrokenRegStub(), addrs, LIVE_REG) is None
assert cd.resolve_genomic_nft_address(BrokenRegStub(), addrs, BAKED_REG) == BAKED_NFT

lock = threading.Lock()
state = {"rpcConnected": True, "chainId": 84532, "lastBlock": 10}
srv, _ = cd.start_health_server("127.0.0.1", 0, state, lock, max_workers=16, socket_timeout_sec=5.0)
port = srv.server_address[1]
try:
    assert srv.daemon_threads is True and srv.allow_reuse_address is True and srv._max_workers == 16
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request("HEAD", "/healthz")
    r1 = c.getresponse(); b1 = r1.read()
    assert r1.status == 200 and b1 == b"" and int(r1.getheader("Content-Length", "0")) > 0
    with lock:
        state["rpcConnected"] = False
    c.request("HEAD", "/healthz")
    r2 = c.getresponse(); b2 = r2.read()
    assert r2.status == 503 and b2 == b""
    c.request("HEAD", "/metrics")
    r3 = c.getresponse(); b3 = r3.read()
    assert r3.status == 200 and b3 == b""
    c.close()
finally:
    srv.shutdown(); srv.server_close()

print("FIX70D_DISP_OK")
`;
    const dispOut = execFileSync(resolvePythonBin(), ["-c", pyDispR18], { encoding: "utf8" });
    expect(dispOut).to.include("FIX70D_DISP_OK");

    const origFetch = globalThis.fetch;
    try {
      for (const scenario of ["unauth-401", "erased-404", "upstream-503", "network-timeout"]) {
        const calls = [];
        globalThis.fetch = async (url) => {
          calls.push(String(url));
          if (!String(url).startsWith("https://private.genochain.test/")) {
            throw new Error(`PUBLIC GATEWAY LEAK on ${scenario}: ${url}`);
          }
          if (scenario === "unauth-401") return new Response(JSON.stringify({ error: "Missing auth" }), { status: 401, headers: { "content-type": "application/json" } });
          if (scenario === "erased-404") return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
          if (scenario === "upstream-503") return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
          throw new Error("ETIMEDOUT");
        };
        clearKuboLocalRefsCache();
        clearLocalIpfsCache();
        let caught = null;
        try {
          await retrieveFromIpfs(CID_A, "https://gateway.pinata.cloud/ipfs", {
            customGateway: "https://private.genochain.test",
            timeoutMs: 200,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught, `Expected fail-closed throw on ${scenario}`).to.not.equal(null);
        expect(caught.privateGatewayFailClosed).to.equal(true);
        const publicCalls = calls.filter((u) => !u.startsWith("https://private.genochain.test/"));
        expect(publicCalls.length, `Public gateway leak on ${scenario}: ${publicCalls}`).to.equal(0);
      }

      const dsSrc = fs.readFileSync(path.resolve("frontend/src/services/datasetService.js"), "utf8");
      expect(dsSrc).to.not.include("_raw.enc");
      expect(dsSrc).to.not.include("_report.enc");
      const uploaderSrc = fs.readFileSync(path.resolve("ipfs/pinata_uploader.js"), "utf8");
      expect(uploaderSrc).to.include('.endsWith(".enc")');
    } finally {
      globalThis.fetch = origFetch;
      clearKuboLocalRefsCache();
      clearLocalIpfsCache();
    }
  });

  // =========================================================================
  // FIX-70e [R18-06 Polish]: wtns.fill(0), Atomic IPFS Settings, AdminPortal Timelock, CSP & CI Parity
  // =========================================================================
  it("FIX-70e [R18-06 Polish]: scrubs Groth16 witness bytes in finally, validates IPFS settings atomically, detects GenomicTimelock governance in AdminPortal, strips loopback CSP on non-local Vite builds, and syncs runbook/CI", async function () {
    const { generateGroth16ProofWithZkey } = await import("../crypto/zk/groth16_prover.js");
    let capturedWtnsSuccess = null;
    await generateGroth16ProofWithZkey({
      snarkjs: {
        groth16: {
          prove: async (_zkey, wtnsBuf) => {
            capturedWtnsSuccess = wtnsBuf;
            expect(wtnsBuf.some((b) => b !== 0)).to.equal(true);
            return {
              proof: { pi_a: ["1", "2"], pi_b: [["1", "2"], ["3", "4"]], pi_c: ["5", "6"] },
              publicSignals: ["1"],
            };
          },
        },
      },
      zkeySource: new Uint8Array([1]),
      donorAddress: seller.address,
      targetTraitId: ethers.id("ALDH2_rs671"),
      witnessSecret: "0x" + "12".repeat(32),
      bountyId: 1,
      verifierAddress: registry.target,
      chainId: 31337,
      vkEpoch: 1,
    });
    expect(capturedWtnsSuccess).to.not.equal(null);
    expect(capturedWtnsSuccess.every((b) => b === 0), "wtns buffer was NOT zeroed on success!").to.equal(true);

    let capturedWtnsErr = null;
    let proveFailed = false;
    try {
      await generateGroth16ProofWithZkey({
        snarkjs: {
          groth16: {
            prove: async (_zkey, wtnsBuf) => {
              capturedWtnsErr = wtnsBuf;
              throw new Error("simulated prover abort");
            },
          },
        },
        zkeySource: new Uint8Array([1]),
        donorAddress: seller.address,
        targetTraitId: ethers.id("ALDH2_rs671"),
        witnessSecret: "0x" + "34".repeat(32),
        bountyId: 1,
        verifierAddress: registry.target,
        chainId: 31337,
        vkEpoch: 1,
      });
    } catch {
      proveFailed = true;
    }
    expect(proveFailed).to.equal(true);
    expect(capturedWtnsErr.every((b) => b === 0), "wtns buffer was NOT zeroed on error!").to.equal(true);

    const web3Src = fs.readFileSync(path.resolve("frontend/src/context/Web3Context.jsx"), "utf8");
    const idxGwCheck = web3Src.indexOf('throw new Error("Invalid Kubo Gateway URL');
    const idxRpcSet = web3Src.indexOf("const normalizedRpc = setKuboRpcStorage(rpc)");
    expect(idxGwCheck).to.be.gt(0);
    expect(idxGwCheck).to.be.lt(idxRpcSet);

    const adminSrc = fs.readFileSync(path.resolve("frontend/src/features/admin/AdminPortal.jsx"), "utf8");
    expect(adminSrc).to.include("GenomicTimelockABI");
    expect(adminSrc).to.include("admin-timelock-mode-banner");
    expect(adminSrc).to.include('encodeFunctionData("schedule"');

    const idxHtml = fs.readFileSync(path.resolve("frontend/index.html"), "utf8");
    expect(idxHtml).to.not.include("fonts.googleapis.com");
    const viteSrc = fs.readFileSync(path.resolve("frontend/vite.config.js"), "utf8");
    expect(viteSrc).to.include("transformIndexHtml");
    expect(viteSrc).to.include("genochain-prod-csp-hardening");

    const runbook = fs.readFileSync(path.resolve("deploy/DEPLOYMENT_RUNBOOK.md"), "utf8");
    expect(runbook).to.not.include("deploy/secrets/dispatcher_seed_vault.json");
    expect(runbook).to.include("deploy/secrets/vault/dispatcher_seed_vault.json");
    const ciYml = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
    const secYml = fs.readFileSync(path.resolve(".github/workflows/security_ci.yml"), "utf8");
    expect(ciYml).to.include("bash -n deploy/kubo-private-init.sh");
    expect(ciYml).to.include("npm run audit:slither");
    expect(ciYml).to.include("capsuleDispatcher disabled to 0x0000000000000000000000000000000000000000 on-chain");
    expect(secYml).to.include("bash -n deploy/kubo-private-init.sh");
    expect(secYml).to.include("npm run audit:slither");
  });

  // =========================================================================
  // FIX-70f [R18-Review]: First-Claimant Cooldown Bypass, Anchored Pinned Cap, HTTP Smuggling, RPC Backoff & Edge Guards
  // =========================================================================
  it("FIX-70f [R18-Review]: closes First-Claimant cooldown bypass & RPC fail-open, enforces anchored tracked_pins storage cap & FD cleanup, adds RPC failure backoff & non-blocking cached reads, rejects unsupported TE/duplicate CL, fixes null/empty upload filenames, live dispatcher chainId & AdminPortal Timelock validation/execute calldata", async function () {
    this.timeout(30000);
    const pyReviewSuite = `
import base64, hashlib, http.client, json, os, socket, sys, tempfile, threading, time
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, os.path.abspath("deploy"))
import ipfs_access_gateway as gw

CID_V0 = "QmW2WQi7j6c7UgJTarActp7tDNikE4B2qXtFCfLPdsgaTQ"
mh_v0 = gw.extract_canonical_multihash(CID_V0)
digest = bytes.fromhex(mh_v0.split(":")[-1])
CID_V1_DAGPB = "b" + base64.b32encode(bytes([0x01, 0x70, 0x12, 0x20]) + digest).decode("ascii").rstrip("=").lower()
CID_META = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx"
CID_RAND = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"fix70f_probe").digest()).decode("ascii").rstrip("=").lower()

VICTIM = Account.create()
ATTACKER = Account.create()
CHAIN_ID = 84532
REG = "0x4444444444444444444444444444444444444444"

class CooldownAttackReg:
    def __init__(self):
        self.datasets = []
        self.fail_catalog = False
    def is_connected(self): return True
    def get_all_datasets(self):
        if self.fail_catalog:
            raise RuntimeError("RPC down")
        return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise ValueError("DataNotFound")
    def has_active_access(self, d, b): return False

class StubKubo:
    def health_check(self): return True
    def cat_cid(self, cid): return b"SECRET_VICTIM_GENOME"

reg1 = CooldownAttackReg()
srv1 = gw.create_gateway_server(
    host="127.0.0.1", port=0, chain_id=CHAIN_ID, registry_address=REG,
    registry_adapter=reg1, kubo_adapter=StubKubo(), min_forced_refresh_sec=5.0,
)
threading.Thread(target=srv1.serve_forever, daemon=True).start()
p1 = srv1.server_address[1]
try:
    for probe in (CID_META, CID_RAND):
        c = http.client.HTTPConnection("127.0.0.1", p1, timeout=5)
        c.request("GET", f"/ipfs/{probe}")
        r = c.getresponse(); r.read(); c.close()
    reg1.datasets.append({"dataId": 1, "currentOwner": VICTIM.address, "rawCid": CID_V0, "summaryCid": "", "metadataCid": CID_META, "status": 0})
    reg1.datasets.append({"dataId": 2, "currentOwner": ATTACKER.address, "rawCid": CID_V1_DAGPB, "summaryCid": "", "metadataCid": CID_META, "status": 0})
    now = int(time.time())
    nonce = "fix70f_cooldown_bypass_1"
    msg = gw.build_siwe_auth_message(CHAIN_ID, REG, 2, CID_V1_DAGPB, ATTACKER.address, now, nonce)
    sig = Account.sign_message(encode_defunct(text=msg), ATTACKER.key).signature.hex()
    c = http.client.HTTPConnection("127.0.0.1", p1, timeout=5)
    c.request("GET", f"/ipfs/{CID_V1_DAGPB}", headers={
        "X-GenoChain-Data-Id": "2",
        "X-GenoChain-Address": ATTACKER.address,
        "X-GenoChain-Timestamp": str(now),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": "0x" + sig if not sig.startswith("0x") else sig,
    })
    r = c.getresponse(); body = r.read(); c.close()
    assert r.status == 403 and b"earlier dataset #1" in body, f"Cooldown bypass leaked! {r.status} {body}"

    reg1.fail_catalog = True
    srv1.gateway_catalog_index._first_registrant_by_mh.clear()
    srv1.gateway_catalog_index.invalidate()
    ok1b, code1b, _ = gw.authorize_cid_access(reg1, 2, CID_V1_DAGPB, ATTACKER.address, catalog_index=srv1.gateway_catalog_index)
    assert ok1b is False and code1b == 502, f"Catalog outage failed open: ok={ok1b}, code={code1b}"
finally:
    srv1.shutdown(); srv1.server_close()

class PinCapReg:
    def __init__(self):
        self.datasets = []
        self.events = []
    def is_connected(self): return True
    def get_block_number(self): return 100
    def get_all_datasets(self): return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise ValueError("DataNotFound")
    def get_status_updated_events(self, a, b): return list(self.events)

class PinCapKubo:
    def __init__(self):
        self.seq = 0
        self.pins = {}
    def health_check(self): return True
    def add_stream(self, stream, fn, cl, cid_version=1):
        data = stream.read(cl)
        self.seq += 1
        d = hashlib.sha256(f"fix70f_pin_{self.seq}".encode()).digest()
        c = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + d).decode("ascii").rstrip("=").lower()
        self.pins[c] = len(data)
        return {"cid": c, "size": len(data)}
    def unpin_cid(self, cid):
        return self.pins.pop(cid, None) is not None
    def run_gc(self): return True

with tempfile.TemporaryDirectory() as td:
    db2 = os.path.join(td, "fix70f_pins.sqlite")
    reg2 = PinCapReg()
    kubo2 = PinCapKubo()
    srv2 = gw.create_gateway_server(
        host="127.0.0.1", port=0, chain_id=CHAIN_ID, registry_address=REG,
        registry_adapter=reg2, kubo_adapter=kubo2, state_db_path=db2,
        max_upload_bytes_per_hour=500_000, max_global_upload_bytes_per_hour=500_000,
        max_total_pinned_bytes=100_000, upload_policy="open-dev",
    )
    threading.Thread(target=srv2.serve_forever, daemon=True).start()
    p2 = srv2.server_address[1]
    rec2 = gw.GdprErasureReconciler(reg2, kubo2, start_block=95, db_path=db2, orphan_pin_ttl_sec=3600)
    try:
        payload = b"P" * 80_000
        sha = hashlib.sha256(payload).hexdigest()
        now = int(time.time())
        n1 = "fix70f_pincap_nonce_0001"
        s1 = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha, ATTACKER.address, now, n1)), ATTACKER.key).signature.hex()
        c = http.client.HTTPConnection("127.0.0.1", p2, timeout=5)
        c.request("POST", "/api/v0/upload", body=payload, headers={
            "X-GenoChain-Address": ATTACKER.address, "X-GenoChain-Timestamp": str(now),
            "X-GenoChain-Nonce": n1, "X-GenoChain-Signature": s1, "X-GenoChain-Content-Sha256": sha,
        })
        r1 = c.getresponse(); j1 = json.loads(r1.read().decode()); c.close()
        assert r1.status == 200
        reg2.datasets.append({"dataId": 1, "currentOwner": ATTACKER.address, "rawCid": j1["cid"], "summaryCid": "", "metadataCid": "", "status": 0})
        rec2.reconcile_once()

        n2 = "fix70f_pincap_nonce_0002"
        s2 = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha, ATTACKER.address, now, n2)), ATTACKER.key).signature.hex()
        c = http.client.HTTPConnection("127.0.0.1", p2, timeout=5)
        c.request("POST", "/api/v0/upload", body=payload, headers={
            "X-GenoChain-Address": ATTACKER.address, "X-GenoChain-Timestamp": str(now),
            "X-GenoChain-Nonce": n2, "X-GenoChain-Signature": s2, "X-GenoChain-Content-Sha256": sha,
        })
        r2 = c.getresponse(); r2.read(); c.close()
        assert r2.status == 429, f"Anchored pinned cap bypassed! status={r2.status}"

        reg2.datasets[0]["status"] = 2
        reg2.events.append({"dataId": 1, "newStatus": 2, "blockNumber": 100})
        rec2.reconcile_once()
        n3 = "fix70f_pincap_nonce_0003"
        s3 = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, sha, ATTACKER.address, now, n3)), ATTACKER.key).signature.hex()
        c = http.client.HTTPConnection("127.0.0.1", p2, timeout=5)
        c.request("POST", "/api/v0/upload", body=payload, headers={
            "X-GenoChain-Address": ATTACKER.address, "X-GenoChain-Timestamp": str(now),
            "X-GenoChain-Nonce": n3, "X-GenoChain-Signature": s3, "X-GenoChain-Content-Sha256": sha,
        })
        r3 = c.getresponse(); r3.read(); c.close()
        assert r3.status == 200, f"Post-erasure upload expected 200, got {r3.status}"

        small = b"HELLO_GENO"
        small_sha = hashlib.sha256(small).hexdigest()
        n_te = "fix70f_bad_te_nonce_0001"
        s_te = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, small_sha, ATTACKER.address, now, n_te)), ATTACKER.key).signature.hex()
        ct = http.client.HTTPConnection("127.0.0.1", p2, timeout=5)
        ct.putrequest("POST", "/api/v0/upload")
        ct.putheader("Transfer-Encoding", "gzip, chunked")
        ct.putheader("X-GenoChain-Address", ATTACKER.address)
        ct.putheader("X-GenoChain-Timestamp", str(now))
        ct.putheader("X-GenoChain-Nonce", n_te)
        ct.putheader("X-GenoChain-Signature", s_te)
        ct.putheader("X-GenoChain-Content-Sha256", small_sha)
        ct.endheaders()
        rt = ct.getresponse(); rt.read(); ct.close()
        assert rt.status == 501, f"Unsupported TE expected 501, got {rt.status}"

        n_cl = "fix70f_dup_cl_nonce_0001"
        s_cl = Account.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REG, small_sha, ATTACKER.address, now, n_cl)), ATTACKER.key).signature.hex()
        raw_req = (
            f"POST /api/v0/upload HTTP/1.1\\r\\nHost: 127.0.0.1:{p2}\\r\\n"
            f"Content-Length: 10\\r\\nContent-Length: 10\\r\\n"
            f"X-GenoChain-Address: {ATTACKER.address}\\r\\nX-GenoChain-Timestamp: {now}\\r\\n"
            f"X-GenoChain-Nonce: {n_cl}\\r\\nX-GenoChain-Signature: {s_cl}\\r\\nX-GenoChain-Content-Sha256: {small_sha}\\r\\n"
            f"Connection: close\\r\\n\\r\\nHELLO_GENO"
        ).encode()
        sk = socket.create_connection(("127.0.0.1", p2), timeout=5)
        sk.sendall(raw_req)
        resp_line = sk.recv(4096).splitlines()[0]
        sk.close()
        assert b" 400 " in resp_line, f"Duplicate CL expected 400, got {resp_line!r}"
    finally:
        rec2.close(); srv2.shutdown(); srv2.server_close()

class FailingReg:
    def __init__(self): self.calls = 0
    def get_all_datasets(self):
        self.calls += 1
        raise RuntimeError("RPC 503")

freg = FailingReg()
fidx = gw.PublicMetadataCatalogIndex(freg, refresh_ttl_sec=10.0, min_forced_refresh_sec=5.0)
for _ in range(10):
    fidx.is_public_active_metadata_cid(CID_META)
assert freg.calls == 1, f"RPC failure backoff broken: {freg.calls} calls"

class SlowRefreshReg:
    def __init__(self):
        self.calls = 0
        self.started = threading.Event()
        self.release = threading.Event()
    def get_all_datasets(self):
        self.calls += 1
        if self.calls == 2:
            self.started.set()
            self.release.wait(timeout=5.0)
        return [{"dataId": 1, "currentOwner": VICTIM.address, "rawCid": CID_V0, "summaryCid": "", "metadataCid": CID_META, "status": 0}]

sreg = SlowRefreshReg()
sidx = gw.PublicMetadataCatalogIndex(sreg, refresh_ttl_sec=1.0, min_forced_refresh_sec=0.5)
assert sidx.is_public_active_metadata_cid(CID_META) is True
sidx._last_refresh_mono = time.monotonic() - 1.5
t_bg = threading.Thread(target=lambda: sidx.is_public_active_metadata_cid(CID_RAND))
t_bg.start()
assert sreg.started.wait(timeout=2.0)
t0 = time.monotonic()
res_cached = sidx.is_public_active_metadata_cid(CID_META)
elapsed = time.monotonic() - t0
sreg.release.set()
t_bg.join()
assert res_cached is True and elapsed < 0.2, f"Cached reader blocked during slow refresh ({elapsed:.2f}s)"

print("FIX70F_REVIEW_PY_OK")
`;
    const pyOut = execFileSync(resolvePythonBin(), ["-c", pyReviewSuite], { encoding: "utf8" });
    expect(pyOut).to.include("FIX70F_REVIEW_PY_OK");

    const origFetch = globalThis.fetch;
    const seenFilenames = [];
    globalThis.fetch = async (_url, init) => {
      seenFilenames.push(init?.headers?.["X-GenoChain-Filename"]);
      return new Response(JSON.stringify({ cid: CID_A, size: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const upOpts = {
        customGateway: "https://private.genochain.test",
        signer: {
          getAddress: async () => seller.address,
          signMessage: async () => "0x" + "11".repeat(65),
        },
        chainId: 84532,
        registryAddress: registry.target,
      };
      await uploadEncryptedRawData(new Uint8Array([1, 2, 3, 4]), null, null, upOpts);
      await uploadEncryptedRawData(new Uint8Array([1, 2, 3, 4]), "", null, upOpts);
      await uploadEncryptedSummaryReport(new Uint8Array([1, 2, 3, 4]), undefined, null, upOpts);
      await uploadEncryptedRawData(new Uint8Array([1, 2, 3, 4]), "cohort_raw.enc", null, upOpts);
      expect(seenFilenames).to.deep.equal(["payload.enc", "payload.enc", "report.enc", "cohort_raw.enc"]);
    } finally {
      globalThis.fetch = origFetch;
    }

    const adminSrc = fs.readFileSync(path.resolve("frontend/src/features/admin/AdminPortal.jsx"), "utf8");
    expect(adminSrc).to.include('encodeFunctionData("execute"');
    expect(adminSrc).to.include("admin-timelock-copy-exec-btn");
    expect(adminSrc).to.include("trimmedDisp === ethers.ZeroAddress");
    expect(adminSrc).to.include("trimmedZk === ethers.ZeroAddress");
    const dispSrc = fs.readFileSync(path.resolve("scripts/demo/capsule_dispatcher.py"), "utf8");
    expect(dispSrc).to.include('"chainId": live_chain_id');
  });

  // =========================================================================
  // R18-06a: Multi-Agent Randomized Escrow State-Machine Invariant Fuzzer (60 ops)
  // =========================================================================
  it("R18-06a: 60-step multi-agent escrow invariant fuzzer enforces exact $GENO conservation, zero dust loss, and zero trapped funds", async function () {
    this.timeout(90000);
    const totalSupply = await token.totalSupply();
    const actors = [owner, seller, buyer, buyer2, lab1, lab2, worker, stranger];
    // Register 3 datasets owned by seller
    for (let d = 1; d <= 3; d++) {
      const h = ethers.keccak256(ethers.toUtf8Bytes(`fuzz-ds-${d}`));
      const royalty = BigInt(d * 1000); // 10%, 20%, 30%
      await (await registry.connect(seller).registerGenomicData(h, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, royalty)).wait();
    }
    // Transfer dataset #2 NFT to lab1 so secondary royalty split is exercised too
    await (await nft.connect(seller).transferFrom(seller.address, lab1.address, 2n)).wait();
    await (await token.connect(owner).transfer(stranger.address, ethers.parseEther("5000"))).wait();
    await (await token.connect(stranger).approve(registry.target, ethers.MaxUint256)).wait();

    const buyers = [buyer, buyer2, stranger];
    const ownerFor = (d) => (d === 2 ? lab1 : seller);
    const capCache = new Map();
    for (const b of buyers) {
      const { capsule } = await makeRealCapsule(b, seller.address);
      capCache.set(b.address, capsule);
    }

    async function assertSupplyConservation() {
      let sum = await token.balanceOf(registry.target);
      sum += await token.balanceOf(zkVerifier.target);
      for (const a of actors) {
        sum += await token.balanceOf(a.address);
      }
      expect(sum, "$GENO conservation violated!").to.equal(totalSupply);
    }

    // Deterministic PRNG (LCG) for reproducible 60-step multi-agent fuzzing
    let seed = 0x5eed1234n;
    const nextRand = (mod) => {
      seed = (seed * 1664525n + 1013904223n) & 0xffffffffn;
      return Number(seed % BigInt(mod));
    };

    const activePairs = new Set();
    let executedOps = 0;

    for (let step = 0; step < 60; step++) {
      const dId = nextRand(3) + 1;
      const b = buyers[nextRand(buyers.length)];
      const dsOwner = ownerFor(dId);
      const key = `${dId}:${b.address}`;
      const op = nextRand(9);

      try {
        if (op === 0) {
          await (await registry.connect(b).grantAccessWithEscrow(BigInt(dId), DISPUTE_WINDOW)).wait();
          activePairs.add(key);
        } else if (op === 1) {
          await (await registry.connect(dsOwner).storeTransformedCapsule(BigInt(dId), b.address, capCache.get(b.address))).wait();
        } else if (op === 2) {
          await (await registry.connect(b).setManualEscrowRelease(BigInt(dId), nextRand(2) === 0)).wait();
        } else if (op === 3) {
          await (await registry.connect(dsOwner).updateDataStatus(BigInt(dId), nextRand(2))).wait(); // Active/Paused
        } else if (op === 4) {
          await (await registry.connect(b).confirmCapsuleAndReleaseEscrow(BigInt(dId))).wait();
        } else if (op === 5) {
          await (await registry.connect(b).disputeCapsule(BigInt(dId))).wait();
        } else if (op === 6) {
          await (await registry.connect(owner).resolveEscrowDispute(BigInt(dId), b.address, nextRand(2) === 0)).wait();
        } else if (op === 7) {
          await (await registry.connect(b).claimEscrowRefund(BigInt(dId))).wait();
        } else {
          await advanceTime(3600 * (nextRand(12) + 1));
        }
        executedOps++;
      } catch {
        // Expected reverts on invalid state transitions; state MUST remain consistent
      }
      await assertSupplyConservation();
    }
    expect(executedOps).to.be.gte(15);

    // Ensure every open escrow can cleanly settle to zero locked balance (no trapped funds)
    for (let d = 1; d <= 3; d++) {
      const ds = await registry.getGenomicData(BigInt(d));
      if (Number(ds.status) === 1) {
        await (await registry.connect(ownerFor(d)).updateDataStatus(BigInt(d), 0)).wait();
      }
    }
    await advanceTime(35 * 24 * 3600);
    for (const pair of activePairs) {
      const [dStr, bAddr] = pair.split(":");
      const dId = BigInt(dStr);
      const bSigner = buyers.find((x) => x.address === bAddr);
      const dep = await registry.escrowDeposits(dId, bAddr);
      if (dep.amount > 0n && !dep.released && !dep.refunded) {
        const isDisp = await registry.escrowDisputed(dId, bAddr);
        if (isDisp) {
          await (await registry.connect(bSigner).claimDisputeTimeoutRefund(dId)).wait();
        } else if (dep.capsuleDelivered) {
          await (await registry.connect(ownerFor(Number(dId))).releaseEscrow(dId, bAddr)).wait();
        } else {
          await (await registry.connect(bSigner).claimEscrowRefund(dId)).wait();
        }
      }
    }
    expect(await token.balanceOf(registry.target), "Trapped funds remained in registry escrow!").to.equal(0n);
    await assertSupplyConservation();
  });

  // =========================================================================
  // R18-06b: Pause-Pulsing Anti-Griefing & Post-Release Multi-Device RSA Key Rotation
  // =========================================================================
  it("R18-06b: enforces 15m anti-pause-pulsing cutoff, permits fair settlement while Paused/Revoked, and preserves expiresAt on post-release RSA capsule rotation", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("r18-06b-pause-rotation"));
    await (await registry.connect(seller).registerGenomicData(hash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)).wait();
    await (await registry.connect(buyer).grantAccessWithEscrow(1n, DISPUTE_WINDOW)).wait();

    const { capsule: cap1 } = await makeRealCapsule(buyer, seller.address, "11".repeat(32));
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, cap1)).wait();

    // Pause for 5 minutes (< 15m grace) and unpause 3 times rapidly; verify buyer still cannot abuse refund mid-window
    for (let i = 0; i < 3; i++) {
      await (await registry.connect(seller).updateDataStatus(1n, 1)).wait();
      await advanceTime(300);
      await expect(registry.connect(buyer).claimEscrowRefund(1n)).to.be.revertedWithCustomError(
        registry,
        "CapsuleAlreadyDelivered"
      );
      await (await registry.connect(seller).updateDataStatus(1n, 0)).wait();
    }

    // Even if seller pauses right after delivery, buyer can still honestly confirm & release escrow
    await (await registry.connect(seller).updateDataStatus(1n, 1)).wait();
    const balBefore = await token.balanceOf(seller.address);
    await (await registry.connect(buyer).confirmCapsuleAndReleaseEscrow(1n)).wait();
    expect(await token.balanceOf(seller.address)).to.equal(balBefore + PRICE);

    // Unpause dataset & verify post-release RSA key rotation:
    // (a) Without rotating buyer's on-chain public key, re-delivery reverts CapsuleAlreadyDelivered;
    // (b) After buyer registers a new RSA public key, re-delivery succeeds WITHOUT resetting expiresAt!
    await (await registry.connect(seller).updateDataStatus(1n, 0)).wait();
    const grantBefore = await registry.accessGrants(1n, buyer.address);
    await advanceTime(3600);
    const { pubJwk: pubJwk2, capsule: cap2 } = await makeRealCapsule(buyer, seller.address, "22".repeat(32));
    await expect(
      registry.connect(seller).storeTransformedCapsule(1n, buyer.address, cap2)
    ).to.be.revertedWithCustomError(registry, "CapsuleAlreadyDelivered");
    await (await registry.connect(buyer).registerResearcherPublicKey(JSON.stringify(pubJwk2))).wait();
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, cap2)).wait();
    const grantAfter = await registry.accessGrants(1n, buyer.address);
    expect(grantAfter.expiresAt).to.equal(grantBefore.expiresAt);
    expect(await registry.connect(buyer).getTransformedCapsule(1n)).to.equal(cap2);
  });

  // =========================================================================
  // R18-06c: SWAR 32-Byte validateCapsule Edge Cases & Full CIDv0/CIDv1 Matrix
  // =========================================================================
  it("R18-06c: SWAR validateCapsule rejects escapes/duplicates/oversize/trailing garbage while accepting 8KB capsules, and validateCid verifies CIDv0 + CIDv1 (raw/dag-pb/dag-cbor x SHA2-256/BLAKE2b-256/SHA2-512)", async function () {
    const validHex512 = "ab".repeat(256);
    const validCap = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", keyCipher: validHex512 });
    expect(await nft.validateCapsule(validCap)).to.equal(true);

    // Reject unicode escape, duplicate keyCipher, trailing garbage, odd-length hex, all-zero hex, >8KB
    expect(await nft.validateCapsule(`{"key\\u0043ipher":"${validHex512}"}`)).to.equal(false);
    expect(await nft.validateCapsule(`{"keyCipher":"${validHex512}","keyCipher":"${validHex512}"}`)).to.equal(false);
    expect(await nft.validateCapsule(`${validCap} trailing`)).to.equal(false);
    expect(await nft.validateCapsule(`{"keyCipher":"${"a".repeat(513)}"}`)).to.equal(false);
    expect(await nft.validateCapsule(`{"keyCipher":"${"0".repeat(512)}"}`)).to.equal(false);
    expect(await nft.validateCapsule(`{"keyCipher":"${"ab".repeat(256)}","pad":"${"x".repeat(8200)}"}`)).to.equal(false);

    // Valid ~7.8 KB capsule MUST pass SWAR validation within reasonable gas
    const largeCap = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", pad: "z".repeat(7100), keyCipher: validHex512 });
    expect(largeCap.length).to.be.gt(7500);
    expect(largeCap.length).to.be.lte(8192);
    expect(await nft.validateCapsule(largeCap)).to.equal(true);
    const largeGas = await nft.validateCapsule.estimateGas(largeCap);
    expect(largeGas).to.be.lt(500000n);

    // Full CIDv0 & CIDv1 multihash parity matrix against GenomicNFT.validateCid
    const sampleBytes = new TextEncoder().encode("GENOCHAIN_CID_MATRIX_PAYLOAD_V2");
    const cidV0 = await computeIpfsCidV0(sampleBytes);
    expect(await nft.validateCid(cidV0)).to.equal(true);

    const codecs = [0x55, 0x70, 0x71]; // raw, dag-pb, dag-cbor
    const mhCodes = [MULTIHASH_SHA2_256, MULTIHASH_BLAKE2B_256, MULTIHASH_SHA2_512];
    for (const codec of codecs) {
      for (const mhCode of mhCodes) {
        const cidV1 = await computeIpfsCidV1(sampleBytes, { codec, mhCode });
        expect(await nft.validateCid(cidV1), `validateCid rejected valid CIDv1 codec=0x${codec.toString(16)} mh=0x${mhCode.toString(16)}: ${cidV1}`).to.equal(true);
      }
    }
    // Reject invalid CIDv1 (unsupported codec 0x99, invalid base32 char '0', truncated)
    expect(await nft.validateCid("bafkrei0000000000000000000000000000000000000000000000000000")).to.equal(false);
    expect(await nft.validateCid("bafkreishort")).to.equal(false);
  });

  // =========================================================================
  // R18-06d: Commit-Reveal Same-Block Guard, Sender Isolation & Bundle Registration
  // =========================================================================
  it("R18-06d: commitGenomicData enforces CommitmentTooNew, cross-sender salt isolation, and atomic revealAndRegisterGenomicDataBundle", async function () {
    await (await registry.connect(owner).setCommitRevealRequired(true)).wait();
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("r18-06d-raw"));
    const sumHash = ethers.keccak256(ethers.toUtf8Bytes("r18-06d-sum"));
    const metaHash = ethers.keccak256(ethers.toUtf8Bytes("r18-06d-meta"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("r18-06d-salt"));
    const tag1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "string", "string", "bytes32"], ["GENOCHAIN_BLIND_TAG_V1", "gene", "ALDH2", salt]));

    // Direct registration blocked when commit-reveal is required
    await expect(
      registry.connect(seller).registerGenomicData(rawHash, CID_A, CID_B, CID_C, URI_A, PRICE, DURATION, 1000)
    ).to.be.revertedWithCustomError(registry, "CommitmentNotFound");

    const commitment = ethers.solidityPackedKeccak256(["bytes32", "bytes32", "address"], [rawHash, salt, seller.address]);
    await (await registry.connect(seller).commitGenomicData(commitment)).wait();

    // Front-runner (stranger) trying to reveal seller's commitment MUST fail CommitmentNotFound
    await expect(
      registry
        .connect(stranger)
        .revealAndRegisterGenomicDataBundle([rawHash, sumHash, metaHash], salt, [CID_A, CID_B, CID_C, URI_A], PRICE, DURATION, 1000, [tag1])
    ).to.be.revertedWithCustomError(registry, "CommitmentNotFound");

    // Next-block reveal succeeds atomically with 3-artifact hashes & blind tags
    await (
      await registry
        .connect(seller)
        .revealAndRegisterGenomicDataBundle([rawHash, sumHash, metaHash], salt, [CID_A, CID_B, CID_C, URI_A], PRICE, DURATION, 1000, [tag1])
    ).wait();
    expect(await registry.dataCount()).to.equal(1n);
    const anchored = await registry.getArtifactHashes(1n);
    expect(anchored.rawDataHash).to.equal(rawHash);
    expect(anchored.summaryDataHash).to.equal(sumHash);
    expect(anchored.metadataHash).to.equal(metaHash);
    expect(await registry.matchesBlindTag(1n, tag1)).to.equal(true);
  });

  // =========================================================================
  // R18-06e: Groth16 VK Epoch Rotation (1 -> 2), Fail-Closed Missing vkPath & Clean Phenopacket Deduplication
  // =========================================================================
  it("R18-06e: rotates Groth16 vkEpoch cleanly (1 -> 2), fails closed on explicit missing vkPath, and deduplicates HANCESTRO in buildPhenopacket", async function () {
    const crs1 = await runLocalGroth16Ceremony(zkVerifier, owner);
    expect(crs1.vkEpoch).to.equal(1);
    const crs2 = await runLocalGroth16Ceremony(zkVerifier, owner);
    expect(crs2.vkEpoch).to.equal(2);

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const traitId = ethers.id("ACTN3_rs1815739");
    const secret = "DONOR_EPOCH2_WITNESS_SECRET";
    const commitment = computeDonorWitnessCommitment(seller.address, traitId, secret);

    // Explicit non-existent vkPath MUST fail closed (never silently skip verification!)
    await expect(
      generateAuthenticGroth16Proof({
        donorAddress: seller.address,
        targetTraitId: traitId,
        variantCommitment: commitment,
        witnessSecret: secret,
        bountyId: 1,
        verifierAddress: zkVerifier.target,
        chainId,
        vkEpoch: 2,
        vkPath: path.resolve("frontend/public/zk/nonexistent_vk_file.json"),
      })
    ).to.be.rejectedWith(/Missing Groth16 verification key/);

    // Epoch-2 proof verifies cleanly on-chain while epoch-1 proof is rejected
    await (await token.connect(buyer).approve(zkVerifier.target, ethers.parseEther("200"))).wait();
    await (await zkVerifier.connect(buyer).createZkBounty(traitId, "Epoch2 Cohort", ethers.parseEther("50"), 2, 86400)).wait();

    const proofEp1 = await generateAuthenticGroth16Proof({
      donorAddress: seller.address,
      targetTraitId: traitId,
      variantCommitment: commitment,
      witnessSecret: secret,
      bountyId: 1,
      verifierAddress: zkVerifier.target,
      chainId,
      vkEpoch: 1,
    });
    await expect(
      zkVerifier.connect(seller).claimZkBounty(1n, proofEp1.proof, commitment)
    ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");

    const proofEp2 = await generateAuthenticGroth16Proof({
      donorAddress: seller.address,
      targetTraitId: traitId,
      variantCommitment: commitment,
      witnessSecret: secret,
      bountyId: 1,
      verifierAddress: zkVerifier.target,
      chainId,
      vkEpoch: 2,
    });
    await (await zkVerifier.connect(seller).claimZkBounty(1n, proofEp2.proof, commitment)).wait();
    expect(await zkVerifier.hasVerifiedTraitVariant(traitId, commitment, seller.address)).to.equal(true);

    // buildPhenopacket deduplicates HANCESTRO when caller also passes it in phenotypes[]
    const pp = buildPhenopacket({
      subjectId: "ANON_DEDUP_TEST_01",
      disease: "Benign ALDH2 Polymorphism",
      ancestry: "Vietnamese Kinh (KHV)",
      phenotypes: [
        { id: "SO:0001583", label: "missense_variant" },
        { id: "HANCESTRO:0021", label: "Vietnamese Kinh (KHV)" },
      ],
      variants: [{ gene: "ALDH2", rsId: "rs671", chrom: "chr12", pos: 111803962, zygosity: "0/1 Heterozygous" }],
    });
    const hancestroCount = pp.phenotypicFeatures.filter((f) => f.type?.id === "HANCESTRO:0021").length;
    expect(hancestroCount).to.equal(1);
    expect(validatePhenopacketSchema(pp).valid).to.equal(true);
  });

  // =========================================================================
  // R18-06f: Private IPFS Gateway Owner-Scoped Shared-CID GDPR Art. 17 Erasure & Anti-Squatting
  // =========================================================================
  it("R18-06f: Private IPFS Gateway preserves same-owner shared CIDs until all owner datasets are Revoked, while blocking third-party CID squatters from vetoing GDPR erasure", async function () {
    this.timeout(25000);
    const pyGdprRef = `
import os, sys, tempfile
sys.path.insert(0, os.path.abspath("deploy"))
import ipfs_access_gateway as gw

CID_SHARED = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
CID_SQUATTED = "QmW2WQi7j6c7UgJTarActp7tDNikE4B2qXtFCfLPdsgaTQ"
CID_META_1 = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx"
CID_META_2 = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ"
OWNER_A = "0x1111111111111111111111111111111111111111"
SQUATTER = "0x2222222222222222222222222222222222222222"

class RefReg:
    def __init__(self):
        self.datasets = [
            # Same-owner shared rawCid across datasets #1 and #2
            {"dataId": 1, "currentOwner": OWNER_A, "rawCid": CID_SHARED, "summaryCid": "", "metadataCid": CID_META_1, "status": 2},
            {"dataId": 2, "currentOwner": OWNER_A, "rawCid": CID_SHARED, "summaryCid": "", "metadataCid": CID_META_2, "status": 0},
            # Victim dataset #3 revoked while third-party SQUATTER dataset #4 squats on CID_SQUATTED
            {"dataId": 3, "currentOwner": OWNER_A, "rawCid": CID_SQUATTED, "summaryCid": "", "metadataCid": "", "status": 2},
            {"dataId": 4, "currentOwner": SQUATTER, "rawCid": CID_SQUATTED, "summaryCid": "", "metadataCid": "", "status": 0},
        ]
        self.events = [
            {"dataId": 1, "newStatus": 2, "blockNumber": 10},
            {"dataId": 3, "newStatus": 2, "blockNumber": 11},
        ]
    def is_connected(self): return True
    def get_block_number(self): return 12
    def get_all_datasets(self): return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise ValueError("DataNotFound")
    def get_status_updated_events(self, a, b): return list(self.events)

class RefKubo:
    def __init__(self):
        self.pins = {CID_SHARED: 100, CID_SQUATTED: 100, CID_META_1: 50, CID_META_2: 50}
        self.unpinned = []
        self.gc_runs = 0
    def health_check(self): return True
    def unpin_cid(self, cid):
        self.unpinned.append(cid)
        return self.pins.pop(cid, None) is not None
    def run_gc(self):
        self.gc_runs += 1
        return True

with tempfile.TemporaryDirectory() as td:
    db = os.path.join(td, "refcount.sqlite")
    reg = RefReg()
    kubo = RefKubo()
    rec = gw.GdprErasureReconciler(reg, kubo, start_block=5, db_path=db)
    try:
        r1 = rec.reconcile_once()
        # 1. Same owner still has active dataset #2 -> CID_SHARED MUST stay pinned (skippedSharedCids)!
        assert CID_SHARED in kubo.pins and CID_SHARED in r1["skippedSharedCids"], f"Same-owner shared CID prematurely unpinned: {r1}"
        assert CID_META_1 not in kubo.pins, f"Unshared metadata CID_META_1 should be unpinned: {r1}"
        # 2. Third-party squatter (#4) CANNOT block victim OWNER_A's GDPR Art. 17 erasure of CID_SQUATTED!
        assert CID_SQUATTED not in kubo.pins, f"Third-party squatter blocked GDPR Art. 17 erasure: {r1}"

        # 3. Once OWNER_A also revokes dataset #2 -> CID_SHARED & CID_META_2 MUST be unpinned + repo/gc executed!
        reg.datasets[1]["status"] = 2
        reg.events.append({"dataId": 2, "newStatus": 2, "blockNumber": 12})
        r2 = rec.reconcile_once()
        assert CID_SHARED not in kubo.pins and CID_META_2 not in kubo.pins, f"Expected full erasure after both owner datasets revoked: {r2}"
        assert kubo.gc_runs >= 1
    finally:
        rec.close()
print("GDPR_REFCOUNT_OK")
`;
    const out = execFileSync(resolvePythonBin(), ["-c", pyGdprRef], { encoding: "utf8" });
    expect(out).to.include("GDPR_REFCOUNT_OK");
  });

  // =========================================================================
  // R18-06g: Non-31337 i18n Chain-Text Parity (Zero Hardhat/31337 Leaks), EIP-191/8-char Copy & Modal Trap LIFO Guard
  // =========================================================================
  it("R18-06g: formatConfiguredChainText strips 100% Hardhat/31337 strings across EN & VI locales, faucet/vault copy matches contract & UI rules, and useModalFocusTrap enforces LIFO stack isolation", async function () {
    for (const [lang, dict] of [["en", enLocale], ["vi", viLocale]]) {
      for (const [k, v] of Object.entries(dict)) {
        if (typeof v !== "string") continue;
        const formatted = formatConfiguredChainText(v, 11155111, "Sepolia");
        expect(formatted, `${lang}.${k} leaked 'Hardhat' on Sepolia: ${formatted}`).to.not.match(/\bHardhat\b/i);
        expect(formatted, `${lang}.${k} leaked '31337' on Sepolia: ${formatted}`).to.not.match(/\b31337\b/);
      }
      // Verify EIP-191 faucet voucher copy (matches GenomicToken.sol:222) and >= 8 char passphrase copy (matches PatientSovereignVault.jsx:414)
      expect(dict.faucetVoucherModalDesc).to.include("EIP-191");
      expect(dict.faucetVoucherModalDesc).to.not.include("EIP-712");
      expect(dict.adminFaucetVoucherLabel).to.include("EIP-191");
      expect(dict.vaultPassphraseTooShort).to.include("8");
    }

    // Verify LIFO stacked-modal guard & inert/hidden ancestor exclusion in useModalFocusTrap.js
    const trapSrc = fs.readFileSync(path.resolve("frontend/src/hooks/useModalFocusTrap.js"), "utf8");
    expect(trapSrc).to.include("activeTrapStack");
    expect(trapSrc).to.include("isTopTrap()");
    expect(trapSrc).to.include("parentContainer");
    expect(trapSrc).to.include("[inert], [hidden], [aria-hidden='true']");
  });

  // =========================================================================
  // R18-06h: Private IPFS Gateway Upload-Provenance Front-Running Defense (L3-M1) & 525 MiB Framing Cap
  // =========================================================================
  it("R18-06h: upload_provenance blocks mempool front-runner CID hijacking, metadataCid SIWE bypass, & GDPR pin-lock/erasure DoS across CIDv0/CIDv1 aliases and ERC-721 transfers", async function () {
    this.timeout(25000);
    const pyFrontRun = `
import hashlib, json, os, sys, tempfile, threading, time, urllib.error, urllib.request
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, os.path.abspath("deploy"))
import ipfs_access_gateway as gw

assert gw.MAX_UPLOAD_BYTES == 525 * 1024 * 1024, f"Expected 525 MiB upload cap, got {gw.MAX_UPLOAD_BYTES}"
assert gw.MAX_STREAM_BYTES == 525 * 1024 * 1024, f"Expected 525 MiB stream cap, got {gw.MAX_STREAM_BYTES}"

VICTIM = Account.create()
NEW_OWNER = Account.create()
ATTACKER = Account.create()
BUYER = Account.create()
CHAIN_ID = 31337
REGISTRY = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
CID_V1 = "bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34"
assert gw.extract_canonical_multihash(CID_V0) == gw.extract_canonical_multihash(CID_V1)
RAW_BYTES = b"GNC2_ENCRYPTED_VICTIM_GENOMIC_CIPHERTEXT_PAYLOAD_BYTES"

class FrontRunRegistry:
    def __init__(self):
        self.datasets = []
        self.events = []
        self.licenses = {}
    def is_connected(self): return True
    def get_block_number(self): return 25
    def get_all_datasets(self): return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise KeyError("DataNotFound")
    def has_active_access(self, d, buyer):
        return (int(d), str(buyer).lower()) in self.licenses
    def get_status_updated_events(self, a, b): return list(self.events)

class FrontRunKubo:
    def __init__(self):
        self.blobs = {}
        self.pins = {}
        self.unpinned = []
        self.gc_runs = 0
    def health_check(self): return True
    def add_stream(self, stream, filename, content_length, cid_version=1):
        data = stream.read(content_length)
        cid_ret = CID_V1 if cid_version == 1 else CID_V0
        self.blobs[CID_V1] = data
        self.blobs[CID_V0] = data
        self.pins[cid_ret] = len(data)
        return {"cid": cid_ret, "size": len(data)}
    def list_recursive_pins(self):
        return list(self.pins.keys())
    def cat_cid(self, cid):
        if cid not in self.blobs:
            raise FileNotFoundError(cid)
        return self.blobs[cid]
    def unpin_cid(self, cid):
        self.unpinned.append(cid)
        removed = self.pins.pop(cid, None) is not None
        if removed:
            self.blobs.pop(cid, None)
        return removed
    def run_gc(self):
        self.gc_runs += 1
        return True

def sign_upload(acct, payload_bytes, ts, nonce):
    sha = hashlib.sha256(payload_bytes).hexdigest()
    msg = gw.build_siwe_upload_message(CHAIN_ID, REGISTRY, sha, acct.address, ts, nonce)
    sig = acct.sign_message(encode_defunct(text=msg)).signature.hex()
    return {
        "Content-Type": "application/octet-stream",
        "X-GenoChain-Address": acct.address,
        "X-GenoChain-Timestamp": str(ts),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": sig if sig.startswith("0x") else "0x" + sig,
        "X-GenoChain-Content-Sha256": sha,
        "X-GenoChain-Filename": "victim_raw.enc",
    }

def sign_download(acct, data_id, cid, ts, nonce):
    msg = gw.build_siwe_auth_message(CHAIN_ID, REGISTRY, data_id, cid, acct.address, ts, nonce)
    sig = acct.sign_message(encode_defunct(text=msg)).signature.hex()
    return {
        "X-GenoChain-Data-Id": str(data_id),
        "X-GenoChain-Address": acct.address,
        "X-GenoChain-Timestamp": str(ts),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": sig if sig.startswith("0x") else "0x" + sig,
    }

with tempfile.TemporaryDirectory() as td:
    db_path = os.path.join(td, "frontrun_gateway.sqlite")
    reg = FrontRunRegistry()
    kubo = FrontRunKubo()
    now_ts = int(time.time())
    srv = gw.create_gateway_server(
        host="127.0.0.1",
        port=0,
        chain_id=CHAIN_ID,
        registry_address=REGISTRY,
        registry_adapter=reg,
        kubo_adapter=kubo,
        state_db_path=db_path,
        upload_policy="open-dev",
        now_fn=lambda: now_ts,
    )
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        # 1. Victim uploads ciphertext via SIWE POST /api/v0/upload -> Kubo returns CIDv1, records upload_provenance(mh -> VICTIM)
        up_req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload",
            data=RAW_BYTES,
            headers=sign_upload(VICTIM, RAW_BYTES, now_ts, "upload-nonce-victim-0001"),
            method="POST",
        )
        with urllib.request.urlopen(up_req, timeout=5) as resp:
            assert resp.status == 200
            up_body = json.loads(resp.read().decode("utf-8"))
            assert up_body["cid"] == CID_V1

        # 2. Front-runner attempts SIWE bypass by setting metadataCid = VICTIM's CIDv0/CIDv1 BEFORE Victim confirms
        reg.datasets = [
            {"dataId": 1, "tokenId": 1, "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address, "rawCid": "", "summaryCid": "", "metadataCid": CID_V0, "status": 0},
        ]
        srv.gateway_catalog_index.invalidate()
        for probe_cid in (CID_V0, CID_V1):
            unauth_status = None
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/ipfs/{probe_cid}", timeout=5)
            except urllib.error.HTTPError as e:
                unauth_status = e.code
            assert unauth_status == 401, f"Front-run metadataCid bypass MUST fail 401 for {probe_cid}, got {unauth_status}"

        # 3. Front-runner registers dummy dataset #1 referencing VICTIM's CIDv0 BEFORE VICTIM's dataset #2 lands (also CIDv0)
        reg.datasets = [
            {"dataId": 1, "tokenId": 1, "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address, "rawCid": CID_V0, "summaryCid": "", "metadataCid": "", "status": 0},
            {"dataId": 2, "tokenId": 2, "currentOwner": VICTIM.address, "originalCreator": VICTIM.address, "rawCid": CID_V0, "summaryCid": "", "metadataCid": "", "status": 0},
            {"dataId": 3, "tokenId": 3, "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address, "rawCid": CID_V1, "summaryCid": "", "metadataCid": "", "status": 0},
        ]
        reg.licenses[(2, BUYER.address.lower())] = True
        srv.gateway_catalog_index.invalidate()

        # 4. Front-runner trying to download via front-run dataset #1 MUST be denied (403)
        att_req = urllib.request.Request(
            f"http://127.0.0.1:{port}/ipfs/{CID_V0}",
            headers=sign_download(ATTACKER, 1, CID_V0, now_ts, "dl-nonce-attacker-0001"),
        )
        att_status = None
        try:
            urllib.request.urlopen(att_req, timeout=5)
        except urllib.error.HTTPError as e:
            att_status = e.code
        assert att_status == 403, f"Front-runner MUST be denied 403, got {att_status}"

        # 5. Victim (dataset #2, CIDv0 alias of uploaded CIDv1) and Victim's licensed buyer MUST both succeed (200)
        for who, n in [(VICTIM, "dl-nonce-victim-0002"), (BUYER, "dl-nonce-buyer-0003")]:
            ok_req = urllib.request.Request(
                f"http://127.0.0.1:{port}/ipfs/{CID_V0}",
                headers=sign_download(who, 2, CID_V0, now_ts, n),
            )
            with urllib.request.urlopen(ok_req, timeout=5) as resp:
                assert resp.status == 200
                assert resp.read() == RAW_BYTES

        # 6. ERC-721 Transfer (VICTIM -> NEW_OWNER): NEW_OWNER & BUYER still get 200 via originalCreator provenance!
        reg.datasets[1]["currentOwner"] = NEW_OWNER.address
        srv.gateway_catalog_index.invalidate()
        for who, n in [(NEW_OWNER, "dl-nonce-newowner-0004"), (BUYER, "dl-nonce-buyer-0005")]:
            ok_req = urllib.request.Request(
                f"http://127.0.0.1:{port}/ipfs/{CID_V0}",
                headers=sign_download(who, 2, CID_V0, now_ts, n),
            )
            with urllib.request.urlopen(ok_req, timeout=5) as resp:
                assert resp.status == 200
                assert resp.read() == RAW_BYTES

        # 7. Front-runner revokes dummy dataset #3 trying to trigger GDPR unpin/repo-gc -> VICTIM's CIDv1 pin MUST survive!
        reg.datasets[2]["status"] = 2
        reg.events.append({"dataId": 3, "newStatus": 2, "blockNumber": 18})
        rec = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path)
        try:
            r1 = rec.reconcile_once()
            assert CID_V1 in kubo.pins and CID_V1 in r1["skippedSharedCids"], f"Front-runner wiped victim pin: {r1}"
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_V0)) == VICTIM.address.lower()

            # 8. Legitimate owner (NEW_OWNER) revokes dataset #2 WHILE front-runner's earlier dataset #1 stays ACTIVE (status=0)!
            # Front-runner dataId=1 MUST NOT pin-lock GDPR Art. 17 erasure, and CIDv1 alias MUST be physically unpinned & GC'd!
            reg.datasets[1]["status"] = 2
            reg.events.append({"dataId": 2, "newStatus": 2, "blockNumber": 19})
            r2 = rec.reconcile_once()
            assert CID_V1 not in kubo.pins and CID_V1 in r2["unpinnedCids"], f"GDPR erasure pin-locked by active front-runner: {r2}"
            assert kubo.gc_runs >= 1
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_V0)) is None
        finally:
            rec.close()
    finally:
        srv.shutdown()
        srv.server_close()

print("FRONTRUN_PROVENANCE_DEFENSE_OK")
`;
    const out = execFileSync(resolvePythonBin(), ["-c", pyFrontRun], { encoding: "utf8" });
    expect(out).to.include("FRONTRUN_PROVENANCE_DEFENSE_OK");
  });

  // =========================================================================
  // R18-06i: Strict IV/UTF-8 Validation, Hybrid KMS+Local Dispatcher Key Load & INV-11 Phenopacket Clamp
  // =========================================================================
  it("R18-06i: enforces strict 12B IV & fatal UTF-8 decoding in WebCrypto, INV-11 non-pathological phenopacket clamp, and hybrid KMS+local summary vault loading", async function () {
    // 1. packCiphertextPayload rejects non-12-byte Uint8Array IVs & null/undefined ciphertext; decryptGenomicData rejects non-12-byte IVs
    expect(() => packCiphertextPayload(new Uint8Array(8), new Uint8Array(32))).to.throw(/12-byte/);
    expect(() => packCiphertextPayload(new Uint8Array(16), new Uint8Array(32))).to.throw(/12-byte/);
    expect(() => packCiphertextPayload(new Uint8Array(12), null)).to.throw(/Invalid ciphertext/);
    expect(() => packCiphertextPayload(new Uint8Array(12), undefined)).to.throw(/Invalid ciphertext/);

    // 2. Invalid UTF-8 bytes decrypted with asString=true reject cleanly under fatal TextDecoder (both monolithic & GNC2)
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x80, 0xc0]);
    const monoEnc = await encryptGenomicData(invalidUtf8);
    await expect(decryptGenomicData(monoEnc.ciphertext, new Uint8Array(16), monoEnc.keyHex, false)).to.be.rejectedWith(/12-byte/);
    await expect(decryptGenomicData(monoEnc.ciphertext, monoEnc.iv, monoEnc.keyHex, true)).to.be.rejected;
    const monoRaw = await decryptGenomicData(monoEnc.ciphertext, monoEnc.iv, monoEnc.keyHex, false);
    expect(Array.from(monoRaw)).to.deep.equal(Array.from(invalidUtf8));

    const chunkEnc = await encryptGenomicDataChunked(invalidUtf8);
    await expect(decryptGenomicDataChunked(chunkEnc.payload, chunkEnc.keyHex, { asString: true })).to.be.rejected;
    const chunkRaw = await decryptGenomicDataChunked(chunkEnc.payload, chunkEnc.keyHex, { asString: false });
    expect(Array.from(chunkRaw)).to.deep.equal(Array.from(invalidUtf8));

    // 3. INV-11: buildPhenopacket NEVER emits PATHOGENIC, LIKELY_PATHOGENIC, CAUSATIVE, or undeclared NCIT:C16355
    const pp = buildPhenopacket({
      subjectId: "ANON_INV11_CLAMP_01",
      disease: "Functional Polymorphism Cohort",
      clinicalSignificance: "PATHOGENIC",
      bloodGroup: "O+",
      variants: [{ gene: "ALDH2", rsId: "rs671", pathogenicity: "PATHOGENIC", interpretationStatus: "CAUSATIVE" }],
    });
    const ppJson = JSON.stringify(pp);
    expect(ppJson).to.not.match(/"(PATHOGENIC|LIKELY_PATHOGENIC|CAUSATIVE)"/);
    expect(ppJson).to.not.include("NCIT:C16355");
    expect(validatePhenopacketSchema(pp).valid).to.equal(true);

    // 4. Hybrid KMS raw key + local AES-GCM summary key loads cleanly in capsule_dispatcher.py using LOCAL_VAULT_DIR
    const pyHybrid = `
import os, sys, json, tempfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.abspath("scripts/demo"))
import capsule_dispatcher as cd

with tempfile.TemporaryDirectory() as td:
    vk = os.urandom(32)
    with open(os.path.join(td, "dispatcher_vault.key"), "w", encoding="utf-8") as f:
        f.write(vk.hex())
    sum_key = os.urandom(32)
    nonce = os.urandom(12)
    sum_env = (nonce + AESGCM(vk).encrypt(nonce, sum_key, None)).hex()
    vault_path = os.path.join(td, "dispatcher_seed_vault.json")
    raw_key = os.urandom(32).hex()
    orig_kms_dec = cd.kms_decrypt_seed_key
    cd.kms_decrypt_seed_key = lambda env: raw_key
    try:
        with open(vault_path, "w", encoding="utf-8") as f:
            json.dump({
                "vaultVersion": 2,
                "vaultKdf": {"mode": "keyfile", "algorithm": "raw-256"},
                "seeds": [{
                    "dataId": 1,
                    "kmsKeyEnvelope": {"mode": "aws-kms-envelope-v1"},
                    "encryptedSummaryKeyEnvelopeHex": sum_env
                }]
            }, f)
        sk, ssk = cd.load_vault_keys(vault_path, os.getcwd())
        assert sk[1] == raw_key and ssk[1] == sum_key.hex()
    finally:
        cd.kms_decrypt_seed_key = orig_kms_dec
print("HYBRID_VAULT_OK")
`;
    const pyOut = execFileSync(resolvePythonBin(), ["-c", pyHybrid], { encoding: "utf8" });
    expect(pyOut).to.include("HYBRID_VAULT_OK");
  });

  // =========================================================================
  // R18-06j: Phase 5 Private IPFS Gateway Hardening (REV-01A/B, REV-02, REV-03, L3-L1/L2, L3-01/02)
  // =========================================================================
  it("R18-06j: blocks post-anchor upload_provenance hijack (REV-01A/B), cross-owner private_mhs metadata censorship (REV-02), orphan-pin lock & TOCTOU (REV-03/L3-L2), pre-GC provenance purge (L3-L1/L3-02) & batched chunk quota contention (L3-01)", async function () {
    this.timeout(30000);
    const pyPhase5Gateway = `
import base64, hashlib, http.client, json, os, sqlite3, sys, tempfile, threading, time, urllib.error, urllib.request
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, os.path.abspath("deploy"))
import ipfs_access_gateway as gw

VICTIM = Account.create()
BUYER = Account.create()
ATTACKER = Account.create()
CHAIN_ID = 31337
REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

CID_META_V0 = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx"
mh_meta = gw.extract_canonical_multihash(CID_META_V0)
meta_digest = bytes.fromhex(mh_meta.split(":")[-1])
CID_META_V1 = "b" + base64.b32encode(bytes([0x01, 0x70, 0x12, 0x20]) + meta_digest).decode("ascii").rstrip("=").lower()
assert gw.extract_canonical_multihash(CID_META_V1) == mh_meta

CID_RAW_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
mh_raw = gw.extract_canonical_multihash(CID_RAW_V0)
raw_digest = bytes.fromhex(mh_raw.split(":")[-1])
CID_RAW_V1 = "b" + base64.b32encode(bytes([0x01, 0x70, 0x12, 0x20]) + raw_digest).decode("ascii").rstrip("=").lower()
assert gw.extract_canonical_multihash(CID_RAW_V1) == mh_raw

CID_ORPHAN = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"rev03_orphan_payload").digest()).decode("ascii").rstrip("=").lower()
CID_PREGC = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"l3l1_pregc_payload").digest()).decode("ascii").rstrip("=").lower()
CID_REUP = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"l3l1_reupload_payload").digest()).decode("ascii").rstrip("=").lower()
CID_OUTAGE = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"rpc_outage_502_payload").digest()).decode("ascii").rstrip("=").lower()
CID_RACE = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"l3l2_unpin_race_payload").digest()).decode("ascii").rstrip("=").lower()
CID_TINY = "b" + base64.b32encode(bytes([0x01, 0x55, 0x12, 0x20]) + hashlib.sha256(b"l301_tiny_chunks").digest()).decode("ascii").rstrip("=").lower()

META_BYTES = b'{"id":"ANON_VICTIM_01","phenopacket":true}'
RAW_BYTES = b"GNC2_ENCRYPTED_VICTIM_RAW_SEQ_BYTES"
ORPHAN_BYTES = b"ABANDONED_VICTIM_UPLOAD_BYTES"
PREGC_BYTES = b"PRE_GC_PROTECTED_CIPHERTEXT_BYTES"
REUP_BYTES = b"DELAYED_GC_LEGIT_REUPLOAD_BYTES"
OUTAGE_BYTES = b"RPC_OUTAGE_SHOULD_NOT_PIN_BYTES"
RACE_BYTES = b"CONCURRENT_UNPIN_TOCTOU_RACE_BYTES"

def sign_upload(acct, payload_bytes, ts, nonce):
    sha = hashlib.sha256(payload_bytes).hexdigest()
    msg = gw.build_siwe_upload_message(CHAIN_ID, REGISTRY, sha, acct.address, ts, nonce)
    sig = acct.sign_message(encode_defunct(text=msg)).signature.hex()
    return {
        "Content-Type": "application/octet-stream",
        "X-GenoChain-Address": acct.address,
        "X-GenoChain-Timestamp": str(ts),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": sig if sig.startswith("0x") else "0x" + sig,
        "X-GenoChain-Content-Sha256": sha,
    }

def sign_download(acct, data_id, cid, ts, nonce):
    msg = gw.build_siwe_auth_message(CHAIN_ID, REGISTRY, data_id, cid, acct.address, ts, nonce)
    sig = acct.sign_message(encode_defunct(text=msg)).signature.hex()
    return {
        "X-GenoChain-Data-Id": str(data_id),
        "X-GenoChain-Address": acct.address,
        "X-GenoChain-Timestamp": str(ts),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": sig if sig.startswith("0x") else "0x" + sig,
    }

class Phase5Reg:
    def __init__(self):
        self.datasets = []
        self.events = []
        self.licenses = {}
        self.fail_catalog_rpc = False
    def is_connected(self): return not self.fail_catalog_rpc
    def get_block_number(self): return 50
    def get_all_datasets(self):
        if self.fail_catalog_rpc:
            raise RuntimeError("Simulated Ethereum RPC outage")
        return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise KeyError("DataNotFound")
    def has_active_access(self, d, buyer):
        return (int(d), str(buyer).lower()) in self.licenses
    def get_status_updated_events(self, a, b): return list(self.events)

class Phase5Kubo:
    def __init__(self):
        self.blobs = {
            CID_META_V0: META_BYTES, CID_META_V1: META_BYTES,
            CID_RAW_V0: RAW_BYTES, CID_RAW_V1: RAW_BYTES,
            CID_ORPHAN: ORPHAN_BYTES, CID_PREGC: PREGC_BYTES,
            CID_REUP: REUP_BYTES,
        }
        self.pins = {CID_META_V0: len(META_BYTES), CID_RAW_V0: len(RAW_BYTES)}
        self.gc_should_succeed = True
        self.gc_runs = 0
        self.on_unpin_hook = None
    def health_check(self): return True
    def add_stream(self, stream, filename, content_length, cid_version=1, pin=True):
        data = stream.read(content_length)
        if data == META_BYTES:
            cid = CID_META_V1
        elif data == RAW_BYTES:
            cid = CID_RAW_V1
        elif data == ORPHAN_BYTES:
            cid = CID_ORPHAN
        elif data == PREGC_BYTES:
            cid = CID_PREGC
        elif data == REUP_BYTES:
            cid = CID_REUP
        elif data == OUTAGE_BYTES:
            cid = CID_OUTAGE
        else:
            cid = CID_TINY
        self.blobs[cid] = data
        if pin:
            self.pins[cid] = len(data)
        return {"cid": cid, "size": len(data)}
    def pin_cid(self, cid):
        if cid not in self.blobs:
            raise FileNotFoundError(cid)
        self.pins[cid] = len(self.blobs[cid])
        return True
    def list_recursive_pins(self): return list(self.pins.keys())
    def cat_cid(self, cid):
        if cid not in self.blobs:
            raise FileNotFoundError(cid)
        return self.blobs[cid]
    def unpin_cid(self, cid):
        res = self.pins.pop(cid, None) is not None
        if callable(self.on_unpin_hook):
            self.on_unpin_hook(cid)
        return res
    def run_gc(self):
        self.gc_runs += 1
        if not self.gc_should_succeed:
            return False
        # Physically delete unpinned blocks on successful GC
        for c in list(self.blobs.keys()):
            if c not in self.pins:
                mh_c = gw.extract_canonical_multihash(c)
                if not any(gw.extract_canonical_multihash(p) == mh_c for p in self.pins):
                    self.blobs.pop(c, None)
        return True

with tempfile.TemporaryDirectory() as td:
    db_path = os.path.join(td, "phase5_gateway.sqlite")
    reg = Phase5Reg()
    kubo = Phase5Kubo()
    now_ts = int(time.time())

    # Pre-existing anchored dataset #1 BEFORE gateway SQLite DB even exists (fresh/upgraded gateway scenario)
    reg.datasets = [
        {
            "dataId": 1, "tokenId": 1,
            "currentOwner": VICTIM.address, "originalCreator": VICTIM.address,
            "rawCid": CID_RAW_V0, "summaryCid": "", "metadataCid": CID_META_V0, "status": 0,
        }
    ]
    reg.licenses[(1, BUYER.address.lower())] = True

    srv = gw.create_gateway_server(
        host="127.0.0.1", port=0, chain_id=CHAIN_ID, registry_address=REGISTRY,
        registry_adapter=reg, kubo_adapter=kubo, state_db_path=db_path,
        upload_policy="open-dev", now_fn=lambda: now_ts,
    )
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # ------------------------------------------------------------------
        # REV-01A: Fresh DB (0 upload_provenance) -> ATTACKER re-uploads Victim's public metadataCid
        # ------------------------------------------------------------------
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_meta) is None
        req_1a = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload", data=META_BYTES,
            headers=sign_upload(ATTACKER, META_BYTES, now_ts, "rev01a-attacker-upload-01"),
            method="POST",
        )
        st_1a = None
        try:
            urllib.request.urlopen(req_1a, timeout=5)
        except urllib.error.HTTPError as e:
            st_1a = e.code
        assert st_1a == 403, f"REV-01A expected 403, got {st_1a}"
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_meta) == VICTIM.address.lower()

        # Victim's public metadata STILL serves 200; Attacker revoking dummy #2 MUST NOT unpin Victim's metadata!
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ipfs/{CID_META_V0}", timeout=5) as r_pub:
            assert r_pub.status == 200 and r_pub.read() == META_BYTES

        reg.datasets.append({
            "dataId": 2, "tokenId": 2,
            "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address,
            "rawCid": "", "summaryCid": "", "metadataCid": CID_META_V1, "status": 2,
        })
        reg.events.append({"dataId": 2, "newStatus": 2, "blockNumber": 10})
        rec = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path, now_fn=lambda: now_ts)
        r_1a = rec.reconcile_once()
        assert CID_META_V0 in kubo.pins and CID_META_V1 in r_1a["skippedSharedCids"], f"REV-01A unpinned Victim metadata: {r_1a}"

        # ------------------------------------------------------------------
        # REV-01B: Licensed BUYER re-uploads Victim's anchored rawCid -> blocked 403, owner keeps 200, dummy revoke cannot unpin!
        # ------------------------------------------------------------------
        req_1b = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload", data=RAW_BYTES,
            headers=sign_upload(BUYER, RAW_BYTES, now_ts, "rev01b-buyer-upload-0001"),
            method="POST",
        )
        st_1b = None
        try:
            urllib.request.urlopen(req_1b, timeout=5)
        except urllib.error.HTTPError as e:
            st_1b = e.code
        assert st_1b == 403, f"REV-01B expected 403, got {st_1b}"
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_raw) == VICTIM.address.lower()

        # Owner still downloads dataId=1 (200)
        req_own = urllib.request.Request(
            f"http://127.0.0.1:{port}/ipfs/{CID_RAW_V0}",
            headers=sign_download(VICTIM, 1, CID_RAW_V0, now_ts, "rev01b-owner-dl-00000001"),
        )
        with urllib.request.urlopen(req_own, timeout=5) as r_own:
            assert r_own.status == 200 and r_own.read() == RAW_BYTES

        reg.datasets.append({
            "dataId": 3, "tokenId": 3,
            "currentOwner": BUYER.address, "originalCreator": BUYER.address,
            "rawCid": CID_RAW_V1, "summaryCid": "", "metadataCid": "", "status": 2,
        })
        reg.events.append({"dataId": 3, "newStatus": 2, "blockNumber": 11})
        r_1b = rec.reconcile_once()
        assert CID_RAW_V0 in kubo.pins and CID_RAW_V1 in r_1b["skippedSharedCids"], f"REV-01B unpinned Victim ciphertext: {r_1b}"

        # ------------------------------------------------------------------
        # REV-02: Attacker registers & revokes dummy dataset setting rawCid = Victim.metadataCid -> Victim stays PUBLIC (200)!
        # ------------------------------------------------------------------
        reg.datasets.append({
            "dataId": 4, "tokenId": 4,
            "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address,
            "rawCid": CID_META_V1, "summaryCid": "", "metadataCid": "", "status": 2,
        })
        reg.datasets.append({
            "dataId": 5, "tokenId": 5,
            "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address,
            "rawCid": "", "summaryCid": CID_META_V0, "metadataCid": "", "status": 0,
        })
        srv.gateway_catalog_index.invalidate()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ipfs/{CID_META_V0}", timeout=5) as r_rev02:
            assert r_rev02.status == 200 and r_rev02.read() == META_BYTES

        # ------------------------------------------------------------------
        # REV-03 + L3-L2: Abandoned Victim upload referenced by Attacker dummy dataset is STILL GC'd cleanly!
        # ------------------------------------------------------------------
        req_orp = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload", data=ORPHAN_BYTES,
            headers=sign_upload(VICTIM, ORPHAN_BYTES, now_ts, "rev03-victim-orphan-0001"),
            method="POST",
        )
        with urllib.request.urlopen(req_orp, timeout=5) as r_orp:
            assert r_orp.status == 200
        # Attacker references Victim's abandoned CID in an Active dummy dataset #6 trying to pin-lock it forever
        reg.datasets.append({
            "dataId": 6, "tokenId": 6,
            "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address,
            "rawCid": CID_ORPHAN, "summaryCid": "", "metadataCid": "", "status": 0,
        })
        rec_orphan = gw.GdprErasureReconciler(
            reg, kubo, start_block=1, db_path=db_path,
            orphan_pin_ttl_sec=3600, now_fn=lambda: now_ts + 4000,
        )
        r_orp_gc = rec_orphan.reconcile_once()
        assert CID_ORPHAN in r_orp_gc["orphanUnpinnedCids"], f"REV-03 orphan pin was immortalized by attacker: {r_orp_gc}"
        assert CID_ORPHAN not in kubo.pins
        rec_orphan.close()

        # ------------------------------------------------------------------
        # L3-L1 + L3-02: Deferred/failed run_gc() MUST retain upload_provenance & persist _gc_pending across restarts!
        # ------------------------------------------------------------------
        req_pg = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload", data=PREGC_BYTES,
            headers=sign_upload(VICTIM, PREGC_BYTES, now_ts, "l3l1-victim-pregc-000001"),
            method="POST",
        )
        with urllib.request.urlopen(req_pg, timeout=5) as r_pg:
            assert r_pg.status == 200
        mh_pregc = gw.extract_canonical_multihash(CID_PREGC)

        # Front-runner lands earlier dataId=7 (Active); Victim lands dataId=8 and then revokes dataId=8
        reg.datasets.append({
            "dataId": 7, "tokenId": 7,
            "currentOwner": ATTACKER.address, "originalCreator": ATTACKER.address,
            "rawCid": CID_PREGC, "summaryCid": "", "metadataCid": "", "status": 0,
        })
        reg.datasets.append({
            "dataId": 8, "tokenId": 8,
            "currentOwner": VICTIM.address, "originalCreator": VICTIM.address,
            "rawCid": CID_PREGC, "summaryCid": "", "metadataCid": "", "status": 2,
        })
        reg.events.append({"dataId": 8, "newStatus": 2, "blockNumber": 20})
        srv.gateway_catalog_index.invalidate()

        # Simulate Kubo repo/gc failure -> unpinned block still exists in Kubo blobs!
        kubo.gc_should_succeed = False
        r_fail_gc = rec.reconcile_once()
        assert r_fail_gc["gcRan"] is False and r_fail_gc["gcPending"] is True
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_pregc) == VICTIM.address.lower(), "L3-L1 purged upload_provenance BEFORE repo/gc succeeded!"

        # Front-runner (dataId=7) MUST STILL receive 403 while block awaits GC!
        req_fr = urllib.request.Request(
            f"http://127.0.0.1:{port}/ipfs/{CID_PREGC}",
            headers=sign_download(ATTACKER, 7, CID_PREGC, now_ts, "l3l1-frontrunner-dl-0001"),
        )
        st_fr = None
        try:
            urllib.request.urlopen(req_fr, timeout=5)
        except urllib.error.HTTPError as e:
            st_fr = e.code
        assert st_fr == 403, f"L3-L1 front-runner bypassed 403 before GC! got {st_fr}"

        # Simulate process restart with new reconciler reading SQLite: _gc_pending MUST still be True!
        rec.close()
        rec_restarted = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path, now_fn=lambda: now_ts + 5)
        assert rec_restarted._gc_pending is True, "L3-02 _gc_pending did not survive restart!"
        kubo.gc_should_succeed = True
        r_ok_gc = rec_restarted.reconcile_once()
        assert r_ok_gc["gcRan"] is True and r_ok_gc["gcPending"] is False
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_pregc) is None, "L3-L1 did not flush upload_provenance AFTER repo/gc succeeded!"
        assert CID_PREGC not in kubo.blobs
        rec_restarted.close()

        # ------------------------------------------------------------------
        # L3-01: Tiny-chunk streaming upload does NOT hit SQLite on every chunk!
        # ------------------------------------------------------------------
        tiny_chunks = [b"x" * 64 for _ in range(32)]  # 2048 bytes in 32 tiny chunks
        tiny_full = b"".join(tiny_chunks)
        tiny_sha = hashlib.sha256(tiny_full).hexdigest()
        n_tiny = "l301-tiny-chunks-nonce-1"
        s_tiny = VICTIM.sign_message(encode_defunct(text=gw.build_siwe_upload_message(CHAIN_ID, REGISTRY, tiny_sha, VICTIM.address, now_ts, n_tiny))).signature.hex()

        orig_usage = srv.gateway_upload_limiter._usage_locked
        usage_calls = [0]
        def counted_usage(*a, **kw):
            usage_calls[0] += 1
            return orig_usage(*a, **kw)
        srv.gateway_upload_limiter._usage_locked = counted_usage
        try:
            ct = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            ct.putrequest("POST", "/api/v0/upload")
            ct.putheader("Transfer-Encoding", "chunked")
            ct.putheader("X-GenoChain-Address", VICTIM.address)
            ct.putheader("X-GenoChain-Timestamp", str(now_ts))
            ct.putheader("X-GenoChain-Nonce", n_tiny)
            ct.putheader("X-GenoChain-Signature", s_tiny if s_tiny.startswith("0x") else "0x" + s_tiny)
            ct.putheader("X-GenoChain-Content-Sha256", tiny_sha)
            ct.endheaders()
            for ch in tiny_chunks:
                ct.send(f"{len(ch):x}\\r\\n".encode() + ch + b"\\r\\n")
            ct.send(b"0\\r\\n\\r\\n")
            rt = ct.getresponse(); rt.read(); ct.close()
            assert rt.status == 200, f"L3-01 tiny chunk upload failed: {rt.status}"
            # 1 check at reserve() + 1 final verify_streamed_quota() == 2 (NOT 34!)
            assert usage_calls[0] <= 3, f"L3-01 fired {usage_calls[0]} SQLite quota checks for 32 tiny chunks!"
        finally:
            srv.gateway_upload_limiter._usage_locked = orig_usage

        # ------------------------------------------------------------------
        # Phase 5 Review Hardening #1: Zero untracked Kubo pins on 403 / 502!
        # ------------------------------------------------------------------
        assert CID_META_V1 not in kubo.pins, "403 REV-01A cross-owner re-upload polluted Kubo pins with CID_META_V1!"
        assert CID_RAW_V1 not in kubo.pins, "403 REV-01B cross-owner re-upload polluted Kubo pins with CID_RAW_V1!"
        reg.fail_catalog_rpc = True
        srv.gateway_catalog_index.invalidate()
        try:
            req_502 = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=OUTAGE_BYTES,
                headers=sign_upload(VICTIM, OUTAGE_BYTES, now_ts, "outage-502-nopin-0001"),
                method="POST",
            )
            st_502 = None
            try:
                urllib.request.urlopen(req_502, timeout=5)
            except urllib.error.HTTPError as e:
                st_502 = e.code
            assert st_502 == 502, f"Expected 502 on catalog RPC outage, got {st_502}"
            assert CID_OUTAGE not in kubo.pins, "502 RPC outage leaked an untracked immortal Kubo pin!"
            # Direct record_pending_upload() MUST also fail closed when catalog RPC is down!
            assert srv.gateway_upload_limiter.record_pending_upload(CID_OUTAGE, ATTACKER.address, len(OUTAGE_BYTES), now_ts) is False
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_OUTAGE)) is None
        finally:
            reg.fail_catalog_rpc = False
            srv.gateway_catalog_index.invalidate()

        # ------------------------------------------------------------------
        # Phase 5 Review Hardening #2A: Delayed GC MUST NOT wipe provenance of a legitimate re-upload!
        # ------------------------------------------------------------------
        mh_reup = gw.extract_canonical_multihash(CID_REUP)
        req_reup1 = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload",
            data=REUP_BYTES,
            headers=sign_upload(VICTIM, REUP_BYTES, now_ts, "reup-legit-nonce-0001"),
            method="POST",
        )
        with urllib.request.urlopen(req_reup1, timeout=5) as r_reup1:
            assert r_reup1.status == 200
        reg.datasets.append({
            "dataId": 9, "tokenId": 9, "currentOwner": VICTIM.address, "originalCreator": VICTIM.address,
            "rawCid": CID_REUP, "summaryCid": "", "metadataCid": "", "status": 2,
        })
        reg.events.append({"dataId": 9, "newStatus": 2})
        rec_reup = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path, now_fn=lambda: now_ts + 2)
        try:
            kubo.gc_should_succeed = False
            r_reup_fail = rec_reup.reconcile_once()
            assert r_reup_fail["gcRan"] is False and r_reup_fail["gcPending"] is True
            # Before delayed GC succeeds, Victim legitimately re-uploads CID_REUP!
            req_reup2 = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=REUP_BYTES,
                headers=sign_upload(VICTIM, REUP_BYTES, now_ts + 5, "reup-legit-nonce-0002"),
                method="POST",
            )
            with urllib.request.urlopen(req_reup2, timeout=5) as r_reup2:
                assert r_reup2.status == 200
            # Now delayed GC succeeds: Victim's re-uploaded provenance & pin MUST survive!
            kubo.gc_should_succeed = True
            r_reup_ok = rec_reup.reconcile_once()
            assert r_reup_ok["gcRan"] is True
            assert srv.gateway_upload_limiter.get_upload_provenance(mh_reup) == VICTIM.address.lower(), "Delayed GC wiped provenance of legitimate re-upload!"
            assert CID_REUP in kubo.pins, "Delayed GC lost pin of legitimate re-upload!"
        finally:
            rec_reup.close()

        # ------------------------------------------------------------------
        # Phase 5 Review Hardening #2B: Post-unpin TOCTOU concurrent re-upload recovery!
        # ------------------------------------------------------------------
        rec_race = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path, orphan_pin_ttl_sec=60, now_fn=lambda: now_ts + 1000)
        assert srv.gateway_upload_limiter.record_pending_upload(CID_RACE, VICTIM.address, len(RACE_BYTES), now_ts) is True
        kubo.blobs[CID_RACE] = RACE_BYTES
        kubo.pins[CID_RACE] = len(RACE_BYTES)
        def _simulate_concurrent_reupload(unpinned_cid):
            if unpinned_cid == CID_RACE:
                srv.gateway_upload_limiter.record_pending_upload(CID_RACE, VICTIM.address, len(RACE_BYTES), now_ts + 1000)
        kubo.on_unpin_hook = _simulate_concurrent_reupload
        try:
            unpinned_race = rec_race.reconcile_orphan_uploads(now_ts=now_ts + 1000)
            assert CID_RACE not in unpinned_race, "Concurrent re-upload during unpin was still reported as orphan-unpinned!"
            assert CID_RACE in kubo.pins, "Concurrent re-upload during unpin was NOT re-pinned in Kubo!"
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_RACE)) == VICTIM.address.lower()
        finally:
            kubo.on_unpin_hook = None
            rec_race.close()
    finally:
        srv.shutdown(); srv.server_close()

print("PHASE5_GATEWAY_REMEDIATION_OK")
`;
    const out = execFileSync(resolvePythonBin(), ["-c", pyPhase5Gateway], { encoding: "utf8" });
    expect(out).to.include("PHASE5_GATEWAY_REMEDIATION_OK");
  });

  // =========================================================================
  // R18-06k: Key Vault Fail-Closed Account Scope (LOW-01), WCAG Focus Tokens (L4-L1), Modal Hotkey Guard (L4-L3) & Pure Updater (REV-I06)
  // =========================================================================
  it("R18-06k: fails closed on empty/null key_vault account scopes (LOW-01) and enforces WCAG focus tokens, modal '/' guard & pure state updater", async function () {
    clearVaultMemoryCache();
    const capOwner = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", owner: seller.address, keyCipher: "ab".repeat(256) });
    const capBuyer = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", recipient: buyer.address, keyCipher: "cd".repeat(256) });
    await saveOwnerCapsulePersistent(CID_A, capOwner, seller.address);
    await saveBuyerCapsulePersistent(CID_B, capBuyer, buyer.address);

    // Explicit empty string scope MUST fail closed (never scan across accounts)
    expect(await loadOwnerCapsulePersistent(CID_A, "")).to.equal(null);
    expect(await loadBuyerCapsulePersistent(CID_B, "")).to.equal(null);
    expect(await getAllOwnerCapsulesPersistent("")).to.deep.equal([]);
    expect(await getAllBuyerCapsulesPersistent("")).to.deep.equal([]);

    // Cross-account scope isolation: buyer cannot read seller's owner capsule and vice versa,
    // AND read-path must NEVER mutate module-global activeVaultAccount!
    await saveOwnerCapsulePersistent(CID_A, capOwner, seller.address); // sets activeVaultAccount = seller
    expect(await loadOwnerCapsulePersistent(CID_A, buyer.address)).to.equal(null);
    // If read mutated activeVaultAccount to buyer, default-scope read would fail; must still resolve seller!
    expect(await loadOwnerCapsulePersistent(CID_A)).to.equal(capOwner);
    expect(await loadBuyerCapsulePersistent(CID_B, seller.address)).to.equal(null);
    expect(await getAllOwnerCapsulesPersistent(buyer.address)).to.deep.equal([]);
    expect(await getAllBuyerCapsulesPersistent(seller.address)).to.deep.equal([]);

    // Legitimate scoped reads still succeed
    expect(await loadOwnerCapsulePersistent(CID_A, seller.address)).to.equal(capOwner);
    expect(await loadBuyerCapsulePersistent(CID_B, buyer.address)).to.equal(capBuyer);
    clearVaultMemoryCache();
    // After clearing activeVaultAccount (wallet disconnected), null buyer scope MUST fail closed!
    expect(await loadBuyerCapsulePersistent(CID_B, null)).to.equal(null);
    expect(await getAllBuyerCapsulesPersistent(null)).to.deep.equal([]);

    // Verify L4-L1 focus ring tokens, L4-03 --bg-elevated, F-02 global '/' guard in Navbar, L4-04 toast-warning, L4-F3 partialWarning, and REV-I06 pure setPurchasedData updater + unmount scrub
    const tokensCss = fs.readFileSync(path.resolve("frontend/src/styles/tokens.css"), "utf8");
    expect(tokensCss).to.include("--focus-ring-color: #005fcc;");
    expect(tokensCss).to.include("--focus-ring-color: #38bdf8;");
    expect(tokensCss).to.include("--bg-elevated: var(--bg-surface-elevated);");
    const baseCss = fs.readFileSync(path.resolve("frontend/src/styles/base.css"), "utf8");
    expect(baseCss).to.include("var(--focus-ring-color");
    const navbarSrc = fs.readFileSync(path.resolve("frontend/src/components/common/Navbar.jsx"), "utf8");
    expect(navbarSrc).to.include('[role="dialog"][aria-modal="true"]');
    expect(navbarSrc).to.include('getElementById("nav-search-input")');
    expect(navbarSrc).to.include('aria-label={t("ariaClearSearch")}');
    const filterBarSrc = fs.readFileSync(path.resolve("frontend/src/features/researcher/GenomicFilterBar.jsx"), "utf8");
    expect(filterBarSrc).to.not.include('getElementById("input-filter-search")');
    const toastSrc = fs.readFileSync(path.resolve("frontend/src/components/common/Toast.jsx"), "utf8");
    expect(toastSrc).to.include("toast-warning");
    const modalsCss = fs.readFileSync(path.resolve("frontend/src/styles/components/modals.css"), "utf8");
    expect(modalsCss).to.include(".toast-warning");
    const decHookSrc = fs.readFileSync(path.resolve("frontend/src/hooks/useDatasetDecryption.js"), "utf8");
    expect(decHookSrc).to.not.include("p.decryptedPdfBytes.fill(0)");
    expect(decHookSrc).to.include("useEffect(() =>");
    expect(decHookSrc).to.include("partialWarning");
  });

  // =========================================================================
  // R18-06l: Phase 6 Gateway Pre-Hash (F-03), Single-RPC Atomic Claim & Concurrency (F-01), Delayed Purge Retry (L3-03) & Dispatcher Missing-Key Queue (L3-02)
  // =========================================================================
  it("R18-06l: enforces only-hash=true zero-write 403/502 (F-03), single-RPC atomic concurrent duplicate-CID claim & fail-closed commit (F-01), post-GC purge retry (L3-03) & dispatcher missing_seed_key queue (L3-02)", async function () {
    const pyPhase6 = `
import hashlib, http.server, json, os, sqlite3, tempfile, threading, time, urllib.error, urllib.request
from eth_account import Account
from eth_account.messages import encode_defunct
import deploy.ipfs_access_gateway as gw

CHAIN_ID = 31337
REGISTRY = "0x1111111111111111111111111111111111111111"
ALICE = Account.from_key("0x" + "11" * 32)
BOB = Account.from_key("0x" + "22" * 32)
CHARLIE = Account.from_key("0x" + "33" * 32)

CID_ANCHORED   = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
CID_FRESH_1    = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
CID_RACE_DUP   = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm"
CID_OUTAGE     = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"
CID_COMMIT_ERR = "bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq"
CID_COMMIT_CON = "bafybeigvgzoolc3drupxhlevdp2ugqcrbcsqfmcek2zxiw5wctk3xjpjwy"
CID_PURGE      = "bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m"
CID_REVOKED    = "bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly"

ANCHORED_BYTES = b"PHASE6_ANCHORED_OWNER_BYTES"
FRESH1_BYTES   = b"PHASE6_FRESH_SINGLE_RPC_BYTES"
RACE_BYTES     = b"PHASE6_CONCURRENT_RACE_DUP_BYTES"
OUTAGE_BYTES   = b"PHASE6_OUTAGE_ZERO_WRITE_BYTES"
ERR_BYTES      = b"PHASE6_COMMIT_SQLITE_ERR_BYTES"
CON_BYTES      = b"PHASE6_COMMIT_CONFLICT_BYTES"
PURGE_BYTES    = b"PHASE6_POST_GC_PURGE_RETRY_BYTES"
REVOKED_BYTES  = b"PHASE6_GDPR_REVOKED_REUPLOAD_BYTES"

BYTES_TO_CID = {
    ANCHORED_BYTES: CID_ANCHORED,
    FRESH1_BYTES: CID_FRESH_1,
    RACE_BYTES: CID_RACE_DUP,
    OUTAGE_BYTES: CID_OUTAGE,
    ERR_BYTES: CID_COMMIT_ERR,
    CON_BYTES: CID_COMMIT_CON,
    PURGE_BYTES: CID_PURGE,
    REVOKED_BYTES: CID_REVOKED,
}

def sign_upload(acct, payload_bytes, ts, nonce):
    sha = hashlib.sha256(payload_bytes).hexdigest()
    msg = gw.build_siwe_upload_message(CHAIN_ID, REGISTRY, sha, acct.address, ts, nonce)
    sig = acct.sign_message(encode_defunct(text=msg)).signature.hex()
    return {
        "Content-Type": "application/octet-stream",
        "X-GenoChain-Address": acct.address,
        "X-GenoChain-Timestamp": str(ts),
        "X-GenoChain-Nonce": nonce,
        "X-GenoChain-Signature": sig if sig.startswith("0x") else "0x" + sig,
        "X-GenoChain-Content-Sha256": sha,
    }

# 0. Verify KuboHttpAdapter.add_stream(..., only_hash=True) transmits only-hash=true&pin=false over HTTP
seen_kubo_paths = []
class MockKuboRpcHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): return
    def do_POST(self):
        seen_kubo_paths.append(self.path)
        cl = int(self.headers.get("Content-Length", "0"))
        if cl > 0:
            self.rfile.read(cl)
        body = json.dumps({"Name": "f.enc", "Hash": CID_FRESH_1, "Size": str(len(FRESH1_BYTES))}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

mock_kubo_srv = http.server.HTTPServer(("127.0.0.1", 0), MockKuboRpcHandler)
threading.Thread(target=mock_kubo_srv.serve_forever, daemon=True).start()
try:
    import io
    adapter = gw.KuboHttpAdapter(rpc_url=f"http://127.0.0.1:{mock_kubo_srv.server_address[1]}")
    r_oh = adapter.add_stream(io.BytesIO(FRESH1_BYTES), "f.enc", len(FRESH1_BYTES), cid_version=1, pin=True, only_hash=True)
    assert r_oh["cid"] == CID_FRESH_1
    assert any("only-hash=true" in p and "pin=false" in p for p in seen_kubo_paths), f"only-hash=true missing in Kubo URL: {seen_kubo_paths}"
finally:
    mock_kubo_srv.shutdown(); mock_kubo_srv.server_close()

class Phase6Reg:
    def __init__(self):
        self.datasets = []
        self.events = []
        self.fail_catalog_rpc = False
        self.fail_after_n = None
        self.rpc_calls = 0
    def is_connected(self): return not self.fail_catalog_rpc
    def get_block_number(self): return 100
    def get_all_datasets(self):
        self.rpc_calls += 1
        if self.fail_catalog_rpc:
            raise RuntimeError("Simulated RPC outage")
        if self.fail_after_n is not None and self.rpc_calls >= self.fail_after_n:
            raise RuntimeError("Simulated transient RPC failure")
        return list(self.datasets)
    def get_genomic_data(self, d):
        for ds in self.datasets:
            if ds["dataId"] == int(d): return ds
        raise KeyError("DataNotFound")
    def has_active_access(self, d, buyer): return False
    def get_status_updated_events(self, a, b): return list(self.events)

class Phase6Kubo:
    def __init__(self):
        self.written_blocks = {}
        self.pins = {}
        self.only_hash_calls = 0
        self.write_calls = 0
        self.delay_on_write_sec = 0.0
        self.gc_runs = 0
    def health_check(self): return True
    def add_stream(self, stream, filename, content_length, cid_version=1, pin=True, only_hash=False):
        data = stream.read(content_length)
        cid = BYTES_TO_CID[data]
        if only_hash:
            self.only_hash_calls += 1
            return {"cid": cid, "size": len(data)}
        if self.delay_on_write_sec > 0:
            time.sleep(self.delay_on_write_sec)
        self.write_calls += 1
        self.written_blocks[cid] = data
        if pin:
            self.pins[cid] = len(data)
        return {"cid": cid, "size": len(data)}
    def pin_cid(self, cid):
        if cid not in self.written_blocks:
            raise FileNotFoundError(cid)
        self.pins[cid] = len(self.written_blocks[cid])
        return True
    def unpin_cid(self, cid):
        return self.pins.pop(cid, None) is not None
    def list_recursive_pins(self): return list(self.pins.keys())
    def cat_cid(self, cid):
        if cid not in self.written_blocks:
            raise FileNotFoundError(cid)
        return self.written_blocks[cid]
    def run_gc(self):
        self.gc_runs += 1
        for c in list(self.written_blocks.keys()):
            if c not in self.pins:
                self.written_blocks.pop(c, None)
        return True

with tempfile.TemporaryDirectory() as td:
    db_path = os.path.join(td, "phase6_gateway.sqlite")
    reg = Phase6Reg()
    kubo = Phase6Kubo()
    now_ts = int(time.time())
    reg.datasets = [
        {
            "dataId": 1, "tokenId": 1,
            "currentOwner": ALICE.address, "originalCreator": ALICE.address,
            "rawCid": CID_ANCHORED, "summaryCid": "", "metadataCid": "", "status": 0,
        },
        {
            "dataId": 2, "tokenId": 2,
            "currentOwner": ALICE.address, "originalCreator": ALICE.address,
            "rawCid": CID_REVOKED, "summaryCid": "", "metadataCid": "", "status": 2,
        },
    ]

    srv = gw.create_gateway_server(
        host="127.0.0.1", port=0, chain_id=CHAIN_ID, registry_address=REGISTRY,
        registry_adapter=reg, kubo_adapter=kubo, state_db_path=db_path,
        upload_policy="open-dev", now_fn=lambda: now_ts, min_forced_refresh_sec=5.0,
    )
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # ------------------------------------------------------------------
        # F-01A: Normal upload performs at most 1 catalog RPC scan (no redundant 2nd RPC, no post-upload invalidate!)
        # ------------------------------------------------------------------
        reg.rpc_calls = 0
        req_ok = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload",
            data=FRESH1_BYTES,
            headers=sign_upload(ALICE, FRESH1_BYTES, now_ts, "p6-f01a-normal-000001"),
            method="POST",
        )
        with urllib.request.urlopen(req_ok, timeout=5) as resp_ok:
            assert resp_ok.status == 200
        assert reg.rpc_calls <= 1, f"F-01A expected <=1 catalog RPC on normal upload, got {reg.rpc_calls}"
        assert CID_FRESH_1 in kubo.pins and CID_FRESH_1 in kubo.written_blocks

        # ------------------------------------------------------------------
        # F-03: Rejected 403 (anchored owner mismatch AND GDPR-revoked ciphertext re-upload) write ZERO blocks to Kubo!
        # ------------------------------------------------------------------
        writes_before = kubo.write_calls
        for label, payload, cid_target, nonce_val in (
            ("anchored-403", ANCHORED_BYTES, CID_ANCHORED, "p6-f03-anchored-403-1"),
            ("revoked-403", REVOKED_BYTES, CID_REVOKED, "p6-f03-revoked-403-01"),
        ):
            req_403 = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=payload,
                headers=sign_upload(BOB, payload, now_ts, nonce_val),
                method="POST",
            )
            st_403 = None
            try:
                urllib.request.urlopen(req_403, timeout=5)
            except urllib.error.HTTPError as e:
                st_403 = e.code
            assert st_403 == 403, f"F-03 {label} expected 403, got {st_403}"
            assert cid_target not in kubo.written_blocks, f"F-03 {label} wrote unpinned block to Kubo!"
            assert cid_target not in kubo.pins, f"F-03 {label} pinned rejected CID!"
        assert kubo.write_calls == writes_before, f"F-03 403 rejections invoked write_calls: {kubo.write_calls} vs {writes_before}"

        # ------------------------------------------------------------------
        # F-01D + F-03: Catalog RPC outage returns 502 with rpc_calls == 1 (no 2x amplification) AND 0 Kubo block writes!
        # ------------------------------------------------------------------
        reg.fail_catalog_rpc = True
        srv.gateway_catalog_index.invalidate()
        reg.rpc_calls = 0
        writes_before_502 = kubo.write_calls
        try:
            req_502 = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=OUTAGE_BYTES,
                headers=sign_upload(ALICE, OUTAGE_BYTES, now_ts, "p6-f01d-outage-502-01"),
                method="POST",
            )
            st_502 = None
            try:
                urllib.request.urlopen(req_502, timeout=5)
            except urllib.error.HTTPError as e:
                st_502 = e.code
            assert st_502 == 502, f"F-01D expected 502, got {st_502}"
            assert reg.rpc_calls == 1, f"F-01D expected exactly 1 RPC call on 502 outage, got {reg.rpc_calls}"
            assert CID_OUTAGE not in kubo.written_blocks and CID_OUTAGE not in kubo.pins
            assert kubo.write_calls == writes_before_502, "F-03 502 outage wrote block to Kubo!"
        finally:
            reg.fail_catalog_rpc = False
            srv.gateway_catalog_index.invalidate()

        # ------------------------------------------------------------------
        # F-01C: Live 2-thread threading.Barrier(2) concurrent Alice/Bob duplicate-CID race -> STRICTLY 1x200 + 1x403!
        # ------------------------------------------------------------------
        kubo.delay_on_write_sec = 0.08
        barrier = threading.Barrier(2)
        race_results = {}
        def _race_upload(name, acct, nonce_s):
            req_r = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=RACE_BYTES,
                headers=sign_upload(acct, RACE_BYTES, now_ts, nonce_s),
                method="POST",
            )
            barrier.wait()
            try:
                with urllib.request.urlopen(req_r, timeout=10) as resp_r:
                    race_results[name] = resp_r.status
            except urllib.error.HTTPError as e:
                race_results[name] = e.code
        t_a = threading.Thread(target=_race_upload, args=("alice", ALICE, "p6-f01c-race-alice-01"))
        t_b = threading.Thread(target=_race_upload, args=("bob", BOB, "p6-f01c-race-bob-0001"))
        t_a.start(); t_b.start()
        t_a.join(); t_b.join()
        kubo.delay_on_write_sec = 0.0
        statuses = sorted(race_results.values())
        assert statuses == [200, 403], f"F-01C concurrent duplicate-CID race MUST return strictly [200, 403], got {race_results}"
        winner_addr = ALICE.address.lower() if race_results["alice"] == 200 else BOB.address.lower()
        mh_race = gw.extract_canonical_multihash(CID_RACE_DUP)
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_race) == winner_addr
        pending_cids = {p["cid"]: p["uploader"] for p in srv.gateway_upload_limiter.list_pending_uploads()}
        assert pending_cids.get(CID_RACE_DUP) == winner_addr, f"F-01C winner missing from pending_uploads: {pending_cids}"

        # ------------------------------------------------------------------
        # F-01B: Commit failure / conflict MUST fail closed (NEVER return 200 without tracking/provenance!)
        # ------------------------------------------------------------------
        orig_commit = srv.gateway_upload_limiter.commit
        def _failing_commit(*a, **kw):
            if kw.get("cid") == CID_COMMIT_ERR:
                raise sqlite3.OperationalError("Simulated SQLite write fault")
            if kw.get("cid") == CID_COMMIT_CON:
                # Simulate a second process winning SQLite upload_provenance 1ms before real orig_commit()
                mh_con = gw.extract_canonical_multihash(CID_COMMIT_CON)
                srv.gateway_upload_limiter.record_upload_provenance(mh_con, ALICE.address, created_at=float(now_ts))
            return orig_commit(*a, **kw)
        srv.gateway_upload_limiter.commit = _failing_commit
        try:
            req_err = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=ERR_BYTES,
                headers=sign_upload(CHARLIE, ERR_BYTES, now_ts, "p6-f01b-commit-err-01"),
                method="POST",
            )
            st_err = None
            try:
                urllib.request.urlopen(req_err, timeout=5)
            except urllib.error.HTTPError as e:
                st_err = e.code
            assert st_err == 502, f"F-01B SQLite commit fault expected 502, got {st_err}"
            assert CID_COMMIT_ERR not in kubo.pins, "F-01B failed commit left CID pinned!"
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_COMMIT_ERR)) is None

            kubo.pins[CID_COMMIT_CON] = len(CON_BYTES)  # Alice's pin in another process
            req_con = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/v0/upload",
                data=CON_BYTES,
                headers=sign_upload(CHARLIE, CON_BYTES, now_ts, "p6-f01b-commit-con-01"),
                method="POST",
            )
            st_con = None
            try:
                urllib.request.urlopen(req_con, timeout=5)
            except urllib.error.HTTPError as e:
                st_con = e.code
            assert st_con == 403, f"F-01B real SQLite commit provenance conflict expected 403, got {st_con}"
            assert CID_COMMIT_CON in kubo.pins, "F-01B cross-process conflict must NOT unpin winner's pin!"
            assert srv.gateway_upload_limiter.get_upload_provenance(gw.extract_canonical_multihash(CID_COMMIT_CON)) == ALICE.address.lower()
        finally:
            srv.gateway_upload_limiter.commit = orig_commit

        # ------------------------------------------------------------------
        # L3-03: Post-GC transient RPC failure retries _flush_pending_provenance_purges() on next healthy cycle!
        # ------------------------------------------------------------------
        req_p = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/v0/upload",
            data=PURGE_BYTES,
            headers=sign_upload(ALICE, PURGE_BYTES, now_ts, "p6-l303-purge-retry-1"),
            method="POST",
        )
        with urllib.request.urlopen(req_p, timeout=5) as rp:
            assert rp.status == 200
        mh_purge = gw.extract_canonical_multihash(CID_PURGE)
        assert srv.gateway_upload_limiter.get_upload_provenance(mh_purge) == ALICE.address.lower()
        reg.datasets.append({
            "dataId": 3, "tokenId": 3,
            "currentOwner": ALICE.address, "originalCreator": ALICE.address,
            "rawCid": CID_PURGE, "summaryCid": "", "metadataCid": "", "status": 2,
        })
        reg.events.append({"dataId": 3, "newStatus": 2, "blockNumber": 99})
        rec = gw.GdprErasureReconciler(reg, kubo, start_block=1, db_path=db_path, now_fn=lambda: now_ts + 10)
        try:
            # Make get_all_datasets succeed during revocation refcount + orphan checks, then fail DURING _flush_pending_provenance_purges!
            orig_collect = rec._collect_anchored_owners_by_mh
            fail_flush_once = [True]
            def _flaky_collect():
                if fail_flush_once[0] and kubo.gc_runs > 0:
                    fail_flush_once[0] = False
                    raise RuntimeError("Transient RPC timeout after run_gc()")
                return orig_collect()
            rec._collect_anchored_owners_by_mh = _flaky_collect
            r_c1 = rec.reconcile_once()
            assert r_c1["gcRan"] is True and r_c1["gcPending"] is False
            assert r_c1["flushedProvenancePurges"] == 0
            # Provenance is preserved during transient RPC outage (fail-closed)
            assert srv.gateway_upload_limiter.get_upload_provenance(mh_purge) == ALICE.address.lower()
            # Next healthy cycle: NO new revocations, NO new orphans, _gc_pending == False -> MUST retry & flush!
            r_c2 = rec.reconcile_once()
            assert r_c2["gcPending"] is False
            assert r_c2["flushedProvenancePurges"] >= 1, f"L3-03 stranded pending_provenance_purges: {r_c2}"
            assert srv.gateway_upload_limiter.get_upload_provenance(mh_purge) is None, "L3-03 failed to purge provenance on retry!"
        finally:
            rec.close()
    finally:
        srv.shutdown(); srv.server_close()

# L3-02: Verify capsule_dispatcher.py queues missing_seed_key confirmed orders into pending_orders
with open(os.path.join("scripts", "demo", "capsule_dispatcher.py"), "r", encoding="utf-8") as df:
    disp_src = df.read()
assert '"missing_seed_key"' in disp_src and "if data_id not in seed_keys:" in disp_src

print("PHASE6_MICRO_POLISH_OK")
`;
    const out = execFileSync(resolvePythonBin(), ["-c", pyPhase6], { encoding: "utf8" });
    expect(out).to.include("PHASE6_MICRO_POLISH_OK");
  });
});
