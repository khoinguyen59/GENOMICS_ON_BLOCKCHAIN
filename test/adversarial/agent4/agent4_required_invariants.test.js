/**
 * AGENT 4/6 — DOC LAP ADVERSARIAL SUITE (PART 2: cac ASSERTION DANH INvariant AN TOAN)
 *
 * Day la "failing regression tests" theo step 5 cua skill `test-and-fix`:
 * Moi `it` ASSERT BE MAT AN TOAN MA DE TAI/YEU CAU BAT BUOC (AGENTS.md INV-01..18,
 * docs/specs/01_project_rubric.md). Neu test FAIL => defect THAT, co evidence do luong
 * EVM thuc (INV-17: khong assert so hoc JS, khong coi "exploit thành cong" la PASS).
 *
 * Read-only: khong sua mau nguon; chi them file moi trong test/adversarial/agent4/.
 */
import { expect } from "chai";
import hre from "hardhat";

const G1_GEN = [1n, 2n];
const G2_GEN = [
  [
    BigInt("0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2"),
    BigInt("0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed"),
  ],
  [
    BigInt("0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b"),
    BigInt("0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
  ],
];
const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const E18 = 10n ** 18n;
const PRICE = 100n * E18;
const DURATION = 30n * 24n * 3600n;

const fp = (a) => ((a % P_MOD) + P_MOD) % P_MOD;
function modPow(base, exp, mod) {
  let out = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) out = (out * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return out;
}
function jsG1Add(p, q) {
  if (p[0] === 0n && p[1] === 0n) return q;
  if (q[0] === 0n && q[1] === 0n) return p;
  let m;
  if (p[0] === q[0]) {
    if (fp(p[1] + q[1]) === 0n) return [0n, 0n];
    m = fp(3n * fp(p[0] * p[0]) * modPow(fp(2n * p[1]), P_MOD - 2n, P_MOD));
    const x = fp(m * m - 2n * p[0]);
    return [x, fp(m * (p[0] - x) - p[1])];
  }
  m = fp((p[1] - q[1]) * modPow(p[0] - q[0], P_MOD - 2n, P_MOD));
  const x = fp(m * m - p[0] - q[0]);
  return [x, fp(m * (p[0] - x) - p[1])];
}
function jsG1Mul(k, p = G1_GEN) {
  let s = ((k % R_MOD) + R_MOD) % R_MOD;
  let acc = [0n, 0n];
  let cur = p;
  while (s > 0n) {
    if (s & 1n) acc = jsG1Add(acc, cur);
    cur = jsG1Add(cur, cur);
    s >>= 1n;
  }
  return acc;
}

/**
 * THE FORGERY. contracts/GenomicZkVerifier.sol:309-330 hard-codes
 *   alpha = G1 = (1,2)   and   beta = gamma = delta = the SAME G2 generator g2.
 * The Groth16 check  e(-A,B) * e(alpha,beta) * e(vk_x,gamma) * e(C,delta) = 1
 * with vk_x = publicSignal * G1 therefore collapses by bilinearity to
 *   e( -A + (1 + publicSignal) * G1 + C , g2 ) = 1
 * which is satisfied by  A = (1 + publicSignal + cScalar) * G1,  C = cScalar * G1.
 * publicSignal = keccak256(commitment || traitId || donor) is 100% public.
 * => no witness, no circuit, no trusted setup: anyone can mint a "valid" proof in JS.
 */
function forgeProof(ethers, commitment, traitId, donorAddress, cScalar = 1n) {
  const packed = ethers.solidityPacked(["bytes32", "bytes32", "address"], [commitment, traitId, donorAddress]);
  const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;
  const C = jsG1Mul(cScalar);
  const A = jsG1Mul((1n + publicSignal + cScalar) % R_MOD);
  return { a: A, b: G2_GEN, c: C };
}

describe("AGENT4 / PART2 — assertions of the required security invariants (failures ARE the defects)", function () {
  let ethers;
  let owner, sponsor, donor1, donor2, attacker, buyerA, buyerB, stranger;
  let token, nft, registry;

  async function deployStack(paymentToken) {
    const NftF = await ethers.getContractFactory("GenomicNFT");
    const newNft = await NftF.deploy(owner.address, 1000);
    await newNft.waitForDeployment();
    const RegF = await ethers.getContractFactory("GenomicsRegistry");
    const newReg = await RegF.deploy(paymentToken.target, newNft.target, owner.address);
    await newReg.waitForDeployment();
    await (await newNft.setRegistryContract(newReg.target)).wait();
    return { newNft, newReg };
  }

  async function register(seed, reg = registry, who = owner, price = PRICE) {
    const cid = `QmAgent4P2${seed}00000000000000000000000000000000`;
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`agent4-p2-${seed}`));
    await (await reg.connect(who).registerGenomicData(hash, cid, cid, cid, `ipfs://${seed}`, price, DURATION, 1000)).wait();
    return await reg.dataCount();
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, sponsor, donor1, donor2, attacker, buyerA, buyerB, stranger] = await ethers.getSigners();
    const TokenF = await ethers.getContractFactory("GenomicToken");
    token = await TokenF.deploy(owner.address);
    await token.waitForDeployment();
    const { newNft, newReg } = await deployStack(token);
    nft = newNft;
    registry = newReg;
    for (const b of [buyerA, buyerB, stranger]) {
      await (await token.connect(owner).transfer(b.address, 10_000n * E18)).wait();
      await (await token.connect(b).approve(registry.target, 10_000n * E18)).wait();
    }
  });

  // ==================================================================
  describe("DEF4-01 / DEF4-02 — Task 3 + Task 2: GenomicZkVerifier soundness (INV: ZK = proof of KNOWLEDGE)", function () {
    let zk, zkToken;
    const REWARD = 100n * E18;
    const MAX_CLAIMS = 3n;
    beforeEach(async function () {
      const TokenF = await ethers.getContractFactory("GenomicToken");
      zkToken = await TokenF.deploy(owner.address);
      await zkToken.waitForDeployment();
      const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
      zk = await ZkF.deploy(zkToken.target);
      await zk.waitForDeployment();
      await (await zkToken.connect(owner).transfer(sponsor.address, REWARD * MAX_CLAIMS)).wait();
      await (await zkToken.connect(sponsor).approve(zk.target, REWARD * MAX_CLAIMS)).wait();
      await (
        await zk
          .connect(sponsor)
          .createZkBounty(ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous")), "rs671", REWARD, MAX_CLAIMS, 30n * 86400n)
      ).wait();
    });

    it("DEF4-01: a proof computed OFFLINE in JavaScript, with no genomic witness and no trusted setup, must be REJECTED", async function () {
      const traitId = (await zk.bounties(1n)).targetTraitId;
      const fakeCommitment = ethers.keccak256(ethers.toUtf8Bytes("attacker-invented-commitment"));
      const proof = forgeProof(ethers, fakeCommitment, traitId, attacker.address);

      let accepted = false;
      let reason = null;
      try {
        await (await zk.connect(attacker).claimZkBounty(1n, proof, fakeCommitment)).wait();
        accepted = true;
      } catch (e) {
        reason = e.shortMessage || e.message;
      }
      const paid = await zkToken.balanceOf(attacker.address);
      const claims = (await zk.bounties(1n)).currentClaims;
      console.log(
        `AGENT4/DEF4-01 accepted=${accepted} attackerPaid=${paid / E18}GENO claims=${claims} reason=${reason}`
      );
      // REQUIRED BEHAVIOUR (rubric 3.x "BN254 Groth16 zer-knowledge chứng minh possess variant"):
      expect(accepted, `CRITICAL: forged Groth16 proof was ACCEPTED (paid ${paid / E18} GENO)`).to.equal(false);
      expect(paid).to.equal(0n);
      expect(claims).to.equal(0n);
    });

    it("DEF4-01b: legacy {7,2,3,5} trapdoor forgery must ALSO be REJECTED against default constructor VK", async function () {
      const traitId = (await zk.bounties(1n)).targetTraitId;
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("attacker-7235-trapdoor-test"));
      const packed = ethers.solidityPacked(["bytes32", "bytes32", "address"], [commitment, traitId, attacker.address]);
      const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;
      const cScalar = 1n;
      const aScalar = (14n + 3n * publicSignal + 5n * cScalar) % R_MOD;
      const trapdoorProof = { a: jsG1Mul(aScalar), b: G2_GEN, c: jsG1Mul(cScalar) };
      await expect(zk.connect(attacker).claimZkBounty(1n, trapdoorProof, commitment))
        .to.be.revertedWithCustomError(zk, "InvalidZkProof");
      expect(await zkToken.balanceOf(attacker.address)).to.equal(0n);
      expect((await zk.bounties(1n)).currentClaims).to.equal(0n);
    });

    it("DEF4-02: bounty funds must NOT be drainable by Sybil EOAs holding zero genomic data", async function () {
      const traitId = (await zk.bounties(1n)).targetTraitId;
      const sybils = [];
      for (let i = 0; i < 3; i++) {
        const w = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`agent4-zk-sybil-${i}`)), ethers.provider);
        await (await owner.sendTransaction({ to: w.address, value: ethers.parseEther("0.5") })).wait();
        sybils.push(w);
      }
      let claims = 0;
      for (const w of sybils) {
        const commitment = ethers.keccak256(ethers.toUtf8Bytes(`no-witness-${w.address}`));
        const proof = forgeProof(ethers, commitment, traitId, w.address);
        try {
          await (await zk.connect(w).claimZkBounty(1n, proof, commitment)).wait();
          claims++;
        } catch (e) {
          console.log(`AGENT4/DEF4-02 sybil claim rejected: ${e.shortMessage || e.message}`);
        }
      }
      const verifierLeft = await zkToken.balanceOf(zk.target);
      let sybilTotal = 0n;
      for (const w of sybils) sybilTotal += await zkToken.balanceOf(w.address);
      const bounty = await zk.bounties(1n);
      console.log(
        `AGENT4/DEF4-02 successfulClaims=${claims} sybilTotal=${sybilTotal / E18}GENO ` +
          `verifierLeft=${verifierLeft / E18}GENO currentClaims=${bounty.currentClaims} isActive=${bounty.isActive}`
      );
      // REQUIRED BEHAVIOUR: without a valid witness nobody withdraws a single wei.
      expect(claims, "CRITICAL: forged Sybil claims were accepted").to.equal(0);
      expect(sybilTotal, "CRITICAL: bounty paid to accounts holding no genomic data").to.equal(0n);
      expect(verifierLeft).to.equal(REWARD * MAX_CLAIMS, "bounty principal must be intact");
    });

    it("DEF4-03: the public API must not claim curve validation it does not perform (off-field-boundary only)", async function () {
      // validateCurvePoints (L254-258) only does `>= P_MOD`. An in-field but OFF-CURVE
      // G1 point must still be rejected *as an invalid curve point*, not merely by luck of
      // the pairing precompile. The @dev comment at L250-252 says "lie within the field
      // boundary" while the NatSpec/error name promises curve membership.
      const traitId = (await zk.bounties(1n)).targetTraitId;
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("offcurve-check"));
      const offCurve = { a: [1n, 3n], b: G2_GEN, c: G1_GEN };
      let revertName = null;
      let revertText = null;
      try {
        await (await zk.connect(attacker).claimZkBounty(1n, offCurve, commitment)).wait();
      } catch (e) {
        revertText = e?.shortMessage || e?.message || null;
        revertName =
          e?.revert?.name ??
          (revertText && revertText.includes("InvalidCurvePoint") ? "InvalidCurvePoint" : null);
      }
      console.log(`AGENT4/DEF4-03 offCurve revertName=${revertName} text=${revertText}`);
      expect(revertName, "off-curve point must be rejected as InvalidCurvePoint").to.equal("InvalidCurvePoint");
    });
  });

  // ==================================================================
  describe("DEF4-04 / 05 / 06 / 07 — Task 2: INV-16 lifecycle symmetry & buyer protection", function () {
    it("DEF4-04: after emitTransformedCapsule the buyer must be able to read the capsule from CHAIN STATE (or keep the refund right)", async function () {
      const dataId = await register("event-only");
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 2n * 86400n)).wait();
      const capsule = JSON.stringify({ version: "GNC1", keyCipher: "ab".repeat(512) });
      const seller0 = await token.balanceOf(owner.address);
      await (await registry.emitTransformedCapsule(dataId, buyerA.address, capsule)).wait();
      const seller1 = await token.balanceOf(owner.address);

      const onChain = await registry.connect(buyerA).getTransformedCapsule.staticCall(dataId);
      const ownerView = await registry.getCapsuleForBuyer.staticCall(dataId, buyerA.address);
      console.log(
        `AGENT4/DEF4-04 sellerPaid=${(seller1 - seller0) / E18}GENO getTransformedCapsule="${onChain}"` +
          ` getCapsuleForBuyer="${ownerView}"`
      );
      // money already left the escrow, so the buyer's only protection is on-chain availability:
      expect(seller1 - seller0).to.equal(PRICE, "escrow was already released");
      expect(onChain, "CRITICAL: escrow paid out but the capsule is NOT in chain state").to.equal(capsule);
      expect(ownerView).to.equal(capsule);
    });

    it("DEF4-05: a buyer who paid through grantAccessWithEscrow and never received a capsule must recover 100% of the payment", async function () {
      const dataId = await register("no-show");
      const buyer0 = await token.balanceOf(buyerA.address);
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 3600n)).wait();
      const paid = buyer0 - (await token.balanceOf(buyerA.address));
      expect(paid).to.equal(PRICE);

      // the seller now simply never calls storeTransformedCapsule; advance past dispute window
      await ethers.provider.send("evm_increaseTime", [3605]);
      await ethers.provider.send("evm_mine", []);
      let refundReason = null;
      try {
        await (await registry.connect(buyerA).claimEscrowRefund(dataId)).wait();
      } catch (e) {
        refundReason = e.shortMessage || e.message;
      }
      console.log(
        `AGENT4/DEF4-05 paid=${paid / E18}GENO refundRevert="${refundReason}"`
      );
      expect(refundReason).to.equal(null);
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0, "buyer funds must be recoverable");
    });

    it("DEF4-06: hasActiveAccess must never be true while capsule retrieval is impossible", async function () {
      const dataId = await register("phantom-access");
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 2n * 86400n)).wait();
      const flag = await registry.hasActiveAccess.staticCall(dataId, buyerA.address);
      let retrieval = "OK";
      try {
        await registry.connect(buyerA).getTransformedCapsule.staticCall(dataId);
      } catch (e) {
        retrieval = e.shortMessage || e.message;
      }
      console.log(`AGENT4/DEF4-06 hasActiveAccess=${flag} retrieval="${retrieval}"`);
      // useGenomicCatalog.js:119 renders this dataset as purchasable from this flag.
      expect(flag, "INV-16: view must not promise access the contract cannot serve").to.equal(false);
    });

    it("DEF4-07: buyerCapsules must stop returning the capsule to the owner path after the grant expires", async function () {
      const dataId = await register("post-expiry");
      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      const capsule = JSON.stringify({ version: "GNC1", tag: "secret-capsule-payload", keyCipher: "ab".repeat(256) });
      await (await registry.storeTransformedCapsule(dataId, buyerA.address, capsule)).wait();
      await ethers.provider.send("evm_increaseTime", [Number(DURATION) + 60]);
      await ethers.provider.send("evm_mine", []);
      const leaked = await registry.buyerCapsules.staticCall(dataId, buyerA.address); // msg.sender == owner
      console.log(`AGENT4/DEF4-07 owner-path buyerCapsules after expiry="${leaked}"`);
      expect(leaked, "INV-16: expired grant must not keep serving the buyer capsule").to.equal("");
    });

    it("DEF4-09: after an ERC-721 transfer EVERY reader of GenomicData.currentOwner must agree (INV-16 symmetry)", async function () {
      const dataId = await register("stale-getter");
      await (await nft.transferFrom(owner.address, buyerB.address, 1n)).wait();

      const viaPublicGetter = (await registry.genomicDataItems(dataId)).currentOwner; // raw mapping
      const viaGetGenomicData = (await registry.getGenomicData(dataId)).currentOwner;
      const viaCatalog = (await registry.getAllDataItems())[Number(dataId) - 1].currentOwner;
      const [viaPaginated] = (await registry.getDataItemsPaginated(0, 10)).items;
      const trueOwner = await nft.ownerOf(1n);
      console.log(
        `AGENT4/DEF4-09 nftOwner=${trueOwner} genomicDataItems()=${viaPublicGetter} ` +
          `getGenomicData()=${viaGetGenomicData} getAllDataItems()=${viaCatalog} ` +
          `paginated()=${viaPaginated.currentOwner}`
      );
      // REQUIRED BEHAVIOUR: independent_stress_suite.mjs:366-372 advertises "Dynamic Real-Time
      // Ownership Sync"; every reader must therefore return the true NFT holder.
      expect(viaGetGenomicData).to.equal(trueOwner);
      expect(viaCatalog).to.equal(trueOwner);
      expect(viaPaginated.currentOwner).to.equal(trueOwner);
      expect(viaPublicGetter, "CRITICAL: the public genomicDataItems() getter still reports the pre-transfer owner").to.equal(
        trueOwner
      );
    });

    it("DEF4-08: a paid-upon-delivery escrow must remain refundable until the buyer actually decrypts a stored capsule", async function () {
      const dataId = await register("refund-after-event");
      const buyer0 = await token.balanceOf(buyerA.address);
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 3600n)).wait();
      await expect(
        registry.emitTransformedCapsule(dataId, buyerA.address, "event-only-capsule")
      ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);
      await (await registry.connect(buyerA).claimEscrowRefund(dataId)).wait();
      await expect(
        registry.connect(buyerA).getTransformedCapsule.staticCall(dataId)
      ).to.be.revertedWithCustomError(registry, "AccessNotGranted");
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(false);
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0, "buyer must be made whole");

      // After refund, re-granting access must allow fresh capsule delivery (CRITICAL-03 lifecycle symmetry)
      await (await registry.grantDirectAccess(dataId, buyerA.address)).wait();
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(true);
      const freshCapsule = JSON.stringify({
        version: "GENO-ASYM-v2",
        key: "fresh-post-refund",
        keyCipher: "ab".repeat(256),
      });
      await (await registry.storeTransformedCapsule(dataId, buyerA.address, freshCapsule)).wait();
      expect(await registry.connect(buyerA).getTransformedCapsule.staticCall(dataId)).to.contain("fresh-post-refund");
    });
  });
});
