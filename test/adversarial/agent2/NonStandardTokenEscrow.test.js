/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.d)
 * Non-standard ERC20 (USDT-style VOID transfer/transferFrom return) driven through
 * the full escrow lifecycle: deposit -> release, deposit -> refund, and the
 * insufficient-allowance failure path.
 *
 * Contracts under test are wired with paymentToken = NonStandardERC20, so a
 * SafeERC20 omission would show up as a *silent* state change. Every assertion
 * re-reads real token balances and real registry storage.
 */
import { expect } from "chai";
import hre from "hardhat";

const DISPUTE = 86400;
const price = 40n * 10n ** 18n;

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

describe("AGENT2 :: Non-Standard (void-return) ERC20 through the escrow lifecycle", function () {
  this.timeout(240000);
  let ethers, token, nft, registry, owner, seller, buyer1, buyer2;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer1, buyer2] = await ethers.getSigners();

    const NST = await ethers.getContractFactory("NonStandardERC20");
    token = await NST.deploy(ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await nft.setRegistryContract(registry.target);

    for (const b of [seller, buyer1, buyer2]) {
      await (await token.transfer(b.address, ethers.parseEther("1000"))).wait();
    }

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("NST_DS1")),
      "QmcAnKW3SMsuxYiNWCTuMZhp8GXpQmt8HjKFWPEJoNkM4B",
      "QmV3xjiLwjT5gmvn9zjqjNCRXqBYTLxV2tugBgKcFFMgcu",
      "QmTUYCNn6YgU3jN2eGHKJDTgjtJ3GJUsMWT3ZiAVFNCsWC",
      "ipfs://nst-ds1", price, 86400 * 30, 1000
    );
    expect((await reg.wait()).status).to.equal(1);
  });

  it("A2-N01 void-return transferFrom still escrows the FULL price into contract custody", async function () {
    const registryAddr = await registry.getAddress();
    const preBuyer = await token.balanceOf(buyer1.address);

    await (await token.connect(buyer1).approve(registryAddr, price)).wait();
    const r = await capture(() =>
      registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price)
    );
    expect(r.ok, r.error).to.equal(true);

    // the void token really moved
    expect(await token.balanceOf(registryAddr)).to.equal(price);
    expect(preBuyer - (await token.balanceOf(buyer1.address))).to.equal(price);

    const dep = await registry.escrowDeposits(1n, buyer1.address);
    expect(dep.amount).to.equal(price);
    expect(dep.disputeWindow).to.equal(BigInt(DISPUTE));
    expect(dep.released).to.equal(false);
    expect(dep.capsuleDelivered).to.equal(false);
  });

  it("A2-N02 void-return safeTransfer pays the seller on release and empties custody", async function () {
    const registryAddr = await registry.getAddress();
    await (await token.connect(buyer1).approve(registryAddr, price)).wait();
    await (await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](1n, DISPUTE)).wait();

    const preSeller = await token.balanceOf(seller.address);
    const t = await registry
      .connect(seller)
      .storeTransformedCapsule(1n, buyer1.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", capsule: "NST-REAL-DELIVERY", keyCipher: "ab".repeat(256) }));
    expect((await t.wait()).status).to.equal(1);
    expect((await registry.escrowDeposits(1n, buyer1.address)).released).to.equal(false);
    await (await registry.connect(buyer1).confirmCapsuleAndReleaseEscrow(1n)).wait();

    expect(await token.balanceOf(registryAddr)).to.equal(0n);
    // seller == royalty receiver -> the whole price (incl. the 10% royalty leg) lands on the seller
    expect(await token.balanceOf(seller.address) - preSeller).to.equal(price);
    const dep = await registry.escrowDeposits(1n, buyer1.address);
    expect(dep.released).to.equal(true);
  });

  it("A2-N03 dispute-window expiry refunds 100% of a void-token deposit (no dust left behind)", async function () {
    const registryAddr = await registry.getAddress();
    await (await token.connect(buyer2).approve(registryAddr, price)).wait();
    const dep0 = await (await registry.connect(buyer2)["grantAccessWithEscrow(uint256,uint256)"](1n, DISPUTE)).wait();
    const depositTime = BigInt((await ethers.provider.getBlock(dep0.blockNumber)).timestamp);

    const preBuyer = await token.balanceOf(buyer2.address);
    expect(await token.balanceOf(registryAddr)).to.equal(price);

    // too early -> must be rejected
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(depositTime + BigInt(DISPUTE) - 2n)]);
    await ethers.provider.send("evm_mine", []);
    const early = await capture(() => registry.connect(buyer2).claimEscrowRefund(1n));
    expect(early.ok).to.equal(false);
    expect(early.error).to.contain("DisputeWindowActive()");
    expect(await token.balanceOf(buyer2.address)).to.equal(preBuyer);

    // at expiry -> full refund through the void transfer() path
    // (the rejected attempt above never got mined, so push the clock to T-1 first)
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(depositTime + BigInt(DISPUTE) - 1n)]);
    await ethers.provider.send("evm_mine", []);
    const r = await capture(() => registry.connect(buyer2).claimEscrowRefund(1n));
    expect(r.ok, r.error).to.equal(true);
    expect(await token.balanceOf(buyer2.address) - preBuyer).to.equal(price);
    expect(await token.balanceOf(registryAddr)).to.equal(0n);
    const dep = await registry.escrowDeposits(1n, buyer2.address);
    expect(dep.refunded).to.equal(true);
    expect((await registry.accessGrants(1n, buyer2.address)).isGranted).to.equal(false);
  });

  it("A2-N04 an under-funded buyer cannot obtain access: SafeERC20 failure is not silently swallowed", async function () {
    const registryAddr = await registry.getAddress();
    const preSupplyRegistry = await token.balanceOf(registryAddr);
    const preSeller = await token.balanceOf(seller.address);

    await (await token.connect(buyer1).approve(registryAddr, price)).wait();
    // drain the buyer below the price after approving
    await (await token.connect(buyer1).transfer(owner.address, ethers.parseEther("980"))).wait();
    expect(await token.balanceOf(buyer1.address)).to.equal(20n * 10n ** 18n);

    const res = await capture(() => registry.connect(buyer1)["grantAccess(uint256,uint256)"](1n, price));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("Insufficient balance");

    // no phantom access grant may survive the failed pull
    expect(await registry.hasActiveAccess(1n, buyer1.address)).to.equal(false);
    const g = await registry.accessGrants(1n, buyer1.address);
    expect(g.isGranted).to.equal(false);
    expect(await token.balanceOf(seller.address)).to.equal(preSeller);
    expect(await token.balanceOf(registryAddr)).to.equal(preSupplyRegistry);
  });

  it("A2-N05 single-use allowance: a second purchase without re-approval reverts (no infinite drain)", async function () {
    const registryAddr = await registry.getAddress();
    await (await token.connect(buyer1).approve(registryAddr, price)).wait();
    const first = await capture(() => registry.connect(buyer1)["grantAccess(uint256,uint256)"](1n, price));
    expect(first.ok, first.error).to.equal(true);
    expect(await token.allowance(buyer1.address, registryAddr)).to.equal(0n);

    // access is still live, so the second attempt is rejected for that reason first
    const dup = await capture(() => registry.connect(buyer1)["grantAccess(uint256,uint256)"](1n, price));
    expect(dup.ok).to.equal(false);
    expect(dup.error).to.contain("AccessAlreadyActive()");
    expect(await token.balanceOf(registryAddr)).to.equal(0n);
  });

  it("A2-N06 rescueTokens() refuses the payment token even when it is a void-return token", async function () {
    const res = await capture(() =>
      registry.connect(owner).rescueTokens(token.target, owner.address, ethers.parseEther("100"))
    );
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("CannotRescuePaymentToken()");

    await (await token.transfer(registry.target, ethers.parseEther("5"))).wait();
    expect(await token.balanceOf(registry.target)).to.equal(ethers.parseEther("5"));

    const notOwner = await capture(() =>
      registry.connect(buyer1).rescueTokens(token.target, buyer1.address, 1n)
    );
    expect(notOwner.ok).to.equal(false);
    expect(notOwner.error).to.contain("OwnableUnauthorizedAccount");
  });
});
