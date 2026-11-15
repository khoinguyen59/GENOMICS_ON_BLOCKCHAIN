/**
 * AGENT 6/6 — INDEPENDENT BLIND ADVERSARIAL TEST (Task 6)
 * Target: contracts/GenomicZkVerifier.sol
 *
 * Threat model (black-box, no access to project helpers):
 *   An attacker who can only read the deployed bytecode / public source and the
 *   bounty parameters from the EVM, and who possesses NO genomic data, NO Groth16
 *   witness and NO trusted-setup secret, attempts to forge a "valid" proof and
 *   drain a victim sponsor's escrowed $GENO bounty funding.
 *
 * Security property asserted (INV-17: assert DEFENCE, never exploit success):
 *   "A proof that is not bound to a real circuit witness MUST be rejected with
 *    InvalidZkProof, and the victim sponsor's funds MUST be preserved 100%."
 *
 * If this test FAILS, the verifier is unsound.
 */
import { expect } from "chai";
import hre from "hardhat";

const P_MOD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R_MOD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// BN254 G1 generator
const G1_X = 1n;
const G1_Y = 2n;
// BN254 G2 generator in EIP-197 word order: [x_im, x_re, y_im, y_re]
const G2_GEN = [
  0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2n,
  0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6edn,
  0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975bn,
  0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daan,
];

const w32 = (n) => n.toString(16).padStart(64, "0");

describe("AGENT6 :: GenomicZkVerifier proof soundness (blind adversarial)", function () {
  let ethers;
  let token;
  let zkVerifier;
  let sponsor;
  let attacker;

  const G1 = { x: G1_X, y: G1_Y };

  /** ecAdd via EVM precompile 0x06 — real curve arithmetic, no mocking. */
  async function ecAdd(p, q) {
    const data =
      "0x" + w32(p.x % P_MOD) + w32(p.y % P_MOD) + w32(q.x % P_MOD) + w32(q.y % P_MOD);
    const res = await ethers.provider.call({
      to: "0x0000000000000000000000000000000000000006",
      data,
    });
    return {
      x: BigInt(ethers.dataSlice(res, 0, 32)),
      y: BigInt(ethers.dataSlice(res, 32, 64)),
    };
  }

  /** ecMul via EVM precompile 0x07. */
  async function ecMul(p, s) {
    const data = "0x" + w32(p.x) + w32(p.y) + w32(s % R_MOD);
    const res = await ethers.provider.call({
      to: "0x0000000000000000000000000000000000000007",
      data,
    });
    return {
      x: BigInt(ethers.dataSlice(res, 0, 32)),
      y: BigInt(ethers.dataSlice(res, 32, 64)),
    };
  }

  /**
   * FORGERY derived only from GenomicZkVerifier.sol:272-343 source reading.
   * The contract checks (EIP-197 word order [P.x, P.y, Q.x_im, Q.x_re, Q.y_im, Q.y_re]):
   *   e(-A, B) * e(G1, Qg) * e(vk_x, Qg) * e(C, Qg) == 1
   * Picking B := Qg (the public G2 generator) collapses every term onto one G2 point:
   *   e(-A + G1 + vk_x + C, Qg) == 1
   * By non-degeneracy of the optimal-ate pairing this holds iff
   *   A == G1 + vk_x + C          (a pure public G1 point addition)
   * vk_x = publicSignal * G1, and publicSignal = keccak(commitment, traitId, msg.sender)
   * — all three inputs are chosen/known by the attacker. No secret exists.
   */
  async function forgeProof(donorAddress, traitId, commitment) {
    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "address"],
      [commitment, traitId, donorAddress]
    );
    const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;

    const vkX = await ecMul(G1, publicSignal);
    const C = G1; // arbitrary non-zero point, c[0] == 1 != 0 passes :274
    let A = await ecAdd(G1, vkX);
    A = await ecAdd(A, C);

    return {
      a: [A.x, A.y],
      b: [
        [G2_GEN[0], G2_GEN[1]],
        [G2_GEN[2], G2_GEN[3]],
      ],
      c: [C.x, C.y],
    };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [sponsor, attacker] = await ethers.getSigners();

    const TokenF = await ethers.getContractFactory("GenomicToken");
    token = await TokenF.deploy(sponsor.address);
    await token.waitForDeployment();

    const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkF.deploy(token.target);
    await zkVerifier.waitForDeployment();

    await token.faucet(sponsor.address); // 1,000 GENO
    await token
      .connect(sponsor)
      .approve(zkVerifier.target, ethers.parseUnits("10000", 18));
  });

  it("A1 forged Groth16 proof from public constants must be REJECTED and sponsor funds preserved", async function () {
    // Arrange: sponsor funds a real bounty of 100 GENO x 2 claims
    const reward = ethers.parseUnits("100", 18);
    const createTx = await zkVerifier
      .connect(sponsor)
      .createZkBounty(
        ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous")),
        "ALDH2 rs671 cohort",
        reward,
        2,
        86400
      );
    await createTx.wait();

    const bounty = await zkVerifier.bounties(1);
    const traitId = bounty.targetTraitId;
    const sponsorBalBefore = await token.balanceOf(sponsor.address);
    const attackerBalBefore = await token.balanceOf(attacker.address);
    expect(bounty.sponsor).to.equal(sponsor.address);

    // Act: attacker with NO genetic data submits a forged proof for a made-up commitment
    const fakeCommitment = ethers.keccak256(
      ethers.toUtf8Bytes("ATTACKER_INVENTED_WITNESS_NO_REAL_GENOME")
    );
    const proof = await forgeProof(attacker.address, traitId, fakeCommitment);

    let rejected = false;
    let receipt = null;
    try {
      receipt = await (
        await zkVerifier
          .connect(attacker)
          .claimZkBounty(1, proof, fakeCommitment)
      ).wait();
    } catch (e) {
      rejected = true;
    }

    // Assert the DEFENSIVE property (not the attack outcome)
    const attackerBalAfter = await token.balanceOf(attacker.address);

    expect(
      rejected,
      `UNSOUND VERIFIER: forged proof was ACCEPTED (tx ${receipt?.hash}); ` +
        `attacker balance moved ${attackerBalBefore} -> ${attackerBalAfter}`
    ).to.equal(
      true,
      `attacker delta = ${attackerBalAfter - attackerBalBefore} wei; ` +
        `sponsor had ${sponsorBalBefore} wei`
    );
    expect(attackerBalAfter, "attacker must not receive bounty reward").to.equal(
      attackerBalBefore
    );
    expect(
      await token.balanceOf(zkVerifier.target),
      "bounty escrow must remain fully funded"
    ).to.equal(reward * 2n);
  });

  it("A1b legacy {7,2,3,5} trapdoor forgery must ALSO be rejected", async function () {
    const reward = ethers.parseUnits("100", 18);
    await (
      await zkVerifier
        .connect(sponsor)
        .createZkBounty(
          ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous")),
          "ALDH2 trapdoor guard",
          reward,
          2,
          86400
        )
    ).wait();
    const traitId = (await zkVerifier.bounties(1)).targetTraitId;
    const fakeCommitment = ethers.keccak256(ethers.toUtf8Bytes("ATTACKER_7235_TRAPDOOR"));
    const publicSignal =
      BigInt(
        ethers.keccak256(
          ethers.solidityPacked(["bytes32", "bytes32", "address"], [fakeCommitment, traitId, attacker.address])
        )
      ) % R_MOD;
    const cScalar = 1n;
    const aScalar = (14n + 3n * publicSignal + 5n * cScalar) % R_MOD;
    const ecMulG1 = async (scalar) => {
      const res = await ethers.provider.call({
        to: "0x0000000000000000000000000000000000000007",
        data: ethers.concat([
          ethers.zeroPadValue("0x01", 32),
          ethers.zeroPadValue("0x02", 32),
          ethers.zeroPadValue(ethers.toBeHex(scalar % R_MOD), 32),
        ]),
      });
      return [BigInt(ethers.dataSlice(res, 0, 32)), BigInt(ethers.dataSlice(res, 32, 64))];
    };
    const trapProof = {
      a: await ecMulG1(aScalar),
      b: [
        [G2_GEN[0], G2_GEN[1]],
        [G2_GEN[2], G2_GEN[3]],
      ],
      c: await ecMulG1(cScalar),
    };
    await expect(zkVerifier.connect(attacker).claimZkBounty(1, trapProof, fakeCommitment))
      .to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
    expect(await token.balanceOf(attacker.address)).to.equal(0n);
  });

  it("A2 hasVerifiedVariant must never become true for a commitment not backed by a real circuit", async function () {
    const reward = ethers.parseUnits("10", 18);
    await (
      await zkVerifier
        .connect(sponsor)
        .createZkBounty(
          ethers.keccak256(ethers.toUtf8Bytes("ACTN3_rs1815739")),
          "ACTN3 R577X",
          reward,
          1,
          86400
        )
    ).wait();
    const traitId = (await zkVerifier.bounties(1)).targetTraitId;

    const commitment = ethers.keccak256(ethers.toUtf8Bytes("FORGED_COMMIT_X"));
    const proof = await forgeProof(attacker.address, traitId, commitment);
    try {
      await (
        await zkVerifier
          .connect(attacker)
          .claimZkBounty(1, proof, commitment)
      ).wait();
    } catch (_) {
      /* expected */
    }

    expect(
      await zkVerifier.hasVerifiedVariant(commitment, attacker.address),
      "attacker must NOT be recorded as holding a verified genomic variant"
    ).to.equal(false);
  });

  it("A3 (control) rejects degenerate/identity proofs — baseline guard is present", async function () {
    const reward = ethers.parseUnits("10", 18);
    await (
      await zkVerifier
        .connect(sponsor)
        .createZkBounty(
          ethers.keccak256(ethers.toUtf8Bytes("CYP1A2_rs762551")),
          "CYP1A2 caffeine",
          reward,
          1,
          86400
        )
    ).wait();
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("CTRL_X"));

    await expect(
      zkVerifier.connect(attacker).claimZkBounty(
        1,
        { a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] },
        commitment
      )
    ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");

    // out-of-field coordinates must be rejected by validateCurvePoints (GenomicZkVerifier.sol:254)
    await expect(
      zkVerifier.connect(attacker).claimZkBounty(
        1,
        { a: [P_MOD, 1n], b: [[1n, 2n], [3n, 4n]], c: [5n, 6n] },
        commitment
      )
    ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");

    // empty commitment must be rejected (GenomicZkVerifier.sol:175)
    await expect(
      zkVerifier.connect(attacker).claimZkBounty(
        1,
        { a: [1n, 2n], b: [G2_GEN.slice(0, 2), G2_GEN.slice(2)], c: [1n, 2n] },
        ethers.ZeroHash
      )
    ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");
  });
});
