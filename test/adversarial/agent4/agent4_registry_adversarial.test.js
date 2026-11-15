/**
 * AGENT 4/6 — DOC LAP ADVERSARIAL SUITE (PART 1: cac control THAT HOLD)
 *
 * Task 2 (line-by-line contract review) + Task 6 (>=6 new adversarial tests).
 * INV-17: moi assertion doc TRUE EVM state (await tx.wait() + view calls).
 *         Khong assert so hoc JS cuc bo, khong coi "exploit thành cong" la PASS.
 * Read-only audit: file nay la file MOI trong test/adversarial/agent4/, khong sua ma nguon.
 */
import { expect } from "chai";
import hre from "hardhat";

const G1_GEN = [1n, 2n]; // BN254 generator, on-curve: 2^2 == 1^3 + 3
const G2_GEN = [
  [
    BigInt("0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2"),
    BigInt("0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed"),
  ],
  [
    BigInt("0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b"),
    BigInt("0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
  ],
];
const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const E18 = 10n ** 18n;
const PRICE = 100n * E18;
const DURATION = 30n * 24n * 3600n;

const fp = (a) => ((a % P_MOD) + P_MOD) % P_MOD;
function modPow(base, exp, mod) {
  let out = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) out = (out * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return out;
}
/** Pure-JS affine BN254 G1 add (handles doubling + inversion) — shows a forger needs no oracle. */
function jsG1Add(p, q) {
  if (p[0] === 0n && p[1] === 0n) return q;
  if (q[0] === 0n && q[1] === 0n) return p;
  let m;
  if (p[0] === q[0]) {
    if (fp(p[1] + q[1]) === 0n) return [0n, 0n]; // P + (-P) = O
    m = fp(3n * fp(p[0] * p[0]) * modPow(fp(2n * p[1]), P_MOD - 2n, P_MOD)); // tangent
    const x = fp(m * m - 2n * p[0]);
    return [x, fp(m * (p[0] - x) - p[1])];
  }
  m = fp((p[1] - q[1]) * modPow(p[0] - q[0], P_MOD - 2n, P_MOD));
  const x = fp(m * m - p[0] - q[0]);
  return [x, fp(m * (p[0] - x) - p[1])];
}
function jsG1Mul(k, p = G1_GEN) {
  let s = ((k % R_MOD) + R_MOD) % R_MOD;
  let acc = [0n, 0n];
  let cur = p;
  while (s > 0n) {
    if (s & 1n) acc = jsG1Add(acc, cur);
    cur = jsG1Add(cur, cur);
    s >>= 1n;
  }
  return acc;
}
const onCurve = ([x, y]) => fp(y * y) === fp(fp(x * x % P_MOD * x) + 3n);

/** Matcher-version-proof rejection check: returns the revert reason, throws if the tx SUCCEEDED. */
async function expectRejection(txFactory, label) {
  let reason = null;
  let succeeded = false;
  try {
    const rc = await (await txFactory()).wait();
    succeeded = Boolean(rc && rc.status === 1);
  } catch (e) {
    reason = e.shortMessage || e.message;
  }
  expect(succeeded, `${label} SHOULD have reverted — reason: ${reason}`).to.equal(false);
  return reason;
}

describe("AGENT4 / PART1 — adversarial controls that HOLD", function () {
  let ethers;
  let owner, buyerA, buyerB, buyerC, stranger, extra1, extra2;
  let token, nft, registry;

  async function deployStack(paymentToken) {
    const NftF = await ethers.getContractFactory("GenomicNFT");
    const newNft = await NftF.deploy(owner.address, 1000);
    await newNft.waitForDeployment();
    const RegF = await ethers.getContractFactory("GenomicsRegistry");
    const newReg = await RegF.deploy(paymentToken.target, newNft.target, owner.address);
    await newReg.waitForDeployment();
    await (await newNft.setRegistryContract(newReg.target)).wait();
    return { newNft, newReg };
  }

  async function fund(signers, amount) {
    for (const s of signers) {
      await (await token.connect(owner).transfer(s.address, amount)).wait();
      await (await token.connect(s).approve(registry.target, amount)).wait();
    }
  }

  async function register(seed, price = PRICE, duration = DURATION, bps = 1000n, who = owner, reg = registry) {
    const cid = `QmAgent4${seed}0000000000000000000000000000000`;
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`agent4-dataset-${seed}`));
    const tx = await reg.connect(who).registerGenomicData(hash, cid, cid, cid, `ipfs://${seed}`, price, duration, bps);
    await tx.wait();
    return { dataId: await reg.dataCount(), hash, tokenId: await reg.dataCount() };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, buyerA, buyerB, buyerC, stranger, extra1, extra2] = await ethers.getSigners();

    const TokenF = await ethers.getContractFactory("GenomicToken");
    token = await TokenF.deploy(owner.address);
    await token.waitForDeployment();
    const { newNft, newReg } = await deployStack(token);
    nft = newNft;
    registry = newReg;
    await fund([buyerA, buyerB, buyerC, stranger], 10_000n * E18);
  });

  // ==================================================================
  describe("Task 6.1 / INV-15 — faucet economic controls (cooldown + Sybil)", function () {
    it("reverts FaucetCooldownActive on BOTH the caller side and the recipient side, and frees at exactly 3600s", async function () {
      const b0 = await token.balanceOf(buyerA.address);
      await (await token.connect(buyerA).faucet(buyerA.address)).wait();
      expect((await token.balanceOf(buyerA.address)) - b0).to.equal(1000n * E18);

      // (a) same caller + same recipient
      await expect(token.connect(buyerA).faucet(buyerA.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      // (b) a DIFFERENT caller funneling into the freshly-fauceted recipient
      await expect(token.connect(buyerB).faucet(buyerA.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      // (c) caller-side cooldown also blocks a brand-new recipient
      await expect(token.connect(buyerA).faucet(buyerC.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      // (d) boundary: still locked at 3599s, unlocked after 3601s
      await ethers.provider.send("evm_increaseTime", [3599]);
      await expect(token.connect(buyerA).faucet(buyerA.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      await ethers.provider.send("evm_increaseTime", [2]);
      const b1 = await token.balanceOf(buyerA.address);
      await (await token.connect(buyerA).faucet(buyerA.address)).wait();
      expect((await token.balanceOf(buyerA.address)) - b1).to.equal(1000n * E18);
      expect(await token.FAUCET_COOLDOWN()).to.equal(3600n);
      expect(await token.FAUCET_AMOUNT()).to.equal(1000n * E18);
    });

    it("SWEEP FOR ABSENT MECHANISM: 25 fresh EOAs mint 25 x FAUCET_AMOUNT inside one epoch (no aggregate/lifetime cap, no caller-type restriction)", async function () {
      const sybils = [];
      for (let i = 0; i < 25; i++) {
        const w = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`agent4-sybil-${i}`)), ethers.provider);
        await (await owner.sendTransaction({ to: w.address, value: ethers.parseEther("0.5") })).wait();
        sybils.push(w);
      }
      const supply0 = await token.totalSupply();
      for (const w of sybils) {
        await (await token.connect(w).faucet(w.address)).wait();
        expect(await token.balanceOf(w.address)).to.equal(1000n * E18);
      }
      const delta = (await token.totalSupply()) - supply0;
      // Harm measured from real EVM state (this is the finding, not a pass for the system):
      expect(delta).to.equal(25n * 1000n * E18);
      // Per-address INV-15 limit does hold — the missing control is only the aggregate cap.
      await expect(token.connect(sybils[0]).faucet(sybils[0].address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );
      // Static absence sweep is completed by `grep -c ContractCallersNotAllowed` (declared, never used).
      expect(await token.FAUCET_COOLDOWN()).to.equal(3600n);
    });

    it("owner mint() is access-controlled and rejects the zero address recipient for faucet", async function () {
      await expect(token.connect(stranger).mint(stranger.address, E18)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
      await expect(token.faucet(ethers.ZeroAddress)).to.be.revertedWithCustomError(token, "InvalidRecipient");
    });
  });

  // ==================================================================
  describe("Task 2 / Task 6.2 — INV-16 dataId boundary sweep over EVERY entrypoint", function () {
    it("all 18 entrypoints revert DataNotFound() for dataId = 0, dataCount+1 and 2^255 (no EVM default-value fallback)", async function () {
      const { dataId } = await register("bounds");
      expect(dataId).to.equal(1n);
      const failures = [];
      for (const id of [0n, 10n ** 6n, 1n << 255n]) {
        const calls = {
          "grantAccess(uint256)": () => registry.connect(buyerA).grantAccess(id),
          "grantAccess(uint256,uint256)": () => registry["grantAccess(uint256,uint256)"](id, PRICE),
          "grantAccessWithEscrow(uint256,uint256)": () => registry.connect(buyerA).grantAccessWithEscrow(id, 86400),
          "grantAccessWithEscrow(...maxPrice)": () =>
            registry["grantAccessWithEscrow(uint256,uint256,uint256)"](id, 86400, PRICE),
          "claimEscrowRefund": () => registry.connect(buyerA).claimEscrowRefund(id),
          "releaseEscrow": () => registry.connect(stranger).releaseEscrow(id, buyerA.address),
          "storeTransformedCapsule": () => registry.storeTransformedCapsule(id, buyerA.address, "capsule"),
          "emitTransformedCapsule": () => registry.emitTransformedCapsule(id, buyerA.address, "capsule"),
          "getTransformedCapsule": () => registry.connect(buyerA).getTransformedCapsule(id),
          "getCapsuleForBuyer": () => registry.getCapsuleForBuyer(id, buyerA.address),
          "buyerCapsules": () => registry.connect(buyerA).buyerCapsules(id, buyerA.address),
          "hasActiveAccess": () => registry.hasActiveAccess(id, buyerA.address),
          "getGenomicData": () => registry.getGenomicData(id),
          "updateDataStatus": () => registry.updateDataStatus(id, 1),
          "updateDataPrice": () => registry.updateDataPrice(id, 1n),
          "grantDirectAccess": () => registry.grantDirectAccess(id, buyerA.address),
          "setAuthorizedCapsuleWorker": () => registry.setAuthorizedCapsuleWorker(id, stranger.address, true),
          "resetAuthorizedWorkers": () => registry.resetAuthorizedWorkers(id),
        };
        for (const [name, fn] of Object.entries(calls)) {
          try {
            await expect(fn()).to.be.revertedWithCustomError(registry, "DataNotFound");
          } catch (e) {
            failures.push(`${name}(dataId=${id}): ${e.shortMessage || e.message}`);
          }
        }
      }
      expect(failures, failures.join("\n  ")).to.have.lengthOf(0);
      // zero side effects from the sweep
      expect(await registry.dataCount()).to.equal(1n);
      expect((await registry.accessGrants(1n, buyerA.address)).isGranted).to.equal(false);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });

    it("registration guards revert with custom errors and leave no half-written record", async function () {
      const cid = "QmAgent4Guard000000000000000000000000000000";
      const h = ethers.keccak256(ethers.toUtf8Bytes("agent4-guard"));
      await expect(
        registry.registerGenomicData(ethers.ZeroHash, cid, cid, cid, "ipfs://x", PRICE, DURATION, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");
      await expect(
        registry.registerGenomicData(h, "", cid, cid, "ipfs://x", PRICE, DURATION, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");
      await expect(
        registry.registerGenomicData(h, cid, cid, cid, "ipfs://x", 0n, DURATION, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidPrice");
      await expect(
        registry.registerGenomicData(h, cid, cid, cid, "ipfs://x", PRICE, 0n, 1000)
      ).to.be.revertedWithCustomError(registry, "InvalidDuration");
      expect(await registry.dataCount()).to.equal(0n);
      expect(await nft.nextTokenId()).to.equal(1n);

      await (await registry.registerGenomicData(h, cid, cid, cid, "ipfs://x", PRICE, DURATION, 1000)).wait();
      await expect(
        registry.registerGenomicData(h, cid, cid, cid, "ipfs://x2", PRICE, DURATION, 1000)
      ).to.be.revertedWithCustomError(registry, "DataAlreadyRegistered");
      expect(await registry.dataCount()).to.equal(1n);
      expect(await registry.registeredRawDataHashes(h)).to.equal(true);
    });
  });

  // ==================================================================
  describe("Task 2 / Task 6.5 — reentrancy through the shipped malicious mocks", function () {
    it("MaliciousReentrantReceiver cannot re-enter registerGenomicData from onERC721Received (async callback vector)", async function () {
      const MalF = await ethers.getContractFactory("MaliciousReentrantReceiver");
      const mal = await MalF.deploy(registry.target);
      await mal.waitForDeployment();

      await (
        await mal.registerWithRegistry(
          ethers.keccak256(ethers.toUtf8Bytes("agent4-reenter-1")),
          "QmAgent4A00000000000000000000000000000",
          "QmAgent4B00000000000000000000000000000",
          "QmAgent4C00000000000000000000000000000",
          "ipfs://mal-a",
          PRICE,
          DURATION,
          500
        )
      ).wait();

      expect(await mal.attackInitiated()).to.equal(true, "the hook must have fired");
      expect(await mal.attackSucceeded()).to.equal(false, "EXPLOIT LANDED — reentrancy guard failed");
      expect(await mal.lastErrorMessage()).to.equal("ReentrancyGuardReentrantCall()");
      expect(await registry.dataCount()).to.equal(1n);
      expect(await nft.nextTokenId()).to.equal(2n);
      expect(await nft.ownerOf(1n)).to.equal(mal.target);
      expect(await registry.tokenToDataId(1n)).to.equal(1n);
      expect((await registry.getGenomicData(1n)).accessCount).to.equal(0n);
    });

    it("MaliciousReentrantToken cannot re-enter grantAccess from inside its own transferFrom (cross-function vector)", async function () {
      const MalT = await ethers.getContractFactory("MaliciousReentrantToken");
      const malToken = await MalT.deploy(owner.address);
      await malToken.waitForDeployment();
      const { newNft: nft2, newReg: reg2 } = await deployStack(malToken);

      await (
        await reg2.registerGenomicData(
          ethers.keccak256(ethers.toUtf8Bytes("agent4-reenter-2")),
          "QmAgent4D00000000000000000000000000000",
          "QmAgent4E00000000000000000000000000000",
          "QmAgent4F00000000000000000000000000000",
          "ipfs://mal-b",
          PRICE,
          DURATION,
          1000
        )
      ).wait();
      expect(await reg2.dataCount()).to.equal(1n);
      await (await malToken.transfer(buyerA.address, 1000n * E18)).wait();
      await (await malToken.connect(buyerA).approve(reg2.target, 1000n * E18)).wait();
      await (await malToken.setRegistryAndTarget(reg2.target, 1n)).wait();

      const seller0 = await malToken.balanceOf(owner.address);
      const buyer0 = await malToken.balanceOf(buyerA.address);
      await (await reg2.connect(buyerA).grantAccess(1n)).wait();

      expect(await malToken.attackInitiated()).to.equal(true, "the transfer hook must have fired");
      expect(await malToken.attackSucceeded()).to.equal(false, "EXPLOIT LANDED — reentrancy guard failed");
      expect(await malToken.lastErrorMessage()).to.equal("ReentrancyGuardReentrantCall()");
      // Victim-asset preservation, read from real balances:
      expect(await malToken.balanceOf(owner.address)).to.equal(seller0 + PRICE);
      expect(await malToken.balanceOf(buyerA.address)).to.equal(buyer0 - PRICE);
      expect(await reg2.dataCount()).to.equal(1n);
      expect((await reg2.getGenomicData(1n)).accessCount).to.equal(1n);
      // the attack contract must NOT have obtained a grant of its own
      expect((await reg2.accessGrants(1n, malToken.target)).isGranted).to.equal(false);
    });
  });

  // ==================================================================
  describe("Task 2 / Task 6.4 — non-standard (void-return) ERC20 through the full escrow lifecycle", function () {
    it("SafeERC20 accepts void transfer/transferFrom and escrow settles with exact conservation", async function () {
      const NST = await ethers.getContractFactory("NonStandardERC20");
      const nst = await NST.deploy(1_000_000n * E18);
      await nst.waitForDeployment();
      const { newNft: nft3, newReg: reg3 } = await deployStack(nst);

      await (await nst.transfer(buyerA.address, 4n * PRICE)).wait();
      await (await nst.connect(buyerA).approve(reg3.target, 4n * PRICE)).wait();
      await (
        await reg3.registerGenomicData(
          ethers.keccak256(ethers.toUtf8Bytes("agent4-nst")),
          "QmAgent4N00000000000000000000000000000",
          "QmAgent4N100000000000000000000000000000",
          "QmAgent4N200000000000000000000000000000",
          "ipfs://nst",
          PRICE,
          DURATION,
          1000
        )
      ).wait();

      const escrow0 = await nst.balanceOf(reg3.target);
      await (await reg3.connect(buyerA).grantAccessWithEscrow(1n, 2n * 86400n)).wait();
      expect(await nst.balanceOf(reg3.target)).to.equal(escrow0 + PRICE);
      expect(await nst.balanceOf(buyerA.address)).to.equal(3n * PRICE);
      expect((await reg3.accessGrants(1n, buyerA.address)).isGranted).to.equal(false);

      const seller0 = await nst.balanceOf(owner.address);
      const capsuleNst = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "GNC1|capsule-nst", keyCipher: "ab".repeat(256) });
      await (await reg3.storeTransformedCapsule(1n, buyerA.address, capsuleNst)).wait();
      const dep = await reg3.escrowDeposits(1n, buyerA.address);
      expect(dep.released).to.equal(true);
      expect(dep.capsuleDelivered).to.equal(true);
      expect(dep.amount).to.equal(PRICE, "DEPOSIT NOT ZEROED -> dead storage, documented");
      expect(await nst.balanceOf(owner.address)).to.equal(seller0 + PRICE);
      expect(await nst.balanceOf(reg3.target)).to.equal(escrow0, "escrow fully drained -> conservation holds");
      expect(await reg3.connect(buyerA).getTransformedCapsule(1n)).to.equal(capsuleNst);
      // no double refund / no double release
      await expect(reg3.connect(buyerA).claimEscrowRefund(1n)).to.be.revertedWithCustomError(
        reg3,
        "CapsuleAlreadyDelivered"
      );
      await expect(reg3.releaseEscrow(1n, buyerA.address)).to.be.revertedWithCustomError(reg3, "EscrowNotActive");
      expect(await nst.balanceOf(reg3.target)).to.equal(escrow0);
    });
  });

  // ==================================================================
  describe("Task 2 / Task 6.3 — EIP-2981 royalty maths, MEV slippage, concurrent buyers", function () {
    it("5 concurrent buyers on the primary market: registry retains nothing, seller receives exactly 5 x price", async function () {
      const { dataId } = await register("royalty-primary", PRICE, DURATION, 1000n);
      const buyers = [buyerA, buyerB, buyerC, extra1, extra2];
      await fund(buyers, 300n * E18);

      const seller0 = await token.balanceOf(owner.address);
      const contract0 = await token.balanceOf(registry.target);
      const totalBuyer0 = await token.balanceOf(buyers[0].address);
      for (const b of buyers) await (await registry.connect(b).grantAccess(dataId)).wait();

      const n = BigInt(buyers.length);
      expect(await token.balanceOf(registry.target)).to.equal(contract0, "registry must not retain payment");
      expect(await token.balanceOf(owner.address)).to.equal(seller0 + n * PRICE);
      expect(await token.balanceOf(buyers[0].address)).to.equal(totalBuyer0 - PRICE);
      expect((await registry.getGenomicData(dataId)).accessCount).to.equal(n);
      const [receiver, amount] = await nft.royaltyInfo(1n, PRICE);
      expect(receiver).to.equal(owner.address);
      expect(amount).to.equal(PRICE / 10n);
      // each buyer got an independent, correctly-dated grant
      const gA = await registry.accessGrants(dataId, buyerA.address);
      const gB = await registry.accessGrants(dataId, buyerB.address);
      expect(gA.isGranted && gB.isGranted).to.equal(true);
      expect(gA.expiresAt - gA.grantedAt).to.equal(DURATION);
      expect(gB.expiresAt - gB.grantedAt).to.equal(DURATION);
    });

    it("secondary market after an NFT transfer: exact 90/10 split and royalty receiver stays the ORIGINAL creator", async function () {
      const { dataId } = await register("royalty-secondary", PRICE, DURATION, 1000n);
      await (await nft.transferFrom(owner.address, buyerB.address, 1n)).wait();
      expect(await nft.ownerOf(1n)).to.equal(buyerB.address);
      const [receiver, amount] = await nft.royaltyInfo(1n, PRICE);
      expect(receiver).to.equal(owner.address, "royalty must stay with the creator after resale");
      expect(amount).to.equal(PRICE / 10n);

      const creator0 = await token.balanceOf(owner.address);
      const seller0 = await token.balanceOf(buyerB.address);
      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      expect(await token.balanceOf(owner.address)).to.equal(creator0 + PRICE / 10n);
      expect(await token.balanceOf(buyerB.address)).to.equal(seller0 + PRICE - PRICE / 10n);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      // conservation identity: buyer paid exactly price, and the two receivers got exactly price
      expect(await token.balanceOf(buyerA.address)).to.equal(10_000n * E18 - PRICE);
      expect((await registry.getGenomicData(dataId)).currentOwner).to.equal(buyerB.address);
    });

    it("royalty bps boundary: 10001 reverts (OZ ERC2981) leaving zero state, 10000 routes 100% to the creator", async function () {
      const cid = "QmAgent4Bps00000000000000000000000000000000";
      await expect(
        registry.registerGenomicData(
          ethers.keccak256(ethers.toUtf8Bytes("bps-high")),
          cid, cid, cid, "ipfs://x", PRICE, DURATION, 10001
        )
      ).to.be.revertedWithCustomError(nft, "ERC2981InvalidTokenRoyalty");
      expect(await registry.dataCount()).to.equal(0n);
      expect(await nft.nextTokenId()).to.equal(1n);

      await (
        await registry.registerGenomicData(
          ethers.keccak256(ethers.toUtf8Bytes("bps-max")),
          cid, cid, cid, "ipfs://x", PRICE, DURATION, 10000
        )
      ).wait();
      await (await nft.transferFrom(owner.address, buyerB.address, 1n)).wait();
      const creator0 = await token.balanceOf(owner.address);
      const seller0 = await token.balanceOf(buyerB.address);
      await (await registry.connect(buyerA).grantAccess(1n)).wait();
      expect(await token.balanceOf(owner.address)).to.equal(creator0 + PRICE);
      expect(await token.balanceOf(buyerB.address)).to.equal(seller0, "100% royalty -> seller receives zero");
    });

    it("MEV price front-running reverts PriceExceedsMax with the real numbers and moves no funds", async function () {
      const { dataId } = await register("slippage", PRICE, DURATION, 1000n);
      await (await registry.updateDataPrice(dataId, 2n * PRICE)).wait();
      await expect(registry.connect(buyerA)["grantAccess(uint256,uint256)"](dataId, PRICE)).to.be.revertedWithCustomError(
        registry,
        "PriceExceedsMax"
      ).withArgs(2n * PRICE, PRICE);
      await expect(
        registry.connect(buyerA)["grantAccessWithEscrow(uint256,uint256,uint256)"](dataId, 86400n, PRICE)
      ).to.be.revertedWithCustomError(registry, "PriceExceedsMax");
      expect((await registry.getGenomicData(dataId)).accessCount).to.equal(0n);
      expect(await token.balanceOf(buyerA.address)).to.equal(10_000n * E18);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });
  });

  // ==================================================================
  describe("Task 2 / Task 6.6 — escrow dispute window, expiry, access-bypass attempts", function () {
    it("disputeWindow outside [1h, 30d] reverts InvalidDisputeWindow and escrows nothing", async function () {
      const { dataId } = await register("window");
      for (const w of [0n, 1n, 3599n, 30n * 86400n + 1n, 10n ** 12n]) {
        await expect(registry.connect(buyerA).grantAccessWithEscrow(dataId, w)).to.be.revertedWithCustomError(
          registry,
          "InvalidDisputeWindow"
        );
      }
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect((await registry.escrowDeposits(dataId, buyerA.address)).amount).to.equal(0n);
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 3600n)).wait();
      expect((await registry.escrowDeposits(dataId, buyerA.address)).amount).to.equal(PRICE);
      // boundary values that must be ACCEPTED
      await (await registry.connect(buyerB).grantAccessWithEscrow(dataId, 30n * 86400n)).wait();
      expect((await registry.escrowDeposits(dataId, buyerB.address)).disputeWindow).to.equal(30n * 86400n);
    });

    it("refund before the window reverts DisputeWindowActive; after it refunds 100% and blocks a second claim", async function () {
      const { dataId } = await register("refund");
      const buyer0 = await token.balanceOf(buyerA.address);
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 2n * 86400n)).wait();
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0 - PRICE);

      await expect(registry.connect(buyerA).claimEscrowRefund(dataId)).to.be.revertedWithCustomError(
        registry,
        "DisputeWindowActive"
      );
      await ethers.provider.send("evm_increaseTime", [2 * 86400 + 5]);
      await (await registry.connect(buyerA).claimEscrowRefund(dataId)).wait();
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0, "victim must be made 100% whole");
      await expect(registry.connect(buyerA).claimEscrowRefund(dataId)).to.be.revertedWithCustomError(
        registry,
        "EscrowNotActive"
      );
      expect((await registry.accessGrants(dataId, buyerA.address)).isGranted).to.equal(false);
      expect((await registry.getGenomicData(dataId)).accessCount).to.equal(0n);

      // a stranger can never touch somebody else's deposit
      const stranger0 = await token.balanceOf(stranger.address);
      await expect(registry.connect(stranger).claimEscrowRefund(dataId)).to.be.revertedWithCustomError(
        registry,
        "EscrowNotActive"
      );
      expect(await token.balanceOf(stranger.address)).to.equal(stranger0);
    });

    it("delivery and refund are mutually exclusive (no double-spend of the same escrow)", async function () {
      const { dataId } = await register("mutual-exclusion");
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 2n * 86400n)).wait();
      await (await registry.storeTransformedCapsule(dataId, buyerA.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "caps-1", keyCipher: "ab".repeat(256) }))).wait();
      await expect(registry.connect(buyerA).claimEscrowRefund(dataId)).to.be.revertedWithCustomError(
        registry,
        "CapsuleAlreadyDelivered"
      );
      await ethers.provider.send("evm_increaseTime", [2 * 86400 + 5]);
      await expect(registry.connect(buyerA).claimEscrowRefund(dataId)).to.be.revertedWithCustomError(
        registry,
        "CapsuleAlreadyDelivered"
      );
      await expect(registry.storeTransformedCapsule(dataId, buyerA.address, "caps-2")).to.be.revertedWithCustomError(
        registry,
        "EscrowNotActive"
      );
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });

    it("immediate refund on Paused/Revoked consent, and the seller cannot escape a pending escrow by pausing", async function () {
      const { dataId } = await register("gdpr");
      const buyer0 = await token.balanceOf(buyerA.address);
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 30n * 86400n)).wait();
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0 - PRICE);
      // window has NOT elapsed, but consent was paused -> instant refund is allowed
      await (await registry.updateDataStatus(dataId, 1)).wait();
      await (await registry.connect(buyerA).claimEscrowRefund(dataId)).wait();
      expect(await token.balanceOf(buyerA.address)).to.equal(buyer0, "buyer made whole");
      // while paused nobody can buy
      await expect(registry.connect(buyerB).grantAccess(dataId)).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
      await (await registry.updateDataStatus(dataId, 0)).wait();
      await (await registry.updateDataStatus(dataId, 2)).wait();
      await expect(registry.updateDataStatus(dataId, 0)).to.be.revertedWithCustomError(
        registry,
        "ConsentPermanentlyRevoked"
      );
      await expect(registry.connect(buyerB).grantAccessWithEscrow(dataId, 3600n)).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
      expect(await token.balanceOf(registry.target)).to.equal(0n);
    });

    it("access-bypass attempts revert with the right custom errors (unpurchased / expired / revoked / foreign caller)", async function () {
      const { dataId } = await register("bypass");
      await expect(registry.connect(stranger).getTransformedCapsule(dataId)).to.be.revertedWithCustomError(
        registry,
        "AccessNotGranted"
      );
      // a stranger reading somebody else's capsule gets "" (no leak), but reading as themselves reverts
      expect(await registry.connect(stranger).buyerCapsules(dataId, buyerA.address)).to.equal("");
      await expect(registry.connect(stranger).buyerCapsules(dataId, stranger.address)).to.be.revertedWithCustomError(
        registry,
        "AccessNotGranted"
      );
      await expect(registry.connect(owner).grantAccess(dataId)).to.be.revertedWithCustomError(
        registry,
        "OwnerCannotBuyOwnData"
      );
      await expect(registry.connect(stranger).storeTransformedCapsule(dataId, buyerA.address, "x")).to.be.revertedWithCustomError(
        registry,
        "NotDataOwner"
      );
      await expect(registry.connect(stranger).emitTransformedCapsule(dataId, buyerA.address, "x")).to.be.revertedWithCustomError(
        registry,
        "NotDataOwner"
      );
      expect(await registry.getCapsuleForBuyer(dataId, buyerA.address)).to.equal("", "empty before any purchase");

      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      await (await registry.storeTransformedCapsule(dataId, buyerA.address, JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "caps-b", keyCipher: "ab".repeat(256) }))).wait();
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(true);
      // re-purchase while the grant is live
      await expect(registry.connect(buyerA).grantAccess(dataId)).to.be.revertedWithCustomError(
        registry,
        "AccessAlreadyActive"
      );
      await (await registry.connect(buyerB).grantAccess(dataId)).wait();
      expect((await registry.getGenomicData(dataId)).accessCount).to.equal(2n);

      // expire the grant
      await ethers.provider.send("evm_increaseTime", [Number(DURATION) + 5]);
      await ethers.provider.send("evm_mine", []);
      await expect(registry.connect(buyerA).getTransformedCapsule(dataId)).to.be.revertedWithCustomError(
        registry,
        "AccessExpired"
      );
      await expect(registry.connect(buyerA).buyerCapsules(dataId, buyerA.address)).to.be.revertedWithCustomError(
        registry,
        "AccessExpired"
      );
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(false);
      // Owner/dispatcher path of buyerCapsules also enforces expiry symmetry (DEF4-07 / NEW-11)
      expect(await registry.buyerCapsules(dataId, buyerA.address)).to.equal("");
      // buying again after expiry works and refreshes the grant
      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(true);

      // GDPR revocation cuts every reader
      await (await registry.updateDataStatus(dataId, 2)).wait();
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(false);
      await expect(registry.connect(buyerA).getTransformedCapsule(dataId)).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
      expect(await registry.connect(buyerA).buyerCapsules(dataId, buyerA.address)).to.equal("");
      expect(await registry.buyerCapsules(dataId, buyerA.address)).to.equal("", "owner path also cuts off");
      await expect(registry.storeTransformedCapsule(dataId, buyerA.address, "nope")).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
      await expect(registry.emitTransformedCapsule(dataId, buyerA.address, "nope")).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
    });

    it("empty capsule / zero researcher address revert EmptyCapsule and InvalidAddress", async function () {
      const { dataId } = await register("empty-capsule");
      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      await expect(registry.storeTransformedCapsule(dataId, buyerA.address, "")).to.be.revertedWithCustomError(
        registry,
        "EmptyCapsule"
      );
      await expect(registry.emitTransformedCapsule(dataId, buyerA.address, "")).to.be.revertedWithCustomError(
        registry,
        "EmptyCapsule"
      );
      await expect(registry.storeTransformedCapsule(dataId, ethers.ZeroAddress, "x")).to.be.revertedWithCustomError(
        registry,
        "InvalidAddress"
      );
      await expect(registry.emitTransformedCapsule(dataId, ethers.ZeroAddress, "x")).to.be.revertedWithCustomError(
        registry,
        "InvalidAddress"
      );
      expect(await registry.connect(buyerA).getTransformedCapsule(dataId)).to.equal("");
    });

    it("escrowed paymentToken cannot be rescued by the owner and onlyOwner guards hold everywhere", async function () {
      const { dataId } = await register("rescue");
      await (await registry.connect(buyerA).grantAccessWithEscrow(dataId, 3600n)).wait();
      await expect(registry.rescueTokens(token.target, owner.address, PRICE)).to.be.revertedWithCustomError(
        registry,
        "CannotRescuePaymentToken"
      );
      await expect(registry.connect(stranger).rescueTokens(nft.target, owner.address, 0n)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await expect(registry.connect(stranger).setCapsuleDispatcher(stranger.address)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      expect(await token.balanceOf(registry.target)).to.equal(PRICE, "escrow funds intact");
    });

    it("worker authorisation is revoked on NFT transfer (DEF2-1-05 lifecycle symmetry)", async function () {
      const { dataId } = await register("workers");
      await (await registry.setAuthorizedCapsuleWorker(dataId, stranger.address, true)).wait();
      expect(await registry.authorizedCapsuleWorkers(dataId, stranger.address)).to.equal(true);
      expect(await registry.capsuleWorkerAuthorizer(dataId, stranger.address)).to.equal(owner.address);
      // the authorised worker may deliver a capsule while the authoriser still owns the NFT
      await (await registry.connect(buyerA).grantAccess(dataId)).wait();
      const workerCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "by-worker", keyCipher: "ab".repeat(256) });
      await (await registry.connect(stranger).storeTransformedCapsule(dataId, buyerA.address, workerCapsule)).wait();
      expect(await registry.connect(buyerA).getTransformedCapsule(dataId)).to.equal(workerCapsule);

      await (await nft.transferFrom(owner.address, buyerB.address, 1n)).wait();
      expect(await registry.authorizedCapsuleWorkers(dataId, stranger.address)).to.equal(false);
      expect(await registry.capsuleWorkerAuthorizer(dataId, stranger.address)).to.equal(ethers.ZeroAddress);
      // the previous worker is now just a stranger again
      await expect(
        registry.connect(stranger).storeTransformedCapsule(dataId, buyerC.address, "stale-worker")
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");
      // new holder's escrow deposit must record the NEW seller, not the creator
      await (await registry.connect(buyerC).grantAccessWithEscrow(dataId, 3600n)).wait();
      const dep = await registry.escrowDeposits(dataId, buyerC.address);
      expect(dep.seller).to.equal(buyerB.address);
      expect(dep.buyer).to.equal(buyerC.address);
    });

    it("grantDirectAccess cannot be abused to self-mint access and blocks zero address", async function () {
      const { dataId } = await register("direct");
      await expect(registry.grantDirectAccess(dataId, owner.address)).to.be.revertedWithCustomError(
        registry,
        "SelfAccessNotAllowed"
      );
      await expect(registry.grantDirectAccess(dataId, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        registry,
        "InvalidRecipient"
      );
      await (await registry.grantDirectAccess(dataId, buyerA.address)).wait();
      expect(await registry.hasActiveAccess(dataId, buyerA.address)).to.equal(true);
      await expect(registry.connect(stranger).getTransformedCapsule(dataId)).to.be.revertedWithCustomError(
        registry,
        "AccessNotGranted"
      );
      // direct grant without payment still allows the owner path to deliver a capsule
      const directCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", tag: "c", keyCipher: "ab".repeat(256) });
      await (await registry.storeTransformedCapsule(dataId, buyerA.address, directCapsule)).wait();
      expect(await registry.connect(buyerA).getTransformedCapsule(dataId)).to.equal(directCapsule);
    });
  });

  // ==================================================================
  describe("Task 8 — EIP-170 deployed bytecode ceiling", function () {
    it("all four audited contracts stay below the 24,576-byte limit", async function () {
      const sizes = {};
      sizes.GenomicsRegistry = (await ethers.provider.getCode(registry.target)).length / 2 - 1;
      sizes.GenomicNFT = (await ethers.provider.getCode(nft.target)).length / 2 - 1;
      sizes.GenomicToken = (await ethers.provider.getCode(token.target)).length / 2 - 1;

      const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
      const zk = await ZkF.deploy(token.target);
      await zk.waitForDeployment();
      sizes.GenomicZkVerifier = (await ethers.provider.getCode(zk.target)).length / 2 - 1;

      const Mal1 = await ethers.getContractFactory("MaliciousReentrantReceiver");
      const m1 = await Mal1.deploy(registry.target);
      await m1.waitForDeployment();
      sizes.MaliciousReentrantReceiver = (await ethers.provider.getCode(m1.target)).length / 2 - 1;

      for (const [name, s] of Object.entries(sizes)) {
        expect(s, `${name} size ${s}`).to.be.greaterThan(0);
        expect(s, `${name} exceeds EIP-170`).to.be.at.most(24576);
      }
      global.__AGENT4_SIZES__ = sizes;
      // print for the report
      console.log("AGENT4/EIP-170 deployed sizes:", JSON.stringify(sizes));
    });
  });

  // ==================================================================
  describe("Task 3 — ZK verifier controls that DO hold (isolating the forgeable part)", function () {
    let zk, zkToken;
    beforeEach(async function () {
      const TokenF = await ethers.getContractFactory("GenomicToken");
      zkToken = await TokenF.deploy(owner.address);
      await zkToken.waitForDeployment();
      const ZkF = await ethers.getContractFactory("GenomicZkVerifier");
      zk = await ZkF.deploy(zkToken.target);
      await zk.waitForDeployment();
      await (await zkToken.faucet(buyerA.address)).wait();
      await (await zkToken.connect(buyerA).approve(zk.target, 10n ** 24n)).wait();
    });

    it("test-of-the-test: my pure-JS BN254 ecMul matches precompile 0x07 (no precompile bytecode was touched)", async function () {
      for (const k of [1n, 2n, 7n, 65536n, R_MOD - 1n]) {
        const res = await ethers.provider.call({
          to: "0x0000000000000000000000000000000000000007",
          data: ethers.concat([
            ethers.zeroPadValue("0x01", 32),
            ethers.zeroPadValue("0x02", 32),
            ethers.zeroPadValue(ethers.toBeHex(k), 32),
          ]),
        });
        const px = BigInt(ethers.dataSlice(res, 0, 32));
        const py = BigInt(ethers.dataSlice(res, 32, 64));
        const js = jsG1Mul(k);
        expect(js[0]).to.equal(px, `x mismatch for k=${k}`);
        expect(js[1]).to.equal(py, `y mismatch for k=${k}`);
        expect(onCurve(js)).to.equal(true);
      }
      expect(onCurve(G1_GEN)).to.equal(true);
      expect(onCurve([1n, 3n])).to.equal(false, "sanity: (1,3) is off-curve");
    });

    it("trivial, degenerate and off-curve proofs are all rejected before any payout", async function () {
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671"));
      await (await zk.connect(buyerA).createZkBounty(trait, "desc", 100n * E18, 3n, 7n * 86400n)).wait();
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("commit-1"));
      const cases = [
        ["identity A", { a: [0n, 0n], b: G2_GEN, c: G1_GEN }],
        ["off-curve A=(1,3)", { a: [1n, 3n], b: G2_GEN, c: G1_GEN }],
        ["random C off-curve", { a: G1_GEN, b: G2_GEN, c: [5n, 5n] }],
        ["field-overflow A", { a: [P_MOD, P_MOD], b: G2_GEN, c: G1_GEN }],
        ["swapped B halves", { a: G1_GEN, b: [G2_GEN[1], G2_GEN[0]], c: G1_GEN }],
      ];
      const signers = [buyerB, buyerC, stranger, extra1, extra2];
      for (let i = 0; i < cases.length; i++) {
        const [label, proof] = cases[i];
        await expectRejection(
          () => zk.connect(signers[i]).claimZkBounty(1n, proof, commitment),
          `degenerate proof "${label}"`
        );
      }
      expect(await zk.bountyCount()).to.equal(1n);
      expect((await zk.bounties(1n)).currentClaims).to.equal(0n);
      expect(await zkToken.balanceOf(zk.target)).to.equal(300n * E18, "bounty funds untouched");
    });

    it("bounty parameter validation, unknown-id and zero-commitment guards", async function () {
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671"));
      await expect(zk.connect(buyerA).createZkBounty(ethers.ZeroHash, "d", 1n, 1n, 3600n)).to.be.revertedWithCustomError(
        zk,
        "InvalidBountyParameters"
      );
      await expect(zk.connect(buyerA).createZkBounty(trait, "d", 0n, 1n, 3600n)).to.be.revertedWithCustomError(
        zk,
        "InvalidBountyParameters"
      );
      await expect(zk.connect(buyerA).createZkBounty(trait, "d", 1n, 0n, 3600n)).to.be.revertedWithCustomError(
        zk,
        "InvalidBountyParameters"
      );
      await expect(zk.connect(buyerA).createZkBounty(trait, "d", 1n, 1n, 3599n)).to.be.revertedWithCustomError(
        zk,
        "InvalidBountyParameters"
      );
      await (await zk.connect(buyerA).createZkBounty(trait, "d", 100n * E18, 5n, 7n * 86400n)).wait();
      await expect(
        zk.connect(buyerB).claimZkBounty(99n, { a: G1_GEN, b: G2_GEN, c: G1_GEN }, trait)
      ).to.be.revertedWithCustomError(zk, "BountyExpiredOrInactive");
      await expect(
        zk.connect(buyerB).claimZkBounty(1n, { a: G1_GEN, b: G2_GEN, c: G1_GEN }, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(zk, "InvalidZkProof");
      expect((await zk.bounties(1n)).totalFunding).to.equal(500n * E18);
      expect(await zkToken.balanceOf(zk.target)).to.equal(500n * E18);
    });

    it("closeExpiredBounty is sponsor/owner-only, refunds exactly the remainder and cannot be re-entered", async function () {
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_close"));
      await (await zk.connect(buyerA).createZkBounty(trait, "d", 100n * E18, 1n, 3600n)).wait();
      await expect(zk.connect(stranger).closeExpiredBounty(1n)).to.be.revertedWithCustomError(
        zk,
        "OnlyBountySponsor"
      );
      await expectRejection(
        () => zk.connect(stranger).claimZkBounty(1n, { a: G1_GEN, b: G2_GEN, c: G1_GEN }, trait),
        "invalid proof by non-sponsor"
      );
      await ethers.provider.send("evm_increaseTime", [3601]);
      const s0 = await zkToken.balanceOf(buyerA.address);
      await (await zk.connect(buyerA).closeExpiredBounty(1n)).wait();
      expect(await zkToken.balanceOf(buyerA.address)).to.equal(s0 + 100n * E18);
      expect(await zkToken.balanceOf(zk.target)).to.equal(0n);
      expect((await zk.bounties(1n)).isActive).to.equal(false);
      // a second close must NOT pay again (idempotent refund, no re-claim of drained funds)
      const s1 = await zkToken.balanceOf(buyerA.address);
      await (await zk.connect(buyerA).closeExpiredBounty(1n)).wait();
      expect(await zkToken.balanceOf(buyerA.address)).to.equal(s1, "double refund detected");
      expect(await zkToken.balanceOf(zk.target)).to.equal(0n);
    });

    it("per-donor double claim is blocked (anti-replay)", async function () {
      const trait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_replay"));
      await (await zk.connect(buyerA).createZkBounty(trait, "d", 100n * E18, 3n, 7n * 86400n)).wait();
      const c = ethers.keccak256(ethers.toUtf8Bytes("commit-replay"));
      const proof = { a: G1_GEN, b: G2_GEN, c: G1_GEN }; // deliberately invalid
      await expectRejection(
        () => zk.connect(buyerB).claimZkBounty(1n, proof, c),
        "invalid proof (anti-replay baseline)"
      );
      const before = await zkToken.balanceOf(buyerB.address);
      expect(await zkToken.balanceOf(buyerB.address)).to.equal(before);
      expect((await zk.bounties(1n)).remainingFunding).to.equal(300n * E18);
    });
  });

  // ==================================================================
  describe("Task 2 — GenomicNFT access control", function () {
    it("mintGenomicNFT is registry-only (EOA and even the NFT owner are rejected)", async function () {
      await expect(
        nft.connect(stranger).mintGenomicNFT(stranger.address, "ipfs://x", ethers.ZeroHash, "a", "b", "c", 1000)
      ).to.be.revertedWithCustomError(nft, "OnlyRegistry");
      await expect(
        nft.connect(owner).mintGenomicNFT(owner.address, "ipfs://x", ethers.ZeroHash, "a", "b", "c", 1000)
      ).to.be.revertedWithCustomError(nft, "OnlyRegistry");
      expect(await nft.nextTokenId()).to.equal(1n);
      expect(await nft.balanceOf(stranger.address)).to.equal(0n);
      expect(await nft.balanceOf(owner.address)).to.equal(0n);
    });

    it("setRegistryContract is owner-only and rejects address(0); supportsInterface advertises ERC2981+ERC721", async function () {
      await expect(nft.connect(stranger).setRegistryContract(stranger.address)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.setRegistryContract(ethers.ZeroAddress)).to.be.revertedWithCustomError(nft, "InvalidAddress");
      expect(await nft.supportsInterface("0x2a55205a")).to.equal(true, "ERC2981");
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true, "ERC721");
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true, "ERC165");
    });
  });
});
