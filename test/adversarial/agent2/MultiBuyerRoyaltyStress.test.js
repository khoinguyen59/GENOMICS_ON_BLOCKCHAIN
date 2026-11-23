/**
 * AGENT 2 — ADVERSARIAL SUITE (Task 6.c)
 * Concurrent multi-buyer stress + exact EIP-2981 royalty-split conservation.
 *
 * All money assertions are computed from REAL on-chain balance deltas read
 * before/after each tx (tx.wait() status == 1), never from JS inputs alone.
 */
import { expect } from "chai";
import hre from "hardhat";

const DISPUTE = 86400; // 1 day

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

describe("AGENT2 :: Concurrent Multi-Buyer Stress & Royalty Split Conservation (EIP-2981)", function () {
  this.timeout(240000);
  let ethers, token, nft, registry, owner, creator, reseller;
  let buyers = [];
  // deliberately non-divisible price so royalty rounding must be accounted for
  const price = 1000000000000000001n; // 1e18 + 1 wei
  const bps = 1000n;

  async function deployAndRegister(dataSeed, royaltyBps) {
    const cleanSeed = String(dataSeed).replace(/0/g, "x").replace(/O/g, "o").replace(/I/g, "i").replace(/l/g, "1").replace(/[^1-9A-HJ-NP-Za-km-z]/g, "");
    const tx = await registry.connect(creator).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes(dataSeed)),
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      `ipfs://${dataSeed}`, price, 86400 * 30, royaltyBps
    );
    const r = await tx.wait();
    expect(r.status).to.equal(1);
    return r;
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    const signers = await ethers.getSigners();
    [owner, creator, reseller] = signers;
    buyers = signers.slice(3, 11); // 8 independent buyer wallets

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

    for (const b of buyers) {
      const t = await token.transfer(b.address, ethers.parseEther("500"));
      await t.wait();
    }
  });

  it("A2-R01 creator==seller path: buyer pays exactly price, seller receives exactly price, registry holds nothing", async function () {
    await deployAndRegister("ROY1", bps);
    const registryAddr = await registry.getAddress();

    const preReg = await token.balanceOf(registryAddr);
    const preSeller = await token.balanceOf(creator.address);
    const preBuyer = await token.balanceOf(buyers[0].address);

    await (await token.connect(buyers[0]).approve(registryAddr, price)).wait();
    const r = await capture(() => registry.connect(buyers[0])["grantAccess(uint256)"](1n));
    expect(r.ok, r.error).to.equal(true);

    expect(await token.balanceOf(registryAddr)).to.equal(preReg);           // no escrow left behind
    expect(await token.balanceOf(creator.address) - preSeller).to.equal(price);
    expect(preBuyer - (await token.balanceOf(buyers[0].address))).to.equal(price);

    const grant = await registry.accessGrants(1n, buyers[0].address);
    expect(grant.isGranted).to.equal(true);
    expect(grant.expiresAt).to.equal(grant.grantedAt + 86400n * 30n);
  });

  it("A2-R02 secondary sale: royalty + seller proceeds sum to EXACTLY the price paid (no dust, no double-dip)", async function () {
    await deployAndRegister("ROY2", bps);
    // creator sells the NFT to a reseller -> reseller becomes the market seller
    await (await nft.connect(creator).transferFrom(creator.address, reseller.address, 1n)).wait();
    expect(await nft.ownerOf(1n)).to.equal(reseller.address);

    const [receiver, royalty] = await nft.royaltyInfo.staticCall(1n, price);
    expect(receiver).to.equal(creator.address);
    expect(royalty).to.equal(100000000000000000n); // floor((1e18+1)*1000/10000)

    const preCreator = await token.balanceOf(creator.address);
    const preReseller = await token.balanceOf(reseller.address);
    const preBuyer = await token.balanceOf(buyers[1].address);
    const registryAddr = await registry.getAddress();

    await (await token.connect(buyers[1]).approve(registryAddr, price)).wait();
    const r = await capture(() => registry.connect(buyers[1])["grantAccess(uint256,uint256)"](1n, price));
    expect(r.ok, r.error).to.equal(true);

    const dCreator = await token.balanceOf(creator.address) - preCreator;
    const dReseller = await token.balanceOf(reseller.address) - preReseller;
    const dBuyer = preBuyer - (await token.balanceOf(buyers[1].address));

    expect(dCreator).to.equal(royalty);
    expect(dReseller).to.equal(price - royalty);
    // conservation of the three real deltas (100% of the price is accounted for)
    expect(dCreator + dReseller).to.equal(dBuyer);
    expect(dBuyer).to.equal(price);
    expect(await token.balanceOf(registryAddr)).to.equal(0n);
  });

  it("A2-R03 8-buyer concurrent burst on one dataset: accessCount and total disbursement match exactly", async function () {
    await deployAndRegister("ROY3", bps);
    const registryAddr = await registry.getAddress();
    const preSeller = await token.balanceOf(creator.address);

    const preBuyer = [];
    for (const b of buyers) preBuyer.push(await token.balanceOf(b.address));

    for (const b of buyers) {
      await (await token.connect(b).approve(registryAddr, price)).wait();
    }

    // fire all 8 purchases without awaiting in between (real concurrency on distinct nonces)
    const submitted = await Promise.all(
      buyers.map((b) => registry.connect(b)["grantAccess(uint256,uint256)"](1n, price))
    );
    const receipts = await Promise.all(submitted.map((t) => t.wait()));
    for (const rc of receipts) expect(rc.status).to.equal(1);

    const data = await registry.getGenomicData(1n);
    expect(data.accessCount).to.equal(8n);

    let totalSpent = 0n;
    for (let i = 0; i < buyers.length; i++) {
      const g = await registry.accessGrants(1n, buyers[i].address);
      expect(g.isGranted, `buyer[${i}] grant missing`).to.equal(true);
      const post = await token.balanceOf(buyers[i].address);
      const spent = preBuyer[i] - post;
      expect(spent, `buyer[${i}] over/under-charged`).to.equal(price);
      totalSpent += spent;
    }

    // seller received exactly 8 * price and nothing leaked into the registry
    const sellerGain = (await token.balanceOf(creator.address)) - preSeller;
    expect(sellerGain).to.equal(price * 8n);
    // 100% of what the crowd paid landed in the seller's wallet, 0 stayed in custody
    expect(totalSpent).to.equal(sellerGain);
    expect(await token.balanceOf(registryAddr)).to.equal(0n);
  });

  it("A2-R04 escrow path with 4 concurrent deposits: contract custody == sum(deposits), then 100% released", async function () {
    await deployAndRegister("ROY4", bps);
    const registryAddr = await registry.getAddress();
    const four = buyers.slice(0, 4);

    const preDepositors = [];
    for (const b of four) {
      preDepositors.push(await token.balanceOf(b.address));
      await (await token.connect(b).approve(registryAddr, price)).wait();
    }

    const submitted = await Promise.all(
      four.map((b) => registry.connect(b)["grantAccessWithEscrow(uint256,uint256,uint256)"](1n, DISPUTE, price))
    );
    const receipts = await Promise.all(submitted.map((t) => t.wait()));
    for (const rc of receipts) expect(rc.status).to.equal(1);

    // custody check straight from the chain
    expect(await token.balanceOf(registryAddr)).to.equal(price * 4n);
    for (let i = 0; i < four.length; i++) {
      const dep = await registry.escrowDeposits(1n, four[i].address);
      expect(dep.amount).to.equal(price);
      expect(dep.released).to.equal(false);
      expect(preDepositors[i] - (await token.balanceOf(four[i].address))).to.equal(price);
    }

    // dispatcher delivers real capsules -> buyers confirm fair-exchange release -> 10% creator royalty
    const preCreator = await token.balanceOf(creator.address);
    for (const b of four) {
      const t = await registry
        .connect(owner)
        .storeTransformedCapsule(1n, b.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", capsule: `A2-REAL-${b.address}`, keyCipher: "ab".repeat(256) }));
      expect((await t.wait()).status).to.equal(1);
      await (await registry.connect(b).confirmCapsuleAndReleaseEscrow(1n)).wait();
    }

    expect(await token.balanceOf(registryAddr)).to.equal(0n);
    const paidOut = await token.balanceOf(creator.address) - preCreator;
    // creator is also the seller here -> royaltyReceiver == seller -> full price routed to creator
    expect(paidOut).to.equal(price * 4n);

    for (const b of four) {
      const dep = await registry.escrowDeposits(1n, b.address);
      expect(dep.released).to.equal(true);
      const capsule = await registry.connect(b).getTransformedCapsule.staticCall(1n);
      expect(capsule).to.contain("A2-REAL");
    }
  });

  it("A2-R05 royalty basis-point ceiling is enforced by MAX_ROYALTY_BPS (5000 bps = 50%; >50% reverts)", async function () {
    const over = await capture(() => registry.connect(creator).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("ROY-OVER")), "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx", "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://over", price, 86400, 5001
    ));
    expect(over.ok).to.equal(false);
    expect(over.error).to.contain("ERC2981InvalidTokenRoyalty");

    const maxOk = await capture(() => registry.connect(creator).registerGenomicData(
      ethers.keccak256(ethers.toUtf8Bytes("ROY-MAX")), "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx", "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://max", price, 86400, 5000
    ));
    expect(maxOk.ok, maxOk.error).to.equal(true);

    // 50% max royalty: half routes to creator, half routes to secondary reseller (zero dust loss)
    const registryAddr = await registry.getAddress();
    expect(await registry.dataCount()).to.equal(1n); // the invalid registration rolled back fully
    await (await token.connect(buyers[0]).approve(registryAddr, price * 2n)).wait();
    await (await nft.connect(creator).transferFrom(creator.address, reseller.address, 1n)).wait();
    expect(await nft.ownerOf(1n)).to.equal(reseller.address);
    const preCreator = await token.balanceOf(creator.address);
    const preReseller = await token.balanceOf(reseller.address);
    const preBuyer = await token.balanceOf(buyers[0].address);
    const r = await capture(() => registry.connect(buyers[0])["grantAccess(uint256,uint256)"](1n, price));
    expect(r.ok, r.error).to.equal(true);
    const expectedHalf = price / 2n;
    expect(await token.balanceOf(creator.address) - preCreator).to.equal(expectedHalf);
    expect(await token.balanceOf(reseller.address) - preReseller).to.equal(price - expectedHalf);
    expect(preBuyer - (await token.balanceOf(buyers[0].address))).to.equal(price);
    expect(await token.balanceOf(registryAddr)).to.equal(0n);
  });

  it("A2-R06 MEV slippage guard: a raised price front-runs grantAccess(maxPrice) and reverts PriceExceedsMax", async function () {
    await deployAndRegister("ROY6", bps);
    const registryAddr = await registry.getAddress();
    await (await token.connect(buyers[2]).approve(registryAddr, price * 3n)).wait();

    // attacker-seller bumps the price one block before the buyer's tx
    await (await registry.connect(creator).updateDataPrice(1n, price * 2n)).wait();
    const res = await capture(() => registry.connect(buyers[2])["grantAccess(uint256,uint256)"](1n, price));
    expect(res.ok).to.equal(false);
    expect(res.error).to.contain("PriceExceedsMax");

    // buyer's tokens are untouched
    expect(await token.balanceOf(buyers[2].address)).to.equal(ethers.parseEther("500"));
    expect(await registry.hasActiveAccess(1n, buyers[2].address)).to.equal(false);
  });
});
