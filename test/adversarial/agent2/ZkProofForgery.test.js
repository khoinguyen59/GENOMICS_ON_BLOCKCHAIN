/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.h)
 * GenomicZkVerifier: BN254 (alt_bn128) Groth16-shape verification with a hard-coded
 * "trusted setup". This suite forges a proof with real curve arithmetic and checks
 * whether sponsor funds can be claimed without any genetic witness.
 *
 * Point arithmetic is only used to BUILD the attack input; every verdict is taken
 * from on-chain state (balances, claim counters) after tx.wait().
 */
import { expect } from "chai";
import hre from "hardhat";

const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const G1 = [1n, 2n];
// the exact G2 constant the contract re-uses for beta, gamma AND delta
const G2 = [
  [0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2n,
   0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6edn],
  [0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975bn,
   0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daan],
];

const mod = (a, m = P_MOD) => ((a % m) + m) % m;

function inv(a, m = P_MOD) {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}

function ecAdd(p, q) {
  if (p === null) return q;
  if (q === null) return p;
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null;
  const slope = (p[0] === q[0] && p[1] === q[1])
    ? mod(3n * p[0] * p[0] * inv(2n * p[1]))
    : mod((q[1] - p[1]) * inv(q[0] - p[0]));
  const x = mod(slope * slope - p[0] - q[0]);
  const y = mod(slope * (p[0] - x) - p[1]);
  return [x, y];
}

function ecMul(p, k) {
  let acc = null;
  let addend = p;
  let n = mod(k, R_MOD);
  while (n > 0n) {
    if (n & 1n) acc = ecAdd(acc, addend);
    addend = ecAdd(addend, addend);
    n >>= 1n;
  }
  return acc;
}

// on-curve sanity check for the helper itself (not a contract assertion)
function isOnCurve(pt) {
  return pt !== null && mod(pt[1] * pt[1]) === mod(pt[0] ** 3n + 3n);
}

async function capture(send) {
  try {
    const v = await send();
    if (v && v.wait) {
      const r = await v.wait();
      return { ok: r.status === 1, receipt: r, error: `mined-status-${r.status}` };
    }
    return { ok: true, receipt: null, error: null };
  } catch (e) {
    return { ok: false, receipt: null, error: String(e && e.message ? e.message : e) };
  }
}

describe("AGENT2 :: GenomicZkVerifier BN254 proof forgery (fake trusted setup)", function () {
  this.timeout(240000);
  let ethers, token, zk, sponsor, donor, other;
  const reward = 100n * 10n ** 18n;
  const maxClaims = 2n;
  const traitSeed = "ALDH2_rs671_A_heterozygous";

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [sponsor, donor, other] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(sponsor.address);
    await token.waitForDeployment();

    const Z = await ethers.getContractFactory("GenomicZkVerifier");
    zk = await Z.deploy(token.target);
    await zk.waitForDeployment();

    const fund = reward * maxClaims;
    await (await token.connect(sponsor).approve(zk.target, fund)).wait();
    const c = await capture(() => zk.connect(sponsor).createZkBounty(
      ethers.keccak256(ethers.toUtf8Bytes(traitSeed)),
      "Aldehyde Dehydrogenase 2 Deficiency rs671(A)",
      reward, maxClaims, 86400
    ));
    expect(c.ok, c.error).to.equal(true);
    expect(await token.balanceOf(zk.target)).to.equal(fund);
  });

  function buildForgedProof(commitment, traitId, claimant) {
    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "address"],
      [commitment, traitId, claimant]
    );
    const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;
    // the pairing product collapses to  e(-A + alpha + vk_x + C, G2) == 1
    // with alpha = C = G1 and vk_x = publicSignal * G1
    const A = ecMul(G1, publicSignal + 2n);
    expect(isOnCurve(A), "test helper produced an off-curve point").to.equal(true);
    return {
      proof: [[A[0], A[1]], G2, [G1[0], G1[1]]],
      publicSignal,
    };
  }

  it("A2-Z01 trivial / identity proofs are rejected and pay nothing", async function () {
    const traitId = ethers.keccak256(ethers.toUtf8Bytes(traitSeed));
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("fake-commitment-1"));
    const pre = await token.balanceOf(donor.address);

    const cases = [
      [[0n, 0n], G2, [G1[0], G1[1]]],       // zero A
      [[G1[0], G1[1]], G2, [0n, 0n]],       // zero C
      [[G1[0], G1[1]], [[0n, 0n], [0n, 0n]], [G1[0], G1[1]]], // zero B
      [[1n, 3n], G2, [G1[0], G1[1]]],       // off-curve A (y^2 != x^3+3)
    ];

    for (const proof of cases) {
      const res = await capture(() => zk.connect(donor).claimZkBounty(1n, proof, commitment));
      expect(res.ok, `identity/off-curve proof ${JSON.stringify(proof.map(String))} was accepted`).to.equal(false);
      expect(res.error).to.contain("revert");
    }

    expect(await token.balanceOf(donor.address)).to.equal(pre);
    expect((await zk.bounties(1n)).currentClaims).to.equal(0n);
  });

  it("A2-Z02 REQUIRED: a proof with no circuit behind it must not release bounty funds", async function () {
    const traitId = ethers.keccak256(ethers.toUtf8Bytes(traitSeed));
    // the attacker knows NO genomic witness and there is NO trusted setup file anywhere
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("attacker-invented-commitment"));
    const { proof } = buildForgedProof(commitment, traitId, donor.address);

    const preDonor = await token.balanceOf(donor.address);
    const preZk = await token.balanceOf(zk.target);

    const res = await capture(() => zk.connect(donor).claimZkBounty(1n, proof, commitment));
    const postDonor = await token.balanceOf(donor.address);
    const postZk = await token.balanceOf(zk.target);
    const bounty = await zk.bounties(1n);

    expect(
      postDonor - preDonor,
      `forged BN254 proof accepted (ok=${res.ok}, err=${res.error}): donor gained ${postDonor - preDonor}, ` +
      `zk custody ${preZk} -> ${postZk}, currentClaims=${bounty.currentClaims}, ` +
      `verifiedCommitments=${await zk.verifiedCommitments(commitment, donor.address)}. ` +
      `verifyProofInternal reuses one G2 constant for beta/gamma/delta so the check degenerates to A=(2+pub)G1`
    ).to.equal(0n);
  });

  it("A2-Z03 the (weak) verifier still binds the public signal to the claimant address", async function () {
    const traitId = ethers.keccak256(ethers.toUtf8Bytes(traitSeed));
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("cross-use-commitment"));
    const forgedForDonor = buildForgedProof(commitment, traitId, donor.address).proof;

    const pre = await token.balanceOf(other.address);
    const res = await capture(() => zk.connect(other).claimZkBounty(1n, forgedForDonor, commitment));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("InvalidZkProof()");
    expect(await token.balanceOf(other.address)).to.equal(pre);
  });

  it("A2-Z04 bounty lifecycle guards: id bounds, expiry, double-claim and sponsor-only close", async function () {
    const traitId = ethers.keccak256(ethers.toUtf8Bytes(traitSeed));
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-commitment"));
    const { proof } = buildForgedProof(commitment, traitId, donor.address);

    const idZero = await capture(() => zk.connect(donor).claimZkBounty(0n, proof, commitment));
    expect(idZero.ok).to.equal(false);
    expect(idZero.error).to.contain("BountyExpiredOrInactive()");

    const total = await zk.bountyCount();
    const idHigh = await capture(() => zk.connect(donor).claimZkBounty(total + 1n, proof, commitment));
    expect(idHigh.ok).to.equal(false);
    expect(idHigh.error).to.contain("BountyExpiredOrInactive()");

    const zeroCommit = await capture(() => zk.connect(donor).claimZkBounty(1n, proof, ethers.ZeroHash));
    expect(zeroCommit.ok).to.equal(false);
    expect(zeroCommit.error).to.contain("InvalidZkProof()");

    const closeEarly = await capture(() => zk.connect(sponsor).closeExpiredBounty(1n));
    expect(closeEarly.ok).to.equal(false);
    expect(closeEarly.error).to.contain("BountyNotExpired()");

    const rescue = await capture(() => zk.connect(sponsor).rescueTokens(token.target, sponsor.address, 1n));
    expect(rescue.ok).to.equal(false);
    expect(rescue.error).to.contain("CannotRescuePaymentToken()");

    // bounty parameters are validated
    const badDuration = await capture(() => zk.connect(sponsor).createZkBounty(
      traitId, "too short", reward, 1n, 3599));
    expect(badDuration.ok).to.equal(false);
    expect(badDuration.error).to.contain("InvalidBountyParameters()");
    void traitId; void commitment;
  });
});
