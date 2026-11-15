/**
 * AGENT 6/6 — INDEPENDENT BLIND ADVERSARIAL TEST (Task 6)
 * Target: royalty settlement (EIP-2981), escrow lifecycle, reentrancy via the repo's own
 * malicious mocks, and non-standard (void-return) ERC20 handling through the escrow.
 * Every security claim is decided by real EVM reads (balances / receipts / state).
 */
import { expect } from "chai";
import hre from "hardhat";

const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID2 = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";

describe("AGENT6 :: royalty, escrow & reentrancy adversarial suite", function () {
  let ethers;
  let token, nft, registry;
  let owner, sellerAlt, buyers, attacker;

  const PRICE = () => ethers.parseUnits("100", 18);
  const BPS = 1000; // 10%

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, sellerAlt, attacker, ...buyers] = await ethers.getSigners();

    const TF = await ethers.getContractFactory("GenomicToken");
    token = await TF.deploy(owner.address);
    await token.waitForDeployment();

    const NF = await ethers.getContractFactory("GenomicNFT");
    nft = await NF.deploy(owner.address, BPS);
    await nft.waitForDeployment();

    const RF = await ethers.getContractFactory("GenomicsRegistry");
    registry = await RF.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await nft.setRegistryContract(registry.target);
  });

  async function register(seed, duration = 86400) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
    await (
      await registry
        .connect(owner)
        .registerGenomicData(
          hash,
          CID,
          CID2,
          CID,
          `ipfs://${CID}`,
          PRICE(),
          duration,
          BPS
        )
    ).wait();
    return hash;
  }

  async function fund(signer, times = 3) {
    await (await token.connect(owner).transfer(signer.address, PRICE() * BigInt(times))).wait();
    await (
      await token.connect(signer).approve(registry.target, PRICE() * BigInt(times))
    ).wait();
  }

  // --------------------------------------------------------------- R1
  describe("R1 exact EIP-2981 split under concurrency", function () {
    it("5 buyers mined in the SAME block: every wei must be conserved and the split must equal royaltyInfo()", async function () {
      await register("DNA_ROYALTY_CONC");
      const five = buyers.slice(0, 5);
      for (const b of five) await fund(b, 1);

      const sellerBefore = await token.balanceOf(owner.address);
      const registryBefore = await token.balanceOf(registry.target);
      const expected = await nft.royaltyInfo(1, PRICE());
      const [royaltyReceiver, royaltyAmount] = expected;

      // force same-block inclusion
      let automineDisabled = false;
      try {
        await ethers.provider.send("evm_setAutomine", [false]);
        automineDisabled = true;
      } catch {
        automineDisabled = false;
      }

      const txs = five.map((b) => registry.connect(b)["grantAccess(uint256,uint256)"](1, PRICE()));
      const waits = (await Promise.all(txs)).map((t) => t.wait());
      if (automineDisabled) {
        await ethers.provider.send("evm_mine", []);
      }
      const receipts = await Promise.all(waits);

      const blocks = new Set(receipts.map((r) => r.blockNumber));
      const sellerAfter = await token.balanceOf(owner.address);
      const registryAfter = await token.balanceOf(registry.target);

      // 1) conservation: nothing may remain locked in the registry on the direct path
      expect(registryAfter - registryBefore, "registry must hold nothing after direct grants").to.equal(
        0n
      );
      // 2) exact seller proceeds
      expect(sellerAfter - sellerBefore, "seller proceeds").to.equal(PRICE() * 5n);
      // 3) per-purchase royalty as advertised by the NFT's own EIP-2981 view
      expect(royaltyReceiver, "royalty receiver is the creator == seller here").to.equal(owner.address);
      expect(royaltyAmount, "royalty bps math").to.equal((PRICE() * BigInt(BPS)) / 10000n);

      // 4) RoyaltyPaid events must sum to exactly 5 * royaltyAmount
      const evs = await registry.queryFilter(registry.filters.RoyaltyPaid(1), 0, "latest");
      const sum = evs.reduce((acc, e) => acc + e.args.amount, 0n);
      expect(sum, "sum of emitted royalties").to.equal(royaltyAmount * 5n);
      expect(evs.length, "one RoyaltyPaid per purchase").to.equal(5);

      // 5) accessCount / grants read from chain
      const data = await registry.getGenomicData(1);
      expect(data.accessCount).to.equal(5n);
      for (const b of five) {
        const g = await registry.accessGrants(1, b.address);
        expect(g.isGranted, `grant for ${b.address}`).to.equal(true);
        expect(await registry.hasActiveAccess(1, b.address)).to.equal(true);
      }
      // record whether the same-block requirement actually held (Hardhat EDR may auto-mine)
      if (automineDisabled) {
        expect(blocks.size, "all 5 grants should be in one block").to.equal(1);
      }
    });

    it("secondary market: royalty must go to the ORIGINAL creator, proceeds to the new NFT owner", async function () {
      await register("DNA_SECONDARY");
      // creator (owner) sells the Data NFT to sellerAlt
      const data = await registry.getGenomicData(1);
      await (await nft.connect(owner).transferFrom(owner.address, sellerAlt.address, data.tokenId)).wait();
      expect(await nft.ownerOf(data.tokenId)).to.equal(sellerAlt.address);

      await fund(buyers[0], 1);
      const [receiver, royalty] = await nft.royaltyInfo(data.tokenId, PRICE());
      const altBefore = await token.balanceOf(sellerAlt.address);
      const creatorBefore = await token.balanceOf(owner.address);

      const rc = await (
        await registry.connect(buyers[0])["grantAccess(uint256,uint256)"](1, PRICE())
      ).wait();
      expect(rc.status).to.equal(1);

      const altAfter = await token.balanceOf(sellerAlt.address);
      const creatorAfter = await token.balanceOf(owner.address);

      expect(receiver, "EIP-2981 receiver follows the creator recorded at mint").to.equal(owner.address);
      expect(royalty).to.equal((PRICE() * BigInt(BPS)) / 10000n);
      expect(creatorAfter - creatorBefore, "creator royalty").to.equal(royalty);
      expect(altAfter - altBefore, "secondary seller proceeds").to.equal(PRICE() - royalty);
      expect(
        creatorAfter - creatorBefore + (altAfter - altBefore),
        "no wei may be minted, burned or trapped"
      ).to.equal(PRICE());
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });
  });

  // --------------------------------------------------------------- R2
  describe("R2 reentrancy through the repo's own malicious mocks", function () {
    it("re-entry from an ERC721 onERC721Received hook during registration must fail and mint nothing", async function () {
      const MF = await ethers.getContractFactory("MaliciousReentrantReceiver");
      const mock = await MF.deploy(registry.target);
      await mock.waitForDeployment();

      const before = await registry.dataCount();
      await (
        await mock
          .connect(owner)
          .registerWithRegistry(
            ethers.keccak256(ethers.toUtf8Bytes("MAL_DATA")),
            CID,
            CID2,
            CID,
            "ipfs://malicious",
            PRICE(),
            86400,
            500
          )
      ).wait();

      expect(await mock.attackSucceeded(), "re-entrant registerGenomicData must NOT succeed").to.equal(
        false
      );
      expect(await registry.dataCount(), "no extra dataset may exist").to.equal(before + 1n);
      expect(await registry.dataCount()).to.equal(1n);
    });

    it("re-entry from a malicious ERC20 transferFrom hook during grantAccess must fail and not double-grant", async function () {
      const MT = await ethers.getContractFactory("MaliciousReentrantToken");
      const mal = await MT.deploy(owner.address);
      await mal.waitForDeployment();

      // a SECOND registry instance paid in the malicious token (source is read-only, so we
      // re-point an existing deployment rather than editing contracts/mocks/)
      const RF = await ethers.getContractFactory("GenomicsRegistry");
      const reg2 = await RF.deploy(mal.target, nft.target, owner.address);
      await reg2.waitForDeployment();
      await nft.setRegistryContract(reg2.target);

      await (
        await reg2
          .connect(owner)
          .registerGenomicData(
            ethers.keccak256(ethers.toUtf8Bytes("DNA_MAL")),
            CID,
            CID2,
            CID,
            `ipfs://${CID}`,
            PRICE(),
            86400,
            BPS
          )
      ).wait();

      await (await mal.setRegistryAndTarget(reg2.target, 1)).wait();
      await (await mal.connect(owner).transfer(buyers[0].address, PRICE() * 2n)).wait();
      await (await mal.connect(buyers[0]).approve(reg2.target, PRICE() * 2n)).wait();

      await (await reg2.connect(buyers[0])["grantAccess(uint256,uint256)"](1, PRICE())).wait();

      expect(await mal.attackSucceeded(), "re-entrant grantAccess must NOT succeed").to.equal(false);
      const data = await reg2.getGenomicData(1);
      expect(data.accessCount, "accessCount must not be inflated by the re-entrant call").to.equal(1n);
      const g = await reg2.accessGrants(1, buyers[0].address);
      expect(g.isGranted).to.equal(true);
      expect(await mal.balanceOf(reg2.target)).to.equal(0n);
    });
  });

  // --------------------------------------------------------------- R3
  describe("R3 non-standard (void-return) ERC20 through the escrow (SafeERC20)", function () {
    let nst, reg3;

    beforeEach(async function () {
      const NF2 = await ethers.getContractFactory("NonStandardERC20");
      nst = await NF2.deploy(ethers.parseUnits("1000000", 18));
      await nst.waitForDeployment();

      const RF = await ethers.getContractFactory("GenomicsRegistry");
      reg3 = await RF.deploy(nst.target, nft.target, owner.address);
      await reg3.waitForDeployment();
      await nft.setRegistryContract(reg3.target);

      await (
        await reg3
          .connect(owner)
          .registerGenomicData(
            ethers.keccak256(ethers.toUtf8Bytes("DNA_NST")),
            CID,
            CID2,
            CID,
            `ipfs://${CID}`,
            PRICE(),
            86400,
            BPS
          )
      ).wait();

      await (await nst.connect(owner).transfer(buyers[0].address, PRICE() * 3n)).wait();
      await (await nst.connect(buyers[0]).approve(reg3.target, PRICE() * 3n)).wait();
    });

    it("escrow deposit + delivery + refund all work with a void-return token (no silent skip)", async function () {
      await (await reg3.connect(buyers[0])["grantAccessWithEscrow(uint256,uint256)"](1, 3600)).wait();
      expect(await nst.balanceOf(reg3.target), "void-return transferFrom must really move funds").to.equal(
        PRICE()
      );

      await (
        await reg3
          .connect(owner)
          .storeTransformedCapsule(1, buyers[0].address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", keyCipher: "ab".repeat(256) }))
      ).wait();
      const dep = await reg3.escrowDeposits(1, buyers[0].address);
      expect(dep.released).to.equal(true);
      expect(await nst.balanceOf(reg3.target)).to.equal(0n);
      expect(await nst.balanceOf(owner.address)).to.be.greaterThan(0n);
    });

    it("refund path must also work for a void-return token", async function () {
      await (await reg3.connect(buyers[0])["grantAccessWithEscrow(uint256,uint256)"](1, 3600)).wait();
      const dep = await reg3.escrowDeposits(1, buyers[0].address);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(dep.depositTime) + 3601]);
      const before = await nst.balanceOf(buyers[0].address);
      await (await reg3.connect(buyers[0]).claimEscrowRefund(1)).wait();
      const after = await nst.balanceOf(buyers[0].address);
      expect(after - before, "100% refund with a void-return token").to.equal(PRICE());
      expect((await reg3.escrowDeposits(1, buyers[0].address)).refunded, "refund flagged").to.equal(true);
      expect((await reg3.accessGrants(1, buyers[0].address)).isGranted).to.equal(false);
    });
  });

  // --------------------------------------------------------------- R4
  describe("R4 emitTransformedCapsule: gas-optimised path must not strand the paying buyer", function () {
    it("DEFECT PROBE: escrow released with capsule present ONLY in logs => buyer has no on-chain recourse", async function () {
      await register("DNA_EMIT_ONLY", 86400);
      await fund(buyers[0], 2);
      await (await registry.connect(buyers[0])["grantAccessWithEscrow(uint256,uint256)"](1, 86400)).wait();

      // dispatcher (here the data owner) uses the "gas-optimized" emission path
      const capsule = '{"version":"GENO-ASYM-RSA-OAEP-v2","keyCipher":"' + "ab".repeat(512) + '"}';
      const rc = await (
        await registry.connect(owner).emitTransformedCapsule(1, buyers[0].address, capsule)
      ).wait();
      expect(rc.status).to.equal(1);

      const dep = await registry.escrowDeposits(1, buyers[0].address);
      const stored = await registry.connect(buyers[0]).buyerCapsules(1, buyers[0].address);

      expect(dep.released, "escrow auto-released on emit").to.equal(true);
      expect(dep.capsuleDelivered, "capsuleDelivered flag set").to.equal(true);
      expect(
        stored,
        "buyer paid + escrow released, yet buyerCapsules is empty: the gas-optimised " +
          "emitTransformedCapsule path (GenomicsRegistry.sol:756-789) writes NO storage, and " +
          "claimEscrowRefund is then blocked by the capsuleDelivered/released checks " +
          "(GenomicsRegistry.sol:480-483). The only copy of the key material is the event log " +
          "(datasetService.js:362-373 reads it), so a buyer using a light client, a different " +
          "wallet, or a pruned node loses all recourse."
      ).to.not.equal("");
      const sellerBal = await token.balanceOf(owner.address);
      expect(sellerBal, "seller was paid in full despite empty storage").to.be.greaterThan(0n);
    });
  });
});
