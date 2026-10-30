import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { encryptGenomicData, generateClinicalPdfReport } from "../../crypto/client_crypto.js";
import { buildPhenopacket } from "../../ipfs/phenopacket_builder.js";
import { computeIpfsCidV0, cacheLocalIpfsContent } from "../../ipfs/pinata_uploader.js";

async function main() {
  console.log("==================================================");
  console.log("🚀 Deploying to Hardhat Localhost Node (port 8545)...");
  console.log("==================================================");

  const { ethers } = await hre.network.connect("localhost");
  const [deployer, researcher] = await ethers.getSigners();
  console.log(`Deployer Address   : ${deployer.address}`);
  console.log(`Researcher Address : ${researcher.address}`);

  // 1. Deploy GenomicToken
  console.log("\n1. Deploying GenomicToken ($GENO)...");
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();
  console.log(`✅ GenomicToken deployed at: ${token.target}`);

  // 2. Deploy GenomicNFT
  console.log("\n2. Deploying GenomicNFT (ERC-721 + EIP-2981 Royalty)...");
  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(deployer.address, 1000);
  await nft.waitForDeployment();
  console.log(`✅ GenomicNFT deployed at: ${nft.target}`);

  // 3. Deploy GenomicsRegistry
  console.log("\n3. Deploying GenomicsRegistry (Core + Escrow)...");
  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(token.target, nft.target, deployer.address);
  await registry.waitForDeployment();
  console.log(`✅ GenomicsRegistry deployed at: ${registry.target}`);

  // 3b. Deploy GenomicZkVerifier (Tier-4 zk-Genomics)
  console.log("\n3b. Deploying GenomicZkVerifier (Zero-Knowledge Variant Verification)...");
  const GenomicZkVerifier = await ethers.getContractFactory("GenomicZkVerifier");
  const zkVerifier = await GenomicZkVerifier.deploy(token.target);
  await zkVerifier.waitForDeployment();
  console.log(`✅ GenomicZkVerifier deployed at: ${zkVerifier.target}`);

  // 4. Authorize Registry in NFT
  console.log("\n4. Authorizing GenomicsRegistry in GenomicNFT...");
  const authTx = await nft.connect(deployer).setRegistryContract(registry.target);
  await authTx.wait();
  console.log("✅ Authorization completed!");

  // Transfer initial $GENO tokens to researcher for test buying
  console.log("\nTransferring 1,000 $GENO to Researcher account for marketplace testing...");
  const fundTx = await token.connect(deployer).transfer(researcher.address, ethers.parseUnits("1000", 18));
  await fundTx.wait();
  console.log(`✅ Researcher balance funded: 1,000 $GENO`);

  // 5. Seed On-chain Data
  console.log("\n5. Seeding authenticated genomic datasets...");

  // Seed 1: 1000 Genomes Vietnamese Kinh (KHV)
  const seedVcf1 =
    "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tINFO\nchr12\t111803962\trs671\tG\tA\tAF=0.38000;GENE=ALDH2;TRAIT=1000G_KHV_WGS";
  const enc1 = await encryptGenomicData(seedVcf1);
  const rawCid1 = await computeIpfsCidV0(enc1.payload);

  const pdfBytes1 = generateClinicalPdfReport({
    subjectId: "1000G_KHV_VN_01",
    disease: "1000 Genomes Project — Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
    gene: "ALDH2 / ADH1B Multi-locus Loci (chr12)",
    variant: "rs671 (c.1510G>A)",
  });
  const encPdf1 = await encryptGenomicData(pdfBytes1);
  const summaryCid1 = await computeIpfsCidV0(encPdf1.payload);

  const pheno1 = buildPhenopacket({
    subjectId: "1000G_KHV_VN_01",
    disease: "1000 Genomes Project — Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
    phenotypes: [{ id: "SO:0000694", label: "Population SNP Callset" }],
    variants: [{ gene: "ALDH2", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
    rawDataHash: enc1.rawDataHash,
    rawCid: rawCid1,
    summaryCid: summaryCid1,
    summaryDataHash: encPdf1.rawDataHash,
  });
  const metaJson1 = JSON.stringify(pheno1, null, 2);
  const metaCid1 = await computeIpfsCidV0(metaJson1);

  cacheLocalIpfsContent(rawCid1, enc1.payload);
  cacheLocalIpfsContent(summaryCid1, encPdf1.payload);
  cacheLocalIpfsContent(metaCid1, new TextEncoder().encode(metaJson1));

  const tx1 = await registry.connect(deployer).registerGenomicData(
    enc1.rawDataHash,
    rawCid1,
    summaryCid1,
    metaCid1,
    `ipfs://${metaCid1}`,
    ethers.parseUnits("100", 18),
    45 * 86400,
    1000
  );
  await tx1.wait();
  console.log(`✅ Seed #1 (1000G KHV) registered on-chain: dataId=1`);

  // Seed 2: ACTN3 Muscle Performance
  const seedVcf2 =
    "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tINFO\nchr11\t66560624\trs1815739\tC\tT\tGENE=ACTN3;TRAIT=Fast_twitch_muscle_power";
  const enc2 = await encryptGenomicData(seedVcf2);
  const rawCid2 = await computeIpfsCidV0(enc2.payload);

  const pdfBytes2 = generateClinicalPdfReport({
    subjectId: "SUBJECT_VN_ACTN3",
    disease: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
    gene: "ACTN3 (c.1729C>T, rs1815739, p.Arg577Ter)",
    variant: "c.1729C>T (rs1815739)",
  });
  const encPdf2 = await encryptGenomicData(pdfBytes2);
  const summaryCid2 = await computeIpfsCidV0(encPdf2.payload);

  const pheno2 = buildPhenopacket({
    subjectId: "SUBJECT_VN_ACTN3",
    disease: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
    phenotypes: [{ id: "SO:0001587", label: "Fast-twitch muscle fiber trait" }],
    variants: [{ gene: "ACTN3", hgvs: "c.1729C>T", zygosity: "heterozygous" }],
    rawDataHash: enc2.rawDataHash,
    rawCid: rawCid2,
    summaryCid: summaryCid2,
    summaryDataHash: encPdf2.rawDataHash,
  });
  const metaJson2 = JSON.stringify(pheno2, null, 2);
  const metaCid2 = await computeIpfsCidV0(metaJson2);

  cacheLocalIpfsContent(rawCid2, enc2.payload);
  cacheLocalIpfsContent(summaryCid2, encPdf2.payload);
  cacheLocalIpfsContent(metaCid2, new TextEncoder().encode(metaJson2));

  const tx2 = await registry.connect(deployer).registerGenomicData(
    enc2.rawDataHash,
    rawCid2,
    summaryCid2,
    metaCid2,
    `ipfs://${metaCid2}`,
    ethers.parseUnits("85", 18),
    30 * 86400,
    1000
  );
  await tx2.wait();
  console.log(`✅ Seed #2 (ACTN3) registered on-chain: dataId=2`);

  // 6. Save contract addresses + ABIs for frontend
  const addresses = {
    network: "hardhat-localhost",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    deployedAt: new Date().toISOString(),
    GenomicToken: token.target,
    GenomicNFT: nft.target,
    GenomicsRegistry: registry.target,
    GenomicZkVerifier: zkVerifier.target,
    Deployer: deployer.address,
    Researcher: researcher.address,
  };

  const outputDir = path.resolve("frontend/src/contracts");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "contractAddresses.json"), JSON.stringify(addresses, null, 2));
  console.log("\n📄 Contract addresses saved to frontend/src/contracts/contractAddresses.json");

  const contractsToExport = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier"];
  for (const name of contractsToExport) {
    const artifactPath = path.resolve(`artifacts/contracts/${name}.sol/${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      fs.writeFileSync(path.join(outputDir, `${name}ABI.json`), JSON.stringify(artifact.abi, null, 2));
      console.log(`📄 Exported ABI: ${name}ABI.json`);
    }
  }

  // Public-only seed metadata (ZERO AES keys)
  const publicSeedDataStore = {
    seeds: [
      {
        dataId: 1,
        disease: "1000 Genomes Project — Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
        gene: "ALDH2 / ADH1B Multi-locus Loci (chr12)",
        hpoTerm: "SO:0000694 (Population SNP Callset)",
        ancestry: "Vietnamese Kinh (1000 Genomes: KHV)",
        rawCid: rawCid1,
        metadataCid: metaCid1,
        summaryCid: summaryCid1,
        rawDataHash: enc1.rawDataHash,
        summaryDataHash: encPdf1.rawDataHash,
      },
      {
        dataId: 2,
        disease: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
        gene: "ACTN3 (c.1729C>T, rs1815739, p.Arg577Ter)",
        hpoTerm: "SO:0001587 (Stop-gained)",
        ancestry: "Global Multi-ethnic Cohort",
        rawCid: rawCid2,
        metadataCid: metaCid2,
        summaryCid: summaryCid2,
        rawDataHash: enc2.rawDataHash,
        summaryDataHash: encPdf2.rawDataHash,
      },
    ],
  };
  fs.writeFileSync(path.join(outputDir, "seedMetadata.json"), JSON.stringify(publicSeedDataStore, null, 2));
  console.log("📄 Public seed metadata saved (Zero keys leaked)");

  // Private keys -> scripts only
  const secretKeyStore = {
    deployerAddress: deployer.address,
    seeds: [
      { dataId: 1, rawCid: rawCid1, aesKeyHex: enc1.keyHex, ivHex: enc1.ivHex, rawDataHash: enc1.rawDataHash },
      { dataId: 2, rawCid: rawCid2, aesKeyHex: enc2.keyHex, ivHex: enc2.ivHex, rawDataHash: enc2.rawDataHash },
    ],
  };
  fs.writeFileSync(path.resolve("scripts/deploy/seed_keys.json"), JSON.stringify(secretKeyStore, null, 2));
  console.log("🔒 Seed keys saved to scripts/deploy/seed_keys.json");

  console.log("\n==================================================");
  console.log("🎉 LOCALHOST DEPLOYMENT COMPLETE!");
  console.log(`   GenomicToken    : ${token.target}`);
  console.log(`   GenomicNFT      : ${nft.target}`);
  console.log(`   GenomicsRegistry: ${registry.target}`);
  console.log(`   RPC URL: http://127.0.0.1:8545`);
  console.log("==================================================");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
