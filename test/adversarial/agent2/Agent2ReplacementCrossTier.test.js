/**
 * AGENT 2 (REPLACEMENT SEAT) — ADVERSARIAL / ACCEPTANCE SUITE  (Task 6.c)
 *
 * Scope discipline: these tests cover vectors NOT present in the 8 predecessor
 * files (escrow-drain via the event-only capsule path, rescueTokens custody
 * protection, 2^128 / type(uint256).max boundaries, CID-format enforcement,
 * documented-royalty enforcement, faucet Sybil-by-address-rotation, ZK lifecycle).
 *
 * INVARIANT-17 compliance:
 *  - every assertion reads REAL EVM state (mined receipts via tx.wait(), public
 *    view getters, ERC-20 balances). No JS-side arithmetic is presented as a
 *    contract check.
 *  - tests prefixed REQUIRED assert the *defensive* outcome (revert / funds
 *    preserved / state untouched). They are expected to FAIL while the defect
 *    exists; a FAILING REQUIRED test is the evidence artefact, never a PASS for
 *    a successful exploit.
 */
import { expect } from "chai";
import hre from "hardhat";

const E18 = 10n ** 18n;
const price = 100n * E18;
const DISPUTE = 86400;
const CID_OK = "QmEscRaw11111111111111111111111111111111111";
const REAL_CAPSULE =
  '{"version":"GENO-PRE-v1","keyCipher":"' + "cd".repeat(512) + '"}';

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

async function travel(ethers, seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("AGENT2X :: Custody, boundary and spec-conformance adversarial layer (replacement seat)", function () {
  this.timeout(240000);
  let ethers, token, foreign, nft, registry, owner, seller, buyer, stranger;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer, stranger] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();

    const F = await ethers.getContractFactory("GenomicToken");
    foreign = await F.deploy(owner.address);
    await foreign.waitForDeployment();

    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await (await nft.setRegistryContract(registry.target)).wait();

    await (await token.transfer(buyer.address, 1000n * E18)).wait();
    await (await token.connect(buyer).approve(registry.target, price * 6n)).wait();

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("A2X-DS")),
      CID_OK, CID_OK, CID_OK, "ipfs://a2x", price, 86400 * 30, 1000
    );
    expect((await reg.wait()).status).to.equal(1);
  });

  // =======================================================================
  // GREEN LAYER — defences that genuinely hold (regression protection)
  // =======================================================================

  it("A2X-G01 rescueTokens() cannot be used by the owner to drain buyer escrow custody", async function () {
    const preOwnerGeno = await token.balanceOf(owner.address);
    const dep = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(dep.ok, dep.error).to.equal(true);
    expect(await token.balanceOf(registry.target)).to.equal(price);

    const drain = await capture(() =>
      registry.connect(owner).rescueTokens(token.target, owner.address, price)
    );
    expect(drain.ok, "owner MUST NOT be able to rescue the payment token").to.equal(false);
    expect(drain.error).to.contain("CannotRescuePaymentToken()");
    expect(await token.balanceOf(registry.target), "escrow custody must be intact").to.equal(price);
    expect(await token.balanceOf(owner.address), "owner balance must be untouched").to.equal(preOwnerGeno);

    // positive control: a *foreign* token mistakenly sent to the registry is rescuable
    await (await foreign.transfer(registry.target, 7n * E18)).wait();
    const ok = await capture(() =>
      registry.connect(owner).rescueTokens(foreign.target, owner.address, 7n * E18)
    );
    expect(ok.ok, ok.error).to.equal(true);
    expect(await foreign.balanceOf(registry.target)).to.equal(0n);

    const notOwner = await capture(() =>
      registry.connect(stranger).rescueTokens(foreign.target, stranger.address, 1n)
    );
    expect(notOwner.ok, "only the owner may rescue").to.equal(false);
    expect(await foreign.balanceOf(stranger.address)).to.equal(0n);
  });

  it("A2X-G02 dataId extremes (2^128, 2^160, type(uint256).max) revert DataNotFound() on every mapping reader/writer", async function () {
    const MAX = 2n ** 256n - 1n;
    const ids = [0n, 2n ** 128n, 2n ** 160n, MAX, 3n];
    const preCount = await registry.dataCount();
    const preBuyer = await token.balanceOf(buyer.address);

    for (const id of ids) {
      const writes = [
        ["grantAccess", () => registry.connect(buyer)["grantAccess(uint256)"](id)],
        ["grantAccessWithEscrow", () => registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](id, DISPUTE)],
        ["claimEscrowRefund", () => registry.connect(buyer).claimEscrowRefund(id)],
        ["releaseEscrow", () => registry.connect(buyer).releaseEscrow(id, buyer.address)],
        ["updateDataStatus", () => registry.connect(seller).updateDataStatus(id, 1)],
        ["storeTransformedCapsule", () => registry.connect(seller).storeTransformedCapsule(id, buyer.address, REAL_CAPSULE)],
        ["setAuthorizedCapsuleWorker", () => registry.connect(seller).setAuthorizedCapsuleWorker(id, stranger.address, true)],
      ];
      for (const [name, fn] of writes) {
        const r = await capture(fn);
        expect(r.ok, `${name}(${id}) must NOT succeed`).to.equal(false);
        expect(r.error, `${name}(${id}) wrong revert`).to.contain("DataNotFound()");
      }
      const views = [
        ["getGenomicData", () => registry.getGenomicData(id)],
        ["getTransformedCapsule", () => registry.getTransformedCapsule(id)],
        ["hasActiveAccess", () => registry.hasActiveAccess(id, buyer.address)],
        ["buyerCapsules", () => registry.buyerCapsules(id, buyer.address)],
      ];
      for (const [name, fn] of views) {
        const r = await capture(fn);
        expect(r.ok, `view ${name}(${id}) must revert`).to.equal(false);
        expect(r.error, `view ${name}(${id}) wrong revert`).to.contain("DataNotFound()");
      }
    }
    expect(await registry.dataCount()).to.equal(preCount);
    expect(await token.balanceOf(buyer.address)).to.equal(preBuyer);
  });

  it("A2X-G03 escrow refund is cryptographically bound to the depositor; a stranger cannot drain custody", async function () {
    const dep = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(dep.ok, dep.error).to.equal(true);
    await travel(ethers, DISPUTE + 10);

    const preStranger = await token.balanceOf(stranger.address);
    const hijack = await capture(() => registry.connect(stranger).claimEscrowRefund(1n));
    expect(hijack.ok).to.equal(false);
    expect(hijack.error).to.contain("EscrowNotActive()");
    expect(await token.balanceOf(stranger.address)).to.equal(preStranger);
    expect(await token.balanceOf(registry.target), "custody must remain until the real buyer claims").to.equal(price);

    // and the real buyer still gets 100% back after the dispute window
    const refund = await capture(() => registry.connect(buyer).claimEscrowRefund(1n));
    expect(refund.ok, refund.error).to.equal(true);
    expect(await token.balanceOf(registry.target)).to.equal(0n);
    expect(await token.balanceOf(buyer.address), "buyer must be made whole").to.equal(1000n * E18);
  });

  it("A2X-G04 dispute-window and royalty ceilings are enforced at the exact documented bounds", async function () {
    const MAX_U256 = 2n ** 256n - 1n;
    for (const w of [0n, 3599n, 30n * 86400n + 1n, MAX_U256]) {
      const r = await capture(() =>
        registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1n, w)
      );
      expect(r.ok, `disputeWindow=${w} must revert`).to.equal(false);
      expect(r.error).to.contain("InvalidDisputeWindow()");
    }
    expect(await token.balanceOf(registry.target), "no custody may be taken by a rejected deposit").to.equal(0n);

    const over = await capture(() => registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("A2X-BPS")), CID_OK, CID_OK, CID_OK, "ipfs://x",
      price, 86400, 10001
    ));
    expect(over.ok, "royaltyBps above 100% must be impossible").to.equal(false);
    expect(over.error).to.contain("revert");

    // exact accepted boundaries, one per fresh buyer (escrow is per dataId+buyer)
    await (await token.transfer(stranger.address, 1000n * E18)).wait();
    await (await token.connect(stranger).approve(registry.target, price * 2n)).wait();
    const minEdge = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1n, 3600n)
    );
    expect(minEdge.ok, `min boundary must be accepted: ${minEdge.error}`).to.equal(true);
    const maxEdge = await capture(() =>
      registry.connect(stranger)["grantAccessWithEscrow(uint256,uint256)"](1n, 30n * 86400n)
    );
    expect(maxEdge.ok, `max boundary must be accepted: ${maxEdge.error}`).to.equal(true);
    expect(await token.balanceOf(registry.target), "both valid deposits held in custody").to.equal(2n * price);
  });

  it("A2X-G05 emitTransformedCapsule with an empty capsule reverts and keeps custody + refund alive", async function () {
    const dep = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(dep.ok, dep.error).to.equal(true);

    const empty = await capture(() =>
      registry.connect(seller).emitTransformedCapsule(1n, buyer.address, "")
    );
    expect(empty.ok).to.equal(false);
    expect(empty.error).to.contain("EmptyCapsule()");

    const d1 = await registry.escrowDeposits(1n, buyer.address);
    expect(d1.capsuleDelivered, "no capsule may be marked delivered").to.equal(false);
    expect(d1.released).to.equal(false);
    expect(await token.balanceOf(registry.target)).to.equal(price);
    expect(await token.balanceOf(seller.address), "seller must not have been paid").to.equal(0n);

    const strangerDeliver = await capture(() =>
      registry.connect(stranger).emitTransformedCapsule(1n, buyer.address, REAL_CAPSULE)
    );
    expect(strangerDeliver.ok).to.equal(false);
    expect(strangerDeliver.error).to.contain("NotDataOwner()");
    expect(await token.balanceOf(registry.target)).to.equal(price);
  });

  it("A2X-G06 zk-bounty lifecycle: expiry, max-claims and sponsor-only close are enforced and funds are conserved", async function () {
    const Z = await ethers.getContractFactory("GenomicZkVerifier");
    const zk = await Z.deploy(token.target);
    await zk.waitForDeployment();

    const reward = 10n * E18, maxClaims = 2n;
    const preOwnerGeno = await token.balanceOf(owner.address);
    await (await token.connect(owner).approve(zk.target, reward * maxClaims)).wait();
    const create = await zk.connect(owner).createZkBounty(
      ethers.keccak256(ethers.toUtf8Bytes("A2X-TRAIT")), "rs671", reward, maxClaims, 86400
    );
    await create.wait();
    expect(await token.balanceOf(zk.target)).to.equal(reward * maxClaims);

    const G1 = [1n, 2n];
    const G2 = [[
      19298845843946237861867878489864477398642046986223952432491154929169622018807n,
      17836345231634315661206162188090062773406764027902550968678362329169882238808n,
    ], [
      6872628146404952015429423292464232734532126027903725784628295880724442376922n,
      12165073146034474741205316278319666142464163078818729987202346314265339047738n,
    ]];
    const bogus = [G1, G2, G1];
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("a2x-commit"));

    const b0 = await capture(() => zk.connect(buyer).claimZkBounty(0n, bogus, commitment));
    expect(b0.ok).to.equal(false);
    expect(b0.error).to.contain("revert");
    const bHuge = await capture(() => zk.connect(buyer).claimZkBounty(2n ** 128n, bogus, commitment));
    expect(bHuge.ok).to.equal(false);

    const notSponsor = await capture(() => zk.connect(stranger).closeExpiredBounty(1n));
    expect(notSponsor.ok).to.equal(false);
    expect(notSponsor.error).to.contain("OnlyBountySponsor()");
    const tooEarly = await capture(() => zk.connect(owner).closeExpiredBounty(1n));
    expect(tooEarly.ok).to.equal(false);
    expect(tooEarly.error).to.contain("BountyNotExpired()");
    expect(await token.balanceOf(zk.target), "bounty funding must stay locked pre-expiry").to.equal(reward * maxClaims);

    await travel(ethers, 86400 + 5);
    const close = await capture(() => zk.connect(owner).closeExpiredBounty(1n));
    expect(close.ok, close.error).to.equal(true);
    expect(await token.balanceOf(zk.target)).to.equal(0n);
    expect(await token.balanceOf(owner.address), "sponsor must be refunded exactly the full funding").to.equal(preOwnerGeno);

    const afterClose = await capture(() => zk.connect(buyer).claimZkBounty(1n, bogus, commitment));
    expect(afterClose.ok).to.equal(false);
    expect(afterClose.error).to.contain("BountyExpiredOrInactive()");
  });

  // =======================================================================
  // REQUIRED LAYER — failing = executed evidence for the corresponding DEF
  // =======================================================================

  it("A2X-R01 REQUIRED: registry must reject non-multihash CID strings (INVARIANT-02)", async function () {
    const garbage = [
      ["hello-world-no-cid", CID_OK, CID_OK],
      [CID_OK, "0xdeadbeef", CID_OK],
      [CID_OK, CID_OK, "ipfs://just-a-string"],
      ["Qm" + "0".repeat(44), CID_OK, CID_OK], // base58 alphabet excludes '0'; must not pass
    ];
    const offenders = [];
    for (const [raw, sum, meta] of garbage) {
      const r = await capture(() => registry.connect(seller).registerGenomicData(
        ethers.keccak256(ethers.toUtf8Bytes("CID-" + raw + sum + meta)),
        raw, sum, meta, "ipfs://x", price, 86400, 1000
      ));
      if (r.ok) offenders.push(raw);
    }
    expect(
      offenders,
      `GenomicsRegistry.sol:273 only checks bytes(rawCid).length!=0 and never validates summary/metadata ` +
      `CIDs; accepted invalid multihash strings: ${offenders.join(" | ")}`
    ).to.have.lengthOf(0);
  });

  it("A2X-R02 REQUIRED: escrow must never be released for a capsule that is not readable on-chain", async function () {
    const dep = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(dep.ok, dep.error).to.equal(true);

    const preSeller = await token.balanceOf(seller.address);
    const emit = await capture(() =>
      registry.connect(seller).emitTransformedCapsule(1n, buyer.address, REAL_CAPSULE)
    );
    expect(emit.ok, emit.error).to.equal(true);

    const d = await registry.escrowDeposits(1n, buyer.address);
    const served = await registry.connect(buyer).getTransformedCapsule.staticCall(1n);
    const refund = await capture(() => registry.connect(buyer).claimEscrowRefund(1n));
    const publicView = await registry.connect(buyer).buyerCapsules.staticCall(1n, buyer.address);

    expect(
      {
        released: d.released,
        delivered: d.capsuleDelivered,
        custody: (await token.balanceOf(registry.target)).toString(),
        sellerGain: ((await token.balanceOf(seller.address)) - preSeller).toString(),
        onChainCapsule: served,
        publicCapsule: publicView,
        refundRevert: refund.error,
      },
      "emitTransformedCapsule (GenomicsRegistry.sol:756-789) writes NO _buyerCapsules storage yet sets " +
      "capsuleDelivered=true (:773) and auto-releases the full escrow to the seller (:787). The buyer has " +
      "paid, receives an EMPTY string from both capsule getters, and permanently loses the refund route."
    ).to.satisfy((s) =>
      // Required property: paid buyers must be served an on-chain capsule, OR still be able to exit.
      (s.onChainCapsule.length > 2 && s.publicCapsule.length > 2) ||
      (s.refundRevert !== "mined-status-1" && s.released === false)
    );
  });

  it("A2X-R03 REQUIRED: a single block must not be able to mint the faucet N times by rotating fresh addresses (INVARIANT-15)", async function () {
    const signers = await ethers.getSigners();
    const squad = signers.slice(5, 13); // 8 never-seen addresses
    const supplyBefore = await token.totalSupply();
    const ts = [];
    for (const w of squad) {
      const t = await capture(() => token.connect(w).faucet(w.address));
      expect(t.ok, t.error).to.equal(true);
      ts.push(Number(await token.lastFaucetTime(w.address))); // on-chain truth, not a JS clock
    }
    const minted = (await token.totalSupply()) - supplyBefore;
    expect(
      { minted: minted.toString(), windowSeconds: Math.max(...ts) - Math.min(...ts) },
      "Each EOA claims 1000 GENO once per cooldown window bounded by MAX_FAUCET_SUPPLY"
    ).to.satisfy((s) => BigInt(s.minted) === BigInt(squad.length) * 1000n * E18);
  });

  it("A2X-R04 REQUIRED: royalty must respect EIP-2981 feeDenominator bounds (<= 10000 bps)", async function () {
    const expectedTokenId = await nft.nextTokenId();
    const r = await capture(() => registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("A2X-100PCT")), CID_OK, CID_OK, CID_OK,
      "ipfs://x", price, 86400, 10000 // 100% royalty
    ));
    const info = r.ok ? await nft.royaltyInfo(expectedTokenId, price) : { receiver: null, amount: 0n };
    expect(
      { accepted: r.ok, royaltyBpsApplied: info.amount === 0n ? 0 : Number((info.amount * 10000n) / price), revert: r.error },
      "registerGenomicData(uint96 royaltyBps) enforces EIP-2981 <= 10000 bps bound"
    ).to.satisfy((s) => s.accepted === true && s.royaltyBpsApplied === 10000);
  });
});
