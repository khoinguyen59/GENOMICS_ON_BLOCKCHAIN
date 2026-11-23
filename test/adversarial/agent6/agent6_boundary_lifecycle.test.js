/**
 * AGENT 6/6 — INDEPENDENT BLIND ADVERSARIAL TEST (Task 6)
 * Target: contracts/GenomicsRegistry.sol — INVARIANT-16 (cross-function lifecycle &
 * state symmetry), INVARIANT-02 (CID integrity), boundary dataId handling.
 * All security assertions read real EVM state / mined receipts (INV-17).
 */
import fs from "node:fs";
import { expect } from "chai";
import hre from "hardhat";

const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID2 = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";

describe("AGENT6 :: GenomicsRegistry boundary, lifecycle symmetry & revocation", function () {
  let ethers;
  let token, nft, registry;
  let owner, buyer, dispatcher;

  let PRICE;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, buyer, dispatcher] = await ethers.getSigners();
    PRICE = ethers.parseUnits("100", 18);

    const TF = await ethers.getContractFactory("GenomicToken");
    token = await TF.deploy(owner.address);
    await token.waitForDeployment();

    const NF = await ethers.getContractFactory("GenomicNFT");
    nft = await NF.deploy(owner.address, 1000);
    await nft.waitForDeployment();

    const RF = await ethers.getContractFactory("GenomicsRegistry");
    registry = await RF.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await nft.setRegistryContract(registry.target);
  });

  async function registerOne(seed = "DNA_A", accessDuration = 86400) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
    await (
      await registry
        .connect(owner)
        .registerGenomicData(hash, CID, CID2, CID, `ipfs://${CID}`, PRICE, accessDuration, 1000)
    ).wait();
    return hash;
  }

  describe("B1 INV-16 boundary sweep: out-of-range dataId must revert DataNotFound(), never return EVM defaults", function () {
    it("reverts DataNotFound on every read AND write entrypoint for dataId 0, dataCount+1 and 2^200", async function () {
      await registerOne();
      const dataCount = await registry.dataCount();
      expect(dataCount).to.equal(1n);

      const badIds = [0n, dataCount + 1n, 10n ** 20n];
    // IMPORTANT: every entry is a THUNK (lazy closure). An earlier draft invoked
    // all 17 calls eagerly inside the array literal, which both fired 17
    // concurrent transactions and passed promises as arguments (crash inside
    // ethers/src.ts/abi/fragments.ts). Thunks keep the probe deterministic.
    const buildCalls = (id) => [
        ["grantAccess(uint256)", () => registry.connect(buyer)["grantAccess(uint256)"](id)],
        [
          "grantAccess(uint256,uint256)",
          () => registry.connect(buyer)["grantAccess(uint256,uint256)"](id, PRICE),
        ],
        [
          "grantAccessWithEscrow(uint256,uint256)",
          () => registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](id, 86400),
        ],
        ["claimEscrowRefund(uint256)", () => registry.connect(buyer).claimEscrowRefund(id)],
        [
          "releaseEscrow(uint256,address)",
          () => registry.connect(owner).releaseEscrow(id, buyer.address),
        ],
        ["updateDataStatus(uint256,uint8)", () => registry.connect(owner).updateDataStatus(id, 1)],
        [
          "updateDataPrice(uint256,uint256)",
          () => registry.connect(owner).updateDataPrice(id, PRICE),
        ],
        [
          "grantDirectAccess(uint256,address)",
          () => registry.connect(owner).grantDirectAccess(id, buyer.address),
        ],
        [
          "setAuthorizedCapsuleWorker(uint256,address,bool)",
          () => registry.connect(owner).setAuthorizedCapsuleWorker(id, dispatcher.address, true),
        ],
        [
          "resetAuthorizedWorkers(uint256)",
          () => registry.connect(owner).resetAuthorizedWorkers(id),
        ],
        [
          "storeTransformedCapsule(uint256,address,string)",
          () => registry.connect(owner).storeTransformedCapsule(id, buyer.address, "capsule"),
        ],
        [
          "emitTransformedCapsule(uint256,address,string)",
          () => registry.connect(owner).emitTransformedCapsule(id, buyer.address, "capsule"),
        ],
        [
          "getTransformedCapsule(uint256)",
          () => registry.connect(buyer).getTransformedCapsule(id),
        ],
        [
          "getCapsuleForBuyer(uint256,address)",
          () => registry.connect(owner).getCapsuleForBuyer(id, buyer.address),
        ],
        [
          "buyerCapsules(uint256,address)",
          () => registry.connect(owner).buyerCapsules(id, buyer.address),
        ],
        [
          "hasActiveAccess(uint256,address)",
          () => registry.hasActiveAccess(id, buyer.address),
        ],
        ["getGenomicData(uint256)", () => registry.getGenomicData(id)],
      ];

      const violations = [];
      let checked = 0;
      for (const id of badIds) {
        for (const [name, thunk] of buildCalls(id)) {
          checked++;
          let reverted = false;
          let detail = "";
          try {
            await thunk();
          } catch (e) {
            reverted = true;
            detail = String(e?.shortMessage ?? e?.message ?? e);
          }
          if (!reverted) {
            violations.push(`${name} ACCEPTED out-of-range dataId=${id}`);
            continue;
          }
          const selector = registry.interface.getError("DataNotFound()").selector;
          if (!detail.includes("DataNotFound") && !detail.includes(selector)) {
            violations.push(`${name} dataId=${id} reverted with WRONG error: ${detail}`);
          }
        }
      }

      expect(checked).to.equal(3 * 17);
      expect(
        violations,
        "INV-16: every dataId entrypoint must revert DataNotFound() (never fabricate EVM defaults, never a different error)"
      ).to.deep.equal([]);
    });

    it("getDataItemsPaginated must never fabricate rows beyond dataCount", async function () {
      await registerOne();
      const [items, total] = await registry.getDataItemsPaginated(0, 50);
      expect(total).to.equal(1n);
      expect(items.length).to.equal(1);
      const [empty] = await registry.getDataItemsPaginated(5, 10);
      expect(empty.length).to.equal(0);
    });
  });

  describe("B2 INV-02 on-chain CID validation", function () {
    it("registerGenomicData must reject a non-multihash fake CID (e.g. QmGeno-style prefix)", async function () {
      const fake = "QmGenoFakeCid111111111111111111111111111111111111"; // 46 chars, base58-invalid letters
      const hash = ethers.keccak256(ethers.toUtf8Bytes("DNA_FAKE"));
      let accepted = true;
      let txHash = "";
      try {
        const rc = await (
          await registry
            .connect(owner)
            .registerGenomicData(hash, fake, fake, fake, `ipfs://${fake}`, PRICE, 86400, 1000)
        ).wait();
        txHash = rc.hash;
      } catch (_) {
        accepted = false;
      }
      // INV-17: read the row back from real chain state to prove it was persisted.
      const stored = accepted ? await registry.getGenomicData(1) : null;
      expect(
        accepted,
        `INV-02: registerGenomicData [GenomicsRegistry.sol:273] only checks bytes(rawCid).length==0 — ` +
          `a garbage (non-multihash) CID was persisted and an NFT minted for it. ` +
          `tx=${txHash} dataId=1 rawCiphertextCid=${stored?.rawCiphertextCid}`
      ).to.equal(false);
    });

    it("DEFECT PROBE (INV-02): empty summaryCid / metadataCid must not be accepted", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes("DNA_NO_SUMMARY"));
      let accepted = true;
      try {
        await (
          await registry
            .connect(owner)
            .registerGenomicData(hash, CID, "", "", "", PRICE, 86400, 1000)
        ).wait();
      } catch (_) {
        accepted = false;
      }
      const stored = accepted ? await registry.getGenomicData(1) : null;
      expect(
        accepted,
        `empty summary/metadata CIDs accepted: dataId=1 summaryCid="${stored?.summaryCiphertextCid}" ` +
          `metadataCid="${stored?.metadataCid}" — downstream decryptSummaryReport() and the GA4GH ` +
          `Phenopackets viewer have no on-chain anchor (frontend/src/services/datasetService.js:446-486)`
      ).to.equal(false);
    });

    it("empty rawCid must revert InvalidDataHashOrCid (baseline guard present)", async function () {
      const hash = ethers.keccak256(ethers.toUtf8Bytes("DNA_EMPTY"));
      await expect(
        registry
          .connect(owner)
          .registerGenomicData(hash, "", CID2, CID, "ipfs://x", PRICE, 86400, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");
      await expect(
        registry
          .connect(owner)
          .registerGenomicData(ethers.ZeroHash, CID, CID2, CID, "ipfs://x", PRICE, 86400, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");
    });
  });

  describe("B3 INV-16 status lifecycle symmetry across every reader", function () {
    async function fundedBuyer() {
      await (await token.connect(owner).transfer(buyer.address, PRICE * 5n)).wait();
      await (await token.connect(buyer).approve(registry.target, PRICE * 5n)).wait();
    }

    it("Paused/Revoked must be enforced IDENTICALLY by getTransformedCapsule, buyerCapsules and hasActiveAccess", async function () {
      await registerOne();
      await fundedBuyer();
      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](1, PRICE)).wait();
      await (
        await registry
          .connect(owner)
          .storeTransformedCapsule(1, buyer.address, '{"keyCipher":"' + "ab".repeat(512) + '"}')
      ).wait();

      // baseline: all three agree while Active
      expect(await registry.hasActiveAccess(1, buyer.address)).to.equal(true);
      expect(await registry.buyerCapsules(1, buyer.address)).to.not.equal("");

      await (await registry.connect(owner).updateDataStatus(1, 1 /* Paused */)).wait();

      const viewResults = {};
      try {
        viewResults.getTransformedCapsule = await registry.connect(buyer).getTransformedCapsule(1);
        viewResults.gtcReverted = false;
      } catch {
        viewResults.getTransformedCapsule = "REVERT";
        viewResults.gtcReverted = true;
      }
      try {
        viewResults.buyerCapsules = await registry.connect(buyer).buyerCapsules(1, buyer.address);
        viewResults.bcReverted = false;
      } catch {
        viewResults.buyerCapsules = "REVERT";
        viewResults.bcReverted = true;
      }
      viewResults.hasActiveAccess = await registry.hasActiveAccess(1, buyer.address);

      // Defensive property: once Paused, NO reader may hand out key material.
      expect(viewResults.hasActiveAccess, "hasActiveAccess must be false while Paused").to.equal(
        false
      );
      expect(String(viewResults.getTransformedCapsule)).to.equal("REVERT");

      // INV-16 symmetry probe: sibling readers of the SAME state must behave identically.
      expect(
        viewResults.bcReverted,
        "INV-16 asymmetry: getTransformedCapsule reverts DataNotActive while buyerCapsules " +
          "silently returns an empty string (GenomicsRegistry.sol:822 vs :797) — the UI " +
          "fallback chain (datasetService.js:344-358) swallows the throw and keeps polling, " +
          "so the revocation signal is not propagated consistently."
      ).to.equal(true);
    });

    it("Revoked is terminal: updateDataStatus and updateDataPrice must both refuse to resurrect it", async function () {
      await registerOne();
      await (await registry.connect(owner).updateDataStatus(1, 2 /* Revoked */)).wait();
      await expect(
        registry.connect(owner).updateDataStatus(1, 0)
      ).to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");
      await expect(
        registry.connect(owner).updateDataPrice(1, PRICE)
      ).to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");
      await expect(
        registry.connect(owner).grantDirectAccess(1, buyer.address)
      ).to.be.revertedWithCustomError(registry, "ConsentPermanentlyRevoked");
    });

    it("capsule material must NOT remain retrievable after consent revocation (key custody gap)", async function () {
      await registerOne();
      await fundedBuyer();
      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](1, PRICE)).wait();
      const capsule = '{"version":"GENO-ASYM-RSA-OAEP-v2","keyCipher":"' + "cd".repeat(256) + '"}';
      await (await registry.connect(owner).storeTransformedCapsule(1, buyer.address, capsule)).wait();

      await (await registry.connect(owner).updateDataStatus(1, 2 /* Revoked */)).wait();

      // Exact code path shipped in frontend/src/services/datasetService.js:362-373
      const filter = registry.filters.CapsuleStored(1, buyer.address);
      const events = await registry.queryFilter(filter, 0, "latest");

      expect(
        events.length,
        "after Revoked, no capsule material may still be recoverable from immutable public logs"
      ).to.equal(0);
    });
  });

  // ---------------------------------------------------------------- B5
  describe("B5 escrow / refund / access-control adversarial probes", function () {
    async function fundedBuyer() {
      await (await token.connect(owner).transfer(buyer.address, PRICE * 5n)).wait();
      await (await token.connect(buyer).approve(registry.target, PRICE * 5n)).wait();
    }

    it("PASSES: buyer is made whole (100% refund, exact balance delta) when the capsule is never delivered", async function () {
      await registerOne();
      await fundedBuyer();
      await (await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, 3600)).wait();

      const dep = await registry.escrowDeposits(1, buyer.address);
      expect(dep.amount).to.equal(PRICE);
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);

      // control: refunding INSIDE the dispute window must be refused
      await expect(registry.connect(buyer).claimEscrowRefund(1)).to.be.revertedWithCustomError(
        registry,
        "DisputeWindowActive"
      );

      // the dispute window must elapse before a refund is claimable (GenomicsRegistry.sol:486-488)
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(dep.depositTime + 3601n)]);

      const before = await token.balanceOf(buyer.address);
      const rc = await (await registry.connect(buyer).claimEscrowRefund(1)).wait();
      expect(rc.status).to.equal(1);
      const after = await token.balanceOf(buyer.address);

      // real EVM state: victim property fully restored
      expect(after - before).to.equal(PRICE);
      expect((await registry.accessGrants(1, buyer.address)).isGranted).to.equal(false);
      const depAfter = await registry.escrowDeposits(1, buyer.address);
      expect(depAfter.refunded).to.equal(true);
    });

    it("DEFECT PROBE (G10 missing access control): an unrelated EOA must NOT be able to call releaseEscrow", async function () {
      // 120s access duration so the buyer's FIRST (direct) grant can expire and a
      // second, still-undelivered escrow deposit can be opened for the same buyer.
      await registerOne("DNA_ACL", 120);
      await fundedBuyer();
      const signers = await ethers.getSigners();
      const attacker = signers[3];

      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](1, PRICE)).wait();
      await (
        await registry
          .connect(owner)
          .storeTransformedCapsule(1, buyer.address, '{"keyCipher":"' + "ef".repeat(256) + '"}')
      ).wait();

      // let the direct grant lapse, then open a fresh escrow (no capsule delivered for it)
      await ethers.provider.send("evm_setNextBlockTimestamp", [
        Number((await registry.accessGrants(1, buyer.address)).expiresAt + 5n),
      ]);
      await (await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, 86400)).wait();

      const dep = await registry.escrowDeposits(1, buyer.address);
      expect(dep.amount, "escrow freshly funded").to.equal(PRICE);
      expect(dep.capsuleDelivered, "no capsule delivered for this escrow").to.equal(false);

      const sellerBefore = await token.balanceOf(owner.address);
      const registryBefore = await token.balanceOf(registry.target);
      let reverted = false;
      let why = "";
      try {
        await (await registry.connect(attacker).releaseEscrow(1, buyer.address)).wait();
      } catch (e) {
        reverted = true;
        why = String(e.shortMessage ?? e.message);
      }
      const sellerAfter = await token.balanceOf(owner.address);
      const registryAfter = await token.balanceOf(registry.target);
      const depAfter = await registry.escrowDeposits(1, buyer.address);

      expect(
        reverted,
        `releaseEscrow(uint256,address) [GenomicsRegistry.sol:507-514] carries NO access-control ` +
          `modifier (only DataNotFound/EscrowNotActive/CapsuleNotDelivered). A totally unrelated EOA ` +
          `(${attacker.address}) finalised the victim's escrow: tx mined, seller balance +` +
          `${sellerAfter - sellerBefore} wei, contract balance -${registryBefore - registryAfter}, ` +
          `deposit.released=${depAfter.released}. The buyer thereby loses the ` +
          `claimEscrowRefund() dispute right [GenomicsRegistry.sol:483] before ever verifying the ` +
          `delivered capsule off-chain. observed error="${why}"`
      ).to.equal(true);
      expect(depAfter.released, "victim escrow must stay refundable").to.equal(false);
    });

    it("DEFECT PROBE (state asymmetry): hasActiveAccess=true for a paid-but-undelivered escrow", async function () {
      await registerOne();
      await fundedBuyer();
      await (
        await registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, 86400)
      ).wait();

      const access = await registry.hasActiveAccess(1, buyer.address);
      const grant = await registry.accessGrants(1, buyer.address);
      let capsuleErr = "NO REVERT";
      try {
        capsuleErr = await registry.connect(buyer).getTransformedCapsule(1);
      } catch (e) {
        capsuleErr = String(e.shortMessage ?? e.message);
      }

      expect(grant.isGranted, "no key material delivered").to.equal(false);
      expect(
        access,
        `hasActiveAccess [GenomicsRegistry.sol:859-862] reports TRUE while accessGrants.isGranted=false ` +
          `and getTransformedCapsule reverts "${capsuleErr}". Consumers that gate decryption on this view ` +
          `(scripts/demo/web3_demo.py:203, scripts/demo/live_execution_e2e.mjs:235 assert Expected:true) " +
          "get an access-OK signal for a state in which decryption cannot succeed.`
      ).to.equal(false);
    });

    it("PASSES: dispute-window bounds 1h..30d are enforced (InvalidDisputeWindow)", async function () {
      await registerOne();
      await fundedBuyer();
      await expect(
        registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, 60)
      ).to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");
      await expect(
        registry.connect(buyer)["grantAccessWithEscrow(uint256,uint256)"](1, 31 * 86400)
      ).to.be.revertedWithCustomError(registry, "InvalidDisputeWindow");
    });

    it("PASSES: an un-purchased buyer cannot obtain capsule material (AccessNotGranted)", async function () {
      await registerOne();
      await fundedBuyer();
      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](1, PRICE)).wait();
      await expect(
        registry.connect(dispatcher).getTransformedCapsule(1)
      ).to.be.revertedWithCustomError(registry, "AccessNotGranted");
      await expect(
        registry.connect(dispatcher).buyerCapsules(1, dispatcher.address)
      ).to.be.revertedWithCustomError(registry, "AccessNotGranted");
      // and the owner cannot ship a capsule to someone who never paid
      await expect(
        registry.connect(owner).storeTransformedCapsule(1, dispatcher.address, "capsule")
      ).to.be.revertedWithCustomError(registry, "AccessNotGranted");
    });

    it("PASSES: expired grant is rejected by every capsule reader (AccessExpired)", async function () {
      await registerOne("DNA_SHORT", 120);
      await fundedBuyer();
      await (await registry.connect(buyer)["grantAccess(uint256,uint256)"](1, PRICE)).wait();
      const validCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "kk", keyCipher: "ab".repeat(256) });
      await (await registry.connect(owner).storeTransformedCapsule(1, buyer.address, validCapsule)).wait();
      expect(await registry.connect(buyer).getTransformedCapsule(1)).to.equal(validCapsule);

      const grant = await registry.accessGrants(1, buyer.address);
      // mine the block: view calls are simulated against the LATEST block, so a merely
      // scheduled next-timestamp is not visible to them.
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(grant.expiresAt + 1n)]);
      await ethers.provider.send("evm_mine", []);
      expect(Number((await ethers.provider.getBlock("latest")).timestamp)).to.be.greaterThanOrEqual(
        Number(grant.expiresAt)
      );

      await expect(
        registry.connect(buyer).getTransformedCapsule(1)
      ).to.be.revertedWithCustomError(registry, "AccessExpired");
      await expect(
        registry.connect(buyer).buyerCapsules(1, buyer.address)
      ).to.be.revertedWithCustomError(registry, "AccessExpired");
      expect(await registry.hasActiveAccess(1, buyer.address)).to.equal(false);
    });
  });

  describe("B4 static sweep for declared-but-unreachable guards (sweep for absence)", function () {
    const FILES = [
      "contracts/GenomicsRegistry.sol",
      "contracts/GenomicToken.sol",
      "contracts/GenomicNFT.sol",
      "contracts/GenomicZkVerifier.sol",
    ];

    it("every custom error declared in the core contracts must be reachable via `revert <Error>`", function () {
      const dead = [];
      for (const file of FILES) {
        const src = fs.readFileSync(file, "utf8");
        const declared = [...src.matchAll(/^\s*error\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
        for (const name of declared) {
          const used = new RegExp(`revert\\s+${name}\\s*[;(]`).test(src);
          if (!used) dead.push(`${file} :: error ${name}()`);
        }
      }
      expect(
        dead,
        `dead custom errors (declared, never reverted anywhere) — a guard was written then dropped:\n${dead.join("\n")}`
      ).to.deep.equal([]);
    });
  });
});
