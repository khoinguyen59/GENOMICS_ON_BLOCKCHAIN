/**
 * AUDIT AGENT 1/6 - INDEPENDENT BLIND ADVERSARIAL SUITE (ZERO-DECOMPOSITION full 8-dimension run)
 * =================================================================================================
 * Written from the spec + threat model WITHOUT trusting the builder's own test suite (INVARIANT-17).
 * Anti-tautology discipline: every assertion reads REAL EVM state after `await tx.wait()` or via a
 * contract VIEW call. Security tests assert DEFENSE HELD (revert-with-custom-error, victim balance
 * preserved, state unmodified) - never "exploit succeeded = pass".
 *
 * Coverage matrix (Task 6):
 *  T1 faucet economic fuzzer / Anti-Sybil on BOTH msg.sender and `to` + >=1h cooldown  (INV-15)
 *  T2 dataId boundary 0 / dataCount / dataCount+1 must revert DataNotFound             (INV-16)
 *  T3 access-control bypass sweep (onlyDataOwner) + owner-cannot-buy-own               (CEI/access)
 *  T4 escrow dispute-window + 100% refund guarantee + capsule-delivery release         (escrow)
 *  T5 reentrancy via MaliciousReentrantReceiver (ERC721 callback on register)          (reentrancy)
 *  T6 reentrancy via MaliciousReentrantToken (ERC20 callback on grantAccess)           (reentrancy)
 *  T7 non-standard ERC20 (void return) through escrow settlement via SafeERC20         (ERC20 RV)
 *  T8 concurrent multi-buyer + EIP-2981 secondary-sale royalty split math == 100%       (royalty)
 *  T9 [DEFECT] BN254 ZK verifier degenerate-VK trivial proof forgery -> bounty drain    (CRITICAL)
 */
import hre from "hardhat";
import { expect } from "chai";

const G2_GEN = [
  [
    0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2n,
    0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6edn,
  ],
  [
    0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975bn,
    0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daan,
  ],
];
const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const VALID_SUM_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
const VALID_META_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
const PRICE = 100n * 10n ** 18n; // 100 $GENO
const DURATION = 30n * 86400n; // 30 days
const ROYALTY_BPS = 1000; // 10%

let ethers;
let deployer, creator, buyer1, buyer2, buyer3, seller2, attacker, outsider;

async function deployStack(paymentTokenAddr, nftAddr) {
  const Reg = await ethers.getContractFactory("GenomicsRegistry");
  const reg = await Reg.deploy(paymentTokenAddr, nftAddr, deployer.address);
  await reg.waitForDeployment();
  return reg;
}

async function deployNft() {
  const Nft = await ethers.getContractFactory("GenomicNFT");
  const nft = await Nft.deploy(deployer.address, ROYALTY_BPS);
  await nft.waitForDeployment();
  return nft;
}

async function registerDataset(reg, nft, owner, seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`AGENT1_CIPHERTEXT_PKG_${seed}`));
  const tx = await reg.connect(owner).registerGenomicData(
    hash, VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID,
    `ipfs://${VALID_META_CID}`, PRICE, DURATION, ROYALTY_BPS
  );
  await tx.wait();
  return hash;
}

async function mineAt(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

// Deterministic boundary control: force the NEXT block to an exact timestamp (no +1 drift).
async function setNextTs(t) {
  const target = BigInt(t);
  await ethers.provider.send("evm_setNextBlockTimestamp", ["0x" + target.toString(16)]);
}

before(async function () {
  ({ ethers } = await hre.network.create());
  [deployer, creator, buyer1, buyer2, buyer3, seller2, attacker, outsider] = await ethers.getSigners();
});

describe("AGENT1 :: Independent Adversarial Matrix", function () {
  let token, nft, reg;

  beforeEach(async function () {
    const Tok = await ethers.getContractFactory("GenomicToken");
    token = await Tok.deploy(deployer.address);
    await token.waitForDeployment();
    nft = await deployNft();
    reg = await deployStack(token.target, nft.target);
    await nft.connect(deployer).setRegistryContract(reg.target);
  });

  // =============================================================================
  // T1 - Faucet Anti-Sybil economic fuzzer (INVARIANT-15): rate limit on BOTH msg.sender and `to`
  // =============================================================================
  describe("T1 faucet Anti-Sybil cooldown (INV-15)", function () {
    it("blocks a caller from a second claim within 1h (msg.sender cooldown) - DEFENSE HELD", async function () {
      await (await token.connect(buyer1).faucet(buyer1.address)).wait();
      await expect(token.connect(buyer1).faucet(buyer1.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
    });

    it("blocks a DIFFERENT caller from topping-up a recipient already in cooldown (`to` cooldown) - DEFENSE HELD", async function () {
      // buyer1 funds itself -> lastFaucetTime[buyer1] set as recipient too.
      await (await token.connect(buyer1).faucet(buyer1.address)).wait();
      // attacker (fresh, never claimed) tries to send faucet TO buyer1 -> recipient cooldown must block.
      await expect(token.connect(attacker).faucet(buyer1.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
      // victim balance must be exactly the one self-claim (no sybil double-dip).
      expect(await token.balanceOf(buyer1.address)).to.equal(1000n * 10n ** 18n);
    });

    it("re-opens faucet exactly at/after the 3600s boundary, not before", async function () {
      await (await token.connect(buyer2).faucet(buyer2.address)).wait();
      // Anchor on the on-chain recorded time (not a JS-relative guess) for a deterministic boundary.
      const t0 = await token.lastFaucetTime(buyer2.address);
      // One second short of the window: force THIS tx's block to t0+3599 -> still inside cooldown -> revert.
      await setNextTs(t0 + 3599n);
      await expect(token.connect(buyer2).faucet(buyer2.address))
        .to.be.revertedWithCustomError(token, "FaucetCooldownActive");
      // Exactly at the window boundary: force tx block to t0+3600 -> `block.timestamp < t0+3600` is false -> allowed.
      await setNextTs(t0 + 3600n);
      await (await token.connect(buyer2).faucet(buyer2.address)).wait();
      expect(await token.balanceOf(buyer2.address)).to.equal(2000n * 10n ** 18n);
    });
  });

  // =============================================================================
  // T2 - dataId boundary must revert DataNotFound (INVARIANT-16), never rely on EVM defaults
  // =============================================================================
  describe("T2 dataId boundary DataNotFound (INV-16)", function () {
    it("reverts DataNotFound for dataId==0 and dataId==dataCount+1 on every accessor", async function () {
      await registerDataset(reg, nft, creator, "B1");
      expect(await reg.dataCount()).to.equal(1n);

      for (const bad of [0n, 2n]) {
        await expect(reg.getGenomicData(bad)).to.be.revertedWithCustomError(reg, "DataNotFound");
        await expect(reg.hasActiveAccess(bad, buyer1.address)).to.be.revertedWithCustomError(reg, "DataNotFound");
        await expect(reg.getTransformedCapsule(bad)).to.be.revertedWithCustomError(reg, "DataNotFound");
        await expect(reg.buyerCapsules(bad, buyer1.address)).to.be.revertedWithCustomError(reg, "DataNotFound");
        await expect(reg.connect(buyer1).grantAccess(bad)).to.be.revertedWithCustomError(reg, "DataNotFound");
        await expect(reg.connect(buyer1).grantAccessWithEscrow(bad, 3600)).to.be.revertedWithCustomError(reg, "DataNotFound");
      }
      // valid boundary dataId==dataCount is NOT rejected by the range guard
      expect((await reg.getGenomicData(1n)).dataId).to.equal(1n);
    });
  });

  // =============================================================================
  // T3 - Access-control bypass sweep (onlyDataOwner) + OwnerCannotBuyOwnData
  // =============================================================================
  describe("T3 access-control bypass sweep", function () {
    beforeEach(async function () {
      await registerDataset(reg, nft, creator, "AC1");
    });

    it("rejects non-owner lifecycle mutation - DEFENSE HELD", async function () {
      await expect(reg.connect(attacker).updateDataStatus(1n, 1))
        .to.be.revertedWithCustomError(reg, "NotDataOwner");
      await expect(reg.connect(attacker).updateDataPrice(1n, 1n))
        .to.be.revertedWithCustomError(reg, "NotDataOwner");
      await expect(reg.connect(attacker).grantDirectAccess(1n, buyer1.address))
        .to.be.revertedWithCustomError(reg, "NotDataOwner");
      // state unchanged by rejected attempts
      expect((await reg.getGenomicData(1n)).status).to.equal(0); // Active
    });

    it("rejects data owner buying their own dataset", async function () {
      await expect(reg.connect(creator).grantAccess(1n))
        .to.be.revertedWithCustomError(reg, "OwnerCannotBuyOwnData");
    });

    it("rejects buyer whose access already EXPIRED from pulling a capsule (AccessExpired)", async function () {
      await reg.connect(creator).grantDirectAccess(1n, buyer1.address);
      await mineAt(Number(DURATION) + 5);
      await expect(reg.connect(buyer1).getTransformedCapsule(1n))
        .to.be.revertedWithCustomError(reg, "AccessExpired");
      expect(await reg.hasActiveAccess(1n, buyer1.address)).to.equal(false);
    });
  });

  // =============================================================================
  // T4 - Escrow: dispute window, 100% refund guarantee, capsule-delivery release
  // =============================================================================
  describe("T4 escrow dispute/refund/release", function () {
    beforeEach(async function () {
      await registerDataset(reg, nft, creator, "ESC1");
      await token.connect(deployer).mint(buyer1.address, PRICE);
      await token.connect(buyer1).approve(reg.target, PRICE);
      await (await reg.connect(buyer1).grantAccessWithEscrow(1n, 3600)).wait();
    });

    it("holds escrowed funds in-contract and marks buyer as pending", async function () {
      expect(await token.balanceOf(reg.target)).to.equal(PRICE);
      const dep = await reg.escrowDeposits(1n, buyer1.address);
      expect(dep.amount).to.equal(PRICE);
      expect(dep.released).to.equal(false);
      expect(dep.refunded).to.equal(false);
    });

    it("blocks premature refund inside the active dispute window (no capsule) - DEFENSE HELD", async function () {
      const creatorBalBefore = await token.balanceOf(creator.address);
      await expect(reg.connect(buyer1).claimEscrowRefund(1n))
        .to.be.revertedWithCustomError(reg, "DisputeWindowActive");
      // buyer funds still locked, creator not paid
      expect(await token.balanceOf(creator.address)).to.equal(creatorBalBefore);
      expect(await token.balanceOf(reg.target)).to.equal(PRICE);
    });

    it("refunds 100% to buyer after dispute window lapses without delivery", async function () {
      await mineAt(3601);
      const balBefore = await token.balanceOf(buyer1.address);
      const creatorBefore = await token.balanceOf(creator.address);
      await (await reg.connect(buyer1).claimEscrowRefund(1n)).wait();
      expect((await token.balanceOf(buyer1.address)) - balBefore).to.equal(PRICE); // full refund
      expect(await token.balanceOf(creator.address)).to.equal(creatorBefore); // seller got nothing
      expect(await token.balanceOf(reg.target)).to.equal(0n);
    });

    it("releases escrow to seller once owner dispatches capsule; blocks refund afterwards", async function () {
      await reg.connect(creator).storeTransformedCapsule(1n, buyer1.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "REAL_RSA_OAEP_CAPSULE_JSON", keyCipher: "ab".repeat(256) }));
      const dep = await reg.escrowDeposits(1n, buyer1.address);
      expect(dep.released).to.equal(true);
      expect(dep.capsuleDelivered).to.equal(true);
      // funds disbursed -> contract drained, creator paid (primary sale: royaltyReceiver==seller)
      expect(await token.balanceOf(reg.target)).to.equal(0n);
      await expect(reg.connect(buyer1).claimEscrowRefund(1n))
        .to.be.revertedWithCustomError(reg, "CapsuleAlreadyDelivered");
    });
  });

  // =============================================================================
  // T5 - Reentrancy via MaliciousReentrantReceiver on ERC721 receive hook during register
  // =============================================================================
  describe("T5 reentrancy: ERC721 onERC721Received callback on register", function () {
    it("blocks re-entrant registerGenomicData via nonReentrant - DEFENSE HELD", async function () {
      const Mal = await ethers.getContractFactory("MaliciousReentrantReceiver");
      const mal = await Mal.deploy(reg.target);
      await mal.waitForDeployment();
      await (await mal.registerWithRegistry(
        ethers.keccak256(ethers.toUtf8Bytes("agent1_mal")),
        VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID, "ipfs://x",
        PRICE, DURATION, ROYALTY_BPS
      )).wait();
      expect(await mal.attackSucceeded()).to.equal(false);
      expect(await reg.dataCount()).to.equal(1n); // only the legit outer registration committed
    });
  });

  // =============================================================================
  // T6 - Reentrancy via MaliciousReentrantToken.transferFrom callback during grantAccess
  // =============================================================================
  describe("T6 reentrancy: ERC20 transferFrom callback on grantAccess", function () {
    it("blocks re-entrant grantAccess during payment - DEFENSE HELD", async function () {
      const Mal = await ethers.getContractFactory("MaliciousReentrantToken");
      const mal = await Mal.deploy(deployer.address);
      await mal.waitForDeployment();
      const nft2 = await deployNft();
      const reg2 = await deployStack(mal.target, nft2.target);
      await nft2.connect(deployer).setRegistryContract(reg2.target);

      // register on reg2 by creator
      await reg2.connect(creator).registerGenomicData(
        ethers.keccak256(ethers.toUtf8Bytes("agent1_reent")),
        VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID, "ipfs://x",
        PRICE, DURATION, ROYALTY_BPS
      ).then((t) => t.wait());

      await mal.setRegistryAndTarget(reg2.target, 1);
      await mal.connect(deployer).transfer(buyer1.address, PRICE);
      await mal.connect(buyer1).approve(reg2.target, PRICE);

      const creatorBefore = await mal.balanceOf(creator.address);
      await (await reg2.connect(buyer1).grantAccess(1n)).wait();
      expect(await mal.attackSucceeded()).to.equal(false);
      // exactly one payment of PRICE reached creator (no double-disbursement)
      expect((await mal.balanceOf(creator.address)) - creatorBefore).to.equal(PRICE);
      const grant = await reg2.accessGrants(1n, buyer1.address);
      expect(grant.isGranted).to.equal(true);
    });
  });

  // =============================================================================
  // T7 - Non-standard ERC20 (transfer/transferFrom return void) through escrow + grantAccess
  // =============================================================================
  describe("T7 non-standard ERC20 (void return) via SafeERC20", function () {
    let nst, nstNft, nstReg;
    beforeEach(async function () {
      const NST = await ethers.getContractFactory("NonStandardERC20");
      nst = await NST.deploy(10n ** 24n);
      await nst.waitForDeployment();
      nstNft = await deployNft();
      nstReg = await deployStack(nst.target, nstNft.target);
      await nstNft.connect(deployer).setRegistryContract(nstReg.target);
      await nstReg.connect(creator).registerGenomicData(
        ethers.keccak256(ethers.toUtf8Bytes("agent1_nst")),
        VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID, "ipfs://x",
        PRICE, DURATION, ROYALTY_BPS
      ).then((t) => t.wait());
      await nst.connect(deployer).transfer(buyer1.address, PRICE);
      await nst.connect(buyer1).approve(nstReg.target, PRICE);
    });

    it("escrow deposit succeeds with a void-return token (no false-negative revert)", async function () {
      await (await nstReg.connect(buyer1).grantAccessWithEscrow(1n, 3600)).wait();
      const dep = await nstReg.escrowDeposits(1n, buyer1.address);
      expect(dep.amount).to.equal(PRICE);
      expect(await nst.balanceOf(nstReg.target)).to.equal(PRICE); // funds really moved
    });

    it("grantAccess direct settlement succeeds + refunds correctly with void-return token", async function () {
      await (await nstReg.connect(buyer1).grantAccess(1n)).wait();
      expect(await nst.balanceOf(creator.address)).to.equal(PRICE); // primary sale: full to creator
      await expect(nstReg.connect(buyer1).grantAccess(1n))
        .to.be.revertedWithCustomError(nstReg, "AccessAlreadyActive");
    });
  });

  // =============================================================================
  // T8 - Concurrent multi-buyer stress + EIP-2981 secondary-sale royalty split == 100%
  // =============================================================================
  describe("T8 concurrent buyers + royalty split math", function () {
    it("secondary sale: 10% royalty to original creator, 90% to current seller (read from EVM)", async function () {
      await reg.connect(creator).registerGenomicData(
        ethers.keccak256(ethers.toUtf8Bytes("agent1_roy")),
        VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID, "ipfs://x",
        PRICE, DURATION, ROYALTY_BPS
      ).then((t) => t.wait());
      // secondary market: creator sells the NFT (data ownership) to seller2
      await nft.connect(creator).transferFrom(creator.address, seller2.address, 1n).then((t) => t.wait());

      await token.connect(deployer).mint(buyer1.address, PRICE);
      await token.connect(deployer).mint(buyer2.address, PRICE);
      await token.connect(buyer1).approve(reg.target, PRICE);

      const c0 = await token.balanceOf(creator.address);
      const s0 = await token.balanceOf(seller2.address);
      await (await reg.connect(buyer1)["grantAccess(uint256,uint256)"](1n, PRICE)).wait();

      expect((await token.balanceOf(creator.address)) - c0).to.equal(10n * 10n ** 18n); // 10% royalty
      expect((await token.balanceOf(seller2.address)) - s0).to.equal(90n * 10n ** 18n); // 90% proceeds
      // conservation: buyer paid exactly PRICE, contract holds nothing (direct disbursement)
      expect(await token.balanceOf(buyer1.address)).to.equal(0n);
    });

    it("concurrent independent purchases across distinct datasets settle atomically", async function () {
      const ids = [];
      for (const [i, b] of [buyer1, buyer2, buyer3].entries()) {
        await reg.connect(creator).registerGenomicData(
          ethers.keccak256(ethers.toUtf8Bytes(`agent1_conc_${i}`)),
          VALID_RAW_CID, VALID_SUM_CID, VALID_META_CID, "ipfs://x",
          PRICE, DURATION, ROYALTY_BPS
        ).then((t) => t.wait());
        ids.push(await reg.dataCount());
        await token.connect(deployer).mint(b.address, PRICE);
        await token.connect(b).approve(reg.target, PRICE);
      }
      await Promise.all(ids.map((id, i) =>
        reg.connect([buyer1, buyer2, buyer3][i])["grantAccess(uint256,uint256)"](id, PRICE).then((t) => t.wait())
      ));
      for (const id of ids) {
        const d = await reg.getGenomicData(id);
        expect(d.accessCount).to.equal(1n);
      }
      expect(await token.balanceOf(creator.address)).to.equal(PRICE * 3n); // 3 primary sales
    });
  });

  // =============================================================================
  // T9 - [DEFECT] BN254 Groth16 verifier uses a degenerate FIXED verification key.
  //      alpha = G1 generator (1,2); beta = gamma = delta = the SAME G2 generator.
  //      => pairing e(-A,B)*e(a,b)*e(s*G1,gy)*e(C,d) collapses (for B=G2gen) to the PUBLIC
  //         linear relation A = (publicSignal+1)*G1 + C, computable by ANYONE with NO secret
  //         witness and NO genetic data. This test asserts the DEFENSE (a witness-free forged
  //         proof must revert InvalidZkProof and sponsor funds must be preserved).
  //      It is EXPECTED to FAIL against current code -> this failure is defect DEF1-01 (CRITICAL).
  // =============================================================================
  describe("T9 zk-Genomics verifier soundness (DEF1-01 candidate)", function () {
    let zk, bountyId;
    beforeEach(async function () {
      const Zk = await ethers.getContractFactory("GenomicZkVerifier");
      zk = await Zk.deploy(token.target);
      await zk.waitForDeployment();
      await token.connect(deployer).mint(buyer1.address, 10n ** 24n); // sponsor
      await token.connect(buyer1).approve(zk.target, PRICE * 5n);
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
      const tx = await zk.connect(buyer1).createZkBounty(trait, "Study", 100n * 10n ** 18n, 3n, 86400);
      await tx.wait();
      bountyId = 1n;
    });

    it("rejects a witness-free forged proof and preserves sponsor escrow - DEFENSE MUST HOLD", async function () {
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
      // Attacker picks an ARBITRARY commitment that has nothing to do with any real genome.
      const fakeCommitment = ethers.keccak256(ethers.toUtf8Bytes("NOT_A_REAL_GENOME_ANY_USER"));

      const packed = ethers.solidityPacked(
        ["bytes32", "bytes32", "address"], [fakeCommitment, trait, attacker.address]
      );
      const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;

      // A = (publicSignal + 2) * G1 via ecMul precompile 0x07  ; C = 1 * G1 ; B = G2 generator.
      async function g1mul(scalar) {
        const res = await ethers.provider.call({
          to: "0x0000000000000000000000000000000000000007",
          data: ethers.concat([
            ethers.zeroPadValue("0x01", 32),
            ethers.zeroPadValue("0x02", 32),
            ethers.toBeHex(scalar % R_MOD, 32),
          ]),
        });
        return [BigInt(ethers.dataSlice(res, 0, 32)), BigInt(ethers.dataSlice(res, 32, 64))];
      }
      const A = await g1mul(publicSignal + 2n);
      const C = await g1mul(1n);
      const forgedProof = { a: A, b: G2_GEN, c: C };

      const zkBalBefore = await token.balanceOf(zk.target);
      const attBalBefore = await token.balanceOf(attacker.address);

      // Probe (staticCall) whether the witness-free forged proof is accepted by the verifier.
      let defenseHeld = false;
      try {
        await zk.connect(attacker).claimZkBounty.staticCall(bountyId, forgedProof, fakeCommitment);
        defenseHeld = false; // accepted -> verifier is UNSOUND
      } catch {
        defenseHeld = true;   // reverted -> verifier rejected the forgery
      }

      if (defenseHeld) {
        // If the verifier were sound, sponsor escrow must be untouched and attacker gains nothing.
        expect(await token.balanceOf(zk.target)).to.equal(zkBalBefore);
        expect(await token.balanceOf(attacker.address)).to.equal(attBalBefore);
        return; // PASS only if the DEFENSE genuinely holds
      }

      // Defense broken: execute the forge and READ REAL EVM STATE to quantify the victim drain.
      await (await zk.connect(attacker).claimZkBounty(bountyId, forgedProof, fakeCommitment)).wait();
      const attGain = (await token.balanceOf(attacker.address)) - attBalBefore;
      const zkLoss = zkBalBefore - (await token.balanceOf(zk.target));

      // SECURITY POSTURE (this assertion is EXPECTED TO FAIL on current code => proves DEF1-01):
      // a proof bound to no secret witness must transfer ZERO value; sponsor escrow preserved 100%.
      expect(attGain, `attacker drained ${attGain} wei from sponsor escrow with a witness-free proof`).to.equal(0n);
      expect(zkLoss, `sponsor escrow lost ${zkLoss} wei`).to.equal(0n);
    });
  });
});
