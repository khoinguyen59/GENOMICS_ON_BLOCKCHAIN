/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.b)
 * INV-16 index/boundary sweep: dataId = 0, dataCount, dataCount+1, type(uint256).max
 * over EVERY state-changing and view entry point of GenomicsRegistry.
 *
 * Each assertion decodes the REAL revert (custom error) or reads REAL storage back.
 */
import { expect } from "chai";
import hre from "hardhat";

async function capture(send) {
  try {
    const v = await send();
    if (v && v.wait) {
      const r = await v.wait();
      return { ok: r.status === 1, value: r, error: `mined-status-${r.status}` };
    }
    return { ok: true, value: v, error: null };
  } catch (e) {
    return { ok: false, value: null, error: String(e && e.message ? e.message : e) };
  }
}

const toB58 = (s) => String(s).replace(/0/g, "x").replace(/O/g, "o").replace(/I/g, "i").replace(/l/g, "1").replace(/[^1-9A-HJ-NP-Za-km-z]/g, "");
const CID_POOL = ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx", "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ"];
const CID = (n) => CID_POOL[Math.abs([...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0)) % CID_POOL.length];

describe("AGENT2 :: dataId Boundary & Cross-Function State Symmetry (INV-16)", function () {
  this.timeout(180000);
  let ethers, token, nft, registry, owner, alice, bob, carol;
  const price = 50n * 10n ** 18n;

  async function register(signer, seed) {
    const tx = await registry.connect(signer).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes(seed)),
      CID(seed), CID(`${seed}-sum`), CID(`${seed}-meta`),
      `ipfs://${seed}-uri`,
      price, 86400 * 30, 1000
    );
    const r = await tx.wait();
    expect(r.status).to.equal(1);
    return r;
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, alice, bob, carol] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();

    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await nft.setRegistryContract(registry.target);

    await token.transfer(alice.address, ethers.parseEther("1000"));
    await token.transfer(bob.address, ethers.parseEther("1000"));

    // two live datasets owned by alice -> dataCount == 2
    await register(alice, "DS1");
    await register(alice, "DS2");
    expect(await registry.dataCount()).to.equal(2n);
  });

  it("A2-B01 every state-changing entry point reverts DataNotFound() at dataId=0 and dataId=dataCount+1", async function () {
    const bad = [0n, 3n, ethers.MaxUint256];
    const builders = (id) => [
      ["grantAccess(uint256)", () => registry.connect(bob)["grantAccess(uint256)"](id)],
      ["grantAccess(uint256,uint256)", () => registry.connect(bob)["grantAccess(uint256,uint256)"](id, price)],
      ["grantAccessWithEscrow(uint256,uint256)", () => registry.connect(bob)["grantAccessWithEscrow(uint256,uint256)"](id, 86400)],
      ["grantAccessWithEscrow(uint256,uint256,uint256)", () => registry.connect(bob)["grantAccessWithEscrow(uint256,uint256,uint256)"](id, 86400, price)],
      ["claimEscrowRefund(id)", () => registry.connect(bob).claimEscrowRefund(id)],
      ["releaseEscrow(id,buyer)", () => registry.connect(bob).releaseEscrow(id, bob.address)],
      ["updateDataStatus(id,status)", () => registry.connect(alice).updateDataStatus(id, 1)],
      ["updateDataPrice(id,price)", () => registry.connect(alice).updateDataPrice(id, price)],
      ["grantDirectAccess(id,recipient)", () => registry.connect(alice).grantDirectAccess(id, bob.address)],
      ["setAuthorizedCapsuleWorker(id,w,true)", () => registry.connect(alice).setAuthorizedCapsuleWorker(id, carol.address, true)],
      ["storeTransformedCapsule(id,r,c)", () => registry.connect(alice).storeTransformedCapsule(id, bob.address, "capsule")],
      ["emitTransformedCapsule(id,r,c)", () => registry.connect(alice).emitTransformedCapsule(id, bob.address, "capsule")],
      ["resetAuthorizedWorkers(id)", () => registry.connect(alice).resetAuthorizedWorkers(id)],
    ];

    for (const id of bad) {
      const preCount = await registry.dataCount();
      for (const [name, fn] of builders(id)) {
        const res = await capture(fn);
        expect(res.ok, `${name} with dataId=${id} must NOT succeed`).to.equal(false);
        expect(res.error, `${name} must revert DataNotFound(), got: ${res.error}`)
          .to.contain("DataNotFound()");
      }
      // no out-of-range call may mutate the counter or mint/transfer anything
      expect(await registry.dataCount()).to.equal(preCount);
    }
  });

  it("A2-B02 every view entry point reverts DataNotFound() out of range (no silent zero-struct reads)", async function () {
    const views = [
      ["getGenomicData", (id) => registry.getGenomicData.staticCall(id)],
      ["getTransformedCapsule", (id) => registry.getTransformedCapsule.staticCall(id)],
      ["buyerCapsules", (id) => registry.buyerCapsules.staticCall(id, bob.address)],
      ["hasActiveAccess", (id) => registry.hasActiveAccess.staticCall(id, bob.address)],
      ["getCapsuleForBuyer", (id) => registry.getCapsuleForBuyer.staticCall(id, bob.address)],
    ];
    for (const id of [0n, 3n, ethers.MaxUint256]) {
      for (const [name, fn] of views) {
        const res = await capture(() => fn(id));
        expect(res.ok, `${name}(${id}) must revert`).to.equal(false);
        expect(res.error, `${name}(${id}) wrong revert: ${res.error}`).to.contain("DataNotFound()");
      }
    }
  });

  it("A2-B03 positive control: dataId == dataCount is fully functional (boundary is inclusive)", async function () {
    await token.connect(bob).approve(registry.target, price);
    const tx = await registry.connect(bob)["grantAccess(uint256)"](2n);
    expect((await tx.wait()).status).to.equal(1);

    const item = await registry.getGenomicData(2n);
    expect(item.dataId).to.equal(2n);
    expect(item.tokenId).to.equal(2n);
    expect(item.accessCount).to.equal(1n);
    expect(await registry.hasActiveAccess(2n, bob.address)).to.equal(true);
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("1000") + price);
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("1000") - price);
  });

  it("A2-B04 off-by-one guard: dataCount+1 stays unreachable until a real registration happens", async function () {
    const res = await capture(() => registry.getGenomicData.staticCall(3n));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("DataNotFound()");

    await register(alice, "DS3");
    expect(await registry.dataCount()).to.equal(3n);
    const third = await registry.getGenomicData(3n);
    expect(third.dataId).to.equal(3n);
    expect(third.rawCiphertextCid).to.equal(CID("DS3"));
  });

  it("A2-B05 duplicate-hash and zero-argument registration guards hold on-chain", async function () {
    const dup = await capture(() => registry.connect(alice).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("DS1")), CID("dup"), CID("dup2"), CID("dup3"),
      "ipfs://dup", price, 86400, 1000
    ));
    expect(dup.ok).to.equal(false);
    expect(dup.error).to.contain("DataAlreadyRegistered()");

    const zeroPrice = await capture(() => registry.connect(alice).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("DS-PRICE0")), CID("p0"), CID("p0s"), CID("p0m"),
      "ipfs://p0", 0n, 86400, 1000
    ));
    expect(zeroPrice.ok).to.equal(false);
    expect(zeroPrice.error).to.contain("InvalidPrice()");

    const zeroDur = await capture(() => registry.connect(alice).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("DS-DUR0")), CID("d0"), CID("d0s"), CID("d0m"),
      "ipfs://d0", price, 0n, 1000
    ));
    expect(zeroDur.ok).to.equal(false);
    expect(zeroDur.error).to.contain("InvalidDuration()");

    const badHash = await capture(() => registry.connect(alice).registerGenomicData(
      ethers.ZeroHash, CID("h0"), CID("h0s"), CID("h0m"), "ipfs://h0", price, 86400, 1000
    ));
    expect(badHash.ok).to.equal(false);
    expect(badHash.error).to.contain("InvalidDataHashOrCid()");

    expect(await registry.dataCount()).to.equal(2n);
  });

  it("A2-B06 enum domain is enforced: updateDataStatus() must not store an undefined DataStatus value", async function () {
    // DataStatus has exactly 3 members (Active=0, Paused=1, Revoked=2); 3 is out of domain.
    const res = await capture(() => registry.connect(alice).updateDataStatus(1n, 3));
    const stored = await registry.genomicDataItems(1n);

    if (res.ok) {
      // The EVM accepted the call -> assert the persisted state stayed in-domain.
      expect(Number(stored.status), `status persisted as ${stored.status} (outside DataStatus domain)`)
        .to.be.lessThan(3);
    } else {
      // Ensure the rejection came from the EVM, not from a client-side encoding quirk.
      expect(res.error, `non-EVM rejection: ${res.error}`).to.contain("revert");
      expect(Number(stored.status)).to.equal(0);
    }
  });

  it("A2-B07 paginated reader never crosses the boundary and never returns phantom rows", async function () {
    const [items, total] = await registry.getDataItemsPaginated.staticCall(0, 10);
    expect(total).to.equal(2n);
    expect(items.length).to.equal(2);
    expect(items[0].dataId).to.equal(1n);
    expect(items[1].dataId).to.equal(2n);

    const [over, t2] = await registry.getDataItemsPaginated.staticCall(5, 5);
    expect(t2).to.equal(2n);
    expect(over.length).to.equal(0);

    const all = await registry.getAllDataItems.staticCall();
    expect(all.length).to.equal(2);
  });
});
