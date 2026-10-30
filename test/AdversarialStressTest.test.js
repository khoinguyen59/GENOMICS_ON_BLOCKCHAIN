import { expect } from "chai";
import hre from "hardhat";
import {
  encryptGenomicData,
  decryptGenomicPayload,
  generateAsymmetricKeyPair,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash,
  exportPublicKey,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  createWalletKeyBackup,
  restoreWalletKeyBackup,
} from "../crypto/client_crypto.js";

describe("Adversarial Stress Testing & Edge Cases Audit (Genomics on Blockchain)", function () {
  let ethers;
  let token, nft, registry;
  let owner, researcher1, researcher2, attacker;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, researcher1, researcher2, attacker] = await ethers.getSigners();

    const GenomicToken = await ethers.getContractFactory("GenomicToken");
    token = await GenomicToken.deploy(owner.address);
    await token.waitForDeployment();

    const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
    nft = await GenomicNFT.deploy(owner.address, 1000); // 10% default
    await nft.waitForDeployment();

    const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
    registry = await GenomicsRegistry.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();

    await nft.setRegistryContract(registry.target);
  });

  describe("1. Token Faucet Boundary & Cooldown Edge Cases", function () {
    it("Should revert if faucet is called with address(0)", async function () {
      await expect(token.faucet(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        token,
        "InvalidRecipient"
      );
    });

    it("Should strictly enforce 1-hour cooldown down to the exact second", async function () {
      await token.faucet(researcher1.address);
      const initialBal = await token.balanceOf(researcher1.address);
      expect(initialBal).to.equal(ethers.parseUnits("1000", 18));

      // 1. Revert when trying again immediately
      await expect(token.faucet(researcher1.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );

      // 2. Advance time to 3590 seconds (10s before 1 hour)
      await ethers.provider.send("evm_increaseTime", [3590]);
      await ethers.provider.send("evm_mine", []);

      await expect(token.faucet(researcher1.address)).to.be.revertedWithCustomError(
        token,
        "FaucetCooldownActive"
      );

      // 3. Advance time past 3600 seconds
      await ethers.provider.send("evm_increaseTime", [20]);
      await ethers.provider.send("evm_mine", []);

      await token.faucet(researcher1.address);
      const secondBal = await token.balanceOf(researcher1.address);
      expect(secondBal).to.equal(ethers.parseUnits("2000", 18));
    });
  });

  describe("2. Smart Contract Edge Cases & Boundary Conditions", function () {
    let dummyHash, rawCid, summaryCid, metaCid;

    beforeEach(function () {
      dummyHash = ethers.keccak256(ethers.toUtf8Bytes("SAMPLE_DNA_1"));
      rawCid = "QmZz9LPTymAgzXaac8L3CWJuuyN7pHLzajeL1mM5VC4eAb";
      summaryCid = "QmfNmxRqDBfYmrEvnJZdcQoT77Jydy4rCg8YA1MUYL1aEX";
      metaCid = "QmSXYnPw5QWejV3FwtWKs78dimHrEVYbHdTWSNNYvAqxAC";
    });

    it("Should support 0% royalty without reverting", async function () {
      const price = ethers.parseUnits("100", 18);
      await registry.registerGenomicData(
        dummyHash,
        rawCid,
        summaryCid,
        metaCid,
        "ipfs://test",
        price,
        86400,
        0 // 0% royalty
      );

      await token.faucet(researcher1.address);
      await token.connect(researcher1).approve(registry.target, price);

      const ownerBefore = await token.balanceOf(owner.address);
      await registry.connect(researcher1).grantAccess(1);
      const ownerAfter = await token.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(price);
    });

    it("Should support 100% royalty (10000 bps) without reverting", async function () {
      const price = ethers.parseUnits("50", 18);
      await registry.registerGenomicData(
        dummyHash,
        rawCid,
        summaryCid,
        metaCid,
        "ipfs://test",
        price,
        86400,
        10000 // 100% royalty
      );

      await token.faucet(researcher1.address);
      await token.connect(researcher1).approve(registry.target, price);

      const ownerBefore = await token.balanceOf(owner.address);
      await registry.connect(researcher1).grantAccess(1);
      const ownerAfter = await token.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(price);
    });

    it("Should revert if royaltyBps exceeds 100% (> 10000 bps)", async function () {
      await expect(
        registry.registerGenomicData(
          dummyHash,
          rawCid,
          summaryCid,
          metaCid,
          "ipfs://test",
          ethers.parseUnits("10", 18),
          86400,
          10001 // > 10000
        )
      ).to.be.rejected;
    });

    it("Should handle 1 wei price without precision underflow", async function () {
      await registry.registerGenomicData(
        dummyHash,
        rawCid,
        summaryCid,
        metaCid,
        "ipfs://test",
        1n, // 1 wei
        86400,
        1000 // 10%
      );

      await token.faucet(researcher1.address);
      await token.connect(researcher1).approve(registry.target, 1n);

      await expect(registry.connect(researcher1).grantAccess(1)).to.not.be.rejected;
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.true;
    });

    it("Should expire access grant after duration and allow re-purchase (renewal)", async function () {
      const price = ethers.parseUnits("100", 18);
      const duration = 3600; // 1 hour

      await registry.registerGenomicData(
        dummyHash,
        rawCid,
        summaryCid,
        metaCid,
        "ipfs://test",
        price,
        duration,
        1000
      );

      await token.faucet(researcher1.address);
      await token.connect(researcher1).approve(registry.target, price * 2n);

      // 1. Initial purchase
      await registry.connect(researcher1).grantAccess(1);
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.true;

      // Cannot buy again while active
      await expect(registry.connect(researcher1).grantAccess(1)).to.be.revertedWithCustomError(
        registry,
        "AccessAlreadyActive"
      );

      // 2. Fast forward past expiration (3601s)
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Has access is now false
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.false;

      // 3. Renewal: should succeed now that previous grant has expired
      await expect(registry.connect(researcher1).grantAccess(1)).to.not.be.rejected;
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.true;
    });

    it("Should immediately suspend access if dataset is paused, and restore when active", async function () {
      const price = ethers.parseUnits("100", 18);
      await registry.registerGenomicData(
        dummyHash,
        rawCid,
        summaryCid,
        metaCid,
        "ipfs://test",
        price,
        86400,
        1000
      );

      // Owner grants direct access
      await registry.grantDirectAccess(1, researcher1.address);
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.true;

      // Owner pauses dataset (1 = Paused)
      await registry.updateDataStatus(1, 1);
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.false;

      // Owner unpauses dataset (0 = Active)
      await registry.updateDataStatus(1, 0);
      expect(await registry.hasActiveAccess(1, researcher1.address)).to.be.true;
    });

    it("Should correctly handle out-of-bounds pagination gracefully", async function () {
      // Register 3 datasets with unique data hashes
      for (let i = 1; i <= 3; i++) {
        const uniqueHash = ethers.keccak256(ethers.toUtf8Bytes(`pagination_dataset_${i}`));
        await registry.registerGenomicData(
          uniqueHash,
          rawCid,
          summaryCid,
          metaCid,
          `ipfs://test${i}`,
          ethers.parseUnits("10", 18),
          86400,
          1000
        );
      }

      // Offset beyond count (offset = 10, total = 3)
      const [emptyItems, total1] = await registry.getDataItemsPaginated(10, 5);
      expect(emptyItems.length).to.equal(0);
      expect(total1).to.equal(3);

      // Limit = 0
      const [zeroItems, total2] = await registry.getDataItemsPaginated(0, 0);
      expect(zeroItems.length).to.equal(0);
      expect(total2).to.equal(3);

      // Fetch slice (offset = 1, limit = 2)
      const [slice, total3] = await registry.getDataItemsPaginated(1, 2);
      expect(slice.length).to.equal(2);
      expect(total3).to.equal(3);
      expect(slice[0].dataId).to.equal(2);
      expect(slice[1].dataId).to.equal(3);
    });
  });

  describe("3. Cryptographic Fault Injection & Tamper Resistance", function () {
    it("Should fail decryption if ciphertext is tampered by 1 bit (AES-GCM Auth Tag Failure)", async function () {
      const sampleVcf = "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\nchr17\t43044295\trs80357906\tG\tA";
      const enc = await encryptGenomicData(sampleVcf);

      const decryptedOriginal = await decryptGenomicPayload(enc.payload, enc.keyHex);
      expect(decryptedOriginal).to.equal(sampleVcf);

      // Tamper: Flip 1 byte in ciphertext
      const tamperedPayload = new Uint8Array(enc.payload);
      tamperedPayload[tamperedPayload.length - 1] ^= 0x01;

      const tamperedHash = await computeDataHash(tamperedPayload);
      expect(tamperedHash).to.not.equal(enc.rawDataHash);

      let decryptionFailed = false;
      try {
        await decryptGenomicPayload(tamperedPayload, enc.keyHex);
      } catch (err) {
        decryptionFailed = true;
      }
      expect(decryptionFailed).to.be.true;
    });

    it("Should fail capsule unwrap if wrong RSA private key is used", async function () {
      const kp1 = await generateAsymmetricKeyPair(true);
      const kp2 = await generateAsymmetricKeyPair(true);

      const jwk1 = await exportPublicKey(kp1.publicKey);
      const testSecretKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const capsule = await packageKeyCapsule(testSecretKey, jwk1, researcher1.address, owner.address);

      const recovered = await decryptKeyCapsule(capsule, kp1.privateKey);
      expect(recovered.keyHex).to.equal(testSecretKey);

      let failed = false;
      try {
        await decryptKeyCapsule(capsule, kp2.privateKey);
      } catch (e) {
        failed = true;
      }
      expect(failed).to.be.true;
    });
  });

  describe("4. Deflationary Tokenomics: ERC20Burnable Anti-Inflation", function () {
    it("Should allow token holder to burn tokens and reduce total supply", async function () {
      await token.faucet(researcher1.address);
      const balBefore = await token.balanceOf(researcher1.address);
      const supplyBefore = await token.totalSupply();

      const burnAmount = ethers.parseUnits("300", 18);
      await token.connect(researcher1).burn(burnAmount);

      const balAfter = await token.balanceOf(researcher1.address);
      const supplyAfter = await token.totalSupply();

      expect(balAfter).to.equal(balBefore - burnAmount);
      expect(supplyAfter).to.equal(supplyBefore - burnAmount);
    });

    it("Should revert if burning more than balance", async function () {
      await token.faucet(researcher1.address);
      const excessiveAmount = ethers.parseUnits("5000", 18);
      await expect(token.connect(researcher1).burn(excessiveAmount)).to.be.revertedWithCustomError(
        token,
        "ERC20InsufficientBalance"
      );
    });
  });

  describe("5. Access-Controlled buyerCapsules Query Verification", function () {
    it("Should return stored capsule to data owner, dispatcher, or the granted buyer, but empty to unauthorized third party", async function () {
      const dummyHash = ethers.keccak256(ethers.toUtf8Bytes("SAMPLE_DNA_CAPSULE"));
      const price = ethers.parseUnits("50", 18);
      await registry.registerGenomicData(
        dummyHash,
        "QmZz9LPTymAgzXaac8L3CWJuuyN7pHLzajeL1mM5VC4eAb",
        "QmfNmxRqDBfYmrEvnJZdcQoT77Jydy4rCg8YA1MUYL1aEX",
        "QmSXYnPw5QWejV3FwtWKs78dimHrEVYbHdTWSNNYvAqxAC",
        "ipfs://test",
        price,
        86400,
        1000
      );

      // Buy access
      await token.faucet(researcher1.address);
      await token.connect(researcher1).approve(registry.target, price);
      await registry.connect(researcher1).grantAccess(1);

      // Store capsule
      const sampleCapsule = '{"version":"GENO-ASYM-RSA-OAEP-v2","keyCipher":"abcdef"}';
      await registry.connect(owner).storeTransformedCapsule(1, researcher1.address, sampleCapsule);

      // 1. Data owner can query
      const capOwner = await registry.connect(owner).buyerCapsules(1, researcher1.address);
      expect(capOwner).to.equal(sampleCapsule);

      // 2. Buyer can query
      const capBuyer = await registry.connect(researcher1).buyerCapsules(1, researcher1.address);
      expect(capBuyer).to.equal(sampleCapsule);

      // 3. Unauthorized third party gets empty string
      const capAttacker = await registry.connect(attacker).buyerCapsules(1, researcher1.address);
      expect(capAttacker).to.equal("");
    });
  });

  describe("6. Big Data GA4GH Crypt4GH Chunked Encryption & Decryption", function () {
    it("Should encrypt large genomic sequences in discrete 64KB authenticated chunks and decrypt losslessly", async function () {
      // Create a 150KB simulated genomic sequence (exceeds single 64KB block)
      const baseLine = "chr12\t111803962\trs671\tG\tA\tPASS\tANN=ALDH2|c.1510G>A\n";
      const repeats = Math.ceil((150 * 1024) / baseLine.length);
      const largeVcf = baseLine.repeat(repeats);

      let progressCount = 0;
      const progressTracker = (fraction, processed, total) => {
        progressCount++;
        expect(fraction).to.be.at.least(0);
        expect(fraction).to.be.at.most(1);
      };

      // Encrypt with 64KB chunks
      const encResult = await encryptGenomicDataChunked(largeVcf, {
        chunkSize: 64 * 1024,
        onProgress: progressTracker,
      });

      expect(encResult.chunkCount).to.equal(3);
      expect(encResult.totalPlaintextSize).to.equal(largeVcf.length);
      expect(encResult.payload.length).to.be.greaterThan(largeVcf.length);
      expect(progressCount).to.be.greaterThan(0);

      // Decrypt chunked payload
      const decryptedVcf = await decryptGenomicDataChunked(encResult.payload, encResult.keyHex, {
        asString: true,
      });

      expect(decryptedVcf.length).to.equal(largeVcf.length);
      expect(decryptedVcf).to.equal(largeVcf);
    });
  });

  describe("7. Wallet Signature Deterministic Key Backup & Recovery", function () {
    it("Should export encrypted key backup signed with wallet, and restore without data loss", async function () {
      const originalKeyPair = await generateAsymmetricKeyPair(true);
      const pubJwkBefore = await exportPublicKey(originalKeyPair.publicKey);

      // Create backup using researcher1's ethers signer
      const backupJson = await createWalletKeyBackup(researcher1, researcher1.address, originalKeyPair);
      const parsedBackup = JSON.parse(backupJson);
      expect(parsedBackup.version).to.equal("GENO-WALLET-BACKUP-v1");
      expect(parsedBackup.account).to.equal(researcher1.address.toLowerCase());

      // Restore backup using researcher1's ethers signer
      const restoredKeyPair = await restoreWalletKeyBackup(researcher1, researcher1.address, backupJson);
      const pubJwkAfter = await exportPublicKey(restoredKeyPair.publicKey);
      expect(pubJwkAfter).to.equal(pubJwkBefore);

      // Verify that restored key can actually decrypt a real key capsule
      const testSecretKey = "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef";
      const capsule = await packageKeyCapsule(testSecretKey, pubJwkAfter, researcher1.address, owner.address);

      const recovered = await decryptKeyCapsule(capsule, restoredKeyPair.privateKey);
      expect(recovered.keyHex).to.equal(testSecretKey);
    });

    it("Should reject restore if backup belongs to a different wallet address", async function () {
      const originalKeyPair = await generateAsymmetricKeyPair(true);
      const backupJson = await createWalletKeyBackup(researcher1, researcher1.address, originalKeyPair);

      // Attempt to restore with attacker's signer
      await expect(
        restoreWalletKeyBackup(attacker, attacker.address, backupJson)
      ).to.be.rejectedWith("Backup does not match current wallet address.");
    });
  });
});

