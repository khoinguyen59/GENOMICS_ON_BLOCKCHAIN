import hre from "hardhat";
import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
  encryptGenomicData,
  decryptGenomicData,
  generateAsymmetricKeyPair,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash
} from "../crypto/client_crypto.js";
import { parseVcfMetadata } from "../frontend/src/services/vcfService.js";

describe("Diverse Genomic Datasets EVM & Cryptographic Compatibility (GA4GH, GATK, FASTQ, FASTA, ClinVar)", function () {
  let ethers;
  let deployer, dataOwner, researcher;
  let genomicToken, genomicNFT, genomicsRegistry;

  const DATASET_TESTS = [
    {
      name: "GA4GH Phenopacket v2 (ABCA4 Retinal Photoreceptor Trait JSON)",
      filePath: "frontend/public/datasets/GA4GH_Phenopacket_ABCA4_PMID_10874631_II_2.json",
      rawCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      summaryCid: "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      metadataCid: "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      tokenUri: "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      priceGeno: 140n * 10n ** 18n
    },
    {
      name: "Broad Institute GATK / GIAB Benchmark VCF (NA12878 Chr20)",
      filePath: "frontend/public/datasets/NA12878_chr20_sample.vcf",
      rawCid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      summaryCid: "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      metadataCid: "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      tokenUri: "ipfs://QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      priceGeno: 110n * 10n ** 18n
    },
    {
      name: "Illumina NGS Short Reads (FASTQ Quality Callset)",
      filePath: "frontend/public/datasets/Illumina_NGS_reads_sample.fastq",
      rawCid: "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",
      summaryCid: "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      metadataCid: "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      tokenUri: "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      priceGeno: 100n * 10n ** 18n
    },
    {
      name: "1000 Genomes Project Vietnamese Kinh WGS (KHV Cohort)",
      filePath: "frontend/public/datasets/KHV_chr12_1000genomes.vcf",
      rawCid: "Qmcd84psf3UdzpsG8zCZmMTE59mUc8EoVzyQX78SfX7JqC",
      summaryCid: "QmUCJSaRWoQq5Gr9Pvm5ugpSn5HUhTrcAaBvARzNHqpK7v",
      metadataCid: "QmNu4foFDACBK9sZh1jUndGWKiywdZRQuqHF5iYbmDmXsm",
      tokenUri: "ipfs://QmUCJSaRWoQq5Gr9Pvm5ugpSn5HUhTrcAaBvARzNHqpK7v",
      priceGeno: 100n * 10n ** 18n
    },
    {
      name: "HTSLIB Genomic Reference Contig (FASTA Sequence)",
      filePath: "frontend/public/datasets/HTSLIB_reference_c1.fa",
      rawCid: "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
      summaryCid: "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      metadataCid: "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      tokenUri: "ipfs://QmNu4foFDACBK9sZh1jUndGWKiywdZRQuqHF5iYbmDmXsm",
      priceGeno: 50n * 10n ** 18n
    }
  ];

  before(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, dataOwner, researcher] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // 1. Deploy GenomicToken (ERC-20)
    const GenomicTokenFactory = await ethers.getContractFactory("GenomicToken");
    genomicToken = await GenomicTokenFactory.deploy(deployer.address);
    await genomicToken.waitForDeployment();

    // 2. Deploy GenomicNFT (ERC-721 + EIP-2981)
    const GenomicNFTFactory = await ethers.getContractFactory("GenomicNFT");
    genomicNFT = await GenomicNFTFactory.deploy(deployer.address, 1000); // 10% royalty
    await genomicNFT.waitForDeployment();

    // 3. Deploy GenomicsRegistry
    const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
    genomicsRegistry = await GenomicsRegistryFactory.deploy(
      genomicToken.target,
      genomicNFT.target,
      deployer.address
    );
    await genomicsRegistry.waitForDeployment();

    // Set registry in NFT contract
    await genomicNFT.connect(deployer).setRegistryContract(genomicsRegistry.target);

    // Distribute tokens to researcher and approve registry
    await genomicToken.transfer(researcher.address, 10000n * 10n ** 18n);
    await genomicToken.connect(researcher).approve(genomicsRegistry.target, ethers.MaxUint256);
  });

  for (const ds of DATASET_TESTS) {
    it(`Should successfully encrypt, register on-chain, mint NFT, buy access, and decrypt: ${ds.name}`, async function () {
      const fullPath = path.resolve(ds.filePath);
      expect(fs.existsSync(fullPath), `Dataset file exists: ${ds.filePath}`).to.be.true;

      const rawContent = fs.readFileSync(fullPath, "utf-8");
      const filename = path.basename(ds.filePath);

      // 1. Bioinformatics metadata parse
      const parsed = parseVcfMetadata(rawContent, filename);
      expect(parsed.detectedGene).to.be.a("string").and.not.empty;
      expect(parsed.detectedDisease).to.be.a("string").and.not.empty;

      // 2. Client-side authenticated encryption (AES-256-GCM)
      const encResult = await encryptGenomicData(rawContent);
      const { keyHex, rawDataHash, iv, ciphertext } = encResult;

      // 3. On-chain registration via Data Owner
      const txRegister = await genomicsRegistry.connect(dataOwner).registerGenomicData(
        rawDataHash,
        ds.rawCid,
        ds.summaryCid,
        ds.metadataCid,
        ds.tokenUri,
        ds.priceGeno,
        30 * 24 * 3600, // 30 days
        1000 // 10% royalty
      );
      const receipt = await txRegister.wait();

      // Find GenomicDataRegistered event
      const registeredEvent = receipt.logs
        .map((log) => {
          try {
            return genomicsRegistry.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "GenomicDataRegistered");

      expect(registeredEvent).to.not.be.null;
      const dataId = registeredEvent.args.dataId;
      const tokenId = registeredEvent.args.tokenId;

      // Verify NFT minted to dataOwner
      expect(await genomicNFT.ownerOf(tokenId)).to.equal(dataOwner.address);

      // 4. Researcher generates keypair and purchases access via grantAccess
      const researcherKeypair = await generateAsymmetricKeyPair(false);

      const ownerBalanceBefore = await genomicToken.balanceOf(dataOwner.address);
      const txBuy = await genomicsRegistry.connect(researcher).grantAccess(dataId);
      await txBuy.wait();

      // Verify grant is active
      const grant = await genomicsRegistry.accessGrants(dataId, researcher.address);
      expect(grant.isGranted).to.be.true;

      // 5. Data Owner packages key capsule for researcher
      const capsuleJson = await packageKeyCapsule(
        keyHex,
        researcherKeypair.publicKey,
        researcher.address,
        dataOwner.address
      );

      // 6. Deliver key capsule on-chain
      const txDeliver = await genomicsRegistry.connect(dataOwner).storeTransformedCapsule(
        dataId,
        researcher.address,
        capsuleJson
      );
      await txDeliver.wait();

      // Verify capsule stored on-chain and retrievable by researcher
      const retrievedCapsule = await genomicsRegistry.connect(researcher).getTransformedCapsule(dataId);
      expect(retrievedCapsule).to.equal(capsuleJson);

      // Verify Data Owner received payment
      const ownerBalanceAfter = await genomicToken.balanceOf(dataOwner.address);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + ds.priceGeno);

      // 7. Researcher decapsulates key and decrypts in RAM
      const { keyHex: unwrappedKeyHex } = await decryptKeyCapsule(retrievedCapsule, researcherKeypair.privateKey);
      const decryptedText = await decryptGenomicData(ciphertext, iv, unwrappedKeyHex, true);

      // Verify byte-for-byte exact equality
      expect(decryptedText).to.equal(rawContent);
    });
  }
});
