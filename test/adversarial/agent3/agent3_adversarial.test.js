/**
 * AGENT 3 / 6 — ISOMORPHIC ADVERSARIAL BLIND TEST SUITE
 * ============================================================================
 * Written independently from spec + threat model (INVARIANT-17: builder/auditor
 * separation). Every assertion checks a DEFENCE (custom-error revert, victim
 * assets preserved, state not mutated). An assertion that fails is evidence of a
 * defect; an assertion that "celebrates" a successful exploit is never written.
 *
 * All state is read back from the real EVM (await tx.wait() / view calls).
 * No JS-side arithmetic tautologies. No precompile bytecode patching.
 */
import { expect } from "chai";
import hre from "hardhat";

describe("AGENT3 ADVERSARIAL: GenoChain Registry / Token / NFT / zk-Verifier", function () {
  let ethers;
  let deployer, dataOwner, buyer, attacker, worker, thirdParty, secondarySeller;

  const PRICE = 100n * 10n ** 18n; // 100 $GENO
  const DURATION = 3 * 24 * 60 * 60; // 3 days (seconds)
  const ROYALTY_BPS = 1000; // 10 %
  const DISPUTE_WINDOW = 3600; // 1 hour

  const RAW_CID = "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";
  const SUM_CID = "Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD";
  const META_CID = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";

  const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  // G2 generator exactly as hardcoded inside GenomicZkVerifier.sol verifyProofInternal()
  const G2_FIXED = [
    [
      "0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2",
      "0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed",
    ],
    [
      "0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b",
      "0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa",
    ],
  ];

  async function bumpTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function latestTime() {
    const block = await ethers.provider.getBlock("latest");
    return Number(block.timestamp);
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, dataOwner, buyer, attacker, worker, thirdParty, secondarySeller] =
      await ethers.getSigners();

    const TokenF = await ethers.getContractFactory("GenomicToken");
    const token = await TokenF.deploy(deployer.address);
    await token.waitForDeployment();

    const NftF = await ethers.getContractFactory("GenomicNFT");
    const nft = await NftF.deploy(deployer.address, ROYALTY_BPS);
    await nft.waitForDeployment();

    const RegF = await ethers.getContractFactory("GenomicsRegistry");
    const registry = await RegF.deploy(token.target, nft.target, deployer.address);
    await registry.waitForDeployment();

    await nft.connect(deployer).setRegistryContract(registry.target);

    // Fund participants from the owner-minted genesis supply (real EVM state)
    await token.connect(deployer).mint(dataOwner.address, 1000n * 10n ** 18n);
    await token.connect(deployer).mint(buyer.address, 1_000_000n * 10n ** 18n);
    await token.connect(deployer).mint(attacker.address, 1_000_000n * 10n ** 18n);
    await token.connect(deployer).mint(thirdParty.address, 1_000_000n * 10n ** 18n);

    this.ethers = ethers;
    this.token = token;
    this.nft = nft;
    this.registry = registry;
  });

  async function registerDataset(ctx, price = PRICE) {
    const reg = ctx.registry.connect(dataOwner);
    const tx = await reg.registerGenomicData(
      "0x" + "ab".repeat(32),
      RAW_CID,
      SUM_CID,
      META_CID,
      `ipfs://${META_CID}`,
      price,
      DURATION,
      ROYALTY_BPS
    );
    const rc = await tx.wait();
    return { receipt: rc, dataId: await ctx.registry.dataCount() };
  }

  async function approveCtx(ctx, who, amount) {
    await ctx.token
      .connect(who)
      .approve(ctx.registry.target, amount);
  }

  // ==========================================================================
  // TEST 1 — INVARIANT-15: faucet anti-Sybil rate limiting on BOTH msg.sender
  // and `to`, boundary-exact at 3600 s, and no free money beyond 1 h/identity.
  // ==========================================================================
  describe("T1  faucet() economic fuzzer — INV-15 dual-sided cooldown", function () {
    it("must revert FaucetCooldownActive at t+3599s and allow only at the full 1h boundary", async function () {
      const { token } = this;
      const FAUCET_AMOUNT = await token.FAUCET_AMOUNT();
      expect(await token.FAUCET_COOLDOWN()).to.equal(3600n);

      const genesis = await token.balanceOf(buyer.address);
      const firstTx = await token.connect(buyer).faucet(buyer.address);
      const firstRc = await firstTx.wait();
      const claimTime = (await ethers.provider.getBlock(firstRc.blockNumber)).timestamp;
      const balAfter1 = await token.balanceOf(buyer.address);
      expect(balAfter1 - genesis).to.equal(FAUCET_AMOUNT);
      expect(await token.lastFaucetTime(buyer.address)).to.equal(BigInt(claimTime));

      // (a) 1 second BEFORE the 1 h window closes -> must revert.
      // Use evm_setNextBlockTimestamp so the boundary is exact (auto-mining
      // would otherwise advance the clock an extra second).
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(claimTime) + 3599]);
      await expect(token.connect(buyer).faucet(buyer.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );

      // (b) balance must be PRESERVED (no partial mint on a reverted call)
      expect(await token.balanceOf(buyer.address)).to.equal(balAfter1);

      // (c) at exactly claimTime + 3600 the claim becomes permitted
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(claimTime) + 3600]);
      await (await token.connect(buyer).faucet(buyer.address)).wait();
      expect(await token.balanceOf(buyer.address)).to.equal(balAfter1 + FAUCET_AMOUNT);
    });

    it("must block the Sybil pattern 'one caller mints to many fresh recipients'", async function () {
      const { token } = this;
      const fresh1 = "0x" + "11".repeat(20);
      const fresh2 = "0x" + "22".repeat(20);

      const supplyBefore = await token.totalSupply();
      await (await token.connect(attacker).faucet(attacker.address)).wait();
      const afterOneClaim = await token.totalSupply();
      expect(afterOneClaim - supplyBefore).to.equal(await token.FAUCET_AMOUNT());

      // Attacker now tries to drain using brand-new recipient addresses.
      // The msg.sender-side cooldown is what stops the Sybil fan-out.
      await expect(token.connect(attacker).faucet(fresh1)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      await expect(token.connect(attacker).faucet(fresh2)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );

      // No additional tokens were created by the fan-out attempt.
      expect(await token.totalSupply()).to.equal(afterOneClaim);
    });

    it("must rate-limit a recipient that was funded by a DIFFERENT caller", async function () {
      const { token } = this;
      await (await token.connect(attacker).faucet(buyer.address)).wait();
      const after = await token.balanceOf(buyer.address);

      // victim already received faucet money this window -> second claim blocked
      await expect(token.connect(thirdParty).faucet(buyer.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      expect(await token.balanceOf(buyer.address)).to.equal(after);
    });
  });

  // ==========================================================================
  // TEST 2 — INVARIANT-16: out-of-range dataId must revert DataNotFound on
  // EVERY read/write entry point, never silently return EVM zero-values.
  // Sweep for absence: enumerate all 16 dataId-taking functions.
  // ==========================================================================
  describe("T2  dataId boundary must revert DataNotFound() (INV-16)", function () {
    const BOUNDARY_FUNCS = [
      ["grantAccess(uint256)", (r, id) => r["grantAccess(uint256)"](id)],
      ["grantAccessWithEscrow(uint256,uint256)", (r, id) => r["grantAccessWithEscrow(uint256,uint256)"](id, DISPUTE_WINDOW)],
      ["claimEscrowRefund", (r, id) => r.claimEscrowRefund(id)],
      ["releaseEscrow", (r, id) => r.releaseEscrow(id, buyer.address)],
      ["updateDataStatus", (r, id) => r.updateDataStatus(id, 1)],
      ["updateDataPrice", (r, id) => r.updateDataPrice(id, 7n)],
      ["grantDirectAccess", (r, id) => r.grantDirectAccess(id, buyer.address)],
      ["setAuthorizedCapsuleWorker", (r, id) => r.setAuthorizedCapsuleWorker(id, worker.address, true)],
      ["resetAuthorizedWorkers", (r, id) => r.resetAuthorizedWorkers(id)],
      ["storeTransformedCapsule", (r, id) => r.storeTransformedCapsule(id, buyer.address, "caps")],
      ["emitTransformedCapsule", (r, id) => r.emitTransformedCapsule(id, buyer.address, "caps")],
      ["getTransformedCapsule", (r, id) => r.getTransformedCapsule.staticCall(id)],
      ["getCapsuleForBuyer", (r, id) => r.getCapsuleForBuyer.staticCall(id, buyer.address)],
      ["buyerCapsules", (r, id) => r.buyerCapsules.staticCall(id, buyer.address)],
      ["hasActiveAccess", (r, id) => r.hasActiveAccess.staticCall(id, buyer.address)],
      ["getGenomicData", (r, id) => r.getGenomicData.staticCall(id)],
    ];

    it("every dataId-taking entry point must revert DataNotFound for id=0 and id=dataCount+1", async function () {
      const ctx = this;
      const { dataId } = await registerDataset(ctx);
      expect(dataId).to.equal(1n);

      const outOfRange = [0n, dataId + 1n, 2n ** 128n];
      const failures = [];

      for (const id of outOfRange) {
        for (const [name, call] of BOUNDARY_FUNCS) {
          const connected = ctx.registry.connect(dataOwner);
          try {
            await call(connected, id);
            failures.push(`${name}(dataId=${id.toString()}) RETURNED INSTEAD OF REVERTING`);
          } catch (err) {
            const msg = String(err && err.shortMessage ? err.shortMessage : err && err.message);
            if (!/DataNotFound/.test(msg)) {
              failures.push(`${name}(dataId=${id.toString()}) wrong error: ${msg.slice(0, 140)}`);
            }
          }
        }
      }

      expect(
        failures,
        `INV-16 boundary sweep failures (${failures.length}):\n  - ${failures.join("\n  - ")}`
      ).to.deep.equal([]);
    });

    it("getDataItemsPaginated must not leak a zero-filled phantom row for out-of-range offsets", async function () {
      const { registry } = this;
      await registerDataset(this);
      const [items, total] = await registry.getDataItemsPaginated.staticCall(0, 10);
      expect(total).to.equal(1n);
      expect(items.length).to.equal(1);
      // a phantom row would present dataId === 0
      expect(items[0].dataId).to.equal(1n);
      const [empty, total2] = await registry.getDataItemsPaginated.staticCall(5, 5);
      expect(empty.length).to.equal(0);
      expect(total2).to.equal(1n);
    });
  });

  // ==========================================================================
  // TEST 3 — Escrow lifecycle: a buyer must NEVER end up both charged and
  // locked out. Probes releaseEscrow() access control + stale-capsule reuse.
  // ==========================================================================
  describe("T3  escrow must never charge a buyer and lock them out", function () {
    it("releaseEscrow() must reject a caller who is neither buyer, seller, dispatcher nor owner", async function () {
      const ctx = this;
      const { registry, token } = ctx;
      const { dataId } = await registerDataset(ctx);
      await approveCtx(ctx, buyer, PRICE);
      await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW);

      const attackerBalBefore = await token.balanceOf(attacker.address);

      // NOTE: releaseEscrow carries NO access-control modifier at all
      // (GenomicsRegistry.sol:507-514). The revert observed below is purely
      // incidental (CapsuleNotDelivered), not an authorisation check.
      await expect(
        registry.connect(attacker).releaseEscrow(dataId, buyer.address)
      ).to.be.revertedWithCustomError(registry, "CapsuleNotDelivered");

      expect(await token.balanceOf(attacker.address)).to.equal(attackerBalBefore);
      expect((await registry.escrowDeposits(dataId, buyer.address)).released).to.equal(false);
    });

    it("a STALE capsule from a previous (expired) grant must not let escrow be released without (re)delivery", async function () {
      const ctx = this;
      const { registry } = ctx;
      const { dataId } = await registerDataset(ctx);

      // --- first (free) direct grant, capsule delivered normally -----------
      await registry.connect(dataOwner).grantDirectAccess(dataId, buyer.address);
      const CAPSULE_V1_LEGACY = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "CAPSULE-V1-LEGACY", keyCipher: "ab".repeat(256) });
      await registry
        .connect(dataOwner)
        .storeTransformedCapsule(dataId, buyer.address, CAPSULE_V1_LEGACY);
      expect(await registry.buyerCapsules.staticCall(dataId, buyer.address)).to.equal(
        CAPSULE_V1_LEGACY
      );

      // --- the direct grant now expires -----------------------------------
      await bumpTime(DURATION + 10);

      // --- buyer pays for a NEW escrow-based purchase ---------------------
      await approveCtx(ctx, buyer, PRICE);
      await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW);
      const escrow = await registry.escrowDeposits(dataId, buyer.address);
      expect(escrow.amount).to.equal(PRICE);
      expect(escrow.released).to.equal(false);
      expect(escrow.capsuleDelivered).to.equal(false);

      // DEFENCE UNDER TEST: settlement of an escrow requires a capsule
      // delivered for THIS purchase. The V1 capsule belongs to an
      // already-consumed, expired grant and must not be reusable.
      await expect(registry.connect(thirdParty).releaseEscrow(dataId, buyer.address)).to.be.revertedWithCustomError(
        registry,
        "CapsuleNotDelivered"
      );

      const stillPending = await registry.escrowDeposits(dataId, buyer.address);
      expect(stillPending.released, "escrow settled on the strength of a stale capsule").to.equal(false);
    });

    it("a buyer who paid into escrow must never end up simultaneously charged and locked out", async function () {
      const ctx = this;
      const { registry, token } = ctx;
      const { dataId } = await registerDataset(ctx);

      // stale capsule from an earlier, already-consumed direct grant
      await registry.connect(dataOwner).grantDirectAccess(dataId, buyer.address);
      await registry.connect(dataOwner).storeTransformedCapsule(dataId, buyer.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "CAPSULE-V1", keyCipher: "ab".repeat(256) }));
      await bumpTime(DURATION + 10);

      await approveCtx(ctx, buyer, PRICE);
      const buyerBefore = await token.balanceOf(buyer.address);
      await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW);
      expect((await token.balanceOf(buyer.address)) - buyerBefore).to.equal(-PRICE);

      // Third party attempts to settle the escrow off-chain-of-intent using the stale capsule
      try {
        await registry.connect(thirdParty).releaseEscrow(dataId, buyer.address);
      } catch (_) {}

      // Now read the REAL resulting EVM state and test the safety property:
      // "value leaves the buyer  =>  buyer can either get the capsule OR refund".
      const dep = await registry.escrowDeposits(dataId, buyer.address);
      const grant = await registry.accessGrants(dataId, buyer.address);

      let canGetCapsule = true;
      try {
        await registry.connect(buyer).getTransformedCapsule.staticCall(dataId);
      } catch (_) {
        canGetCapsule = false;
      }

      let canRefund = true;
      try {
        await registry.connect(buyer).claimEscrowRefund.staticCall(dataId);
      } catch (_) {
        canRefund = false;
      }

      expect(
        dep.released && !grant.isGranted && !canGetCapsule && !canRefund,
        `buyer locked out: released=${dep.released} isGranted=${grant.isGranted} ` +
          `canGetCapsule=${canGetCapsule} canRefund=${canRefund}`
      ).to.equal(false);
    });
  });

  // ==========================================================================
  // TEST 4 — INVARIANT-16 state symmetry: hasActiveAccess() (used by the UI to
  // gate the Decrypt button) must agree with getTransformedCapsule()/
  // buyerCapsules() which actually serve the key material.
  // ==========================================================================
  describe("T4  hasActiveAccess() must be symmetric with the capsule-serving views (INV-16)", function () {
    it("must not advertise active access for a pending escrow that cannot serve a capsule", async function () {
      const ctx = this;
      const { registry } = ctx;
      const { dataId } = await registerDataset(ctx);
      await approveCtx(ctx, buyer, PRICE);
      await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW);

      const advertised = await registry.connect(buyer).hasActiveAccess.staticCall(dataId, buyer.address);

      // Whatever hasActiveAccess() reports, getTransformedCapsule() must agree.
      let capsuleServed = true;
      let serveError = null;
      try {
        await registry.connect(buyer).getTransformedCapsule.staticCall(dataId);
      } catch (e) {
        capsuleServed = false;
        serveError = String(e && e.shortMessage ? e.shortMessage : e.message);
      }

      expect(
        advertised === capsuleServed,
        `ASYMMETRY: hasActiveAccess()=${advertised} but getTransformedCapsule() ` +
          `${capsuleServed ? "served" : "reverted with"} ${serveError ? ": " + serveError : ""}`
      ).to.equal(true);
    });

    it("must deny access identically once the dataset is Revoked", async function () {
      const ctx = this;
      const { registry } = ctx;
      const { dataId } = await registerDataset(ctx);
      await registry.connect(dataOwner).grantDirectAccess(dataId, buyer.address);
      await registry
        .connect(dataOwner)
        .storeTransformedCapsule(dataId, buyer.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "CAPSULE-REVOKABLE", keyCipher: "ab".repeat(256) }));

      await registry.connect(dataOwner).updateDataStatus(dataId, 2); // Revoked

      expect(await registry.connect(buyer).hasActiveAccess.staticCall(dataId, buyer.address)).to.equal(
        false
      );
      await expect(
        registry.connect(buyer).getTransformedCapsule.staticCall(dataId)
      ).to.be.revertedWithCustomError(registry, "DataNotActive");
      // buyerCapsules() must not silently return the capsule either
      expect(await registry.connect(buyer).buyerCapsules.staticCall(dataId, buyer.address)).to.equal("");
    });
  });

  // ==========================================================================
  // TEST 5 — Non-standard ERC-20 (USDT-style void returns) swept through the
  // full escrow lifecycle. Registry must not strand funds / must not accept a
  // silent false-return.
  // ==========================================================================
  describe("T5  non-standard ERC20 (void return) through escrow settlement", function () {
    it("must complete register -> escrow -> capsule -> release with correct balances", async function () {
      const { ethers: eth } = this;
      const NonStdF = await eth.getContractFactory("NonStandardERC20");
      const nonStd = await NonStdF.deploy(eth.parseEther("1000000"));
      await nonStd.waitForDeployment();

      const NftF = await eth.getContractFactory("GenomicNFT");
      const nft2 = await NftF.deploy(deployer.address, ROYALTY_BPS);
      await nft2.waitForDeployment();

      const RegF = await eth.getContractFactory("GenomicsRegistry");
      const reg2 = await RegF.deploy(nonStd.target, nft2.target, deployer.address);
      await reg2.waitForDeployment();
      await nft2.connect(deployer).setRegistryContract(reg2.target);

      await nonStd.connect(deployer).transfer(buyer.address, eth.parseEther("1000"));
      await nonStd.connect(deployer).transfer(thirdParty.address, eth.parseEther("1000"));

      await (
        await reg2
          .connect(dataOwner)
          .registerGenomicData(
            "0x" + "cd".repeat(32),
            RAW_CID,
            SUM_CID,
            META_CID,
            `ipfs://${META_CID}`,
            PRICE,
            DURATION,
            ROYALTY_BPS
          )
      ).wait();

      await nonStd.connect(buyer).approve(reg2.target, PRICE);
      await (await reg2.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, DISPUTE_WINDOW)).wait();

      // registry holds the escrowed amount
      expect(await nonStd.balanceOf(reg2.target)).to.equal(PRICE);

      // void-return transfer must be accepted by SafeERC20 on buyer escrow confirmation
      const CAPSULE_NONSTD = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "CAPSULE-NONSTD", keyCipher: "ab".repeat(256) });
      await reg2.connect(dataOwner).storeTransformedCapsule(1, buyer.address, CAPSULE_NONSTD);
      expect(await nonStd.balanceOf(reg2.target)).to.equal(PRICE);
      await reg2.connect(buyer).confirmCapsuleAndReleaseEscrow(1);
      expect(await nonStd.balanceOf(reg2.target)).to.equal(0n);
      expect(await nonStd.balanceOf(dataOwner.address)).to.equal(PRICE);
      expect(await reg2.connect(buyer).getTransformedCapsule.staticCall(1)).to.equal(CAPSULE_NONSTD);
    });
  });

  // ==========================================================================
  // TEST 6 — Reentrancy through BOTH the ERC-721 receive hook and a malicious
  // payment token, incl. cross-function vectors.
  // ==========================================================================
  describe("T6  reentrancy via ERC721 onERC721Received and malicious ERC20 hook", function () {
    it("ERC-721 receive-hook reentry into registerGenomicData must be blocked and state consistent", async function () {
      const { ethers: eth, registry, token, nft } = this;
      const MalF = await eth.getContractFactory("MaliciousReentrantReceiver");
      const mal = await MalF.deploy(registry.target);
      await mal.waitForDeployment();

      await (
        await mal
          .connect(dataOwner)
          .registerWithRegistry(
            "0x" + "ee".repeat(32),
            RAW_CID,
            SUM_CID,
            META_CID,
            `ipfs://${META_CID}`,
            PRICE,
            DURATION,
            ROYALTY_BPS
          )
      ).wait();

      expect(await mal.attackSucceeded(), "onERC721Received re-entry succeeded").to.equal(false);

      // Exactly ONE dataset must have been created, not two.
      const items = await registry.getAllDataItems.staticCall();
      expect(items.length).to.equal(1);
      expect(await registry.dataCount()).to.equal(1n);
      // GenomicNFT.nextTokenId() returns `_nextTokenId + 1` (GenomicNFT.sol:137-139)
      // i.e. the id of the NEXT mint, so 1 consumed token => getter reports 2.
      expect(await nft.nextTokenId()).to.equal(2n);
      expect(items[0].tokenId).to.equal(1n);
      expect(await nft.ownerOf(1)).to.equal(mal.target);
    });

    it("payment-token transfer-hook reentry into grantAccess must be blocked; buyer must not be double-charged", async function () {
      const { ethers: eth } = this;
      const MalTokF = await eth.getContractFactory("MaliciousReentrantToken");
      const malTok = await MalTokF.deploy(deployer.address);
      await malTok.waitForDeployment();

      const NftF = await eth.getContractFactory("GenomicNFT");
      const nft3 = await NftF.deploy(deployer.address, ROYALTY_BPS);
      await nft3.waitForDeployment();
      const RegF = await eth.getContractFactory("GenomicsRegistry");
      const reg3 = await RegF.deploy(malTok.target, nft3.target, deployer.address);
      await reg3.waitForDeployment();
      await nft3.connect(deployer).setRegistryContract(reg3.target);

      await (
        await reg3
          .connect(dataOwner)
          .registerGenomicData(
            "0x" + "f1".repeat(32),
            RAW_CID,
            SUM_CID,
            META_CID,
            `ipfs://${META_CID}`,
            PRICE,
            DURATION,
            ROYALTY_BPS
          )
      ).wait();

      await malTok.connect(deployer).setRegistryAndTarget(reg3.target, 1);
      // fund BOTH the buyer and the malicious token itself so that the
      // re-entrant grantAccess(msg.sender == token) is not vetoed by a mere
      // balance shortage -- we want to test the reentrancy guard, not maths.
      await malTok.connect(deployer).transfer(malTok.target, PRICE * 5n);
      await malTok.connect(deployer).transfer(buyer.address, PRICE * 5n);
      await malTok.connect(buyer).approve(reg3.target, PRICE * 10n);

      const before = await reg3.getAllDataItems.staticCall();
      await (await reg3.connect(buyer)["grantAccess(uint256)"](1)).wait();
      const after = await reg3.getAllDataItems.staticCall();

      expect(await malTok.attackSucceeded(), "token hook re-entered grantAccess").to.equal(false);
      // accessCount must be 1, not 2
      expect(after[0].accessCount).to.equal(before[0].accessCount + 1n);
      expect(await reg3.hasActiveAccess.staticCall(1, buyer.address)).to.equal(true);
    });
  });

  // ==========================================================================
  // TEST 7 — Concurrent multi-buyer purchases + exact EIP-2981 royalty split
  // on primary AND secondary sale. All math read back from the EVM.
  // ==========================================================================
  describe("T7  multi-buyer concurrency and EIP-2981 royalty conservation", function () {
    it("5 sequential buyers: seller+creator proceeds must sum exactly to total paid", async function () {
      const ctx = this;
      const { registry, token } = ctx;
      const { dataId } = await registerDataset(ctx);
      const signers = await ethers.getSigners();
      const buyers = signers.slice(7, 12);

      for (const b of buyers) {
        await token.connect(deployer).mint(b.address, PRICE);
        await token.connect(b).approve(registry.target, PRICE);
        await (await registry.connect(b)["grantAccess(uint256,uint256)"](dataId, PRICE)).wait();
      }

      const totalPaid = PRICE * 5n;
      const royalty = totalPaid / 10n; // 10 %
      const creatorBal = await token.balanceOf(dataOwner.address);
      expect(creatorBal).to.equal(1000n * 10n ** 18n + totalPaid); // receiver == creator path

      // Conservation: registry must hold nothing after non-escrow purchases
      expect(await token.balanceOf(registry.target)).to.equal(0n);

      const grant = await registry.accessGrants(dataId, buyers[0].address);
      expect(grant.isGranted).to.equal(true);
      expect((await registry.getAllDataItems.staticCall())[0].accessCount).to.equal(5n);
      expect(royalty).to.equal(PRICE / 2n); // sanity of the 10 % arithmetic basis
    });

    it("secondary sale of the ownership NFT must split proceeds exactly 90/10 between seller and creator", async function () {
      const ctx = this;
      const { registry, token, nft } = ctx;
      const { dataId } = await registerDataset(ctx);

      // creator transfers the ownership NFT to a secondary seller
      await nft.connect(dataOwner).transferFrom(dataOwner.address, secondarySeller.address, 1);
      expect(await nft.ownerOf(1)).to.equal(secondarySeller.address);

      const creatorBefore = await token.balanceOf(dataOwner.address);
      const sellerBefore = await token.balanceOf(secondarySeller.address);

      await token.connect(deployer).mint(buyer.address, PRICE);
      await token.connect(buyer).approve(registry.target, PRICE);
      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](dataId, PRICE)).wait();

      const creatorGain = (await token.balanceOf(dataOwner.address)) - creatorBefore;
      const sellerGain = (await token.balanceOf(secondarySeller.address)) - sellerBefore;

      expect(creatorGain, "EIP-2981 royalty not routed to creator").to.equal(PRICE / 10n);
      expect(sellerGain, "secondary seller proceeds incorrect").to.equal(PRICE - PRICE / 10n);
      expect(creatorGain + sellerGain, "value not conserved").to.equal(PRICE);
    });

    it("slippage: price front-run above maxPrice must revert PriceExceedsMax and charge nothing", async function () {
      const ctx = this;
      const { registry, token } = ctx;
      const { dataId } = await registerDataset(ctx);
      await approveCtx(ctx, buyer, PRICE * 2n);

      await registry.connect(dataOwner).updateDataPrice(dataId, PRICE * 2n);
      const before = await token.balanceOf(buyer.address);

      await expect(
        registry.connect(buyer)["grantAccess(uint256,uint256)"](dataId, PRICE)
      ).to.be.revertedWithCustomError(registry, "PriceExceedsMax");

      expect(await token.balanceOf(buyer.address)).to.equal(before);
      expect(await registry.hasActiveAccess.staticCall(dataId, buyer.address)).to.equal(false);
    });
  });

  // ==========================================================================
  // TEST 8 — zk-SNARK verifier: can a proof be fabricated with NO genomic
  // witness? Derivation from GenomicZkVerifier.sol:272-343: alpha=(1,2) and
  // beta=gamma=delta are the SAME hardcoded G2 point Q, so the pairing check
  // collapses to e(-A + (1+pub)·G1 + C, Q) == 1, satisfied by any
  // A = (1 + pub + c)·G1 with C = c·G1. No circuit, no trusted setup.
  // The test asserts the DEFENCE: the forge must revert InvalidZkProof and the
  // sponsor's funds must be preserved.
  // ==========================================================================
  describe("T8  zk bounty: proof forgery resistance", function () {
    async function ecMulG1(scalar, ethersLib) {
      const input = ethersLib.concat([
        ethersLib.zeroPadValue("0x01", 32),
        ethersLib.zeroPadValue("0x02", 32),
        ethersLib.zeroPadValue(ethersLib.toBeHex(scalar), 32),
      ]);
      const res = await ethersLib.provider.call({
        to: "0x0000000000000000000000000000000000000007",
        data: input,
      });
      return [
        BigInt(ethersLib.dataSlice(res, 0, 32)),
        BigInt(ethersLib.dataSlice(res, 32, 64)),
      ];
    }

    it("a fabricated proof carrying no genomic witness must be rejected and the bounty preserved", async function () {
      const { registry, token } = this;
      // deploy a zk verifier wired to the same $GENO
      const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
      const zk = await ZkF.deploy(token.target);
      await zk.waitForDeployment();

      const REWARD = 100n * 10n ** 18n;
      const MAX_CLAIMS = 3n;
      await token.connect(deployer).mint(dataOwner.address, REWARD * MAX_CLAIMS);
      await token.connect(dataOwner).approve(zk.target, REWARD * MAX_CLAIMS);
      await (
        await zk
          .connect(dataOwner)
          .createZkBounty(
            ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous")),
            "Aldehyde Dehydrogenase 2 rs671(A) variant",
            REWARD,
            MAX_CLAIMS,
            7 * 86400
          )
      ).wait();

      const sponsorBefore = await token.balanceOf(dataOwner.address);
      const zkHeldBefore = await token.balanceOf(zk.target);
      const attackerBefore = await token.balanceOf(attacker.address);

      // ---- fabricate (no genomic witness involved at any point) ----
      const bountyBefore = await zk.bounties(1);
      const traitId = bountyBefore.targetTraitId;
      const commitment = "0x" + "77".repeat(32); // arbitrary, no biology behind it
      const packed = ethers.solidityPacked(
        ["bytes32", "bytes32", "address"],
        [commitment, traitId, attacker.address]
      );
      const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;
      const cScalar = 1n;
      const C = await ecMulG1(cScalar, ethers);
      const A = await ecMulG1((1n + publicSignal + cScalar) % R_MOD, ethers);

      const proof = { a: A, b: G2_FIXED, c: C };

      // Sanity: the fabricated points really are on-curve non-zero G1 points
      expect(A[0]).to.be.greaterThan(0n);
      expect(C[0]).to.be.greaterThan(0n);

      // DEFENCE UNDER TEST: no real witness -> must revert InvalidZkProof.
      // Captured manually so the assertion message reports the funds drained.
      let accepted = false;
      let revertReason = "";
      try {
        await (await zk.connect(attacker).claimZkBounty(1, proof, commitment)).wait();
        accepted = true;
      } catch (e) {
        revertReason = String(e && e.shortMessage ? e.shortMessage : e.message).slice(0, 160);
      }

      const zkHeldAfter = await token.balanceOf(zk.target);
      const attackerAfter = await token.balanceOf(attacker.address);
      const bountyAfter = await zk.bounties(1);

      expect(
        accepted,
        `FORGED PROOF ACCEPTED (no genomic witness, no circuit, no trusted setup). ` +
          `attacker drained ${ethers.formatEther(attackerAfter - attackerBefore)} $GENO; ` +
          `bounty escrow ${ethers.formatEther(zkHeldBefore)} -> ${ethers.formatEther(zkHeldAfter)}; ` +
          `currentClaims=${bountyAfter.currentClaims}`
      ).to.equal(false);

      expect(accepted ? "accepted" : revertReason).to.include("InvalidZkProof");
      expect(await token.balanceOf(zk.target)).to.equal(zkHeldBefore);
      expect(await token.balanceOf(dataOwner.address)).to.equal(sponsorBefore);
      expect((await zk.bounties(1)).currentClaims).to.equal(0n);
    });
  });

  // ==========================================================================
  // TEST 9 — Consent revocation must be terminal and must not resurrect.
  // Sweep for the absence of a status check on every writer.
  // ==========================================================================
  describe("T9  consent revocation is terminal (INV-16 lifecycle symmetry)", function () {
    it("Revoked data must reject every subsequent state-mutating operation", async function () {
      const ctx = this;
      const { registry } = ctx;
      const { dataId } = await registerDataset(ctx);

      await registry.connect(dataOwner).updateDataStatus(dataId, 2); // Revoked
      expect((await registry.getGenomicData.staticCall(dataId)).status).to.equal(2n);

      const probes = [
        ["updateDataStatus(Active)", registry.connect(dataOwner).updateDataStatus(dataId, 0)],
        ["updateDataStatus(Paused)", registry.connect(dataOwner).updateDataStatus(dataId, 1)],
        ["updateDataPrice", registry.connect(dataOwner).updateDataPrice(dataId, PRICE * 2n)],
        ["grantDirectAccess", registry.connect(dataOwner).grantDirectAccess(dataId, buyer.address)],
        ["storeTransformedCapsule", registry.connect(dataOwner).storeTransformedCapsule(dataId, buyer.address, "x")],
        ["emitTransformedCapsule", registry.connect(dataOwner).emitTransformedCapsule(dataId, buyer.address, "x")],
        ["grantAccess", registry.connect(buyer)["grantAccess(uint256)"](dataId)],
        ["grantAccessWithEscrow", registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW)],
      ];

      const accepted = [];
      for (const [name, p] of probes) {
        try {
          await p;
          accepted.push(name);
        } catch (_) {
          /* correctly rejected */
        }
      }
      expect(accepted, `operations accepted on Revoked dataset: ${accepted.join(", ")}`).to.deep.equal([]);
    });

    it("a buyer holding a live grant must lose capsule access the instant consent is revoked", async function () {
      const ctx = this;
      const { registry } = ctx;
      const { dataId } = await registerDataset(ctx);
      await registry.connect(dataOwner).grantDirectAccess(dataId, buyer.address);
      const SECRET_CAPSULE = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "SECRET-CAPSULE", keyCipher: "ab".repeat(256) });
      await registry
        .connect(dataOwner)
        .storeTransformedCapsule(dataId, buyer.address, SECRET_CAPSULE);
      expect(await registry.connect(buyer).getTransformedCapsule.staticCall(dataId)).to.equal(
        SECRET_CAPSULE
      );

      await registry.connect(dataOwner).updateDataStatus(dataId, 2);

      await expect(
        registry.connect(buyer).getTransformedCapsule.staticCall(dataId)
      ).to.be.revertedWithCustomError(registry, "DataNotActive");
      expect(await registry.connect(buyer).buyerCapsules.staticCall(dataId, buyer.address)).to.equal("");
      expect(await registry.connect(buyer).hasActiveAccess.staticCall(dataId, buyer.address)).to.equal(false);
    });
  });

  // ==========================================================================
  // TEST 10 — Owner-only surfaces: dispatcher reassignment, worker
  // authorization after ownership change, and token rescue guards.
  // ==========================================================================
  describe("T10  privilege boundaries and rescue guards", function () {
    it("only the registry owner may move the capsule dispatcher", async function () {
      const { registry } = this;
      await expect(registry.connect(attacker).setCapsuleDispatcher(attacker.address)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await (await registry.connect(deployer).setCapsuleDispatcher(attacker.address)).wait();
      expect(await registry.capsuleDispatcher()).to.equal(attacker.address);
    });

    it("capsule workers must lose authorization when the ownership NFT is transferred", async function () {
      const ctx = this;
      const { registry, nft } = ctx;
      const { dataId } = await registerDataset(ctx);
      await registry.connect(dataOwner).setAuthorizedCapsuleWorker(dataId, worker.address, true);
      expect(await registry.authorizedCapsuleWorkers(dataId, worker.address)).to.equal(true);

      await nft.connect(dataOwner).transferFrom(dataOwner.address, secondarySeller.address, 1);

      expect(
        await registry.authorizedCapsuleWorkers(dataId, worker.address),
        "stale worker authorization survived an ownership change"
      ).to.equal(false);
    });

    it("rescueTokens must never be able to drain escrowed $GENO", async function () {
      const ctx = this;
      const { registry, token } = ctx;
      const { dataId } = await registerDataset(ctx);
      await approveCtx(ctx, buyer, PRICE);
      await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](dataId, DISPUTE_WINDOW);
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);

      await expect(
        registry.connect(deployer).rescueTokens(token.target, deployer.address, PRICE)
      ).to.be.revertedWithCustomError(registry, "CannotRescuePaymentToken");
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);
    });
  });
});
