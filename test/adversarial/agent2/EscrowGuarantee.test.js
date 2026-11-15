/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.g)
 * Escrow guarantee semantics: can a seller (or the dispatcher) walk away with the
 * buyer's money without delivering a *usable* capsule, or redirect it to a third party?
 *
 * A2-E01 and A2-E03 assert the required asset-preservation property and are the
 * executed evidence for DEF2-2-01 (Critical) and DEF2-2-02 (High).
 */
import { expect } from "chai";
import hre from "hardhat";

const price = 100n * 10n ** 18n;
const DISPUTE = 86400;
const REAL_CAPSULE = '{"version":"GENO-PRE-v1","keyCipher":"' + "cd".repeat(512) + '"}';

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

describe("AGENT2 :: Escrow guarantee: capsule validity, counterparty binding, release authority", function () {
  this.timeout(240000);
  let ethers, token, nft, registry, owner, seller, buyer, attacker;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer, attacker] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();

    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await (await nft.setRegistryContract(registry.target)).wait();

    await (await token.transfer(buyer.address, ethers.parseEther("500"))).wait();

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("ESC-DS")),
      "QmEscRaw11111111111111111111111111111111111",
      "QmEscSum11111111111111111111111111111111111",
      "QmEscMeta1111111111111111111111111111111111",
      "ipfs://esc", price, 86400 * 30, 1000
    );
    expect((await reg.wait()).status).to.equal(1);

    await (await token.connect(buyer).approve(registry.target, price * 3n)).wait();
    const dep = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(dep.ok, dep.error).to.equal(true);
    expect(await token.balanceOf(registry.target)).to.equal(price);
  });

  it("A2-E01 REQUIRED: escrow must stay in custody until a structurally valid capsule is delivered", async function () {
    const preSeller = await token.balanceOf(seller.address);

    // seller pushes 13 bytes of garbage: not a capsule, decryptable by nobody
    const garbage = "NOT-A-REAL-CAPSULE";
    const delivered = await capture(() =>
      registry.connect(seller).storeTransformedCapsule(1n, buyer.address, garbage)
    );

    const custody = await token.balanceOf(registry.target);
    const sellerGain = (await token.balanceOf(seller.address)) - preSeller;
    const dep = await registry.escrowDeposits(1n, buyer.address);
    const refund = await capture(() => registry.connect(buyer).claimEscrowRefund(1n));
    const readable = await registry.connect(buyer).getTransformedCapsule.staticCall(1n);

    expect(
      custody,
      `garbage-capsule delivery drained the escrow: delivery ok=${delivered.ok}, ` +
      `custody=${custody}, sellerGain=${sellerGain}, capsuleDelivered=${dep.capsuleDelivered}, ` +
      `released=${dep.released}, buyerRefund="${refund.error}", buyerIsServed="${readable}"`
    ).to.equal(price);
  });

  it("A2-E02 an empty capsule is rejected and the buyer's funds remain in custody", async function () {
    const res = await capture(() => registry.connect(seller).storeTransformedCapsule(1n, buyer.address, ""));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("EmptyCapsule()");

    const res2 = await capture(() => registry.connect(seller).emitTransformedCapsule(1n, buyer.address, ""));
    expect(res2.ok).to.equal(false);
    expect(res2.error).to.contain("EmptyCapsule()");

    expect(await token.balanceOf(registry.target)).to.equal(price);
    const dep = await registry.escrowDeposits(1n, buyer.address);
    expect(dep.released).to.equal(false);
    expect(dep.capsuleDelivered).to.equal(false);
  });

  it("A2-E03 REQUIRED: escrow may only ever pay the recorded deposit counterparty, never a later NFT holder", async function () {
    const dep = await registry.escrowDeposits(1n, buyer.address);
    expect(dep.seller).to.equal(seller.address); // recorded at deposit time

    // seller dumps the NFT on an unrelated wallet, then the dispatcher delivers a good capsule
    await (await nft.connect(seller).transferFrom(seller.address, attacker.address, 1n)).wait();
    expect(await nft.ownerOf(1n)).to.equal(attacker.address);

    const preAttacker = await token.balanceOf(attacker.address);
    const preRecordedSeller = await token.balanceOf(dep.seller);
    const del = await capture(() =>
      registry.connect(owner).storeTransformedCapsule(1n, buyer.address, REAL_CAPSULE)
    );
    expect(del.ok, del.error).to.equal(true);

    const attackerGain = (await token.balanceOf(attacker.address)) - preAttacker;
    const recordedGain = (await token.balanceOf(dep.seller)) - preRecordedSeller;

    expect(
      attackerGain,
      `a wallet that never sold anything (${attacker.address}) received ${attackerGain} of the buyer's ` +
      `escrow; the recorded counterparty received only ${recordedGain} (deposit.seller is never read by ` +
      `_releaseEscrowInternal, GenomicsRegistry.sol:526)`
    ).to.equal(0n);
  });

  it("A2-E04 releaseEscrow() is unauthenticated yet unreachable for a live deposit (custody unchanged)", async function () {
    // before any capsule exists
    const early = await capture(() => registry.connect(attacker).releaseEscrow(1n, buyer.address));
    expect(early.ok).to.equal(false);
    expect(early.error).to.contain("CapsuleNotDelivered()");
    expect(await token.balanceOf(registry.target)).to.equal(price);

    // after delivery the deposit is already released inside the same tx -> no window for a stranger
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, REAL_CAPSULE)).wait();
    const late = await capture(() => registry.connect(attacker).releaseEscrow(1n, buyer.address));
    expect(late.ok).to.equal(false);
    expect(late.error).to.contain("EscrowNotActive()");
    expect(await token.balanceOf(registry.target)).to.equal(0n);
  });

  it("A2-E05 Paused/Revoked datasets let the buyer exit immediately with 100% of the escrow", async function () {
    const preBuyer = await token.balanceOf(buyer.address);

    await (await registry.connect(seller).updateDataStatus(1n, 1)).wait(); // Paused
    const r = await capture(() => registry.connect(buyer).claimEscrowRefund(1n));
    expect(r.ok, r.error).to.equal(true);

    expect(await token.balanceOf(buyer.address) - preBuyer).to.equal(price);
    expect(await token.balanceOf(registry.target)).to.equal(0n);
    const dep = await registry.escrowDeposits(1n, buyer.address);
    expect(dep.refunded).to.equal(true);
    expect((await registry.accessGrants(1n, buyer.address)).isGranted).to.equal(false);

    // double refund must be impossible
    const again = await capture(() => registry.connect(buyer).claimEscrowRefund(1n));
    expect(again.ok).to.equal(false);
    expect(again.error).to.contain("EscrowNotActive()");
  });

  it("A2-E06 dispute-window bounds (min 1h / max 30d) are enforced with real custody checks", async function () {
    const signers = await ethers.getSigners();
    const b2 = signers[5];
    const b3 = signers[6];
    await (await token.transfer(b2.address, ethers.parseEther("500"))).wait();
    await (await token.transfer(b3.address, ethers.parseEther("500"))).wait();
    await (await token.connect(b2).approve(registry.target, price * 4n)).wait();
    await (await token.connect(b3).approve(registry.target, price * 4n)).wait();

    for (const w of [0n, 3599n, 30n * 86400n + 1n, 31n * 86400n]) {
      const res = await capture(() =>
        registry.connect(b2)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, w, price)
      );
      expect(res.ok, `disputeWindow=${w} unexpectedly accepted`).to.equal(false);
      expect(res.error).to.contain("InvalidDisputeWindow()");
      expect(await token.balanceOf(registry.target)).to.equal(price); // no partial custody
    }

    const okMin = await capture(() =>
      registry.connect(b2)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, 3600n, price)
    );
    expect(okMin.ok, okMin.error).to.equal(true);
    const okMax = await capture(() =>
      registry.connect(b3)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, 30n * 86400n, price)
    );
    expect(okMax.ok, okMax.error).to.equal(true);

    expect(await token.balanceOf(registry.target)).to.equal(price * 3n); // original + two new deposits
    const dep2 = await registry.escrowDeposits(1n, b2.address);
    const dep3 = await registry.escrowDeposits(1n, b3.address);
    expect(dep2.disputeWindow).to.equal(3600n);
    expect(dep3.disputeWindow).to.equal(30n * 86400n);
    expect(dep2.amount).to.equal(price);
    expect(dep3.amount).to.equal(price);
  });
});
