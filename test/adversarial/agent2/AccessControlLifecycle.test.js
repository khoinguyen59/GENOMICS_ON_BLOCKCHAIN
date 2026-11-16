/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.f + 6.h)
 * Access-control bypass attempts and the status-lifecycle / view-symmetry matrix.
 *
 * A2-A04 and A2-A06 assert the REQUIRED cross-function symmetry (INV-16); they are
 * expected to FAIL on the current code and are the executed evidence for DEF2-2-04.
 */
import { expect } from "chai";
import hre from "hardhat";

const price = 30n * 10n ** 18n;
const CAPSULE = '{"version":"GENO-PRE-v1","keyCipher":"' + "ab".repeat(512) + '"}';

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

describe("AGENT2 :: Access-control bypass & status-lifecycle symmetry", function () {
  this.timeout(240000);
  let ethers, token, nft, registry, owner, seller, buyer, stranger;

  async function setup(durationSeconds = 86400 * 30) {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer, stranger] = await ethers.getSigners();

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
    await (await token.transfer(stranger.address, ethers.parseEther("500"))).wait();

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("ACL-DS")),
      "QmAc1Raw11111111111111111111111111111111111",
      "QmAc1Sum11111111111111111111111111111111111",
      "QmAc1Meta1111111111111111111111111111111111",
      "ipfs://acl", price, durationSeconds, 1000
    );
    expect((await reg.wait()).status).to.equal(1);
  }

  async function buyDirect(who = buyer, dataId = 1n) {
    await (await token.connect(who).approve(registry.target, price * 3n)).wait();
    const r = await capture(() => registry.connect(who)["grantAccess(uint256,uint256)"](dataId, price));
    expect(r.ok, r.error).to.equal(true);
  }

  async function mineEmptyAt(ts) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
    await ethers.provider.send("evm_mine", []);
  }

  it("A2-A01 a non-buyer can neither read another buyer's capsule nor deliver one", async function () {
    await setup();
    await buyDirect(buyer);
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, CAPSULE)).wait();

    // stranger reads
    const asStranger = await capture(() => registry.connect(stranger).getTransformedCapsule.staticCall(1n));
    expect(asStranger.ok).to.equal(false);
    expect(asStranger.error).to.contain("AccessNotGranted()");

    const peek = await capture(() => registry.connect(stranger).buyerCapsules.staticCall(1n, buyer.address));
    expect(peek.ok).to.equal(true);
    const served = String(peek.value ?? "");
    expect(served, `stranger must not be served a private capsule, got: ${served}`).to.equal("");

    // stranger cannot deliver or buy-without-paying for the buyer's slot
    const deliver = await capture(() => registry.connect(stranger).storeTransformedCapsule(1n, buyer.address, "x"));
    expect(deliver.ok).to.equal(false);
    expect(deliver.error).to.contain("NotDataOwner()");

    // and the buyer alone owns the readable copy
    const own = await registry.connect(buyer).getTransformedCapsule.staticCall(1n);
    expect(own).to.contain("GENO-PRE-v1");
  });

  it("A2-A02 an expired grant is revoked everywhere it matters (no stale capsule reads)", async function () {
    await setup(120); // 120s access window
    await buyDirect(buyer);
    const grant = await registry.accessGrants(1n, buyer.address);
    const expiresAt = grant.expiresAt;
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, CAPSULE)).wait();

    await mineEmptyAt(expiresAt - 1n);
    expect(await registry.hasActiveAccess(1n, buyer.address)).to.equal(true);

    await mineEmptyAt(expiresAt); // now >= expiresAt
    expect(await registry.hasActiveAccess(1n, buyer.address)).to.equal(false);

    const read = await capture(() => registry.connect(buyer).getTransformedCapsule.staticCall(1n));
    expect(read.ok).to.equal(false);
    expect(read.error).to.contain("AccessExpired()");

    const pub = await capture(() => registry.connect(buyer).buyerCapsules.staticCall(1n, buyer.address));
    expect(pub.ok).to.equal(false);
    expect(pub.error).to.contain("AccessExpired()");

    const redeliver = await capture(() => registry.connect(seller).storeTransformedCapsule(1n, buyer.address, "again"));
    expect(redeliver.ok).to.equal(false);
    expect(redeliver.error).to.contain("AccessExpired()");

    // a lapsed buyer must pay again to regain access
    const free = await capture(() => registry.connect(buyer)["grantAccess(uint256,uint256)"](1n, price));
    expect(free.ok).to.equal(true);
    expect((await registry.accessGrants(1n, buyer.address)).expiresAt).to.be.greaterThan(expiresAt);
  });

  it("A2-A03 Revoked consent is permanent and blocks every read/write path (GDPR hard stop)", async function () {
    await setup();
    await buyDirect(buyer);
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, CAPSULE)).wait();

    await (await registry.connect(seller).updateDataStatus(1n, 2)).wait(); // Revoked

    const read = await capture(() => registry.connect(buyer).getTransformedCapsule.staticCall(1n));
    expect(read.ok).to.equal(false);
    expect(read.error).to.contain("DataNotActive()");

    const buy = await capture(() => registry.connect(stranger)["grantAccess(uint256,uint256)"](1n, price));
    expect(buy.ok).to.equal(false);
    expect(buy.error).to.contain("DataNotActive()");

    const deliver = await capture(() => registry.connect(seller).storeTransformedCapsule(1n, buyer.address, "x"));
    expect(deliver.ok).to.equal(false);
    expect(deliver.error).to.contain("DataNotActive()");

    expect(await registry.hasActiveAccess(1n, buyer.address)).to.equal(false);

    // consent cannot be silently un-revoked
    const un = await capture(() => registry.connect(seller).updateDataStatus(1n, 0));
    expect(un.ok).to.equal(false);
    expect(un.error).to.contain("ConsentPermanentlyRevoked()");
    expect((await registry.genomicDataItems(1n)).status).to.equal(2n);
  });

  it("A2-A04 REQUIRED symmetry: hasActiveAccess() must not advertise access that getTransformedCapsule() denies", async function () {
    await setup();
    await (await token.connect(buyer).approve(registry.target, price)).wait();
    const r = await capture(() => registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, 86400, price));
    expect(r.ok, r.error).to.equal(true);

    // money really moved into custody
    expect(await token.balanceOf(registry.target)).to.equal(price);

    const advertised = await registry.hasActiveAccess(1n, buyer.address);
    const readable = await capture(() => registry.connect(buyer).getTransformedCapsule.staticCall(1n));
    const usable = readable.ok;

    // INV-16: the catalog predicate and the redemption path must agree, otherwise
    // the UI sells a "purchased" dataset the buyer cannot open.
    expect(
      advertised,
      `hasActiveAccess=${advertised} while getTransformedCapsule reverts with: ${readable.error}`
    ).to.equal(usable);
  });

  it("A2-A05 only the owner rotates the dispatcher, and an old owner's worker token is bound to that owner", async function () {
    await setup();
    const badCaller = await capture(() => registry.connect(stranger).setCapsuleDispatcher(stranger.address));
    expect(badCaller.ok).to.equal(false);
    expect(badCaller.error).to.contain("OwnableUnauthorizedAccount");

    const zero = await capture(() => registry.connect(owner).setCapsuleDispatcher(ethers.ZeroAddress));
    expect(zero.ok).to.equal(false);
    expect(zero.error).to.contain("InvalidRecipient()");

    await (await registry.connect(seller).setAuthorizedCapsuleWorker(1n, stranger.address, true)).wait();
    expect(await registry.capsuleWorkerAuthorizer(1n, stranger.address)).to.equal(seller.address);

    // worker may deliver while the authorizer still owns the NFT
    await buyDirect(buyer);
    const ok = await capture(() => registry.connect(stranger).storeTransformedCapsule(1n, buyer.address, CAPSULE));
    expect(ok.ok, ok.error).to.equal(true);

    // after the NFT moves, the stale authorizer must not keep the worker effective
    await (await nft.connect(seller).transferFrom(seller.address, owner.address, 1n)).wait();
    expect(await registry.authorizedCapsuleWorkers(1n, stranger.address)).to.equal(false);
    expect(await registry.capsuleWorkerAuthorizer(1n, stranger.address)).to.equal(ethers.ZeroAddress);

    const stale = await capture(() => registry.connect(stranger).emitTransformedCapsule(1n, buyer.address, CAPSULE));
    expect(stale.ok).to.equal(false);
    expect(stale.error).to.contain("NotDataOwner()");

    // ...and the new holder (here the deployer, who is also the dispatcher) can still deliver
    const fresh = await capture(() => registry.connect(owner).emitTransformedCapsule(1n, buyer.address, CAPSULE));
    expect(fresh.ok, fresh.error).to.equal(true);
  });

  it("A2-A06 REQUIRED fail-closed symmetry: a non-Active dataset must revert, not return an empty capsule string", async function () {
    await setup();
    await buyDirect(buyer);
    await (await registry.connect(seller).storeTransformedCapsule(1n, buyer.address, CAPSULE)).wait();
    await (await registry.connect(seller).updateDataStatus(1n, 1)).wait(); // Paused

    const strict = await capture(() => registry.connect(buyer).getTransformedCapsule.staticCall(1n));
    expect(strict.ok).to.equal(false);
    expect(strict.error).to.contain("DataNotActive()");

    const lenient = await capture(() => registry.connect(buyer).buyerCapsules.staticCall(1n, buyer.address));
    // INV-16: the sibling view of the same state must fail the same way. Returning ""
    // makes a paused dataset look like "no capsule yet" instead of "consent paused".
    expect(
      lenient.ok,
      `buyerCapsules() silently returned "${String(lenient.value ?? "")}" for a Paused dataset while ` +
      `getTransformedCapsule() reverts ${strict.error}`
    ).to.equal(false);
  });
});
