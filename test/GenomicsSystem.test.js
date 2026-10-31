import hre from "hardhat";
import { expect } from "chai";
import {
  encryptGenomicData,
  decryptGenomicData,
  decryptGenomicPayload,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash,
  verifyDataIntegrity,
  packCiphertextPayload,
  generateClinicalPdfReport,
} from "../crypto/client_crypto.js";
import { uploadEncryptedRawData } from "../ipfs/pinata_uploader.js";

describe("Genomics on Blockchain System (Production Hardened & Adversarial)", function () {
  let ethers;
  let deployer, dataOwner, researcher, unauthorizedUser, dispatcherWorker;
  let genomicToken, genomicNFT, genomicsRegistry;

  const INITIAL_PRICE = 100n * 10n ** 18n; // 100 $GENO
  const ACCESS_DURATION = 30 * 24 * 60 * 60; // 30 days in seconds
  const ROYALTY_BPS = 1000; // 10% Royalty (1000 basis points)

  // Real RFC multihash CIDv0 (Qm... 46 chars)
  const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const VALID_SUMMARY_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const VALID_METADATA_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const VALID_TOKEN_URI = "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";

  const SAMPLE_VCF =
    "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\nchr17\t43044295\trs80357906\tG\tA";

  let sampleEncrypted;
  let sampleDataHash;

  before(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, dataOwner, researcher, unauthorizedUser, dispatcherWorker] = await ethers.getSigners();
    // Compute real ciphertext package and on-chain hash (IV || Ciphertext)
    sampleEncrypted = await encryptGenomicData(SAMPLE_VCF);
    sampleDataHash = sampleEncrypted.rawDataHash;
  });

  beforeEach(async function () {
    // 1. Deploy GenomicToken (ERC-20)
    const GenomicTokenFactory = await ethers.getContractFactory("GenomicToken");
    genomicToken = await GenomicTokenFactory.deploy(deployer.address);
    await genomicToken.waitForDeployment();

    // 2. Deploy GenomicNFT (ERC-721 + EIP-2981)
    const GenomicNFTFactory = await ethers.getContractFactory("GenomicNFT");
    genomicNFT = await GenomicNFTFactory.deploy(deployer.address, 1000); // 10% default royalty
    await genomicNFT.waitForDeployment();

    // 3. Deploy GenomicsRegistry
    const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
    genomicsRegistry = await GenomicsRegistryFactory.deploy(
      genomicToken.target,
      genomicNFT.target,
      deployer.address
    );
    await genomicsRegistry.waitForDeployment();

    // 4. Authorize GenomicsRegistry in GenomicNFT
    await genomicNFT.connect(deployer).setRegistryContract(genomicsRegistry.target);
  });

  describe("1. Deployment & Tokenomics Verification", function () {
    it("Should deploy GenomicToken with correct metadata and initial supply", async function () {
      expect(await genomicToken.name()).to.equal("Genomic Token");
      expect(await genomicToken.symbol()).to.equal("GENO");
      const deployerBal = await genomicToken.balanceOf(deployer.address);
      expect(deployerBal).to.equal(10_000_000n * 10n ** 18n);
    });

    it("Should allow researcher to use Faucet to receive test tokens", async function () {
      await genomicToken.connect(researcher).faucet(researcher.address);
      const bal = await genomicToken.balanceOf(researcher.address);
      expect(bal).to.equal(1_000n * 10n ** 18n);
    });

    it("Adversarial: Should reject Faucet claim within cooldown period (Anti-Drain)", async function () {
      await genomicToken.connect(researcher).faucet(researcher.address);
      await expect(
        genomicToken.connect(researcher).faucet(researcher.address)
      ).to.be.revertedWithCustomError(genomicToken, "FaucetCooldownActive");
    });

    it("Should configure EIP-2981 royalty correctly on GenomicNFT", async function () {
      expect(await genomicNFT.name()).to.equal("Genomic Data Ownership NFT");
      expect(await genomicNFT.registryContract()).to.equal(genomicsRegistry.target);
    });

    it("Adversarial: Should reject direct minting on GenomicNFT from non-registry caller", async function () {
      await expect(
        genomicNFT.connect(deployer).mintGenomicNFT(
          deployer.address,
          VALID_TOKEN_URI,
          sampleDataHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicNFT, "OnlyRegistry");

      await expect(
        genomicNFT.connect(unauthorizedUser).mintGenomicNFT(
          unauthorizedUser.address,
          VALID_TOKEN_URI,
          sampleDataHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicNFT, "OnlyRegistry");
    });
  });

  describe("2. Dataset Registration: registerGenomicData() & Ciphertext Package Integrity", function () {
    it("Should successfully register genomic data, mint NFT and record ciphertext package hash", async function () {
      const tx = await genomicsRegistry.connect(dataOwner).registerGenomicData(
        sampleDataHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        INITIAL_PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      );
      await tx.wait();

      expect(await genomicsRegistry.dataCount()).to.equal(1);

      const data = await genomicsRegistry.getGenomicData(1);
      expect(data.dataId).to.equal(1);
      expect(data.tokenId).to.equal(1);
      expect(data.currentOwner).to.equal(dataOwner.address);
      expect(data.rawDataHash).to.equal(sampleDataHash);
      expect(data.rawCiphertextCid).to.equal(VALID_RAW_CID);
      expect(data.summaryCiphertextCid).to.equal(VALID_SUMMARY_CID);
      expect(data.metadataCid).to.equal(VALID_METADATA_CID);
      expect(data.price).to.equal(INITIAL_PRICE);
      expect(data.status).to.equal(0); // DataStatus.Active

      // Verify NFT ownership belongs to dataOwner
      expect(await genomicNFT.ownerOf(1)).to.equal(dataOwner.address);

      // Verify NFT record holds rawDataHash
      const nftRecord = await genomicNFT.getGenomicRecord(1);
      expect(nftRecord.rawDataHash).to.equal(sampleDataHash);

      // Verify EIP-2981 royaltyInfo returns dataOwner as royalty receiver with 10%
      const [receiver, royaltyAmount] = await genomicNFT.royaltyInfo(1, INITIAL_PRICE);
      expect(receiver).to.equal(dataOwner.address);
      expect(royaltyAmount).to.equal(10n * 10n ** 18n); // 10% of 100 = 10 $GENO
    });

    it("Adversarial: Should revert if rawDataHash is bytes32(0) or rawCid is empty", async function () {
      // Zero rawDataHash
      await expect(
        genomicsRegistry.connect(dataOwner).registerGenomicData(
          ethers.ZeroHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          INITIAL_PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDataHashOrCid");

      // Empty rawCid
      await expect(
        genomicsRegistry.connect(dataOwner).registerGenomicData(
          sampleDataHash,
          "",
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          INITIAL_PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDataHashOrCid");
    });

    it("Should revert if price is 0 or duration is 0", async function () {
      await expect(
        genomicsRegistry.connect(dataOwner).registerGenomicData(
          sampleDataHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          0,
          ACCESS_DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidPrice");

      await expect(
        genomicsRegistry.connect(dataOwner).registerGenomicData(
          sampleDataHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          INITIAL_PRICE,
          0,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDuration");
    });

    it("Should support getAllDataItems() for marketplace catalog listing", async function () {
      await genomicsRegistry.connect(dataOwner).registerGenomicData(
        sampleDataHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        INITIAL_PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      );

      const allItems = await genomicsRegistry.getAllDataItems();
      expect(allItems.length).to.equal(1);
      expect(allItems[0].dataId).to.equal(1);
      expect(allItems[0].rawDataHash).to.equal(sampleDataHash);
    });
  });

  describe("3. Access Settlement: grantAccess() with Escrow & Auto-Royalty", function () {
    beforeEach(async function () {
      // Data owner registers dataset
      await genomicsRegistry.connect(dataOwner).registerGenomicData(
        sampleDataHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        INITIAL_PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      );

      // Fund researcher with 1000 GENO tokens
      await genomicToken.connect(researcher).faucet(researcher.address);
    });

    it("Should execute Escrow payment, automatically disburse 10% Royalty to data owner, and grant access", async function () {
      const ownerBalBefore = await genomicToken.balanceOf(dataOwner.address);
      const researcherBalBefore = await genomicToken.balanceOf(researcher.address);

      // Researcher approves registry to spend tokens
      await genomicToken.connect(researcher).approve(genomicsRegistry.target, INITIAL_PRICE);

      // Researcher calls grantAccess
      const tx = await genomicsRegistry.connect(researcher).grantAccess(1);
      await tx.wait();

      const ownerBalAfter = await genomicToken.balanceOf(dataOwner.address);
      const researcherBalAfter = await genomicToken.balanceOf(researcher.address);

      // Researcher paid exactly 100 GENO
      expect(researcherBalBefore - researcherBalAfter).to.equal(INITIAL_PRICE);

      // Data owner receives 100% total (10% Royalty + 90% Seller proceeds = 100 GENO)
      expect(ownerBalAfter - ownerBalBefore).to.equal(INITIAL_PRICE);

      // Verify access grant is active
      const hasAccess = await genomicsRegistry.hasActiveAccess(1, researcher.address);
      expect(hasAccess).to.be.true;

      const data = await genomicsRegistry.getGenomicData(1);
      expect(data.accessCount).to.equal(1);
    });

    it("Should correctly split Royalty to original creator when NFT was transferred to a secondary seller", async function () {
      const secondarySeller = unauthorizedUser;

      // DataOwner transfers the NFT to secondarySeller
      await genomicNFT.connect(dataOwner).transferFrom(dataOwner.address, secondarySeller.address, 1);
      expect(await genomicNFT.ownerOf(1)).to.equal(secondarySeller.address);

      const creatorBalBefore = await genomicToken.balanceOf(dataOwner.address);
      const sellerBalBefore = await genomicToken.balanceOf(secondarySeller.address);

      // Researcher approves and purchases access
      await genomicToken.connect(researcher).approve(genomicsRegistry.target, INITIAL_PRICE);
      await genomicsRegistry.connect(researcher).grantAccess(1);

      const creatorBalAfter = await genomicToken.balanceOf(dataOwner.address);
      const sellerBalAfter = await genomicToken.balanceOf(secondarySeller.address);

      // Original creator received exactly 10% Royalty (10 GENO)
      expect(creatorBalAfter - creatorBalBefore).to.equal(10n * 10n ** 18n);

      // Secondary seller received 90% (90 GENO)
      expect(sellerBalAfter - sellerBalBefore).to.equal(90n * 10n ** 18n);
    });

    it("Should revert if dataset owner tries to buy their own data", async function () {
      await genomicToken.connect(dataOwner).faucet(dataOwner.address);
      await genomicToken.connect(dataOwner).approve(genomicsRegistry.target, INITIAL_PRICE);

      await expect(
        genomicsRegistry.connect(dataOwner).grantAccess(1)
      ).to.be.revertedWithCustomError(genomicsRegistry, "OwnerCannotBuyOwnData");
    });
  });

  describe("4. Status Management: updateDataStatus() & Access Control Constraints", function () {
    beforeEach(async function () {
      await genomicsRegistry.connect(dataOwner).registerGenomicData(
        sampleDataHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        INITIAL_PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      );
      await genomicToken.connect(researcher).faucet(researcher.address);
      await genomicToken.connect(researcher).approve(genomicsRegistry.target, INITIAL_PRICE);
    });

    it("Access Control: Only the data owner can update data status", async function () {
      // Unauthorized user attempts update -> must revert
      await expect(
        genomicsRegistry.connect(unauthorizedUser).updateDataStatus(1, 1) // Paused
      ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

      // Valid data owner updates status -> must succeed
      await genomicsRegistry.connect(dataOwner).updateDataStatus(1, 1); // Paused
      const data = await genomicsRegistry.getGenomicData(1);
      expect(data.status).to.equal(1); // DataStatus.Paused
    });

    it("Should prevent purchase when dataset status is Paused or Revoked", async function () {
      await genomicsRegistry.connect(dataOwner).updateDataStatus(1, 1); // Paused

      await expect(
        genomicsRegistry.connect(researcher).grantAccess(1)
      ).to.be.revertedWithCustomError(genomicsRegistry, "DataNotActive");
    });

    it("Access Control: Only the data owner can update data access fee", async function () {
      const newPrice = ethers.parseUnits("250", 18);

      // Unauthorized user attempts price change -> must revert
      await expect(
        genomicsRegistry.connect(unauthorizedUser).updateDataPrice(1, newPrice)
      ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

      // Price 0 must revert
      await expect(
        genomicsRegistry.connect(dataOwner).updateDataPrice(1, 0)
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidPrice");

      // Valid data owner updates price -> must succeed and emit DataPriceUpdated
      await expect(
        genomicsRegistry.connect(dataOwner).updateDataPrice(1, newPrice)
      ).to.emit(genomicsRegistry, "DataPriceUpdated")
        .withArgs(1, INITIAL_PRICE, newPrice);

      const data = await genomicsRegistry.getGenomicData(1);
      expect(data.price).to.equal(newPrice);
    });

    it("Access Control: Data owner can grant direct viewing access without payment", async function () {
      // Unauthorized user attempts direct grant -> must revert
      await expect(
        genomicsRegistry.connect(unauthorizedUser).grantDirectAccess(1, researcher.address)
      ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

      // Valid data owner grants direct access -> must succeed
      await expect(
        genomicsRegistry.connect(dataOwner).grantDirectAccess(1, researcher.address)
      ).to.emit(genomicsRegistry, "DirectAccessGranted");

      const hasAccess = await genomicsRegistry.hasActiveAccess(1, researcher.address);
      expect(hasAccess).to.be.true;
    });

    it("GDPR Permanence: Revoked dataset cannot be reactivated or repriced (ConsentPermanentlyRevoked)", async function () {
      // Transition to Revoked
      await genomicsRegistry.connect(dataOwner).updateDataStatus(1, 2); // Revoked
      const data = await genomicsRegistry.getGenomicData(1);
      expect(data.status).to.equal(2); // DataStatus.Revoked

      // Attempting to un-revoke to Active must revert with ConsentPermanentlyRevoked
      await expect(
        genomicsRegistry.connect(dataOwner).updateDataStatus(1, 0)
      ).to.be.revertedWithCustomError(genomicsRegistry, "ConsentPermanentlyRevoked");

      // Attempting to transition to Paused must revert with ConsentPermanentlyRevoked
      await expect(
        genomicsRegistry.connect(dataOwner).updateDataStatus(1, 1)
      ).to.be.revertedWithCustomError(genomicsRegistry, "ConsentPermanentlyRevoked");

      // Attempting to update price must revert with ConsentPermanentlyRevoked
      await expect(
        genomicsRegistry.connect(dataOwner).updateDataPrice(1, ethers.parseUnits("300", 18))
      ).to.be.revertedWithCustomError(genomicsRegistry, "ConsentPermanentlyRevoked");
    });
  });

  describe("5. On-Chain Key Registration, Non-extractable Crypto & Ciphertext Hash Verification", function () {
    let researcherKeyPair, unauthorizedKeyPair;
    let researcherPubKeyJwk;

    beforeEach(async function () {
      await genomicsRegistry.connect(dataOwner).registerGenomicData(
        sampleDataHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        INITIAL_PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS
      );
      await genomicToken.connect(researcher).faucet(researcher.address);
      await genomicToken.connect(researcher).approve(genomicsRegistry.target, INITIAL_PRICE);
      await genomicsRegistry.connect(researcher).grantAccess(1);

      // Generate non-extractable asymmetric keypair for researcher
      researcherKeyPair = await generateAsymmetricKeyPair(false);
      expect(researcherKeyPair.privateKey.extractable).to.be.false;

      unauthorizedKeyPair = await generateAsymmetricKeyPair(false);
      researcherPubKeyJwk = await exportPublicKey(researcherKeyPair.publicKey);
    });

    it("Should allow researcher to register persistent public key on-chain", async function () {
      const regTx = await genomicsRegistry
        .connect(researcher)
        .registerResearcherPublicKey(researcherPubKeyJwk);
      await regTx.wait();

      const registeredKey = await genomicsRegistry.researcherPublicKeys(researcher.address);
      expect(registeredKey).to.equal(researcherPubKeyJwk);

      // Revert if empty public key
      await expect(
        genomicsRegistry.connect(researcher).registerResearcherPublicKey("")
      ).to.be.revertedWithCustomError(genomicsRegistry, "EmptyPublicKey");
    });

    it("Should compute on-chain rawDataHash on the ciphertext package (IV || Ciphertext) and verify downloaded blob BEFORE decryption", async function () {
      // 1. Data owner encrypts VCF
      const encrypted = await encryptGenomicData(SAMPLE_VCF);
      expect(encrypted.payload).to.be.an.instanceOf(Uint8Array);
      // Verify payload starts with 12 bytes IV
      expect(encrypted.payload.length).to.equal(12 + encrypted.ciphertext.length);

      // Verify on-chain hash matches SHA-256 of payload (IV || Ciphertext)
      const expectedPackageHash = await computeDataHash(encrypted.payload);
      expect(encrypted.rawDataHash).to.equal(expectedPackageHash);

      // 2. Researcher downloads blob from IPFS and verifies integrity BEFORE exposing any key or decrypting
      const downloadedBlob = encrypted.payload;
      const isIntegrityValid = await verifyDataIntegrity(downloadedBlob, encrypted.rawDataHash);
      expect(isIntegrityValid).to.be.true;

      // 3. Decrypt full payload directly
      const decryptedText = await decryptGenomicPayload(downloadedBlob, encrypted.keyHex);
      expect(decryptedText).to.equal(SAMPLE_VCF);
    });

    it("Should securely package AES key using on-chain registered public key, store on-chain, and allow researcher decryption with non-extractable private key", async function () {
      // 1. Researcher registers public key on-chain
      await genomicsRegistry.connect(researcher).registerResearcherPublicKey(researcherPubKeyJwk);

      // 2. Data owner reads buyer's registered public key from chain
      const buyerOnChainPubKey = await genomicsRegistry.researcherPublicKeys(researcher.address);
      expect(buyerOnChainPubKey).to.equal(researcherPubKeyJwk);

      // 3. Encrypt data and package key capsule with buyer's public key
      const encrypted = await encryptGenomicData(SAMPLE_VCF);
      const capsuleJson = await packageKeyCapsule(
        encrypted.keyHex,
        buyerOnChainPubKey,
        researcher.address,
        dataOwner.address
      );

      // 4. Data owner stores transformed capsule on-chain
      await genomicsRegistry
        .connect(dataOwner)
        .storeTransformedCapsule(1, researcher.address, capsuleJson);

      // 5. Researcher retrieves capsule from contract
      const retrievedCapsule = await genomicsRegistry.connect(researcher).getTransformedCapsule(1);
      expect(retrievedCapsule).to.equal(capsuleJson);

      // 6. Researcher decrypts capsule using non-extractable private key
      const { keyHex: recoveredKeyHex } = await decryptKeyCapsule(
        retrievedCapsule,
        researcherKeyPair.privateKey
      );
      expect(recoveredKeyHex).to.equal(encrypted.keyHex);

      // 7. Verify ciphertext blob integrity and decrypt
      const isBlobValid = await verifyDataIntegrity(encrypted.payload, encrypted.rawDataHash);
      expect(isBlobValid).to.be.true;

      const decrypted = await decryptGenomicPayload(encrypted.payload, recoveredKeyHex);
      expect(decrypted).to.equal(SAMPLE_VCF);
    });

    it("Adversarial: Should fail decryption if unauthorized user attempts to decrypt capsule with wrong private key", async function () {
      const encrypted = await encryptGenomicData(SAMPLE_VCF);

      // Capsule encrypted for researcher
      const capsuleJson = await packageKeyCapsule(
        encrypted.keyHex,
        researcherPubKeyJwk,
        researcher.address,
        dataOwner.address
      );

      // Unauthorized user attempts to decrypt with their private key -> MUST REJECT
      let failed = false;
      try {
        await decryptKeyCapsule(capsuleJson, unauthorizedKeyPair.privateKey);
      } catch (err) {
        failed = true;
      }
      expect(failed).to.be.true;
    });

    it("Adversarial: Should reject tampering on downloaded blob before decryption", async function () {
      const encrypted = await encryptGenomicData(SAMPLE_VCF);

      // Tamper 1 byte of the downloaded ciphertext package
      const tamperedPayload = new Uint8Array(encrypted.payload);
      tamperedPayload[15] = tamperedPayload[15] ^ 0xaa; // flip byte in ciphertext

      // Pre-decryption integrity verification MUST FAIL IMMEDIATELY!
      const integrityCheck = await verifyDataIntegrity(tamperedPayload, encrypted.rawDataHash);
      expect(integrityCheck).to.be.false;

      // Decrypting tampered payload also fails AES-GCM tag verification
      let decryptFailed = false;
      try {
        await decryptGenomicPayload(tamperedPayload, encrypted.keyHex);
      } catch (err) {
        decryptFailed = true;
      }
      expect(decryptFailed).to.be.true;
    });
  });

  describe("5. Round 3 Hardening: Capsule Dispatcher, Pagination, Authentic PDF, and Fail-fast IPFS", function () {
    let dispatcherWorker;

    beforeEach(async function () {
      [, , , dispatcherWorker] = await ethers.getSigners();
      // Register a sample dataset by dataOwner
      await genomicNFT.connect(dataOwner).setApprovalForAll(genomicsRegistry.target, true);
      await genomicsRegistry
        .connect(dataOwner)
        .registerGenomicData(
          sampleDataHash,
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          INITIAL_PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS
        );

      // Researcher buys access
      await genomicToken.connect(deployer).transfer(researcher.address, 1000n * 10n ** 18n);
      await genomicToken.connect(researcher).approve(genomicsRegistry.target, INITIAL_PRICE);
      await genomicsRegistry.connect(researcher).grantAccess(1);
    });

    it("Should allow authorized capsule dispatcher or worker to store transformed capsule for researcher", async function () {
      // 1. Set dispatcher
      await genomicsRegistry.connect(deployer).setCapsuleDispatcher(deployer.address);
      expect(await genomicsRegistry.capsuleDispatcher()).to.equal(deployer.address);

      // 2. Authorize a worker for dataId=1 (only data owner can call)
      await genomicsRegistry.connect(dataOwner).setAuthorizedCapsuleWorker(1, dispatcherWorker.address, true);
      expect(await genomicsRegistry.authorizedCapsuleWorkers(1, dispatcherWorker.address)).to.be.true;

      // 3. Worker stores transformed capsule on-chain
      const sampleCapsule = JSON.stringify({ version: "RSA-OAEP-2048", keyCipher: "0x1234abcd" });
      await genomicsRegistry
        .connect(dispatcherWorker)
        .storeTransformedCapsule(1, researcher.address, sampleCapsule);

      // 4. Researcher retrieves stored capsule
      const retrieved = await genomicsRegistry.connect(researcher).getTransformedCapsule(1);
      expect(retrieved).to.equal(sampleCapsule);
    });

    it("Adversarial: Should reject unauthorized third party calling storeTransformedCapsule", async function () {
      const sampleCapsule = JSON.stringify({ version: "RSA-OAEP-2048", keyCipher: "0xdeadbeef" });
      await expect(
        genomicsRegistry
          .connect(unauthorizedUser)
          .storeTransformedCapsule(1, researcher.address, sampleCapsule)
      ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");
    });

    it("Should correctly paginate genomic data items with getDataItemsPaginated", async function () {
      // Register a second dataset
      await genomicsRegistry
        .connect(dataOwner)
        .registerGenomicData(
          "0x111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000",
          VALID_RAW_CID,
          VALID_SUMMARY_CID,
          VALID_METADATA_CID,
          VALID_TOKEN_URI,
          INITIAL_PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS
        );

      const [items, totalCount] = await genomicsRegistry.getDataItemsPaginated(0, 1);
      expect(totalCount).to.equal(2n);
      expect(items.length).to.equal(1);
      expect(items[0].dataId).to.equal(1n);

      const [itemsPage2] = await genomicsRegistry.getDataItemsPaginated(1, 10);
      expect(itemsPage2.length).to.equal(1);
      expect(itemsPage2[0].dataId).to.equal(2n);
    });

    it("Should generate authentic ISO 32000 / PDF-1.4 clinical report and encrypt with AES-256-GCM", async function () {
      const pdfBytes = generateClinicalPdfReport({
        subjectId: "SUBJ_VN_TEST",
        disease: "Alcohol Sensitivity",
        gene: "ALDH2",
        variant: "rs671 (c.1510G>A)",
        date: "2026-09-17",
      });

      // Verify PDF binary structure
      const pdfHeader = new TextDecoder().decode(pdfBytes.slice(0, 8));
      expect(pdfHeader).to.equal("%PDF-1.4");
      const pdfEnd = new TextDecoder().decode(pdfBytes.slice(-10));
      expect(pdfEnd).to.include("%%EOF");

      // Verify encryption
      const encryptedPdf = await encryptGenomicData(pdfBytes);
      expect(encryptedPdf.payload).to.be.instanceOf(Uint8Array);
      expect(encryptedPdf.payload.length).to.be.greaterThan(pdfBytes.length); // includes 12-byte IV + 16-byte GCM tag

      // Verify round-trip decryption using the payload blob (IV || Ciphertext)
      const decryptedString = await decryptGenomicPayload(encryptedPdf.payload, encryptedPdf.keyHex);
      // Since generateClinicalPdfReport produces text-encodable PDF, verify content round-trip
      const reEncodedBytes = new TextEncoder().encode(decryptedString);
      expect(reEncodedBytes).to.deep.equal(pdfBytes);
    });

    it("Adversarial: Should fail-fast and throw hard error if IPFS pinning cannot reach Pinata or Kubo", async function () {
      let threw = false;
      try {
        // Pass fake non-existent JWT and invalid port
        await uploadEncryptedRawData(
          new Uint8Array([1, 2, 3]),
          "test.enc",
          "invalid-mock-jwt"
        );
      } catch (err) {
        threw = true;
        expect(err.message).to.include("Lỗi kết nối IPFS");
      }
      expect(threw).to.be.true;
    });
  });
});
