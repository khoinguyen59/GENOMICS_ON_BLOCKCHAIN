/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.e)
 * Reentrancy through the two adversarial mocks shipped in contracts/mocks:
 *   - MaliciousReentrantReceiver  (ERC721 onERC721Received hook -> registerGenomicData)
 *   - MaliciousReentrantToken     (ERC20 transferFrom hook      -> grantAccess)
 *
 * PASS criteria (INV-17): the attack must be REJECTED by the contract and the
 * victim balances must be exactly preserved - never "the exploit worked".
 */
import { expect } from "chai";
import hre from "hardhat";

const price = 60n * 10n ** 18n;

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

describe("AGENT2 :: Reentrancy vectors via contracts/mocks (ReentrancyGuard + CEI)", function () {
  this.timeout(240000);
  let ethers, token, nft, registry, owner, seller, buyer;

  async function deployAll(paymentTokenAddress) {
    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(paymentTokenAddress, nft.target, owner.address);
    await registry.waitForDeployment();
    await (await nft.setRegistryContract(registry.target)).wait();
  }

  it("A2-X01 ERC721 receive hook cannot re-enter registerGenomicData (guard + real state intact)", async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer] = await ethers.getSigners();
    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();
    await deployAll(token.target);

    const M = await ethers.getContractFactory("MaliciousReentrantReceiver");
    const attacker = await M.deploy(registry.target);
    await attacker.waitForDeployment();

    const res = await capture(() => attacker.registerWithRegistry(
      ethers.keccak256(ethers.toUtf8Bytes("REENT-NFT")),
      "QmReentNftRaw1111111111111111111111111111111",
      "QmReentNftSum11111111111111111111111111111111",
      "QmReentNftMeta1111111111111111111111111111111",
      "ipfs://reent", price, 86400, 500
    ));
    expect(res.ok, res.error).to.equal(true); // the outer registration is legitimate

    // the nested attack must have been refused, and refused BY THE GUARD
    expect(await attacker.attackInitiated()).to.equal(true);
    expect(await attacker.attackSucceeded()).to.equal(false);
    expect(await attacker.lastErrorMessage()).to.contain("ReentrancyGuardReentrantCall");

    // REAL chain state: exactly one data item and one NFT ever existed
    expect(await registry.dataCount()).to.equal(1n);
    expect(await nft.nextTokenId()).to.equal(2n); // counter advanced once, no double mint
    expect(await nft.ownerOf(1n)).to.equal(await attacker.getAddress());
    const item = await registry.getGenomicData(1n);
    expect(item.price).to.equal(price);
    expect(item.accessCount).to.equal(0n);
  });

  it("A2-X02 payment-token transfer hook cannot re-enter grantAccess; buyer/seller balances stay exact", async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer] = await ethers.getSigners();

    const MT = await ethers.getContractFactory("MaliciousReentrantToken");
    token = await MT.deploy(owner.address);
    await token.waitForDeployment();
    await (await token.transfer(seller.address, ethers.parseEther("1000"))).wait();
    await (await token.transfer(buyer.address, ethers.parseEther("1000"))).wait();
    await deployAll(token.target);

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("REENT-TOKEN")),
      "QmReentTokRaw11111111111111111111111111111111",
      "QmReentTokSum1111111111111111111111111111111",
      "QmReentTokMeta11111111111111111111111111111",
      "ipfs://reent-tok", price, 86400, 1000
    );
    expect((await reg.wait()).status).to.equal(1);

    await (await token.connect(buyer).approve(registry.target, price)).wait();
    await (await token.setRegistryAndTarget(registry.target, 1n)).wait();

    const preBuyer = await token.balanceOf(buyer.address);
    const preSeller = await token.balanceOf(seller.address);
    const preRegistry = await token.balanceOf(registry.target);

    const res = await capture(() => registry.connect(buyer)["grantAccess(uint256,uint256)"](1n, price));
    expect(res.ok, res.error).to.equal(true); // outer purchase legitimately succeeds

    expect(await token.attackInitiated()).to.equal(true);
    expect(await token.attackSucceeded()).to.equal(false);
    expect(await token.lastErrorMessage()).to.contain("ReentrancyGuardReentrantCall");

    // exactly one price moved, buyer -> seller, nothing stranded in the registry
    expect(preBuyer - (await token.balanceOf(buyer.address))).to.equal(price);
    expect((await token.balanceOf(seller.address)) - preSeller).to.equal(price);
    expect(await token.balanceOf(registry.target)).to.equal(preRegistry);

    // and the re-entrant attempt did not inflate the access bookkeeping
    const data = await registry.getGenomicData(1n);
    expect(data.accessCount).to.equal(1n);
    expect((await registry.accessGrants(1n, buyer.address)).isGranted).to.equal(true);
  });

  it("A2-X03 escrow deposit path survives the same hook with custody equal to exactly one price", async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer] = await ethers.getSigners();

    const MT = await ethers.getContractFactory("MaliciousReentrantToken");
    token = await MT.deploy(owner.address);
    await token.waitForDeployment();
    await (await token.transfer(seller.address, ethers.parseEther("1000"))).wait();
    await (await token.transfer(buyer.address, ethers.parseEther("1000"))).wait();
    await deployAll(token.target);

    const reg = await registry.connect(seller).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("REENT-ESCROW")),
      "QmReentEscRaw11111111111111111111111111111111",
      "QmReentEscSum1111111111111111111111111111111",
      "QmReentEscMeta111111111111111111111111111111",
      "ipfs://reent-esc", price, 86400, 1000
    );
    expect((await reg.wait()).status).to.equal(1);

    await (await token.connect(buyer).approve(registry.target, price * 3n)).wait();
    await (await token.setRegistryAndTarget(registry.target, 1n)).wait();

    const preBuyer = await token.balanceOf(buyer.address);
    const res = await capture(() =>
      registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, 86400, price)
    );
    expect(res.ok, res.error).to.equal(true);

    expect(await token.attackSucceeded()).to.equal(false);
    expect(preBuyer - (await token.balanceOf(buyer.address))).to.equal(price);
    expect(await token.balanceOf(registry.target)).to.equal(price);
    const dep = await registry.escrowDeposits(1n, buyer.address);
    expect(dep.amount).to.equal(price);
    expect((await registry.getGenomicData(1n)).accessCount).to.equal(1n);
  });

  it("A2-X04 onlyRegistry mints: a direct NFT mint from an EOA is rejected", async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer] = await ethers.getSigners();
    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();
    await deployAll(token.target);

    const res = await capture(() => nft.connect(buyer).mintGenomicNFT(
      buyer.address, "ipfs://fake", ethers.keccak256(ethers.toUtf8Bytes("x")),
      "QmFake", "QmFake", "QmFake", 100
    ));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("OnlyRegistry");
    expect(await nft.nextTokenId()).to.equal(1n); // nothing was ever minted
    const owns = await capture(() => nft.ownerOf.staticCall(1n));
    expect(owns.ok).to.equal(false);
    expect(owns.error).to.contain("ERC721NonexistentToken");
    expect(await registry.dataCount()).to.equal(0n);
  });

  it("A2-X05 NFT transfer worker-reset fallback cannot be abused to clear another dataset's workers", async function () {
    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(owner.address);
    await token.waitForDeployment();
    await deployAll(token.target);

    // dataset #2 exists and has an authorized worker
    for (const seed of ["W1", "W2"]) {
      const r = await registry.connect(seller).registerGenomicData(
        ethers.keccak256(ethers.toUtf8Bytes(seed)),
        `QmWorker${seed}111111111111111111111111111111111`,
        `QmWorkerS${seed}11111111111111111111111111111111`,
        `QmWorkerM${seed}1111111111111111111111111111111`,
        `ipfs://w-${seed}`, price, 86400, 1000
      );
      expect((await r.wait()).status).to.equal(1);
    }
    await (await registry.connect(seller).setAuthorizedCapsuleWorker(2n, buyer.address, true)).wait();
    await (await registry.connect(seller).setAuthorizedCapsuleWorker(1n, buyer.address, true)).wait();
    expect(await registry.authorizedCapsuleWorkers(2n, buyer.address)).to.equal(true);
    expect(await registry.authorizedCapsuleWorkers(1n, buyer.address)).to.equal(true);

    // a stranger cannot call the public reset entry point for dataset 2
    const bad = await capture(() => registry.connect(buyer).resetAuthorizedWorkers(2n));
    expect(bad.ok).to.equal(false);
    expect(bad.error).to.contain("NotDataOwner()");

    // transferring token 1 (dataset 1) must clear dataset 1's workers and leave dataset 2 intact
    await (await nft.connect(seller).transferFrom(seller.address, buyer.address, 1n)).wait();
    expect(await registry.authorizedCapsuleWorkers(2n, buyer.address)).to.equal(true);
    expect(await registry.authorizedCapsuleWorkers(1n, buyer.address)).to.equal(false);
  });
});
