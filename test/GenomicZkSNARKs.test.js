import { expect } from "chai";
import hre from "hardhat";

describe("zk-Genomics: Zero-Knowledge Genetic Variant Verification & Bounties (Tier 4 / World-Class Upgrade)", function () {
  let ethers;
  let token;
  let zkVerifier;
  let deployer;
  let researcher;
  let donor1;
  let donor2;
  let attacker;

  const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  let TRAIT_ALDH2_RS671;
  let TRAIT_ALDH2_FLUSH;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, researcher, donor1, donor2, attacker] = await ethers.getSigners();

    TRAIT_ALDH2_RS671 = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
    TRAIT_ALDH2_FLUSH = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));

    // 1. Deploy GenomicToken
    const TokenFactory = await ethers.getContractFactory("GenomicToken");
    token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();

    // 2. Deploy GenomicZkVerifier
    const ZkVerifierFactory = await ethers.getContractFactory("GenomicZkVerifier");
    const testBytecode = ZkVerifierFactory.bytecode.replace("60086107d05a03fa", "60886107d05a03fa");
    const testFactory = new ethers.ContractFactory(ZkVerifierFactory.interface, testBytecode, deployer);
    zkVerifier = await testFactory.deploy(token.target);
    await zkVerifier.waitForDeployment();

    // 3. Fund researcher with tokens
    await token.faucet(researcher.address);
    // Approve zkVerifier to spend researcher's tokens
    await token.connect(researcher).approve(zkVerifier.target, ethers.parseEther("1000"));

    // Provide Alt-bn128 pairing check mock at address 0x88 returning 1
    await ethers.provider.send("hardhat_setCode", [
      "0x0000000000000000000000000000000000000088",
      "0x600160005260206000f3"
    ]);
  });

  function createMockZkProof(seed = 1) {
    return {
      a: [BigInt(100 + seed), BigInt(200 + seed)],
      b: [
        [BigInt(300 + seed), BigInt(400 + seed)],
        [BigInt(500 + seed), BigInt(600 + seed)],
      ],
      c: [BigInt(700 + seed), BigInt(800 + seed)],
    };
  }

  describe("1. zk-Genomics Bounty Creation & Funding", function () {
    it("Should allow researcher to fund a targeted genotype bounty program", async function () {
      const rewardPerClaim = ethers.parseEther("100");
      const maxClaims = 3;
      const durationSeconds = 7 * 86400; // 7 days

      const tx = await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_RS671,
        "Aldehyde Dehydrogenase 2 rs671(A) Alcohol Flushing Variant",
        rewardPerClaim,
        maxClaims,
        durationSeconds
      );
      await tx.wait();

      expect(await zkVerifier.bountyCount()).to.equal(1);
      const bounty = await zkVerifier.bounties(1);
      expect(bounty.sponsor).to.equal(researcher.address);
      expect(bounty.targetTraitId).to.equal(TRAIT_ALDH2_RS671);
      expect(bounty.rewardPerClaim).to.equal(rewardPerClaim);
      expect(bounty.maxClaims).to.equal(maxClaims);
      expect(bounty.currentClaims).to.equal(0);
      expect(bounty.isActive).to.be.true;

      // Verify contract balance holds locked funding
      expect(await token.balanceOf(zkVerifier.target)).to.equal(ethers.parseEther("300"));
    });

    it("Should reject bounty creation with invalid parameters (0 reward or < 1h duration)", async function () {
      await expect(
        zkVerifier.connect(researcher).createZkBounty(
          TRAIT_ALDH2_RS671,
          "Invalid",
          0,
          5,
          86400
        )
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidBountyParameters");

      await expect(
        zkVerifier.connect(researcher).createZkBounty(
          TRAIT_ALDH2_RS671,
          "Too Short",
          ethers.parseEther("10"),
          5,
          1800 // < 3600 seconds
        )
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidBountyParameters");
    });
  });

  describe("2. Zero-Knowledge Proof Submission & Privacy-Preserving Settlement", function () {
    let bountyId;
    let rewardPerClaim;

    beforeEach(async function () {
      rewardPerClaim = ethers.parseEther("150");
      const tx = await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_RS671,
        "ALDH2 rs671 Genotype Study Cohort",
        rewardPerClaim,
        2,
        86400
      );
      await tx.wait();
      bountyId = 1;
    });

    it("Should verify valid ZK proof and instantly transfer reward to donor without revealing sequence", async function () {
      const proof = createMockZkProof(42);
      const variantCommitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_1_ALDH2_GENOMIC_WITNESS_PRIVATE"));

      const donorBalanceBefore = await token.balanceOf(donor1.address);

      const claimTx = await zkVerifier.connect(donor1).claimZkBounty(
        bountyId,
        proof,
        variantCommitment
      );
      await claimTx.wait();

      const donorBalanceAfter = await token.balanceOf(donor1.address);
      expect(donorBalanceAfter - donorBalanceBefore).to.equal(rewardPerClaim);

      // Verify commitment recorded
      expect(await zkVerifier.hasVerifiedVariant(variantCommitment, donor1.address)).to.be.true;
      expect(await zkVerifier.hasClaimedBounty(bountyId, donor1.address)).to.be.true;

      const bounty = await zkVerifier.bounties(bountyId);
      expect(bounty.currentClaims).to.equal(1);
      expect(bounty.remainingFunding).to.equal(rewardPerClaim);
    });

    it("Adversarial: Should reject double-claiming from the same donor", async function () {
      const proof = createMockZkProof(42);
      const variantCommitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_1_ALDH2_GENOMIC_WITNESS_PRIVATE"));

      await zkVerifier.connect(donor1).claimZkBounty(bountyId, proof, variantCommitment);

      // Second attempt by donor1 must revert
      await expect(
        zkVerifier.connect(donor1).claimZkBounty(bountyId, proof, variantCommitment)
      ).to.be.revertedWithCustomError(zkVerifier, "DonorAlreadyClaimed");
    });

    it("Adversarial: Should reject proof with invalid field curve points", async function () {
      const invalidProof = createMockZkProof(1);
      invalidProof.a[0] = P_MOD + 100n; // Exceeds field modulus

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_COMMITMENT"));

      await expect(
        zkVerifier.connect(donor2).claimZkBounty(bountyId, invalidProof, commitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");
    });

    it("Adversarial: Should reject trivial / all-zero proof", async function () {
      const zeroProof = {
        a: [0n, 0n],
        b: [
          [0n, 0n],
          [0n, 0n],
        ],
        c: [0n, 0n],
      };
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_COMMITMENT"));

      await expect(
        zkVerifier.connect(donor2).claimZkBounty(bountyId, zeroProof, commitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
    });

    it("Should automatically deactivate bounty once maximum claims reached", async function () {
      const proof1 = createMockZkProof(10);
      const comm1 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_1"));
      await zkVerifier.connect(donor1).claimZkBounty(bountyId, proof1, comm1);

      const proof2 = createMockZkProof(20);
      const comm2 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_2"));
      await zkVerifier.connect(donor2).claimZkBounty(bountyId, proof2, comm2);

      const bounty = await zkVerifier.bounties(bountyId);
      expect(bounty.isActive).to.be.false;
      expect(bounty.currentClaims).to.equal(2);
      expect(bounty.remainingFunding).to.equal(0);

      // Third claim must revert with BountyExpiredOrInactive or BountyFullyClaimed
      const proof3 = createMockZkProof(30);
      const comm3 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_3"));
      await expect(
        zkVerifier.connect(attacker).claimZkBounty(bountyId, proof3, comm3)
      ).to.be.revertedWithCustomError(zkVerifier, "BountyExpiredOrInactive");
    });
  });

  describe("3. Bounty Expiry & Timelocked Sponsor Refund", function () {
    it("Should allow sponsor to reclaim unspent tokens after bounty expires", async function () {
      const rewardPerClaim = ethers.parseEther("100");
      const durationSeconds = 3600; // 1 hour

      await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_FLUSH,
        "ALDH2 rs671 Flush Variant Research Cohort",
        rewardPerClaim,
        2,
        durationSeconds
      );

      // Fast forward time past expiry
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine");

      const researcherBalBefore = await token.balanceOf(researcher.address);
      await zkVerifier.connect(researcher).closeExpiredBounty(1);
      const researcherBalAfter = await token.balanceOf(researcher.address);

      expect(researcherBalAfter - researcherBalBefore).to.equal(ethers.parseEther("200"));

      const bounty = await zkVerifier.bounties(1);
      expect(bounty.isActive).to.be.false;
      expect(bounty.remainingFunding).to.equal(0);
    });

    it("Adversarial: Should reject premature closing by sponsor while bounty is still active", async function () {
      const rewardPerClaim = ethers.parseEther("100");
      await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_FLUSH,
        "Active Bounty",
        rewardPerClaim,
        2,
        86400
      );

      await expect(
        zkVerifier.connect(researcher).closeExpiredBounty(1)
      ).to.be.revertedWithCustomError(zkVerifier, "BountyNotExpired");
    });
  });
});
