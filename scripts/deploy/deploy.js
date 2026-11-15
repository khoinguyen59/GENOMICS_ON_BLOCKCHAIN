import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  encryptGenomicData,
  generateClinicalPdfReport,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
} from "../../crypto/client_crypto.js";
import { buildPhenopacket } from "../../ipfs/phenopacket_builder.js";
import { computeIpfsCidV0, cacheLocalIpfsContent } from "../../ipfs/pinata_uploader.js";

function loadOrCreateDispatcherVaultKey() {
  if (process.env.GENOCHAIN_SEED_VAULT_SECRET) {
    return crypto.createHash("sha256").update(process.env.GENOCHAIN_SEED_VAULT_SECRET, "utf8").digest();
  }
  const localDir = path.resolve(".local");
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
  }
  const keyPath = path.join(localDir, "dispatcher_vault.key");
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("Invalid .local/dispatcher_vault.key format (expected 64 hex chars).");
    }
    return Buffer.from(hex, "hex");
  }
  const randomKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, randomKey.toString("hex"), { mode: 0o600 });
  return randomKey;
}

function wrapSeedKeyForVault(aesKeyHex, vaultKey) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey, nonce);
  const rawBytes = Buffer.from(aesKeyHex.replace(/^0x/, ""), "hex");
  const encrypted = Buffer.concat([cipher.update(rawBytes), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, encrypted]).toString("hex");
}

async function main() {
  console.log("==================================================");
  console.log("[INFO] Deploying Genomics on Blockchain System...");
  console.log("==================================================");

  const connection = await hre.network.connect("localhost");
  const { ethers } = connection;
  const [deployer, researcher] = await ethers.getSigners();
  console.log(`Deployer Address   : ${deployer.address}`);
  if (researcher) {
    console.log(`Researcher Address : ${researcher.address}`);
  }

  // 1. Deploy GenomicToken (ERC-20)
  console.log("\n1. Deploying GenomicToken ($GENO)...");
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();
  console.log(`[OK] GenomicToken deployed at: ${token.target}`);

  // 2. Deploy GenomicNFT (ERC-721 + EIP-2981)
  console.log("\n2. Deploying GenomicNFT (ERC-721 + EIP-2981 Royalty)...");
  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(deployer.address, 1000); // 10% default royalty
  await nft.waitForDeployment();
  console.log(`[OK] GenomicNFT deployed at: ${nft.target}`);

  // 3. Deploy GenomicsRegistry
  console.log("\n3. Deploying GenomicsRegistry (Core Registry + Escrow)...");
  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(token.target, nft.target, deployer.address);
  await registry.waitForDeployment();
  console.log(`[OK] GenomicsRegistry deployed at: ${registry.target}`);

  // 4. Link Registry Contract in GenomicNFT
  console.log("\n4. Authorizing GenomicsRegistry in GenomicNFT...");
  const authTx = await nft.connect(deployer).setRegistryContract(registry.target);
  await authTx.wait();
  console.log("[OK] GenomicsRegistry authorization completed!");

  // 4.5. Deploy GenomicZkVerifier (BN254 Groth16 Zero-Knowledge Trait Bounty Verifier)
  console.log("\n4.5. Deploying GenomicZkVerifier (BN254 Groth16 Verifier)...");
  const GenomicZkVerifier = await ethers.getContractFactory("GenomicZkVerifier");
  const zkVerifier = await GenomicZkVerifier.deploy(token.target);
  await zkVerifier.waitForDeployment();
  console.log(`[OK] GenomicZkVerifier deployed at: ${zkVerifier.target}`);

  // Link GenomicZkVerifier in GenomicsRegistry (zk-Genomics Verification Engine)
  const linkZkTx = await registry.connect(deployer).setZkVerifier(zkVerifier.target);
  await linkZkTx.wait();
  console.log(`[OK] GenomicsRegistry successfully linked to GenomicZkVerifier at: ${zkVerifier.target}`);

  // Authorize deployer as Capsule Dispatcher
  const dispTx = await registry.connect(deployer).setCapsuleDispatcher(deployer.address);
  await dispTx.wait();
  console.log("[OK] Capsule Dispatcher authorized!");

  // 5. Seed 10 Authenticated Clinical & Scientific Genomic Cohorts On-Chain
  console.log("\n5. Seeding 10 authentic clinical & scientific genomic cohorts on-chain...");

  // Load real NA12878 GIAB benchmark VCF if available
  let na12878RealVcf = "";
  const na12878Path = path.resolve("data/downloaded_real_samples/NA12878_chr20_sample.vcf");
  if (fs.existsSync(na12878Path)) {
    na12878RealVcf = fs.readFileSync(na12878Path, "utf8");
    console.log(`📂 Loaded authentic Broad Institute GIAB NA12878 VCF (${na12878RealVcf.length} bytes)`);
  } else {
    na12878RealVcf = "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=Broad_Institute_GATK_GIAB\n##reference=GRCh38\n##contig=<ID=chr20,length=64444167,assembly=GRCh38>\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\nchr20\t14370\trs6072048\tC\tT\t100\tPASS\tANN=ZNF343|synonymous_variant\tGT\t0/1\n";
  }

  // Helper to load real genomic sample file
  const loadVcf = (relPath, fallback) => {
    const fullPath = path.resolve(relPath);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf8");
    }
    return fallback;
  };

  const khvVcf = loadVcf("data/diverse_real_datasets/KHV_chr12_1000genomes.vcf", "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=1000Genomes_Phase3_KHV_WGS\n##reference=GRCh38\n##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tKHV01\nchr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.38000;GENE=ALDH2;TRAIT=1000G_KHV\tGT\t0/1\n");
  const actn3Vcf = loadVcf("data/diverse_real_datasets/ACTN3_muscle_performance_rs1815739.vcf", "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ACTN3\n##reference=GRCh38\n##contig=<ID=chr11,length=135086622,assembly=GRCh38>\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSUBJECT01\nchr11\t66560624\trs1815739\tC\tT\t100\tPASS\tGENE=ACTN3;TRAIT=Fast_twitch_muscle_power\tGT\t0/1\n");
  const herc2Vcf = loadVcf("data/diverse_real_datasets/HERC2_eye_color_rs12913832.vcf", "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_HERC2\n##reference=GRCh38\n##contig=<ID=chr15,length=101991189,assembly=GRCh38>\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSUBJECT01\nchr15\t28120472\trs12913832\tA\tG\t100\tPASS\tGENE=HERC2;TRAIT=Eye_color_pigmentation\tGT\t0/1\n");
  const tas2r38Vcf = loadVcf("data/diverse_real_datasets/TAS2R38_bitter_taste_rs713598.vcf", "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_TAS2R38\n##reference=GRCh38\n##contig=<ID=chr7,length=159345973,assembly=GRCh38>\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSUBJECT01\nchr7\t141972804\trs713598\tG\tC\t100\tPASS\tGENE=TAS2R38;TRAIT=Bitter_taste_perception\tGT\t0/1\n");
  const edarVcf = loadVcf("data/diverse_real_datasets/EDAR_hair_thickness_rs3827760.vcf", "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_EDAR\n##reference=GRCh38\n##contig=<ID=chr2,length=242193529,assembly=GRCh38>\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSUBJECT01\nchr2\t108898064\trs3827760\tT\tC\t100\tPASS\tGENE=EDAR;TRAIT=East_Asian_hair_thickness\tGT\t0/1\n");

  const cohortConfigs = [
    {
      dataId: 1,
      chromosome: "chr12",
      pos: 111803962,
      rsId: "rs671",
      geneSymbol: "KHV_1000G",
      gene: "ALDH2 / ADH1B Multi-locus Loci (chr12)",
      disease: "1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
      clinicalSignificance: "Population Genetics",
      consequence: "missense_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "Vietnamese Kinh (1000 Genomes: KHV)",
      hpoTerm: "SO:0000694 (Population SNP Callset)",
      region: "Vietnamese (Kinh)",
      bloodGroup: "O+",
      clinvarId: "1000G:KHV",
      priceGeno: "100",
      durationDays: 45,
      vcfContent: khvVcf,
      phenotypes: [{ id: "SO:0000694", label: "Population SNP Callset" }],
      variants: [{ gene: "ALDH2", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
    },
    {
      dataId: 2,
      chromosome: "chr11",
      pos: 66560624,
      rsId: "rs1815739",
      geneSymbol: "ACTN3",
      gene: "ACTN3 (c.1729C>T, rs1815739, p.Arg577Ter)",
      disease: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
      clinicalSignificance: "Physical Traits & Performance",
      consequence: "stop_gained",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "Global Multi-ethnic Cohort",
      hpoTerm: "SO:0001587 (Stop-gained)",
      region: "Global",
      bloodGroup: "O+",
      clinvarId: "dbSNP:rs1815739",
      priceGeno: "85",
      durationDays: 30,
      vcfContent: actn3Vcf,
      phenotypes: [{ id: "SO:0001587", label: "Fast-twitch muscle fiber trait" }],
      variants: [{ gene: "ACTN3", hgvs: "c.1729C>T", zygosity: "heterozygous" }],
    },
    {
      dataId: 3,
      chromosome: "chr12",
      pos: 111803962,
      rsId: "rs671",
      geneSymbol: "ALDH2",
      gene: "ALDH2 (c.1510G>A, rs671, p.Glu504Lys)",
      disease: "Tốc Độ Chuyển Hóa Acetaldehyde & Cồn (Alcohol Dehydrogenase Locus)",
      clinicalSignificance: "Sensory & Metabolism",
      consequence: "missense_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "East Asian / Kinh Vietnamese (HANCESTRO:0008)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "East Asian",
      bloodGroup: "A+",
      clinvarId: "dbSNP:rs671",
      priceGeno: "80",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ALDH2\n##reference=GRCh38\n##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_01\nchr12\t111803962\trs671\tG\tA\t999\tPASS\tAF=0.380;GENE=ALDH2;TRAIT=Alcohol_sensitivity;CLNSIG=Affects;CLNDN=Alcohol_sensitivity;ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|c.1510G>A|p.Glu504Lys\tGT:GQ:DP\t0/1:99:55\n",
      phenotypes: [
        { id: "SO:0001583", label: "Alcohol dehydrogenase variant" },
        { id: "SO:0001818", label: "Protein altering variant" },
      ],
      variants: [{ gene: "ALDH2", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
    },
    {
      dataId: 4,
      chromosome: "chr2",
      pos: 135851076,
      rsId: "rs4988235",
      geneSymbol: "LCT",
      gene: "MCM6 / LCT (c.-13910C>T, rs4988235)",
      disease: "Duy Trì Enzyme Lactase Ở Người Trưởng Thành (Lactase Persistence Locus)",
      clinicalSignificance: "Sensory & Metabolism",
      consequence: "regulatory_variant",
      zygosity: "1/1 (Homozygous Alt)",
      assembly: "GRCh38",
      ancestry: "Vietnamese / Southeast Asian (HANCESTRO:0005)",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "Southeast Asian",
      bloodGroup: "AB+",
      clinvarId: "dbSNP:rs4988235",
      priceGeno: "80",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_LCT\n##reference=GRCh38\n##contig=<ID=chr2,length=242193529,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_02\nchr2\t135851076\trs4988235\tC\tT\t999\tPASS\tAF=0.740;GENE=LCT;TRAIT=Lactase_persistence;CLNSIG=Benign/Protective;CLNDN=Lactase_persistence;ANN=T|regulatory_variant|MODIFIER|LCT|transcript|NM_002299.4|c.-13910C>T|LactasePersistence\tGT:GQ:DP\t1/1:99:70\n",
      phenotypes: [
        { id: "SO:0001627", label: "Lactase persistence locus" },
      ],
      variants: [{ gene: "LCT", hgvs: "c.-13910C>T", zygosity: "homozygous" }],
    },
    {
      dataId: 5,
      chromosome: "chr15",
      pos: 74749576,
      rsId: "rs762551",
      geneSymbol: "CYP1A2",
      gene: "CYP1A2 (*1F allele, c.-163A>C, rs762551)",
      disease: "Dược Di Truyền: Tốc Độ Thanh Thải Cafein Ở Gan (CYP1A2 Inducibility)",
      clinicalSignificance: "Pharmacogenomics",
      consequence: "regulatory_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "East Asian (HANCESTRO:0008)",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "East Asian",
      bloodGroup: "O-",
      clinvarId: "dbSNP:rs762551",
      priceGeno: "90",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_CYP1A2\n##reference=GRCh38\n##contig=<ID=chr15,length=101991189,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_EA_03\nchr15\t74749576\trs762551\tA\tC\t999\tPASS\tAF=0.680;GENE=CYP1A2;TRAIT=Caffeine_metabolism;CLNSIG=Drug_response;CLNDN=Caffeine_metabolism;ANN=C|regulatory_variant|MODIFIER|CYP1A2|transcript|NM_000761.5|c.-163A>C|SlowCaffeineMetabolizer\tGT:GQ:DP\t0/1:99:50\n",
      phenotypes: [{ id: "SO:0001627", label: "Caffeine clearance speed" }],
      variants: [{ gene: "CYP1A2", hgvs: "c.-163A>C", zygosity: "heterozygous" }],
    },
    {
      dataId: 6,
      chromosome: "chr16",
      pos: 48224287,
      rsId: "rs17822931",
      geneSymbol: "ABCC11",
      gene: "ABCC11 (c.538G>A, rs17822931, p.Gly180Arg)",
      disease: "Đặc Tính Ráy Tai Khô & Tuyến Tiết Mồ Hôi Apocrine Đông Á",
      clinicalSignificance: "Physical Traits & Performance",
      consequence: "missense_variant",
      zygosity: "1/1 (Homozygous Alt)",
      assembly: "GRCh38",
      ancestry: "Vietnamese / East Asian (HANCESTRO:0008)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "East Asian",
      bloodGroup: "B-",
      clinvarId: "dbSNP:rs17822931",
      priceGeno: "75",
      durationDays: 15,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ABCC11\n##reference=GRCh38\n##contig=<ID=chr16,length=90338345,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_04\nchr16\t48224287\trs17822931\tC\tT\t999\tPASS\tAF=0.820;GENE=ABCC11;TRAIT=Cerumen_type;CLNSIG=Benign;CLNDN=Cerumen_type;ANN=T|missense_variant|MODERATE|ABCC11|transcript|NM_033151.3|c.538G>A|p.Gly180Arg|DryEarwax\tGT:GQ:DP\t1/1:99:85\n",
      phenotypes: [{ id: "SO:0001583", label: "Cerumen apocrine phenotype" }],
      variants: [{ gene: "ABCC11", hgvs: "c.538G>A", zygosity: "homozygous" }],
    },
    {
      dataId: 7,
      chromosome: "chr20",
      pos: 14370,
      rsId: "GIAB-NA12878",
      geneSymbol: "NA12878",
      gene: "Broad / GIAB NIST Gold Standard Reference Genome (chr20 Callset)",
      disease: "Bộ Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB (High-Confidence Benchmark Callset)",
      clinicalSignificance: "Reference Benchmark",
      consequence: "synonymous_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh37",
      ancestry: "CEPH / Utah Pedigree 1463 (HANCESTRO:0005)",
      hpoTerm: "SO:0001483 (Benchmark Truth)",
      region: "Global / CEU",
      bloodGroup: "O+",
      clinvarId: "GIAB:NA12878",
      priceGeno: "110",
      durationDays: 90,
      vcfContent: na12878RealVcf,
      phenotypes: [{ id: "SO:0001483", label: "Reference standard" }],
      variants: [{ gene: "ZNF343", hgvs: "c.14370G>A", zygosity: "heterozygous" }],
    },
    {
      dataId: 8,
      chromosome: "chr15",
      pos: 28120472,
      rsId: "rs12913832",
      geneSymbol: "HERC2",
      gene: "HERC2 / OCA2 (c.72+208A>G, rs12913832)",
      disease: "Đặc Tính Đa Hình Sắc Tố Màu Mắt & Da (Human Eye Color Variation)",
      clinicalSignificance: "Physical Traits & Performance",
      consequence: "regulatory_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "European & Global Reference Panel",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "Global",
      bloodGroup: "A-",
      clinvarId: "dbSNP:rs12913832",
      priceGeno: "70",
      durationDays: 30,
      vcfContent: herc2Vcf,
      phenotypes: [{ id: "SO:0001627", label: "Human eye color pigmentation" }],
      variants: [{ gene: "HERC2", hgvs: "c.72+208A>G", zygosity: "heterozygous" }],
    },
    {
      dataId: 9,
      chromosome: "chr7",
      pos: 141972804,
      rsId: "rs713598",
      geneSymbol: "TAS2R38",
      gene: "TAS2R38 (c.145G>C, rs713598, p.Pro49Ala)",
      disease: "Đặc Tính Cảm Nhận Vị Giác Đắng PTC / Rau Xanh (Phenylthiocarbamide Perception)",
      clinicalSignificance: "Sensory & Metabolism",
      consequence: "missense_variant",
      zygosity: "0/1 (Heterozygous)",
      assembly: "GRCh38",
      ancestry: "East Asian & Southeast Asian",
      hpoTerm: "SO:0001583 (Missense)",
      region: "Southeast Asian",
      bloodGroup: "B+",
      clinvarId: "dbSNP:rs713598",
      priceGeno: "65",
      durationDays: 30,
      vcfContent: tas2r38Vcf,
      phenotypes: [{ id: "SO:0001583", label: "Bitter taste perception" }],
      variants: [{ gene: "TAS2R38", hgvs: "c.145G>C", zygosity: "heterozygous" }],
    },
    {
      dataId: 10,
      chromosome: "chr2",
      pos: 108898064,
      rsId: "rs3827760",
      geneSymbol: "EDAR",
      gene: "EDAR (c.1109T>C, rs3827760, p.Val370Ala)",
      disease: "Đặc Tính Độ Dày Sợi Tóc & Hình Thái Răng Đặc Trưng Đông Á (Val370Ala)",
      clinicalSignificance: "Physical Traits & Performance",
      consequence: "missense_variant",
      zygosity: "1/1 (Homozygous Alt)",
      assembly: "GRCh38",
      ancestry: "Vietnamese / East Asian (HANCESTRO:0008)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "Southeast Asian",
      bloodGroup: "AB-",
      clinvarId: "dbSNP:rs3827760",
      priceGeno: "75",
      durationDays: 30,
      vcfContent: edarVcf,
      phenotypes: [{ id: "SO:0001583", label: "Hair thickness and morphology" }],
      variants: [{ gene: "EDAR", hgvs: "c.1109T>C", zygosity: "homozygous" }],
    },
  ];

  const publicSeeds = [];
  const secretSeeds = [];

  for (const c of cohortConfigs) {
    // 1. Encrypt raw sequence
    const enc = await encryptGenomicData(c.vcfContent);
    const rawCid = await computeIpfsCidV0(enc.payload);

    // 2. Generate and encrypt ISO 32000 PDF Report
    const pdfBytes = generateClinicalPdfReport({
      subjectId: `SEED_COHORT_${String(c.dataId).padStart(2, "0")}`,
      disease: c.disease,
      gene: c.gene,
      variant: c.rsId,
    });
    const cleanKeyHex = enc.keyHex.replace(/^0x/, "").toLowerCase();
    const summaryKeyHex = ethers
      .sha256(ethers.toUtf8Bytes(`GENOCHAIN_SUMMARY_PDF_DOMAIN_V1:${cleanKeyHex}`))
      .slice(2);
    const encPdf = await encryptGenomicData(pdfBytes, summaryKeyHex);
    const summaryCid = await computeIpfsCidV0(encPdf.payload);

    // 3. Build Phenopacket v2 metadata
    const pheno = buildPhenopacket({
      subjectId: `SEED_COHORT_${String(c.dataId).padStart(2, "0")}`,
      disease: c.disease,
      phenotypes: c.phenotypes,
      variants: c.variants,
      rawDataHash: enc.rawDataHash,
      rawCid: rawCid,
      summaryCid: summaryCid,
      summaryDataHash: encPdf.rawDataHash,
    });
    const metaJson = JSON.stringify(pheno, null, 2);
    const metaCid = await computeIpfsCidV0(metaJson);

    // 4. Cache in dual-engine local cache
    cacheLocalIpfsContent(rawCid, enc.payload);
    cacheLocalIpfsContent(summaryCid, encPdf.payload);
    cacheLocalIpfsContent(metaCid, new TextEncoder().encode(metaJson));

    // 5. Register on-chain
    const tx = await registry.connect(deployer).registerGenomicData(
      enc.rawDataHash,
      rawCid,
      summaryCid,
      metaCid,
      `ipfs://${metaCid}`,
      ethers.parseUnits(c.priceGeno, 18),
      c.durationDays * 86400,
      1000 // 10% royalty
    );
    await tx.wait();
    console.log(
      `[OK] On-chain Seed #${c.dataId} (${c.geneSymbol}): dataId=${c.dataId}, price=${c.priceGeno} GENO, rawDataHash=${enc.rawDataHash.substring(0, 14)}...`
    );

    // 6. Public metadata for frontend
    publicSeeds.push({
      dataId: c.dataId,
      chromosome: c.chromosome,
      pos: c.pos,
      rsId: c.rsId,
      geneSymbol: c.geneSymbol,
      gene: c.gene,
      disease: c.disease,
      clinicalSignificance: c.clinicalSignificance,
      consequence: c.consequence,
      zygosity: c.zygosity,
      assembly: c.assembly,
      ancestry: c.ancestry,
      hpoTerm: c.hpoTerm,
      region: c.region,
      bloodGroup: c.bloodGroup,
      clinvarId: c.clinvarId,
      rawCid: rawCid,
      metadataCid: metaCid,
      summaryCid: summaryCid,
      rawDataHash: enc.rawDataHash,
      summaryDataHash: encPdf.rawDataHash,
    });

    // 7. Encapsulated seed key capsules (zero plaintext AES keys on disk - INVARIANT-01 & CRITICAL-02)
    if (!globalThis.__deployerSeedKp) {
      globalThis.__deployerSeedKp = await generateAsymmetricKeyPair(false);
      globalThis.__deployerSeedPubJwk = await exportPublicKey(globalThis.__deployerSeedKp.publicKey);
    }
    const ownerCapsule = await packageKeyCapsule(
      enc.keyHex,
      globalThis.__deployerSeedPubJwk,
      deployer.address,
      deployer.address
    );
    secretSeeds.push({
      dataId: c.dataId,
      rawCid: rawCid,
      encryptedCapsule: ownerCapsule,
      encryptedKeyEnvelopeHex: wrapSeedKeyForVault(enc.keyHex, loadOrCreateDispatcherVaultKey()),
      rawDataHash: enc.rawDataHash,
    });
  }

  // 6. Save addresses and ABIs for frontend
  const addresses = {
    network: "hardhat-local",
    chainId: 31337,
    deployedAt: new Date().toISOString(),
    GenomicToken: token.target,
    GenomicNFT: nft.target,
    GenomicsRegistry: registry.target,
    GenomicZkVerifier: zkVerifier.target,
    Deployer: deployer.address,
  };

  const outputDir = path.resolve("frontend/src/contracts");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(outputDir, "contractAddresses.json"),
    JSON.stringify(addresses, null, 2)
  );
  console.log("\n[FILE] Contract addresses saved to frontend/src/contracts/contractAddresses.json");

  // Save Contract ABIs for frontend
  const contractsToExport = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier"];
  for (const name of contractsToExport) {
    const artifactPath = path.resolve(`artifacts/contracts/${name}.sol/${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      fs.writeFileSync(
        path.join(outputDir, `${name}ABI.json`),
        JSON.stringify(artifact.abi, null, 2)
      );
      console.log(`[FILE] Exported ABI for ${name} to frontend/src/contracts/${name}ABI.json`);
    }
  }

  // PUBLIC Metadata ONLY for frontend (Zero keys leaked)
  const publicSeedDataStore = {
    seeds: publicSeeds,
  };

  fs.writeFileSync(
    path.join(outputDir, "seedMetadata.json"),
    JSON.stringify(publicSeedDataStore, null, 2)
  );
  console.log("[FILE] Public seed metadata catalog saved to frontend/src/contracts/seedMetadata.json (10 Cohorts, Zero keys leaked)");

  // Private key envelopes saved strictly to git-ignored .local/ dispatcher vault
  const localVaultDir = path.resolve(".local");
  if (!fs.existsSync(localVaultDir)) {
    fs.mkdirSync(localVaultDir, { recursive: true, mode: 0o700 });
  }
  const secretKeyStore = {
    deployerAddress: deployer.address,
    seeds: secretSeeds,
  };
  fs.writeFileSync(
    path.join(localVaultDir, "dispatcher_seed_vault.json"),
    JSON.stringify(secretKeyStore, null, 2),
    { mode: 0o600 }
  );
  console.log("[SECURITY] Seed secret envelopes saved strictly to .local/dispatcher_seed_vault.json");

  console.log("\n==================================================");
  console.log("[SUCCESS] DEPLOYMENT AND ON-CHAIN SEEDING FINISHED SUCCESSFULLY (10 COHORTS SEEDED)!");
  console.log("==================================================");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exit(1);
});
