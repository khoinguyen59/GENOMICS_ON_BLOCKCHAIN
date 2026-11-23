import { expect } from "chai";
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  exportSovereignKeyVault,
  importSovereignKeyVault,
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
import { sanitizeGenomicMetadata, sanitizeMetadataTree } from "../frontend/src/utils/asyncResilience.js";
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
});
