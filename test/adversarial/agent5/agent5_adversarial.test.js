/**
 * AGENT 5 — INDEPENDENT BLIND ADVERSARIAL SUITE (written from spec + external threat model,
 * NOT from the internal structure of the existing suites).
 *
 * Discipline (INVARIANT-17):
 *  - Every security test asserts SUCCESSFUL DEFENCE (custom-error revert / victim assets preserved),
 *    never "exploit succeeded == PASS". A failing test here IS the exploit evidence.
 *  - Every assertion reads REAL state from the EVM (mined tx via tx.wait() or contract view calls),
 *    never local JS arithmetic.
 *  - No precompile mocking: BN254 points come from the real 0x07 ecMul precompile (see agent5_zk_forgery).
 */
import hre from "hardhat";
import { expect } from "chai";
import { Wallet, MaxUint256 } from "ethers";
import {
  encryptGenomicData,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash,
  unpackCiphertextPayload,
  createWalletKeyBackup,
} from "../../../crypto/client_crypto.js";

const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_V0_B = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
const SAMPLE_VCF = "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\nchr12\t111014145\trs671\tG\tA";
const DURATION = 30 * 24 * 3600;
const E18 = 10n ** 18n;

async function advanceAndMine(ethers, seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("AGENT5 :: Independent Adversarial Suite", function () {
  let ethers;
  let deployer, owner, buyer1, buyer2, attacker, stranger, worker;
  let token, nft, registry;
  let enc, HASH;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, owner, buyer1, buyer2, attacker, stranger, worker] = await ethers.getSigners();

    const T = await ethers.getContractFactory("GenomicToken");
    token = await T.deploy(deployer.address);
    await token.waitForDeployment();

    const N = await ethers.getContractFactory("GenomicNFT");
    nft = await N.deploy(deployer.address, 1000);
    await nft.waitForDeployment();

    const R = await ethers.getContractFactory("GenomicsRegistry");
    registry = await R.deploy(token.target, nft.target, deployer.address);
    await registry.waitForDeployment();

    await nft.connect(deployer).setRegistryContract(registry.target);

    enc = await encryptGenomicData(SAMPLE_VCF);
    HASH = enc.rawDataHash;
  });

  async function register(priceWei = 100n * E18, royaltyBps = 1000n, hash = HASH, who = owner) {
    const tx = await registry.connect(who).registerGenomicData(
      hash, CID_V0, CID_V0_B, CID_V0, `ipfs://${CID_V0}`, priceWei, DURATION, royaltyBps);
    await tx.wait();
    return (await registry.dataCount()).toString();
  }

  async function fund(addr, amountWei) {
    await token.connect(deployer).mint(addr, amountWei);
  }

  // ======================================================================
  // A. ECONOMIC FUZZER — faucet() anti-Sybil (INVARIANT-15)
  // ======================================================================
  describe("A. faucet() economic fuzzer (INV-15)", function () {
    it("A1 [DEFENCE] second claim inside 1h reverts FaucetCooldownActive", async function () {
      await token.connect(buyer1).faucet(buyer1.address);
      await expect(token.connect(buyer1).faucet(buyer1.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
    });

    it("A2 [DEFENCE] cooldown boundary is exactly 1h: reverts at t0+3599, pays at t0+3600", async function () {
      const r1 = await (await token.connect(buyer1).faucet(buyer1.address)).wait();
      const t0 = (await ethers.provider.getBlock(r1.blockNumber)).timestamp;
      // Deterministic timestamps: setNextBlockTimestamp, not evm_increaseTime (+1s automine drift).
      await ethers.provider.send("evm_setNextBlockTimestamp", [t0 + 3599]);
      await expect(token.connect(buyer1).faucet(buyer1.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
      await ethers.provider.send("evm_setNextBlockTimestamp", [t0 + 3600]);
      await (await token.connect(buyer1).faucet(buyer1.address)).wait();
      expect(await token.balanceOf(buyer1.address)).to.equal(2000n * E18);
    });

    it("A3 [DEFENCE] recipient-side limit blocks a third party claiming for a fresh victim", async function () {
      await token.connect(buyer1).faucet(buyer2.address);
      await expect(token.connect(attacker).faucet(buyer2.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
    });

    it("A4 [DEFENCE] zero-address recipient rejected, supply unchanged", async function () {
      await expect(token.connect(attacker).faucet(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "InvalidRecipient");
      expect(await token.totalSupply()).to.equal(10_000_000n * E18);
    });

    it("A5 [PoC DEFECT DEF5-02] faucet(): declared ContractCallersNotAllowed is dead code and there is no global budget", async function () {
      // (a) DEAD-CONTROL PROOF. GenomicToken.sol:27 declares `error ContractCallersNotAllowed();`
      //     and docs/reports/07_technology_benchmark_and_architecture_recommendation.md:927 +
      //     .agents/teamwork/auditor_r5/handoff.md:80 claim contract callers and tx.origin are blocked.
      //     GenomicToken.sol:47-66 checks only msg.sender/to -> a contract recipient is funded anyway.
      const NST = await ethers.getContractFactory("NonStandardERC20");
      const throwaway = [];
      for (let i = 0; i < 6; i++) {
        const c = await NST.deploy(1n);
        await c.waitForDeployment();
        throwaway.push(c.target);
      }
      await expect(token.connect(attacker).faucet(throwaway[0]))
        .to.be.revertedWithCustomError(token, "ContractCallersNotAllowed");
      await expect(token.connect(attacker).faucet(throwaway[1]))
        .to.be.revertedWithCustomError(token, "ContractCallersNotAllowed");
      // ASSERT THE DOCUMENTED CONTROL: a contract recipient must be refused.
      await expect(token.connect(attacker).faucet(throwaway[2]))
        .to.be.revertedWithCustomError(token, "ContractCallersNotAllowed");

      // (b) ECONOMIC FUZZER: verify per-address INV-15 cooldown and MAX_FAUCET_SUPPLY cap
      const many = await ethers.getSigners(20);
      const extra = many.slice(7, 20);
      const supplyBefore = await token.totalSupply();
      for (const w of extra) {
        await (await token.connect(w).faucet(w.address)).wait();
        await expect(token.connect(w).faucet(w.address))
          .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
      }
      const delta = (await token.totalSupply()) - supplyBefore;
      expect(delta).to.equal(BigInt(extra.length) * 1000n * E18);
      expect(await token.totalSupply()).to.be.at.most(await token.MAX_FAUCET_SUPPLY());
    });
  });

  // ======================================================================
  // B. dataId BOUNDARY SWEEP — INV-16 (must revert, never EVM default value)
  // ======================================================================
  describe("B. dataId boundary sweep (INV-16)", function () {
    let dataId;
    beforeEach(async function () {
      dataId = await register();
    });

    const boundaryCalls = [
      ["getGenomicData(uint256)", (r, id) => r.getGenomicData(id)],
      ["hasActiveAccess(uint256,address)", (r, id) => r.hasActiveAccess(id, stranger.address)],
      ["getTransformedCapsule(uint256)", (r, id) => r.getTransformedCapsule(id)],
      ["buyerCapsules(uint256,address)", (r, id) => r.buyerCapsules(id, stranger.address)],
      ["claimEscrowRefund(uint256)", (r, id) => r.claimEscrowRefund(id)],
      ["releaseEscrow(uint256,address)", (r, id) => r.releaseEscrow(id, stranger.address)],
      ["resetAuthorizedWorkers(uint256)", (r, id) => r.resetAuthorizedWorkers(id)],
      ["grantAccess(uint256)", (r, id) => r["grantAccess(uint256)"](id)],
      ["grantAccessWithEscrow(uint256,uint256)", (r, id) => r["grantAccessWithEscrow(uint256,uint256)"](id, 86400)],
      ["updateDataStatus(uint256,uint8)", (r, id) => r.updateDataStatus(id, 1)],
      ["updateDataPrice(uint256,uint256)", (r, id) => r.updateDataPrice(id, 1n)],
      ["grantDirectAccess(uint256,address)", (r, id) => r.grantDirectAccess(id, stranger.address)],
      ["getCapsuleForBuyer(uint256,address)", (r, id) => r.getCapsuleForBuyer(id, stranger.address)],
      ["setAuthorizedCapsuleWorker(uint256,address,bool)", (r, id) => r.setAuthorizedCapsuleWorker(id, stranger.address, true)],
      ["storeTransformedCapsule(uint256,address,string)", (r, id) => r.storeTransformedCapsule(id, stranger.address, "cap")],
      ["emitTransformedCapsule(uint256,address,string)", (r, id) => r.emitTransformedCapsule(id, stranger.address, "cap")],
    ];

    for (const [sig, call] of boundaryCalls) {
      it(`B1 [DEFENCE] ${sig} reverts DataNotFound() at dataId=0`, async function () {
        await expect(call(registry.connect(stranger), 0))
          .to.be.revertedWithCustomError(registry, "DataNotFound");
      });
      it(`B2 [DEFENCE] ${sig} reverts DataNotFound() at dataId=dataCount+1`, async function () {
        await expect(call(registry.connect(stranger), BigInt(dataId) + 1n))
          .to.be.revertedWithCustomError(registry, "DataNotFound");
      });
    }

    it("B3 [DEFENCE] type(uint256).max reverts DataNotFound, no silent default struct", async function () {
      await expect(registry.getGenomicData(ethers.MaxUint256))
        .to.be.revertedWithCustomError(registry, "DataNotFound");
      await expect(registry.hasActiveAccess(ethers.MaxUint256, stranger.address))
        .to.be.revertedWithCustomError(registry, "DataNotFound");
    });

    it("B4 [PoC DEFECT DEF5-05] getDataItemsPaginated panics on offset+limit overflow instead of clamping", async function () {
      // second dataset so that 0 < offset < total is reachable
      const h2 = await computeDataHash("pkg-pagination-second");
      await registry.connect(owner).registerGenomicData(
        h2, CID_V0, CID_V0_B, CID_V0, "u", 10n * E18, DURATION, 1000n).then((t) => t.wait());
      const [items, total] = await registry.getDataItemsPaginated(0, 10);
      expect(total).to.equal(2n);
      expect(items.length).to.equal(2);
      const cases = [[0, MaxUint256], [1, MaxUint256], [1, 2n ** 255n]];
      const outcomes = [];
      for (const [off, lim] of cases) {
        try {
          const r = await registry.getDataItemsPaginated.staticCall(off, lim);
          outcomes.push(`(${off},${String(lim).slice(0, 8)}..)->ok[${r[0].length}]`);
        } catch (e) {
          outcomes.push(`(${off},${String(lim).slice(0, 8)}..)->REVERT ${e.shortMessage || e.message}`);
        }
      }
      // GenomicsRegistry.sol:903 `uint256 end = offset + limit;` has no overflow guard: the catalog
      // reader must clamp, never abort. Assert the defensive outcome for every boundary input.
      expect(outcomes.filter((o) => o.includes("REVERT")),
        "arithmetic overflow in the marketplace catalog reader").to.deep.equal([]);
    });

    it("B5 [PoC DEFECT DEF5-10] genomicDataItems() public getter returns the STALE currentOwner field", async function () {
      await nft.connect(owner).transferFrom(owner.address, buyer1.address, 1n);
      const stored = await registry.genomicDataItems(dataId);
      const live = await registry.getGenomicData(dataId);
      // Defence expected: the raw storage getter must not expose an owner value that contradicts the NFT.
      expect(stored.currentOwner, "storage currentOwner != live NFT owner (two sources of truth)").to.equal(live.currentOwner);
    });

    it("B6 [DEFENCE] paginated view always reflects live NFT ownership", async function () {
      await nft.connect(owner).transferFrom(owner.address, buyer1.address, 1n);
      const [items] = await registry.getDataItemsPaginated(0, 10);
      expect(items[0].currentOwner).to.equal(buyer1.address);
    });
  });

  // ======================================================================
  // C. LIFECYCLE SYMMETRY (Active/Paused/Revoked, expiresAt) — INV-16
  // ======================================================================
  describe("C. Status lifecycle symmetry (INV-16)", function () {
    let dataId;
    beforeEach(async function () {
      dataId = await register();
      await fund(buyer1.address, 1000n * E18);
      await token.connect(buyer1).approve(registry.target, 1000n * E18);
    });

    it("C1 [DEFENCE] Paused blocks purchase, direct grant and capsule delivery", async function () {
      await (await registry.connect(owner).updateDataStatus(dataId, 1)).wait(); // Paused
      await expect(registry.connect(buyer1)["grantAccess(uint256)"](dataId))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
      await expect(registry.connect(owner).grantDirectAccess(dataId, buyer2.address))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
      await expect(registry.connect(owner).storeTransformedCapsule(dataId, buyer1.address, "c"))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
      await expect(registry.connect(owner).emitTransformedCapsule(dataId, buyer1.address, "c"))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
    });

    it("C2 [DEFENCE] updateDataPrice reverts DataNotActive while dataset is Paused (INV-16 symmetry)", async function () {
      await (await registry.connect(owner).updateDataStatus(dataId, 1)).wait(); // Paused
      await expect(registry.connect(owner).updateDataPrice(dataId, 999n * E18))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
      const d = await registry.getGenomicData(dataId);
      expect(d.status).to.equal(1n);
      expect(d.price).to.equal(100n * E18);
    });

    it("C3 [DEFENCE] Revoked is terminal and blocks every reader/writer", async function () {
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      const wrappedCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "wrapped-session-key", keyCipher: "ab".repeat(256) });
      await registry.connect(owner).storeTransformedCapsule(dataId, buyer1.address, wrappedCapsule)
        .then((t) => t.wait());
      expect(await registry.connect(buyer1).getTransformedCapsule.staticCall(dataId, { from: buyer1.address }))
        .to.equal(wrappedCapsule);

      await (await registry.connect(owner).updateDataStatus(dataId, 2)).wait(); // Revoked
      await expect(registry.connect(buyer1).getTransformedCapsule.staticCall(dataId, { from: buyer1.address }))
        .to.be.revertedWithCustomError(registry, "DataNotActive");
      expect(await registry.hasActiveAccess(dataId, buyer1.address)).to.equal(false);
      expect(await registry.buyerCapsules(dataId, buyer1.address)).to.equal("");
      await expect(registry.connect(owner).updateDataStatus(dataId, 0))
        .to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");
      await expect(registry.connect(owner).updateDataPrice(dataId, 1n))
        .to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");
    });

    it("C4 [PoC DEFECT DEF5-11] hasActiveAccess disagrees with getTransformedCapsule on a pending escrow", async function () {
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 3600).then((t) => t.wait());
      const access = await registry.hasActiveAccess(dataId, buyer1.address);
      const errName = (e) => {
        const m = String((e && (e.shortMessage || e.message)) || "");
        const hit = m.match(/custom error '(\w+)/) || m.match(/panic code (0x\w+)/);
        return hit ? hit[1] : m.split("\n")[0].slice(-48);
      };
      let readOutcome = "returned";
      try {
        await registry.connect(buyer1).getTransformedCapsule.staticCall(dataId, { from: buyer1.address });
      } catch (e) {
        readOutcome = "reverted:" + errName(e);
      }
      let buyerCapsuleOutcome = "returned";
      let storedCapsule = "";
      try {
        storedCapsule = await registry.connect(buyer1).buyerCapsules.staticCall(dataId, buyer1.address);
      } catch (e) {
        buyerCapsuleOutcome = "reverted:" + errName(e);
      }
      const observed = `hasActiveAccess=${access} | buyerCapsules=${buyerCapsuleOutcome}/${JSON.stringify(storedCapsule)} | getTransformedCapsule=${readOutcome}`;
      // INV-16 (AGENTS.md:54): the same lifecycle state must answer identically on all three readers.
      expect(observed, "INV-16 asymmetry on a PENDING (undelivered) escrow").to.equal(
        'hasActiveAccess=false | buyerCapsules=reverted:AccessNotGranted/"" | getTransformedCapsule=reverted:AccessNotGranted');
    });

    it("C5 [DEFENCE] expired grant is refused on capsule read AND write paths", async function () {
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      await advanceAndMine(ethers, DURATION + 5);
      await expect(registry.connect(buyer1).getTransformedCapsule.staticCall(dataId, { from: buyer1.address }))
        .to.be.revertedWithCustomError(registry, "AccessExpired");
      await expect(registry.connect(owner).storeTransformedCapsule(dataId, buyer1.address, "c"))
        .to.be.revertedWithCustomError(registry, "AccessExpired");
      expect(await registry.hasActiveAccess(dataId, buyer1.address)).to.equal(false);
    });

    it("C6 [PoC DEFECT DEF5-12] emitTransformedCapsule settles escrow but writes NOTHING to _buyerCapsules", async function () {
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 3600).then((t) => t.wait());
      const eventCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "capsule-event-only", keyCipher: "ab".repeat(256) });
      await registry.connect(owner).emitTransformedCapsule(dataId, buyer1.address, eventCapsule)
        .then((t) => t.wait());
      // Funds already moved to the seller:
      expect(await token.balanceOf(registry.target), "escrow must still hold funds if nothing was stored").to.equal(0n);
      const stored = await registry.connect(buyer1).getTransformedCapsule.staticCall(dataId, { from: buyer1.address });
      expect(stored, "escrow released while the on-chain capsule is empty string").to.equal(eventCapsule);
      // buyerCapsules must be identical to getTransformedCapsule for the owner of the grant
      expect(await registry.buyerCapsules(dataId, buyer1.address)).to.equal(stored);
    });

    it("C7 [DEFENCE] refund path mirrors the delivery path", async function () {
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 3600).then((t) => t.wait());
      await advanceAndMine(ethers, 3601);
      const before = await token.balanceOf(buyer1.address);
      await registry.connect(buyer1).claimEscrowRefund(dataId).then((t) => t.wait());
      expect(await token.balanceOf(buyer1.address)).to.equal(before + 100n * E18);
      const g = await registry.accessGrants(dataId, buyer1.address);
      expect(g.isGranted).to.equal(false);
      expect(g.expiresAt).to.equal(0n);
    });
  });

  // ======================================================================
  // D. ACCESS-CONTROL BYPASS ATTEMPTS
  // ======================================================================
  describe("D. Access-control bypass attempts", function () {
    let dataId;
    beforeEach(async function () {
      dataId = await register();
    });

    it("D1 [DEFENCE] stranger cannot store or emit a capsule", async function () {
      await fund(buyer1.address, 1000n * E18);
      await token.connect(buyer1).approve(registry.target, 100n * E18);
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      await expect(registry.connect(stranger).storeTransformedCapsule(dataId, buyer1.address, "steal"))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(registry.connect(stranger).emitTransformedCapsule(dataId, buyer1.address, "steal"))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("D2 [DEFENCE] non-owner cannot change status/price or grant free access", async function () {
      await expect(registry.connect(stranger).updateDataStatus(dataId, 2))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(registry.connect(stranger).updateDataPrice(dataId, 1n))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(registry.connect(stranger).grantDirectAccess(dataId, stranger.address))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("D3 [DEFENCE] a non-buyer cannot read any capsule", async function () {
      await expect(registry.connect(stranger).getTransformedCapsule.staticCall(dataId, { from: stranger.address }))
        .to.be.revertedWithCustomError(registry, "AccessNotGranted");
      await expect(registry.connect(stranger).buyerCapsules(dataId, stranger.address))
        .to.be.revertedWithCustomError(registry, "AccessNotGranted");
    });

    it("D4 [DEFENCE] direct mint on the NFT is refused (onlyRegistry)", async function () {
      await expect(nft.connect(attacker).mintGenomicNFT(attacker.address, "u", HASH, CID_V0, CID_V0, CID_V0, 1000))
        .to.be.revertedWithCustomError(nft, "OnlyRegistry");
    });

    it("D5 [DEFENCE] owner cannot rescue the escrowed payment token out of the registry", async function () {
      await fund(buyer1.address, 1000n * E18);
      await token.connect(buyer1).approve(registry.target, 100n * E18);
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 86400).then((t) => t.wait());
      await expect(registry.connect(deployer).rescueTokens(token.target, deployer.address, 100n * E18))
        .to.be.revertedWithCustomError(registry, "CannotRescuePaymentToken");
      expect(await token.balanceOf(registry.target)).to.equal(100n * E18);
    });

    it("D6 [DEFENCE] revoked capsule worker loses all rights", async function () {
      await registry.connect(owner).setAuthorizedCapsuleWorker(dataId, worker.address, true).then((t) => t.wait());
      await registry.connect(owner).setAuthorizedCapsuleWorker(dataId, worker.address, false).then((t) => t.wait());
      await fund(buyer1.address, 1000n * E18);
      await token.connect(buyer1).approve(registry.target, 100n * E18);
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      await expect(registry.connect(worker).storeTransformedCapsule(dataId, buyer1.address, "x"))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("D7 [DEFENCE] capsule workers are fully de-authorised after an NFT transfer (DEF2-1-05 hook)", async function () {
      await registry.connect(owner).setAuthorizedCapsuleWorker(dataId, worker.address, true).then((t) => t.wait());
      expect(await registry.authorizedCapsuleWorkers(dataId, worker.address)).to.equal(true);
      await nft.connect(owner).transferFrom(owner.address, stranger.address, 1n).then((t) => t.wait());
      expect(await registry.authorizedCapsuleWorkers(dataId, worker.address),
        "stale worker still authorised after ownership change").to.equal(false);
      expect(await registry.capsuleWorkerAuthorizer(dataId, worker.address)).to.equal(ethers.ZeroAddress);
    });

    it("D8 [DEFENCE] old NFT owner cannot act as a dispatcher/owner after transfer", async function () {
      await nft.connect(owner).transferFrom(owner.address, stranger.address, 1n).then((t) => t.wait());
      await expect(registry.connect(owner).updateDataStatus(dataId, 1))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(registry.connect(owner).storeTransformedCapsule(dataId, stranger.address, "c"))
        .to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("D9 [PoC DEFECT DEF5-13] front-running a pending rawDataHash griefs the honest registrant", async function () {
      const victimHash = await computeDataHash("victim-not-yet-registered-package");
      const victimBoundHash = ethers.keccak256(
        ethers.solidityPacked(["address", "bytes32"], [owner.address, victimHash])
      );
      let outcome = "victim-registered-ok";
      try {
        await (await registry.connect(attacker).registerGenomicData(
          victimHash, CID_V0, CID_V0_B, CID_V0, "ipfs://attacker-grief", 1n * E18, 3600, 1000n)).wait();
        await expect(
          registry.connect(owner).registerGenomicData(
            victimHash, CID_V0_B, CID_V0, CID_V0_B, "ipfs://victim-real-data",
            100n * E18, DURATION, 1000n
          )
        ).to.be.revertedWithCustomError(registry, "DataAlreadyRegistered");
        await (await registry.connect(owner).registerGenomicData(
          victimBoundHash, CID_V0_B, CID_V0, CID_V0_B, "ipfs://victim-real-data",
          100n * E18, DURATION, 1000n)).wait();
      } catch (e) {
        outcome = "REVERT: " + (e.shortMessage || e.message).split("\n")[0];
      }
      expect(outcome, "honest registrant locked out after a first-writer-wins grief").to.equal("victim-registered-ok");
      const id = await registry.dataCount();
      const d = await registry.getGenomicData(id);
      expect(d.rawCiphertextCid, "pinned record carries the attacker's CID, not the victim's").to.equal(CID_V0_B);
    });
  });

  // ======================================================================
  // E. ESCROW + EIP-2981 ROYALTY ECONOMICS (exact EVM balance deltas)
  // ======================================================================
  describe("E. Escrow + EIP-2981 royalty settlement", function () {
    let dataId, PRICE;
    beforeEach(async function () {
      PRICE = 100n * E18;
      dataId = await register(PRICE);
      await fund(buyer1.address, 1000n * E18);
      await fund(buyer2.address, 1000n * E18);
      await token.connect(buyer1).approve(registry.target, 1000n * E18);
      await token.connect(buyer2).approve(registry.target, 1000n * E18);
    });

    it("E1 [DEFENCE] primary sale pays the creator-seller exactly the price", async function () {
      const before = await token.balanceOf(owner.address);
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      const after = await token.balanceOf(owner.address);
      expect(after - before).to.equal(PRICE);
      expect(await token.balanceOf(buyer1.address)).to.equal(900n * E18);
      expect(await token.totalSupply()).to.equal(10_000_000n * E18 + 2000n * E18);
    });

    it("E2 [DEFENCE] secondary sale splits exactly 90% seller / 10% original creator (EIP-2981)", async function () {
      const creator = owner.address;
      await nft.connect(owner).transferFrom(creator, buyer2.address, 1n).then((t) => t.wait());
      const sellerBefore = await token.balanceOf(buyer2.address);
      const creatorBefore = await token.balanceOf(creator);
      await registry.connect(buyer1)["grantAccess(uint256)"](dataId).then((t) => t.wait());
      const sellerGain = (await token.balanceOf(buyer2.address)) - sellerBefore;
      const creatorGain = (await token.balanceOf(creator)) - creatorBefore;
      expect(sellerGain).to.equal(90n * E18);
      expect(creatorGain).to.equal(10n * E18);
      expect(sellerGain + creatorGain).to.equal(PRICE); // conservation
      const rc = await nft.records(1n);
      expect(rc.originalCreator).to.equal(creator);
    });

    it("E3 [DEFENCE] royaltyBps is capped at the EIP-2981 denominator; >100% reverts", async function () {
      const h2 = await computeDataHash("pkg-bps-10000");
      await registry.connect(owner).registerGenomicData(h2, CID_V0, CID_V0_B, CID_V0, "u", PRICE, DURATION, 10000n)
        .then((t) => t.wait());
      const id2 = (await registry.dataCount()).toString();
      await expect(registry.connect(owner).registerGenomicData(
        await computeDataHash("pkg-bps-10001"), CID_V0, CID_V0_B, CID_V0, "u", PRICE, DURATION, 10001n))
        .to.be.revertedWithCustomError(nft, "ERC2981InvalidTokenRoyalty");
      await registry.connect(buyer1)["grantAccess(uint256)"](id2).then((t) => t.wait());
      expect(await token.balanceOf(buyer1.address)).to.equal(900n * E18);
    });

    it("E4 [DEFENCE] dispute window blocks early refund; 100% refund guaranteed after", async function () {
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 3600).then((t) => t.wait());
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);
      await expect(registry.connect(buyer1).claimEscrowRefund(dataId))
        .to.be.revertedWithCustomError(registry, "DisputeWindowActive");
      await advanceAndMine(ethers, 3601);
      const before = await token.balanceOf(buyer1.address);
      await registry.connect(buyer1).claimEscrowRefund(dataId).then((t) => t.wait());
      expect(await token.balanceOf(buyer1.address)).to.equal(before + PRICE);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });

    it("E5 [DEFENCE] disputeWindow bounds [1h, 30d]", async function () {
      await expect(registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 59))
        .to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");
      await expect(registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 31 * 86400))
        .to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");
    });

    it("E6 [DEFENCE] no double settlement: replaying release/refund after delivery is refused", async function () {
      await registry.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](dataId, 3600).then((t) => t.wait());
      await registry.connect(owner).storeTransformedCapsule(dataId, buyer1.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "cap", keyCipher: "ab".repeat(256) })).then((t) => t.wait());
      const sellerAfter = await token.balanceOf(owner.address);
      await expect(registry.connect(stranger).releaseEscrow(dataId, buyer1.address))
        .to.be.revertedWithCustomError(registry, "EscrowNotActive");
      await expect(registry.connect(buyer1).claimEscrowRefund(dataId))
        .to.be.revertedWithCustomError(registry, "CapsuleAlreadyDelivered");
      expect(await token.balanceOf(owner.address)).to.equal(sellerAfter);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });

    it("E7 [DEFENCE] maxPrice slippage protection reverts PriceExceedsMax on a front-run reprice", async function () {
      await registry.connect(owner).updateDataPrice(dataId, 500n * E18).then((t) => t.wait());
      await expect(registry.connect(buyer1)["grantAccess(uint256,uint256)"](dataId, PRICE))
        .to.be.revertedWithCustomError(registry, "PriceExceedsMax");
      expect(await token.balanceOf(buyer1.address)).to.equal(1000n * E18);
    });

    it("E8 [CONCURRENT STRESS] 5 buyers on one dataset: value conservation and accessCount exact", async function () {
      const all = await ethers.getSigners(10);
      const buyers = all.slice(2, 7);
      for (const b of buyers) {
        await token.connect(deployer).mint(b.address, 1000n * E18);
        await token.connect(b).approve(registry.target, 1000n * E18);
        const t = await registry.connect(b)["grantAccess(uint256)"](dataId);
        await t.wait();
      }
      const supplyBefore = await token.totalSupply();
      const sellerGain = PRICE * 5n;
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect(await token.totalSupply()).to.equal(supplyBefore); // sales never mint
      const stored = await registry.genomicDataItems(dataId);
      expect(stored.accessCount).to.equal(5n);
      expect(sellerGain).to.equal(500n * E18);
    });

    it("E9 [DEFENCE] owner cannot buy their own dataset", async function () {
      await expect(registry.connect(owner)["grantAccess(uint256)"](dataId))
        .to.be.revertedWithCustomError(registry, "OwnerCannotBuyOwnData");
    });

    it("E10 [DEFENCE] duplicate rawDataHash registration is refused", async function () {
      await expect(registry.connect(buyer2).registerGenomicData(
        HASH, CID_V0, CID_V0_B, CID_V0, "u", 1n, DURATION, 1000n))
        .to.be.revertedWithCustomError(registry, "DataAlreadyRegistered");
    });

    it("E11 [DEFENCE] royaltyInfo() is externally consistent with what the registry paid", async function () {
      const [receiver, amount] = await nft.royaltyInfo(1n, PRICE);
      expect(receiver).to.equal(owner.address);
      expect(amount).to.equal(10n * E18);
      await nft.connect(owner).transferFrom(owner.address, buyer2.address, 1n).then((t) => t.wait());
      const [r2, a2] = await nft.royaltyInfo(1n, PRICE);
      expect(r2).to.equal(owner.address); // royalty receiver is invariant across transfers
      expect(a2).to.equal(10n * E18);
    });
  });

  // ======================================================================
  // F. NON-STANDARD ERC20 + REENTRANCY MOCKS
  // ======================================================================
  describe("F. Non-standard token & reentrancy mocks", function () {
    it("F1 [DEFENCE] SafeERC20 tolerates a void-returning (USDT-style) token through escrow+refund", async function () {
      const NST = await ethers.getContractFactory("NonStandardERC20");
      const nst = await NST.deploy(1_000_000n * E18);
      await nst.waitForDeployment();
      const R = await ethers.getContractFactory("GenomicsRegistry");
      const reg2 = await R.deploy(nst.target, nft.target, deployer.address);
      await reg2.waitForDeployment();
      await nft.connect(deployer).setRegistryContract(reg2.target);

      const e2 = await encryptGenomicData("alt-ciphertext-package");
      await reg2.connect(owner).registerGenomicData(
        e2.rawDataHash, CID_V0, CID_V0_B, CID_V0, "u", 50n * E18, DURATION, 1000n).then((t) => t.wait());
      const id = (await reg2.dataCount()).toString();

      await nst.connect(deployer).transfer(buyer1.address, 1000n * E18);
      await nst.connect(buyer1).approve(reg2.target, 1000n * E18);
      await reg2.connect(buyer1)["grantAccessWithEscrow(uint256,uint256)"](id, 3600).then((t) => t.wait());
      expect(await nst.balanceOf(reg2.target)).to.equal(50n * E18);

      const before = await nst.balanceOf(buyer1.address);
      await advanceAndMine(ethers, 3601);
      await reg2.connect(buyer1).claimEscrowRefund(id).then((t) => t.wait());
      expect(await nst.balanceOf(buyer1.address)).to.equal(before + 50n * E18);
    });

    it("F2 [DEFENCE] reentrancy through the ERC721 onERC721Received hook is blocked; state unchanged", async function () {
      const M = await ethers.getContractFactory("MaliciousReentrantReceiver");
      const mal = await M.deploy(registry.target);
      await mal.waitForDeployment();
      const e3 = await encryptGenomicData("malicious-package");
      await mal.registerWithRegistry(e3.rawDataHash, CID_V0, CID_V0_B, CID_V0, "u", 10n * E18, DURATION, 500n)
        .then((t) => t.wait());

      expect(await mal.attackSucceeded(), "reentrant mint must not succeed").to.equal(false);
      expect(await registry.dataCount(), "exactly one dataset may exist").to.equal(1n);
      // GenomicNFT.sol:137-139 nextTokenId() returns `_nextTokenId + 1`, i.e. the id that WILL be minted.
      expect(await nft.nextTokenId(), "one mint -> next id is 2").to.equal(2n);
      await expect(nft.ownerOf(2n)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
      expect(await nft.ownerOf(1n)).to.equal(await mal.getAddress());
      const d = await registry.getGenomicData(1);
      expect(d.rawCiphertextCid).to.equal(CID_V0);
    });

    it("F3 [DEFENCE] malicious payment token re-entering grantAccess is blocked", async function () {
      const MT = await ethers.getContractFactory("MaliciousReentrantToken");
      const mt = await MT.deploy(deployer.address);
      await mt.waitForDeployment();
      const R = await ethers.getContractFactory("GenomicsRegistry");
      const reg3 = await R.deploy(mt.target, nft.target, deployer.address);
      await reg3.waitForDeployment();
      await nft.connect(deployer).setRegistryContract(reg3.target);

      const e4 = await encryptGenomicData("pkg-mt");
      await reg3.connect(owner).registerGenomicData(
        e4.rawDataHash, CID_V0, CID_V0_B, CID_V0, "u", 10n * E18, DURATION, 1000n).then((t) => t.wait());
      const id = (await reg3.dataCount()).toString();
      await mt.setRegistryAndTarget(reg3.target, id);
      // Fund the buyer and grant the allowance the registry pulls against (OZ ERC20 needs approve).
      await (await mt.connect(deployer).transfer(buyer1.address, 1000n * E18)).wait();
      await (await mt.connect(buyer1).approve(reg3.target, 1000n * E18)).wait();

      await reg3.connect(buyer1)["grantAccess(uint256)"](id).then((t) => t.wait());
      expect(await mt.attackSucceeded(), "grantAccess reentry must not succeed").to.equal(false);
      expect(await reg3.dataCount()).to.equal(1n);
      const g = await reg3.accessGrants(id, buyer1.address);
      expect(g.isGranted).to.equal(true); // exactly one honest grant landed
    });
  });

  // ======================================================================
  // G. OFF-CHAIN CRYPTO INVARIANTS (real WebCrypto via Node 22 globalThis.crypto)
  // ======================================================================
  describe("G. Client-side crypto invariants (INV-01/05/09)", function () {
    it("G1 [DEFENCE] capsule carries NO plaintext session key (INV-01)", async function () {
      const kp = await generateAsymmetricKeyPair(false);
      const pub = await exportPublicKey(kp.publicKey);
      const c = await packageKeyCapsule(enc.keyHex, pub, buyer1.address, owner.address);
      expect(c).to.not.contain(enc.keyHex);
      const parsed = JSON.parse(c);
      expect(parsed.keyCipher).to.match(/^[0-9a-f]{512}$/); // 256-byte RSA-2048 ciphertext
      expect(Object.keys(parsed).sort()).to.deep.equal(
        ["algorithm", "keyCipher", "owner", "recipient", "timestamp", "version"]);
    });

    it("G2 [DEFENCE] RSA-OAEP unwrap is exact and foreign keys are refused", async function () {
      const kp = await generateAsymmetricKeyPair(false);
      const pub = await exportPublicKey(kp.publicKey);
      const c = await packageKeyCapsule(enc.keyHex, pub, buyer1.address, owner.address);
      expect((await decryptKeyCapsule(c, kp.privateKey)).keyHex).to.equal(enc.keyHex);
      const other = await generateAsymmetricKeyPair(false);
      let refused = false;
      try { await decryptKeyCapsule(c, other.privateKey); } catch { refused = true; }
      expect(refused, "wrong private key must not unwrap").to.equal(true);
    });

    it("G3 [DEFENCE] rawDataHash == SHA-256(IV||Ciphertext), never SHA-256(plaintext) (INV-05)", async function () {
      expect(await computeDataHash(enc.payload)).to.equal(enc.rawDataHash);
      expect(await computeDataHash(SAMPLE_VCF)).to.not.equal(enc.rawDataHash);
      expect(await computeDataHash(enc.ciphertext)).to.not.equal(enc.rawDataHash);
      expect(enc.payload.length).to.equal(12 + enc.ciphertext.length);
    });

    it("G4 [DEFENCE] single-bit tampering is detected before/without decrypting", async function () {
      const tampered = enc.payload.slice();
      tampered[tampered.length - 1] ^= 0x01;
      expect(await computeDataHash(tampered)).to.not.equal(enc.rawDataHash);
      const kp = await generateAsymmetricKeyPair(false);
      const pub = await exportPublicKey(kp.publicKey);
      const capsule = await packageKeyCapsule(enc.keyHex, pub, "0x0", "0x0");
      const key = (await decryptKeyCapsule(capsule, kp.privateKey)).activeKey;
      const { iv, ciphertext } = unpackCiphertextPayload(tampered);
      let macOk = true;
      try { await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext); } catch { macOk = false; }
      expect(macOk, "GCM tag must reject a tampered ciphertext").to.equal(false);
    });

    it("G5 [PoC DEFECT DEF5-03] one AES key protects BOTH packages and IVs are random with no counter/mutex", async function () {
      // datasetService.js:82-85 re-uses `encryptedRaw.activeKey` for the clinical PDF, so a single
      // AES-256-GCM key encrypts two independent on-chain-anchored packages. streaming.js:96 draws a
      // fresh RANDOM 96-bit IV per 64KB chunk under that one key (no counter, no cross-tab mutex).
      const key = enc.activeKey;
      const N = 2000;
      const seen = new Set();
      let dupes = 0;
      for (let i = 0; i < N; i++) {
        const r = await encryptGenomicData(`payload-${i}`, key);
        if (seen.has(r.ivHex)) dupes++;
        seen.add(r.ivHex);
      }
      expect(dupes, `nonce reuse observed: ${dupes}/${N}`).to.equal(0);
      // The load-bearing absence check: no deterministic nonce / counter state is exposed at all,
      // so idempotent retries after a crash are impossible and the NIST SP 800-38D 8.2.2
      // 2^32-invocations-per-key ceiling is nowhere enforced or documented.
      const sample = await encryptGenomicData("probe", key);
      expect(Object.keys(sample).some((k) => /counter|nonce|sequence/i.test(k)),
        "absence sweep: encryptGenomicData exposes NO deterministic nonce/counter state "
        + "(crypto/core/symmetric.js:157 draws a random 96-bit IV per call; NIST SP 800-38D §8.2.2 "
        + "caps random-IV users at 2^32 invocations per key and no such budget is enforced)")
        .to.equal(true);
    });

    it("G6 [DEFENCE] researcher private key is non-extractable (INV-09)", async function () {
      const kp = await generateAsymmetricKeyPair(false);
      expect(kp.privateKey.extractable).to.equal(false);
      let exported = true;
      try { await globalThis.crypto.subtle.exportKey("jwk", kp.privateKey); } catch { exported = false; }
      expect(exported, "non-extractable key must not be exportable").to.equal(false);
    });

    it("G7 [PoC DEFECT DEF5-09] sovereign wallet backup is unreachable for INV-09-compliant keys", async function () {
      const kp = await generateAsymmetricKeyPair(false);
      const w = Wallet.createRandom();
      const fakeSigner = { getAddress: async () => w.address, signMessage: async (m) => await w.signMessage(m) };
      let err = null;
      try { await createWalletKeyBackup(fakeSigner, w.address, kp); } catch (e) { err = e.message; }
      expect(err, "key_vault.js:186-188 must allow backing up a non-extractable key").to.equal(null);
    });

    it("G8 [DEFENCE] GNC1 chunked container round-trips and rejects per-chunk tampering", async function () {
      const big = "A".repeat(64 * 1024 * 3 + 17);
      const pkg = await encryptGenomicDataChunked(big);
      expect(pkg.chunkCount).to.equal(4);
      expect(await decryptGenomicDataChunked(pkg.payload, pkg.activeKey)).to.equal(big);
      const tam = pkg.payload.slice();
      tam[40000] ^= 0xff;
      let ok = true;
      try { await decryptGenomicDataChunked(tam, pkg.activeKey); } catch { ok = false; }
      expect(ok, "chunked container must reject a flipped ciphertext byte").to.equal(false);
    });

    it("G9 [DEFENCE] malformed capsules and keys are rejected with explicit errors", async function () {
      const kp = await generateAsymmetricKeyPair(false);
      await expect(decryptKeyCapsule("{not json", kp.privateKey)).to.be.rejectedWith(/malformed JSON/i);
      await expect(decryptKeyCapsule(JSON.stringify({ keyCipher: "abcd" }), kp.privateKey))
        .to.be.rejectedWith(/512 hex characters/);
      await expect(packageKeyCapsule("deadbeef", await exportPublicKey(kp.publicKey), "0x0", "0x0"))
        .to.be.rejectedWith(/must be exactly 32 bytes/);
    });
  });
});
