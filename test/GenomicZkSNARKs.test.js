import crypto from "node:crypto";
import { expect } from "chai";
import hre from "hardhat";

describe("zk-Genomics: Zero-Knowledge Genetic Variant Verification & Bounties", function () {
  let ethers;
  let token;
  let zkVerifier;
  let deployer;
  let researcher;
  let donor1;
  let donor2;
  let attacker;

  const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  let TRAIT_ALDH2_RS671;
  let TRAIT_ALDH2_FLUSH;

  // Authentic BN254 G2 Generator in EIP-197 canonical encoding:
  const G2_POINTS = [
    [
      BigInt("0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2"),
      BigInt("0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed"),
    ],
    [
      BigInt("0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b"),
      BigInt("0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
    ],
  ];

  // Ephemeral CSPRNG ceremony scalars (freshly randomized per test suite run — zero hardcoded trapdoors)
  let ceremony;

  function modPow(base, exp, mod) {
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
    }
    return result;
  }

  function modInv(a, mod) {
    return modPow(a, mod - 2n, mod);
  }

  function randomScalar() {
    let v = 0n;
    while (v <= 1n || v >= R_MOD) {
      v = BigInt("0x" + crypto.randomBytes(31).toString("hex")) % R_MOD;
    }
    return v;
  }

  // BN254 Fp2 = Fp[u]/(u^2 + 1) arithmetic for runtime test ceremony G2 key derivation
  const fp2Add = (a, b) => [(a[0] + b[0]) % P_MOD, (a[1] + b[1]) % P_MOD];
  const fp2Sub = (a, b) => [((a[0] - b[0]) % P_MOD + P_MOD) % P_MOD, ((a[1] - b[1]) % P_MOD + P_MOD) % P_MOD];
  const fp2Mul = (a, b) => [
    (((a[0] * b[0] - a[1] * b[1]) % P_MOD) + P_MOD) % P_MOD,
    (a[0] * b[1] + a[1] * b[0]) % P_MOD,
  ];
  const fp2Sq = (a) => fp2Mul(a, a);
  const fp2Inv = (a) => {
    const denom = (a[0] * a[0] + a[1] * a[1]) % P_MOD;
    const invD = modInv(denom, P_MOD);
    return [(a[0] * invD) % P_MOD, ((-a[1] * invD) % P_MOD + P_MOD) % P_MOD];
  };

  function g2Add(p1, p2) {
    if (!p1) return p2;
    if (!p2) return p1;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    let lam;
    if (x1[0] === x2[0] && x1[1] === x2[1]) {
      const ySum = fp2Add(y1, y2);
      if (ySum[0] === 0n && ySum[1] === 0n) return null;
      lam = fp2Mul(fp2Mul([3n, 0n], fp2Sq(x1)), fp2Inv(fp2Add(y1, y1)));
    } else {
      lam = fp2Mul(fp2Sub(y2, y1), fp2Inv(fp2Sub(x2, x1)));
    }
    const x3 = fp2Sub(fp2Sub(fp2Sq(lam), x1), x2);
    const y3 = fp2Sub(fp2Mul(lam, fp2Sub(x1, x3)), y1);
    return [x3, y3];
  }

  function g2MulEip197(scalar) {
    // G2_POINTS is [[x_im, x_re], [y_im, y_re]] -> internal [re, im]
    let cur = [
      [G2_POINTS[0][1], G2_POINTS[0][0]],
      [G2_POINTS[1][1], G2_POINTS[1][0]],
    ];
    let res = null;
    let k = ((scalar % R_MOD) + R_MOD) % R_MOD;
    while (k > 0n) {
      if (k & 1n) res = g2Add(res, cur);
      cur = g2Add(cur, cur);
      k >>= 1n;
    }
    return [
      [res[0][1], res[0][0]],
      [res[1][1], res[1][0]],
    ];
  }

  async function ecMulG1(scalar) {
    const input = ethers.concat([
      ethers.zeroPadValue("0x01", 32),
      ethers.zeroPadValue("0x02", 32),
      ethers.zeroPadValue(ethers.toBeHex(((scalar % R_MOD) + R_MOD) % R_MOD), 32),
    ]);
    const res = await ethers.provider.call({
      to: "0x0000000000000000000000000000000000000007",
      data: input,
    });
    return [BigInt(ethers.dataSlice(res, 0, 32)), BigInt(ethers.dataSlice(res, 32, 64))];
  }

  async function configureEphemeralTestCeremony(targetVerifier = zkVerifier) {
    const alphaS = randomScalar();
    const betaS = randomScalar();
    let gammaS = randomScalar();
    while (gammaS === betaS) gammaS = randomScalar();
    let deltaS = randomScalar();
    while (deltaS === betaS || deltaS === gammaS) deltaS = randomScalar();
    const ic0S = randomScalar();
    const ic1S = randomScalar();

    const alphaG1 = await ecMulG1(alphaS);
    const betaG2 = g2MulEip197(betaS);
    const gammaG2 = g2MulEip197(gammaS);
    const deltaG2 = g2MulEip197(deltaS);
    const ic0G1 = await ecMulG1(ic0S);
    const ic1G1 = await ecMulG1(ic1S);

    await (
      await targetVerifier.connect(deployer).setupVerificationKey(alphaG1, betaG2, gammaG2, deltaG2, ic0G1, ic1G1)
    ).wait();

    ceremony = { alphaS, betaS, gammaS, deltaS, ic0S, ic1S };
    return { alphaG1, betaG2, gammaG2, deltaG2, ic0G1, ic1G1 };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, researcher, donor1, donor2, attacker] = await ethers.getSigners();

    TRAIT_ALDH2_RS671 = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
    TRAIT_ALDH2_FLUSH = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));

    // 1. Deploy GenomicToken
    const TokenFactory = await ethers.getContractFactory("GenomicToken");
    token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();

    // 2. Deploy GenomicZkVerifier directly with unmodified factory bytecode (INVARIANT-17 compliant)
    const ZkVerifierFactory = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkVerifierFactory.deploy(token.target);
    await zkVerifier.waitForDeployment();

    // 3. Fund researcher with tokens
    await token.faucet(researcher.address);
    // Approve zkVerifier to spend researcher's tokens
    await token.connect(researcher).approve(zkVerifier.target, ethers.parseEther("1000"));

    // 4. Configure fresh runtime CSPRNG test ceremony (no static hardcoded scalars)
    await configureEphemeralTestCeremony(zkVerifier);
  });

  /**
   * Simulates Groth16 zk-SNARK prover for BN254 bilinear pairing verification.
   * Evaluates e(-A, B) * e(alpha, beta) * e(ic0 + publicSignal * ic1, gamma) * e(C, delta) == 1
   * against the ephemeral CSPRNG ceremony parameters generated in beforeEach.
   */
  async function createAuthenticZkProof(donorAddress, traitId, commitment, cScalar = 1n) {
    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "address"],
      [commitment, traitId, donorAddress]
    );
    const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;

    const bScalar = randomScalar();
    const bPoint = g2MulEip197(bScalar);
    const cPoint = await ecMulG1(cScalar);

    const vkXScalar = (ceremony.ic0S + publicSignal * ceremony.ic1S) % R_MOD;
    const rhs =
      (ceremony.alphaS * ceremony.betaS +
        vkXScalar * ceremony.gammaS +
        cScalar * ceremony.deltaS) %
      R_MOD;
    const aScalar = (rhs * modInv(bScalar, R_MOD)) % R_MOD;
    const aPoint = await ecMulG1(aScalar);

    return {
      a: aPoint,
      b: bPoint,
      c: cPoint,
    };
  }

  describe("0. Cryptographic Soundness Against Legacy Trapdoors on Fresh Deployment", function () {
    it("Should reject both {1,1,1,1} and legacy {7,2,3,5} trapdoor forgeries on default constructor VK", async function () {
      const ZkVerifierFactory = await ethers.getContractFactory("GenomicZkVerifier");
      const freshZk = await ZkVerifierFactory.deploy(token.target);
      await freshZk.waitForDeployment();

      await token.connect(researcher).approve(freshZk.target, ethers.parseEther("300"));
      await freshZk.connect(researcher).createZkBounty(
        TRAIT_ALDH2_RS671,
        "Soundness Test Bounty",
        ethers.parseEther("100"),
        3,
        86400
      );

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("ATTACKER_TRAPDOOR_TEST"));
      const publicSignal = BigInt(
        ethers.keccak256(
          ethers.solidityPacked(["bytes32", "bytes32", "address"], [commitment, TRAIT_ALDH2_RS671, attacker.address])
        )
      ) % R_MOD;

      const C = await ecMulG1(1n);
      const legacy1111 = { a: await ecMulG1((2n + publicSignal) % R_MOD), b: G2_POINTS, c: C };
      const legacy7235 = { a: await ecMulG1((14n + 3n * publicSignal + 5n) % R_MOD), b: G2_POINTS, c: C };

      await expect(freshZk.connect(attacker).claimZkBounty(1, legacy1111, commitment))
        .to.be.revertedWithCustomError(freshZk, "InvalidZkProof");
      await expect(freshZk.connect(attacker).claimZkBounty(1, legacy7235, commitment))
        .to.be.revertedWithCustomError(freshZk, "InvalidZkProof");
    });
  });

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
      const variantCommitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_1_ALDH2_GENOMIC_WITNESS_PRIVATE"));
      const proof = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, variantCommitment);

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
      const variantCommitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_1_ALDH2_GENOMIC_WITNESS_PRIVATE"));
      const proof = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, variantCommitment);

      await zkVerifier.connect(donor1).claimZkBounty(bountyId, proof, variantCommitment);

      // Second attempt by donor1 must revert
      await expect(
        zkVerifier.connect(donor1).claimZkBounty(bountyId, proof, variantCommitment)
      ).to.be.revertedWithCustomError(zkVerifier, "DonorAlreadyClaimed");
    });

    it("Adversarial: Should reject proof with invalid field curve points", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_COMMITMENT"));
      const invalidProof = await createAuthenticZkProof(donor2.address, TRAIT_ALDH2_RS671, commitment);
      invalidProof.a[0] = P_MOD + 100n; // Exceeds field modulus

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

    it("Adversarial: Should reject tampered proof where point A is altered (native precompile 0x08 check fails)", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_COMMITMENT_TAMPER"));
      const validProof = await createAuthenticZkProof(donor2.address, TRAIT_ALDH2_RS671, commitment);

      // Tamper point A with a non-matching curve point (G1 instead of (publicSignal + 2)*G1)
      const tamperedProof = {
        a: [1n, 2n], // Generator G1: on curve, but fails pairing product != 1
        b: validProof.b,
        c: validProof.c,
      };

      await expect(
        zkVerifier.connect(donor2).claimZkBounty(bountyId, tamperedProof, commitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
    });

    it("Adversarial: Should reject proof generated for another donor (public signal mismatch)", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR_COMMITMENT_STEAL"));
      // Generated for donor1, but attacker tries to submit it
      const proofForDonor1 = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, commitment);

      await expect(
        zkVerifier.connect(attacker).claimZkBounty(bountyId, proofForDonor1, commitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
    });

    it("Adversarial: Should reject proof when commitment is tampered", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("REAL_COMMITMENT"));
      const tamperedCommitment = ethers.keccak256(ethers.toUtf8Bytes("TAMPERED_COMMITMENT"));
      const proof = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, commitment);

      await expect(
        zkVerifier.connect(donor1).claimZkBounty(bountyId, proof, tamperedCommitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
    });

    it("Should automatically deactivate bounty once maximum claims reached", async function () {
      const comm1 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_1"));
      const proof1 = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, comm1, 1n);
      await zkVerifier.connect(donor1).claimZkBounty(bountyId, proof1, comm1);

      const comm2 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_2"));
      const proof2 = await createAuthenticZkProof(donor2.address, TRAIT_ALDH2_RS671, comm2, 2n);
      await zkVerifier.connect(donor2).claimZkBounty(bountyId, proof2, comm2);

      const bounty = await zkVerifier.bounties(bountyId);
      expect(bounty.isActive).to.be.false;
      expect(bounty.currentClaims).to.equal(2);
      expect(bounty.remainingFunding).to.equal(0);

      // Third claim must revert with BountyExpiredOrInactive or BountyFullyClaimed
      const comm3 = ethers.keccak256(ethers.toUtf8Bytes("COMMITMENT_3"));
      const proof3 = await createAuthenticZkProof(attacker.address, TRAIT_ALDH2_RS671, comm3, 3n);
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

  describe("4. Administrative Token Rescue Safety (FIX-01)", function () {
    let dummyToken;

    beforeEach(async function () {
      const TokenFactory = await ethers.getContractFactory("GenomicToken");
      dummyToken = await TokenFactory.deploy(deployer.address);
      await dummyToken.waitForDeployment();
    });

    it("Should revert if owner attempts to rescue paymentToken ($GENO)", async function () {
      await expect(
        zkVerifier.connect(deployer).rescueTokens(token.target, deployer.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(zkVerifier, "CannotRescuePaymentToken");
    });

    it("Should revert if non-owner attempts to rescue tokens", async function () {
      await expect(
        zkVerifier.connect(attacker).rescueTokens(dummyToken.target, attacker.address, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(zkVerifier, "OwnableUnauthorizedAccount");
    });

    it("Should revert if destination address is address(0)", async function () {
      await expect(
        zkVerifier.connect(deployer).rescueTokens(dummyToken.target, ethers.ZeroAddress, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidAddress");
    });

    it("Should allow owner to safely rescue non-payment ERC20 tokens and emit TokensRescued", async function () {
      await dummyToken.faucet(deployer.address);
      await dummyToken.connect(deployer).transfer(zkVerifier.target, ethers.parseEther("500"));

      const balBefore = await dummyToken.balanceOf(researcher.address);
      await expect(
        zkVerifier.connect(deployer).rescueTokens(dummyToken.target, researcher.address, ethers.parseEther("500"))
      )
        .to.emit(zkVerifier, "TokensRescued")
        .withArgs(dummyToken.target, researcher.address, ethers.parseEther("500"));

      const balAfter = await dummyToken.balanceOf(researcher.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("500"));
    });
  });

  describe("5. GenomicsRegistry & GenomicZkVerifier Call-Graph Integration", function () {
    let registry;
    let nft;

    beforeEach(async function () {
      const NftFactory = await ethers.getContractFactory("GenomicNFT");
      nft = await NftFactory.deploy(deployer.address, 1000);
      await nft.waitForDeployment();

      const RegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
      registry = await RegistryFactory.deploy(token.target, nft.target, deployer.address);
      await registry.waitForDeployment();

      await nft.connect(deployer).setRegistryContract(registry.target);
    });

    it("Should allow owner to link zkVerifier and emit ZkVerifierUpdated", async function () {
      await expect(registry.connect(deployer).setZkVerifier(zkVerifier.target))
        .to.emit(registry, "ZkVerifierUpdated")
        .withArgs(ethers.ZeroAddress, zkVerifier.target);

      expect(await registry.zkVerifier()).to.equal(zkVerifier.target);
    });

    it("Should revert if non-owner attempts to set zkVerifier", async function () {
      await expect(
        registry.connect(attacker).setZkVerifier(zkVerifier.target)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("Should revert if linking zkVerifier to address(0)", async function () {
      await expect(
        registry.connect(deployer).setZkVerifier(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidRecipient");
    });

    it("Should verify dataset owner trait possession through the linked ZK Verifier", async function () {
      await registry.connect(deployer).setZkVerifier(zkVerifier.target);

      // Register dataset for donor1
      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_GENOMIC_RAW_VCF"));
      const rawCid = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
      const summaryCid = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
      const metaCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

      await registry.connect(donor1).registerGenomicData(
        rawHash,
        rawCid,
        summaryCid,
        metaCid,
        `ipfs://${metaCid}`,
        ethers.parseEther("100"),
        30 * 86400,
        1000
      );

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_ALDH2_SECRET_VARIANT_WITNESS"));

      // Before proof verification: registry query returns false
      expect(await registry.verifyDatasetTraitPossession(1, commitment)).to.be.false;

      // Researcher creates ZK bounty
      const tx = await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_RS671,
        "Target ALDH2 rs671 Cohort Discovery",
        ethers.parseEther("50"),
        5,
        14 * 86400
      );
      const receipt = await tx.wait();
      const bountyId = 1;

      expect(await registry.hasDonorClaimedZkBounty(bountyId, donor1.address)).to.be.false;

      // Donor1 submits authentic ZK proof
      const validProof = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, commitment);
      await zkVerifier.connect(donor1).claimZkBounty(bountyId, validProof, commitment);

      // After claim: registry query returns true!
      expect(await registry.hasDonorClaimedZkBounty(bountyId, donor1.address)).to.be.true;
      expect(await registry.verifyDatasetTraitPossession(1, commitment)).to.be.true;

      // Check wrong commitment returns false
      const wrongCommitment = ethers.keccak256(ethers.toUtf8Bytes("WRONG_COMMITMENT"));
      expect(await registry.verifyDatasetTraitPossession(1, wrongCommitment)).to.be.false;

      // Boundary check: non-existent dataset reverts DataNotFound
      await expect(
        registry.verifyDatasetTraitPossession(0, commitment)
      ).to.be.revertedWithCustomError(registry, "DataNotFound");
      await expect(
        registry.verifyDatasetTraitPossession(999, commitment)
      ).to.be.revertedWithCustomError(registry, "DataNotFound");
    });

    it("Should return false when zkVerifier is address(0) without reverting", async function () {
      // In a fresh unlinked registry or if zkVerifier is 0, view calls should return false
      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_GENOMIC_RAW_VCF_UNLINKED"));
      await registry.connect(donor1).registerGenomicData(
        rawHash,
        "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
        "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
        "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        ethers.parseEther("100"),
        30 * 86400,
        1000
      );

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("UNLINKED_COMMITMENT"));
      expect(await registry.zkVerifier()).to.equal(ethers.ZeroAddress);
      expect(await registry.verifyDatasetTraitPossession(1, commitment)).to.be.false;
      expect(await registry.hasDonorClaimedZkBounty(1, donor1.address)).to.be.false;
    });

    it("Should dynamically track secondary market NFT ownership in verifyDatasetTraitPossession", async function () {
      await registry.connect(deployer).setZkVerifier(zkVerifier.target);

      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_TRANSFER_TEST_VCF"));
      await registry.connect(donor1).registerGenomicData(
        rawHash,
        "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
        "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
        "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        ethers.parseEther("100"),
        30 * 86400,
        1000
      );

      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_TRAIT_COMMITMENT"));
      await zkVerifier.connect(researcher).createZkBounty(
        TRAIT_ALDH2_RS671,
        "Target ALDH2 Cohort",
        ethers.parseEther("20"),
        3,
        14 * 86400
      );
      const validProof = await createAuthenticZkProof(donor1.address, TRAIT_ALDH2_RS671, commitment);
      await zkVerifier.connect(donor1).claimZkBounty(1, validProof, commitment);

      // Initially donor1 owns token 1 -> verified true
      expect(await registry.verifyDatasetTraitPossession(1, commitment)).to.be.true;

      // Donor1 transfers NFT to donor2 on secondary market
      await nft.connect(donor1).transferFrom(donor1.address, donor2.address, 1);
      expect(await nft.ownerOf(1)).to.equal(donor2.address);

      // Now dataset 1 is owned by donor2 who has NOT proven possession of this commitment -> returns false!
      expect(await registry.verifyDatasetTraitPossession(1, commitment)).to.be.false;
    });
  });

  describe("6. Authentic Groth16 Ceremony Setup & Verification Key Rotation", function () {
    it("Should allow owner to configure ceremony verification key and emit VerificationKeyUpdated", async function () {
      const alphaG1 = await ecMulG1(randomScalar());
      const betaG2 = g2MulEip197(randomScalar());
      const gammaG2 = g2MulEip197(randomScalar());
      const deltaG2 = g2MulEip197(randomScalar());
      const ic0G1 = await ecMulG1(randomScalar());
      const ic1G1 = await ecMulG1(randomScalar());

      await expect(
        zkVerifier.connect(deployer).setupVerificationKey(alphaG1, betaG2, gammaG2, deltaG2, ic0G1, ic1G1)
      )
        .to.emit(zkVerifier, "VerificationKeyUpdated")
        .withArgs(deployer.address);
    });

    it("Should revert if non-owner attempts setupVerificationKey", async function () {
      const alphaG1 = [1n, 2n];
      await expect(
        zkVerifier.connect(attacker).setupVerificationKey(alphaG1, G2_POINTS, G2_POINTS, G2_POINTS, alphaG1, alphaG1)
      ).to.be.revertedWithCustomError(zkVerifier, "OwnableUnauthorizedAccount");
    });

    it("Should revert if ceremony curve points are invalid or G2 parameters collide", async function () {
      const invalidAlphaG1 = [1n, 1n];
      const validG1 = await ecMulG1(randomScalar());
      const g2a = g2MulEip197(11n);
      const g2b = g2MulEip197(13n);
      const g2c = g2MulEip197(17n);

      await expect(
        zkVerifier.connect(deployer).setupVerificationKey(invalidAlphaG1, g2a, g2b, g2c, validG1, validG1)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");

      // Colliding beta == gamma must revert
      await expect(
        zkVerifier.connect(deployer).setupVerificationKey(validG1, g2a, g2a, g2c, validG1, validG1)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");
    });
  });
});
