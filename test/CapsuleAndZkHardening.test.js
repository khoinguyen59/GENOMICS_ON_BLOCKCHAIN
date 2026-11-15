import crypto from "node:crypto";
import { expect } from "chai";
import hre from "hardhat";
import {
  encryptGenomicData,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  decryptGenomicPayload,
} from "../crypto/client_crypto.js";

describe("Protocol Hardening: Canonical Key Capsule Validation, ZK Epoch Isolation & G2 Subgroup Checks", function () {
  let ethers;
  let token, nft, registry, zkVerifier;
  let owner, seller, buyer, buyer2, donor1, donor2, attacker;

  const PRICE = 100n * 10n ** 18n;
  const ACCESS_DURATION = 30 * 86400;
  const DISPUTE_WINDOW = 86400;
  const ROYALTY_BPS = 1000;

  const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const VALID_SUMMARY_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const VALID_METADATA_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const VALID_TOKEN_URI = "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";

  const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  // Authentic BN254 G2 Generator in EIP-197 canonical encoding: [[x_im, x_re], [y_im, y_re]]
  const G2_POINTS = [
    [
      BigInt("0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2"),
      BigInt("0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed"),
    ],
    [
      BigInt("0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b"),
      BigInt("0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
    ],
  ];

  const makeValidCapsule = (tag = "v2", hexLen = 512) =>
    JSON.stringify({
      version: "GENO-ASYM-RSA-OAEP-v2",
      tag,
      keyCipher: "ab".repeat(hexLen / 2),
    });

  const MALFORMED_CAPSULES = [
    ["tiny string 'cap'", "cap"],
    ["tiny string 'kk'", "kk"],
    ["plain garbage string", "NOT-A-REAL-CAPSULE"],
    ["short keyCipher JSON", '{"keyCipher":"deadbeef"}'],
    ["non-hex 512-char keyCipher JSON", '{"keyCipher":"' + "zz".repeat(256) + '"}'],
    ["raw non-JSON 600-char string", "x".repeat(600)],
  ];

  // ---------------------------------------------------------------------------
  // BN254 Fp / Fp2 & Groth16 Ceremony Helpers
  // ---------------------------------------------------------------------------
  let ceremony;
  let cachedNonSubgroupTwistPoint = null;

  function modPow(base, exp, mod) {
    let result = 1n;
    let b = ((base % mod) + mod) % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
    }
    return result;
  }

  function modInv(a, mod) {
    return modPow(a, mod - 2n, mod);
  }

  function randomScalar() {
    let v = 0n;
    while (v <= 1n || v >= R_MOD) {
      v = BigInt("0x" + crypto.randomBytes(31).toString("hex")) % R_MOD;
    }
    return v;
  }

  // BN254 Fp2 = Fp[u] / (u^2 + 1), elements stored internally as [re, im]
  const fpAdd = (a, b) => (a + b) % P_MOD;
  const fpSub = (a, b) => ((a - b) % P_MOD + P_MOD) % P_MOD;
  const fpMul = (a, b) => (a * b) % P_MOD;
  const fpInv = (a) => modPow(a, P_MOD - 2n, P_MOD);

  const fp2Add = (a, b) => [fpAdd(a[0], b[0]), fpAdd(a[1], b[1])];
  const fp2Sub = (a, b) => [fpSub(a[0], b[0]), fpSub(a[1], b[1])];
  const fp2Mul = (a, b) => [
    fpSub(fpMul(a[0], b[0]), fpMul(a[1], b[1])),
    fpAdd(fpMul(a[0], b[1]), fpMul(a[1], b[0])),
  ];
  const fp2Sq = (a) => fp2Mul(a, a);
  const fp2Inv = (a) => {
    const denom = fpAdd(fpMul(a[0], a[0]), fpMul(a[1], a[1]));
    const invD = fpInv(denom);
    return [fpMul(a[0], invD), fpSub(0n, fpMul(a[1], invD))];
  };
  const fp2Pow = (base, exp) => {
    let res = [1n, 0n];
    let cur = base;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) res = fp2Mul(res, cur);
      cur = fp2Sq(cur);
      e >>= 1n;
    }
    return res;
  };

  function fp2Sqrt(z) {
    const p2 = P_MOD * P_MOD;
    let q = p2 - 1n;
    let s = 0n;
    while ((q & 1n) === 0n) {
      q >>= 1n;
      s += 1n;
    }
    let nonRes = [1n, 1n];
    while (true) {
      const leg = fp2Pow(nonRes, (p2 - 1n) >> 1n);
      if (leg[0] !== 1n || leg[1] !== 0n) break;
      nonRes = [nonRes[0] + 1n, nonRes[1]];
    }
    let m = s;
    let c = fp2Pow(nonRes, q);
    let t = fp2Pow(z, q);
    let rVal = fp2Pow(z, (q + 1n) >> 1n);
    while (t[0] !== 1n || t[1] !== 0n) {
      let i = 1n;
      let tt = fp2Sq(t);
      while (tt[0] !== 1n || tt[1] !== 0n) {
        tt = fp2Sq(tt);
        i += 1n;
        if (i >= m) return null;
      }
      let b = c;
      for (let k = 0n; k < m - i - 1n; k++) b = fp2Sq(b);
      m = i;
      c = fp2Sq(b);
      t = fp2Mul(t, c);
      rVal = fp2Mul(rVal, b);
    }
    return rVal;
  }

  function g2Add(p1, p2) {
    if (!p1) return p2;
    if (!p2) return p1;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    let lam;
    if (x1[0] === x2[0] && x1[1] === x2[1]) {
      const ySum = fp2Add(y1, y2);
      if (ySum[0] === 0n && ySum[1] === 0n) return null;
      lam = fp2Mul(fp2Mul([3n, 0n], fp2Sq(x1)), fp2Inv(fp2Add(y1, y1)));
    } else {
      lam = fp2Mul(fp2Sub(y2, y1), fp2Inv(fp2Sub(x2, x1)));
    }
    const x3 = fp2Sub(fp2Sub(fp2Sq(lam), x1), x2);
    const y3 = fp2Sub(fp2Mul(lam, fp2Sub(x1, x3)), y1);
    return [x3, y3];
  }

  function g2ScalarMul(pt, scalar) {
    let cur = pt;
    let res = null;
    let k = scalar;
    while (k > 0n) {
      if (k & 1n) res = g2Add(res, cur);
      cur = g2Add(cur, cur);
      k >>= 1n;
    }
    return res;
  }

  function g2MulEip197(scalar) {
    const genInternal = [
      [G2_POINTS[0][1], G2_POINTS[0][0]],
      [G2_POINTS[1][1], G2_POINTS[1][0]],
    ];
    const res = g2ScalarMul(genInternal, ((scalar % R_MOD) + R_MOD) % R_MOD);
    return [
      [res[0][1], res[0][0]],
      [res[1][1], res[1][0]],
    ];
  }

  function findNonSubgroupOnCurveTwistPoint() {
    if (cachedNonSubgroupTwistPoint) return cachedNonSubgroupTwistPoint;
    const bTwist = fp2Mul([3n, 0n], fp2Inv([9n, 1n]));
    for (let c = 1n; c < 50n; c++) {
      const x = [c, 1n]; // x = c + u in Fp2
      const rhs = fp2Add(fp2Mul(x, fp2Sq(x)), bTwist);
      const y = fp2Sqrt(rhs);
      if (!y) continue;
      const lhs = fp2Sq(y);
      if (lhs[0] !== rhs[0] || lhs[1] !== rhs[1]) continue;
      const pt = [x, y];
      if (g2ScalarMul(pt, R_MOD) !== null) {
        cachedNonSubgroupTwistPoint = {
          internal: pt,
          bTwist,
          eip197: [
            [x[1], x[0]],
            [y[1], y[0]],
          ],
        };
        return cachedNonSubgroupTwistPoint;
      }
    }
    throw new Error("Failed to locate non-subgroup BN254 twist curve point");
  }

  async function ecMulG1(scalar) {
    const input = ethers.concat([
      ethers.zeroPadValue("0x01", 32),
      ethers.zeroPadValue("0x02", 32),
      ethers.zeroPadValue(ethers.toBeHex(((scalar % R_MOD) + R_MOD) % R_MOD), 32),
    ]);
    const res = await ethers.provider.call({
      to: "0x0000000000000000000000000000000000000007",
      data: input,
    });
    return [BigInt(ethers.dataSlice(res, 0, 32)), BigInt(ethers.dataSlice(res, 32, 64))];
  }

  async function configureEphemeralTestCeremony(targetVerifier = zkVerifier) {
    const alphaS = randomScalar();
    const betaS = randomScalar();
    let gammaS = randomScalar();
    while (gammaS === betaS) gammaS = randomScalar();
    let deltaS = randomScalar();
    while (deltaS === betaS || deltaS === gammaS) deltaS = randomScalar();
    const ic0S = randomScalar();
    const ic1S = randomScalar();

    const alphaG1 = await ecMulG1(alphaS);
    const betaG2 = g2MulEip197(betaS);
    const gammaG2 = g2MulEip197(gammaS);
    const deltaG2 = g2MulEip197(deltaS);
    const ic0G1 = await ecMulG1(ic0S);
    const ic1G1 = await ecMulG1(ic1S);

    await (
      await targetVerifier
        .connect(owner)
        .setupVerificationKey(alphaG1, betaG2, gammaG2, deltaG2, ic0G1, ic1G1)
    ).wait();

    ceremony = { alphaS, betaS, gammaS, deltaS, ic0S, ic1S };
    return { alphaG1, betaG2, gammaG2, deltaG2, ic0G1, ic1G1 };
  }

  async function createAuthenticZkProof(donorAddress, traitId, commitment, cScalar = 1n) {
    const packed = ethers.solidityPacked(
      ["bytes32", "bytes32", "address"],
      [commitment, traitId, donorAddress]
    );
    const publicSignal = BigInt(ethers.keccak256(packed)) % R_MOD;

    const bScalar = randomScalar();
    const bPoint = g2MulEip197(bScalar);
    const cPoint = await ecMulG1(cScalar);

    const vkXScalar = (ceremony.ic0S + publicSignal * ceremony.ic1S) % R_MOD;
    const rhs =
      (ceremony.alphaS * ceremony.betaS +
        vkXScalar * ceremony.gammaS +
        cScalar * ceremony.deltaS) %
      R_MOD;
    const aScalar = (rhs * modInv(bScalar, R_MOD)) % R_MOD;
    const aPoint = await ecMulG1(aScalar);

    return { a: aPoint, b: bPoint, c: cPoint };
  }

  async function registerSampleDataset(seed = "HARDENING_DS") {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
    await (
      await registry.connect(seller).registerGenomicData(
        hash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      )
    ).wait();
    return await registry.dataCount();
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, seller, buyer, buyer2, donor1, donor2, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("GenomicToken");
    token = await Token.deploy(owner.address);
    await token.waitForDeployment();

    const Nft = await ethers.getContractFactory("GenomicNFT");
    nft = await Nft.deploy(owner.address, ROYALTY_BPS);
    await nft.waitForDeployment();

    const Registry = await ethers.getContractFactory("GenomicsRegistry");
    registry = await Registry.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();
    await (await nft.connect(owner).setRegistryContract(registry.target)).wait();

    const ZkVerifier = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkVerifier.deploy(token.target);
    await zkVerifier.waitForDeployment();

    for (const acct of [buyer, buyer2, attacker]) {
      await (await token.connect(owner).transfer(acct.address, 1000n * 10n ** 18n)).wait();
      await (await token.connect(acct).approve(registry.target, 1000n * 10n ** 18n)).wait();
      await (await token.connect(acct).approve(zkVerifier.target, 1000n * 10n ** 18n)).wait();
    }
  });

  // ===========================================================================
  // 1. Malformed Capsule Rejection (Escrow Path)
  // ===========================================================================
  describe("1. Malformed Capsule Rejection (Escrow Path)", function () {
    it("rejects all malformed capsules on BOTH storeTransformedCapsule and emitTransformedCapsule, keeps escrow & preserves refund", async function () {
      const dataId = await registerSampleDataset("ESCROW_MALFORMED");
      const buyerBefore = await token.balanceOf(buyer.address);

      await (await registry.connect(buyer).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      expect(await token.balanceOf(registry.target)).to.equal(PRICE);

      for (const [label, badCapsule] of MALFORMED_CAPSULES) {
        await expect(
          registry.connect(seller).storeTransformedCapsule(dataId, buyer.address, badCapsule),
          `storeTransformedCapsule accepted malformed capsule (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");

        await expect(
          registry.connect(seller).emitTransformedCapsule(dataId, buyer.address, badCapsule),
          `emitTransformedCapsule accepted malformed capsule (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");
      }

      const dep = await registry.escrowDeposits(dataId, buyer.address);
      expect(dep.released).to.equal(false);
      expect(dep.capsuleDelivered).to.equal(false);
      expect(dep.refunded).to.equal(false);
      expect(dep.amount).to.equal(PRICE);

      const grant = await registry.accessGrants(dataId, buyer.address);
      expect(grant.isGranted).to.equal(false);

      await expect(
        registry.connect(buyer).getTransformedCapsule.staticCall(dataId)
      ).to.be.revertedWithCustomError(registry, "AccessNotGranted");

      expect(await token.balanceOf(registry.target)).to.equal(PRICE);

      // Advance past dispute window and confirm 100% escrow refund succeeds
      await ethers.provider.send("evm_increaseTime", [DISPUTE_WINDOW + 10]);
      await ethers.provider.send("evm_mine", []);

      await (await registry.connect(buyer).claimEscrowRefund(dataId)).wait();
      expect(await token.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect((await registry.escrowDeposits(dataId, buyer.address)).refunded).to.equal(true);
    });
  });

  // ===========================================================================
  // 2. Malformed Capsule Rejection (Direct / Paid Grant Path)
  // ===========================================================================
  describe("2. Malformed Capsule Rejection (Direct & Paid Grant Paths)", function () {
    it("rejects malformed capsules under grantAccess(dataId) and leaves capsule views empty", async function () {
      const dataId = await registerSampleDataset("PAID_MALFORMED");
      await (await registry.connect(buyer).grantAccess(dataId)).wait();

      for (const [label, badCapsule] of MALFORMED_CAPSULES) {
        await expect(
          registry.connect(seller).storeTransformedCapsule(dataId, buyer.address, badCapsule),
          `storeTransformedCapsule under grantAccess accepted (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");

        await expect(
          registry.connect(seller).emitTransformedCapsule(dataId, buyer.address, badCapsule),
          `emitTransformedCapsule under grantAccess accepted (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");
      }

      expect(await registry.connect(buyer).getTransformedCapsule.staticCall(dataId)).to.equal("");
      expect(await registry.connect(buyer).buyerCapsules.staticCall(dataId, buyer.address)).to.equal("");
      expect(await registry.connect(seller).buyerCapsules.staticCall(dataId, buyer.address)).to.equal("");
    });

    it("rejects malformed capsules under grantDirectAccess(dataId, buyer) and leaves capsule views empty", async function () {
      const dataId = await registerSampleDataset("DIRECT_MALFORMED");
      await (await registry.connect(seller).grantDirectAccess(dataId, buyer2.address)).wait();

      for (const [label, badCapsule] of MALFORMED_CAPSULES) {
        await expect(
          registry.connect(seller).storeTransformedCapsule(dataId, buyer2.address, badCapsule),
          `storeTransformedCapsule under grantDirectAccess accepted (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");

        await expect(
          registry.connect(seller).emitTransformedCapsule(dataId, buyer2.address, badCapsule),
          `emitTransformedCapsule under grantDirectAccess accepted (${label})`
        ).to.be.revertedWithCustomError(registry, "InvalidCapsuleFormat");
      }

      expect(await registry.connect(buyer2).getTransformedCapsule.staticCall(dataId)).to.equal("");
      expect(await registry.connect(buyer2).buyerCapsules.staticCall(dataId, buyer2.address)).to.equal("");
      expect(await registry.connect(seller).buyerCapsules.staticCall(dataId, buyer2.address)).to.equal("");
    });
  });

  // ===========================================================================
  // 3. Real Crypto Acceptance (RSA-OAEP 2048 via packageKeyCapsule & 4096-bit 1024-hex)
  // ===========================================================================
  describe("3. Real Crypto Acceptance", function () {
    const SAMPLE_VCF = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA\t100\tPASS\tDP=60\n";

    it("accepts real packageKeyCapsule() RSA-OAEP capsules on BOTH storeTransformedCapsule and emitTransformedCapsule and releases escrow cleanly", async function () {
      const enc = await encryptGenomicData(SAMPLE_VCF);
      const hash = enc.rawDataHash;
      await (
        await registry.connect(seller).registerGenomicData(
          hash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS
        )
      ).wait();
      const dataId = await registry.dataCount();

      // Buyer 1: escrow + storeTransformedCapsule with real Web Crypto RSA-OAEP 2048 capsule
      const kp1 = await generateAsymmetricKeyPair(false);
      const pubJwk1 = await exportPublicKey(kp1.publicKey);
      const realCapsule1 = await packageKeyCapsule(enc.keyHex, pubJwk1, buyer.address, seller.address);

      await (await registry.connect(buyer).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      const sellerBefore1 = await token.balanceOf(seller.address);

      await (await registry.connect(seller).storeTransformedCapsule(dataId, buyer.address, realCapsule1)).wait();

      expect(await token.balanceOf(seller.address) - sellerBefore1).to.equal(PRICE);
      expect(await token.balanceOf(registry.target)).to.equal(0n);

      const dep1 = await registry.escrowDeposits(dataId, buyer.address);
      expect(dep1.released).to.equal(true);
      expect(dep1.capsuleDelivered).to.equal(true);

      const fetched1 = await registry.connect(buyer).getTransformedCapsule.staticCall(dataId);
      expect(fetched1).to.equal(realCapsule1);
      const decKey1 = await decryptKeyCapsule(fetched1, kp1.privateKey);
      expect(await decryptGenomicPayload(enc.payload, decKey1.keyHex)).to.equal(SAMPLE_VCF);

      // Buyer 2: escrow + emitTransformedCapsule with real Web Crypto RSA-OAEP 2048 capsule
      const kp2 = await generateAsymmetricKeyPair(false);
      const pubJwk2 = await exportPublicKey(kp2.publicKey);
      const realCapsule2 = await packageKeyCapsule(enc.keyHex, pubJwk2, buyer2.address, seller.address);

      await (await registry.connect(buyer2).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      const sellerBefore2 = await token.balanceOf(seller.address);

      await expect(
        registry.connect(seller).emitTransformedCapsule(dataId, buyer2.address, realCapsule2)
      )
        .to.emit(registry, "CapsuleStored")
        .withArgs(dataId, buyer2.address, realCapsule2);

      expect(await token.balanceOf(seller.address) - sellerBefore2).to.equal(PRICE);
      expect(await token.balanceOf(registry.target)).to.equal(0n);

      const dep2 = await registry.escrowDeposits(dataId, buyer2.address);
      expect(dep2.released).to.equal(true);
      expect(dep2.capsuleDelivered).to.equal(true);

      const fetched2 = await registry.connect(buyer2).getTransformedCapsule.staticCall(dataId);
      expect(fetched2).to.equal(realCapsule2);
      expect(await registry.connect(buyer2).buyerCapsules.staticCall(dataId, buyer2.address)).to.equal(realCapsule2);
      const decKey2 = await decryptKeyCapsule(fetched2, kp2.privateKey);
      expect(await decryptGenomicPayload(enc.payload, decKey2.keyHex)).to.equal(SAMPLE_VCF);
    });

    it("accepts valid 1024-hex (4096-bit) JSON capsules on both storeTransformedCapsule and emitTransformedCapsule", async function () {
      const dataId = await registerSampleDataset("VALID_1024_HEX");
      const capsule4096Store = makeValidCapsule("rsa4096-store", 1024);
      const capsule4096Emit = makeValidCapsule("rsa4096-emit", 1024);

      await (await registry.connect(buyer).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      await (await registry.connect(seller).storeTransformedCapsule(dataId, buyer.address, capsule4096Store)).wait();
      expect((await registry.escrowDeposits(dataId, buyer.address)).released).to.equal(true);
      expect(await registry.connect(buyer).getTransformedCapsule.staticCall(dataId)).to.equal(capsule4096Store);

      await (await registry.connect(buyer2).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      await (await registry.connect(seller).emitTransformedCapsule(dataId, buyer2.address, capsule4096Emit)).wait();
      expect((await registry.escrowDeposits(dataId, buyer2.address)).released).to.equal(true);
      expect(await registry.connect(buyer2).getTransformedCapsule.staticCall(dataId)).to.equal(capsule4096Emit);
      expect(await registry.connect(buyer2).buyerCapsules.staticCall(dataId, buyer2.address)).to.equal(capsule4096Emit);
    });
  });

  // ===========================================================================
  // 4. ZK Verification Key Epoch Isolation (vkEpoch)
  // ===========================================================================
  describe("4. ZK Verification Key Epoch Isolation (vkEpoch)", function () {
    it("isolates verified commitments per vkEpoch and invalidates pre-rotation proofs until re-proven under the new VK", async function () {
      expect(typeof zkVerifier.vkEpoch, "vkEpoch() must be exposed on GenomicZkVerifier").to.equal("function");
      expect(
        typeof zkVerifier.hasVerifiedTraitVariant,
        "hasVerifiedTraitVariant() must be exposed on GenomicZkVerifier"
      ).to.equal("function");

      await configureEphemeralTestCeremony(zkVerifier);
      const epoch0 = await zkVerifier.vkEpoch();

      const traitId = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_EPOCH_ISOLATION_WITNESS"));
      const reward = ethers.parseEther("50");

      await (
        await zkVerifier.connect(buyer).createZkBounty(traitId, "Epoch Isolation Study 1", reward, 2, 86400)
      ).wait();

      const proofEpoch0 = await createAuthenticZkProof(donor1.address, traitId, commitment);
      await (await zkVerifier.connect(donor1).claimZkBounty(1n, proofEpoch0, commitment)).wait();

      expect(await zkVerifier.hasVerifiedVariant(commitment, donor1.address)).to.equal(true);
      expect(await zkVerifier.verifiedCommitments(commitment, donor1.address)).to.equal(true);
      expect(await zkVerifier.hasVerifiedTraitVariant(traitId, commitment, donor1.address)).to.equal(true);

      // Rotate the Verification Key via a fresh ceremony
      await configureEphemeralTestCeremony(zkVerifier);
      const epoch1 = await zkVerifier.vkEpoch();
      expect(epoch1).to.equal(epoch0 + 1n);

      // All pre-rotation verification records MUST now report false
      expect(await zkVerifier.hasVerifiedVariant(commitment, donor1.address)).to.equal(false);
      expect(await zkVerifier.verifiedCommitments(commitment, donor1.address)).to.equal(false);
      expect(await zkVerifier.hasVerifiedTraitVariant(traitId, commitment, donor1.address)).to.equal(false);

      // Create a second bounty to test replay rejection and re-proving under new VK
      await (
        await zkVerifier.connect(buyer).createZkBounty(traitId, "Epoch Isolation Study 2", reward, 2, 86400)
      ).wait();

      // Pre-rotation proof MUST fail under the rotated VK
      await expect(
        zkVerifier.connect(donor1).claimZkBounty(2n, proofEpoch0, commitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidZkProof");

      // Re-prove using the new ceremony VK
      const proofEpoch1 = await createAuthenticZkProof(donor1.address, traitId, commitment);
      await (await zkVerifier.connect(donor1).claimZkBounty(2n, proofEpoch1, commitment)).wait();

      expect(await zkVerifier.hasVerifiedVariant(commitment, donor1.address)).to.equal(true);
      expect(await zkVerifier.verifiedCommitments(commitment, donor1.address)).to.equal(true);
      expect(await zkVerifier.hasVerifiedTraitVariant(traitId, commitment, donor1.address)).to.equal(true);
    });
  });

  // ===========================================================================
  // 5. ZK Trait-Scoped Commitment Query (hasVerifiedTraitVariant)
  // ===========================================================================
  describe("5. ZK Trait-Scoped Commitment Query (hasVerifiedTraitVariant)", function () {
    it("binds verified commitments strictly to the proven traitId and returns false for distinct traitIds", async function () {
      expect(
        typeof zkVerifier.hasVerifiedTraitVariant,
        "hasVerifiedTraitVariant() must be exposed on GenomicZkVerifier"
      ).to.equal("function");

      await configureEphemeralTestCeremony(zkVerifier);

      const provenTraitId = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671_A_heterozygous"));
      const otherTraitId = ethers.keccak256(ethers.toUtf8Bytes("BRCA1_185delAG_pathogenic"));
      const thirdTraitId = ethers.keccak256(ethers.toUtf8Bytes("APOE_rs429358_e4"));
      const commitment = ethers.keccak256(ethers.toUtf8Bytes("DONOR1_TRAIT_SCOPED_WITNESS"));
      const reward = ethers.parseEther("40");

      await (
        await zkVerifier.connect(buyer).createZkBounty(provenTraitId, "ALDH2 Cohort", reward, 2, 86400)
      ).wait();

      expect(await zkVerifier.hasVerifiedTraitVariant(provenTraitId, commitment, donor1.address)).to.equal(false);

      const proof = await createAuthenticZkProof(donor1.address, provenTraitId, commitment);
      await (await zkVerifier.connect(donor1).claimZkBounty(1n, proof, commitment)).wait();

      expect(await zkVerifier.hasVerifiedTraitVariant(provenTraitId, commitment, donor1.address)).to.equal(true);
      expect(await zkVerifier.hasVerifiedTraitVariant(otherTraitId, commitment, donor1.address)).to.equal(false);
      expect(await zkVerifier.hasVerifiedTraitVariant(thirdTraitId, commitment, donor1.address)).to.equal(false);
      expect(await zkVerifier.hasVerifiedTraitVariant(ethers.ZeroHash, commitment, donor1.address)).to.equal(false);
      expect(await zkVerifier.hasVerifiedTraitVariant(provenTraitId, commitment, donor2.address)).to.equal(false);
    });
  });

  // ===========================================================================
  // 6. G2 Subgroup Check in setupVerificationKey
  // ===========================================================================
  describe("6. G2 Subgroup Check in setupVerificationKey", function () {
    it("rejects an authentic on-curve BN254 twist point Q NOT in G2[r] in _beta, _gamma, or _delta with InvalidCurvePoint", async function () {
      const { internal: qInternal, bTwist, eip197: qEip197 } = findNonSubgroupOnCurveTwistPoint();

      // Verify mathematically in Fp2 that Q lies on E'(Fp2): y^2 = x^3 + 3/(9+u)
      const lhs = fp2Sq(qInternal[1]);
      const rhs = fp2Add(fp2Mul(qInternal[0], fp2Sq(qInternal[0])), bTwist);
      expect(lhs).to.deep.equal(rhs);

      // Verify mathematically that [r]Q != infinity, proving Q is NOT in G2[r]
      expect(g2ScalarMul(qInternal, R_MOD)).to.not.equal(null);

      // Ensure valid distinct G2 points for the remaining two G2 parameters
      const alphaG1 = await ecMulG1(randomScalar());
      const ic0G1 = await ecMulG1(randomScalar());
      const ic1G1 = await ecMulG1(randomScalar());
      const g2a = g2MulEip197(11n);
      const g2b = g2MulEip197(13n);
      const g2c = g2MulEip197(17n);

      // Confirm Q does not collide with g2a, g2b, g2c
      expect(qEip197).to.not.deep.equal(g2a);
      expect(qEip197).to.not.deep.equal(g2b);
      expect(qEip197).to.not.deep.equal(g2c);

      await expect(
        zkVerifier.connect(owner).setupVerificationKey(alphaG1, qEip197, g2b, g2c, ic0G1, ic1G1)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");

      await expect(
        zkVerifier.connect(owner).setupVerificationKey(alphaG1, g2a, qEip197, g2c, ic0G1, ic1G1)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");

      await expect(
        zkVerifier.connect(owner).setupVerificationKey(alphaG1, g2a, g2b, qEip197, ic0G1, ic1G1)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");
    });
  });
});
