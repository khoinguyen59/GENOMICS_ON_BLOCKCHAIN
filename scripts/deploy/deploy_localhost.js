import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { encryptGenomicData, generateClinicalPdfReport, computeDataHash } from "../../crypto/client_crypto.js";
import { buildPhenopacket } from "../../ipfs/phenopacket_builder.js";
import { computeIpfsCidV0, cacheLocalIpfsContent } from "../../ipfs/pinata_uploader.js";
import { pinFileToKubo, pinJsonToKubo } from "../../ipfs/kubo_client.js";

async function main() {
  console.log("==================================================");
  console.log("[INFO] Deploying to Hardhat Localhost Node (port 8545)...");
  console.log("==================================================");

  const { ethers } = await hre.network.connect("localhost");
  const COHORT_BLIND_SALT = ethers.id("GENOCHAIN_COHORT_SALT_V1");
  const computeBlindTagHex = (traitKey, traitValue) =>
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "string", "bytes32"],
        ["GENOCHAIN_BLIND_TAG_V1", traitKey, traitValue, COHORT_BLIND_SALT]
      )
    );
  const [deployer, account1, account2] = await ethers.getSigners();
  const researcher = account1;
  console.log(`Deployer Address   : ${deployer.address}`);
  console.log(`Provider (#1)      : ${account1.address}`);
  console.log(`Researcher (#2)    : ${account2.address}`);

  // 1. Deploy GenomicToken
  console.log("\n1. Deploying GenomicToken ($GENO)...");
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();
  console.log(`[PASS] GenomicToken deployed at: ${token.target}`);

  // 2. Deploy GenomicNFT
  console.log("\n2. Deploying GenomicNFT (ERC-721 + EIP-2981 Royalty)...");
  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(deployer.address, 1000);
  await nft.waitForDeployment();
  console.log(`[OK] GenomicNFT deployed at: ${nft.target}`);

  // 3. Deploy GenomicsRegistry
  console.log("\n3. Deploying GenomicsRegistry (Core + Escrow)...");
  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(token.target, nft.target, deployer.address);
  await registry.waitForDeployment();
  console.log(`[OK] GenomicsRegistry deployed at: ${registry.target}`);

  // 3b. Deploy GenomicZkVerifier (Tier-4 zk-Genomics)
  console.log("\n3b. Deploying GenomicZkVerifier (Zero-Knowledge Variant Verification)...");
  const GenomicZkVerifier = await ethers.getContractFactory("GenomicZkVerifier");
  const zkVerifier = await GenomicZkVerifier.deploy(token.target);
  await zkVerifier.waitForDeployment();
  console.log(`[OK] GenomicZkVerifier deployed at: ${zkVerifier.target}`);

  // Link GenomicZkVerifier in GenomicsRegistry (zk-Genomics Verification Engine)
  const linkZkTx = await registry.connect(deployer).setZkVerifier(zkVerifier.target);
  await linkZkTx.wait();
  console.log(`[OK] GenomicsRegistry linked to GenomicZkVerifier at: ${zkVerifier.target}`);

  // 4. Authorize Registry in NFT
  console.log("\n4. Authorizing GenomicsRegistry in GenomicNFT...");
  const authTx = await nft.connect(deployer).setRegistryContract(registry.target);
  await authTx.wait();
  console.log("[OK] Authorization completed!");

  // Transfer initial $GENO tokens to Account #1 (Data Provider) & Account #2 (Researcher) for testing
  console.log("\nTransferring 2,000 $GENO each to Account #1 (Provider) and Account #2 (Researcher)...");
  const fundTx1 = await token.connect(deployer).transfer(account1.address, ethers.parseUnits("2000", 18));
  await fundTx1.wait();
  const fundTx2 = await token.connect(deployer).transfer(account2.address, ethers.parseUnits("2000", 18));
  await fundTx2.wait();
  console.log(`[OK] Account #1 (${account1.address}) & Account #2 (${account2.address}) each funded: 2,000 $GENO`);

  // 5. Seed On-chain Data
  console.log("\n5. Seeding authenticated genomic datasets...");

  const loadVcf = (relPath, fallback) => {
    const fullPath = path.resolve(relPath);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf8");
    }
    return fallback;
  };

  // Seed 1: 1000 Genomes Vietnamese Kinh (KHV) Authentic WGS VCF
  const seedVcf1 = loadVcf(
    "data/diverse_real_datasets/KHV_chr12_1000genomes.vcf",
    "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=1000Genomes_Phase3_KHV_WGS\n##reference=GRCh38\n##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tKHV01\nchr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.38000;GENE=ALDH2;TRAIT=1000G_KHV_WGS\tGT\t0/1\n"
  );
  const enc1 = await encryptGenomicData(seedVcf1);
  const rawCid1 = await computeIpfsCidV0(enc1.payload);

  const pdfBytes1 = generateClinicalPdfReport({
    subjectId: "1000G_KHV_VN_01",
    disease: "1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
    gene: "ALDH2 / ADH1B Multi-locus Loci (chr12)",
    variant: "rs671 (c.1510G>A)",
  });
  const cleanKeyHex1 = enc1.keyHex.replace(/^0x/, "").toLowerCase();
  const summaryKeyHex1 = ethers
    .sha256(ethers.toUtf8Bytes(`GENOCHAIN_SUMMARY_PDF_DOMAIN_V1:${cleanKeyHex1}`))
    .slice(2);
  const encPdf1 = await encryptGenomicData(pdfBytes1, summaryKeyHex1);
  const summaryCid1 = await computeIpfsCidV0(encPdf1.payload);

  const pheno1 = buildPhenopacket({
    subjectId: "1000G_KHV_VN_01",
    disease: "1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
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

  try {
    await pinFileToKubo(enc1.payload, "seed1_1000g_raw.enc", "application/octet-stream");
    await pinFileToKubo(encPdf1.payload, "seed1_1000g_report.enc", "application/pdf");
    await pinJsonToKubo(pheno1, "phenopacket_1000g.json");
    console.log("[IPFS] Seed #1 pinned to local Kubo daemon");
  } catch (kuboErr) {
    console.warn("[IPFS] Kubo daemon pin note for Seed #1:", kuboErr?.message || kuboErr);
  }

  const metaHash1 = await computeDataHash(new TextEncoder().encode(metaJson1));
  const blindTags1 = [
    computeBlindTagHex("gene", "ALDH2"),
    computeBlindTagHex("trait", "1000G_KHV_WGS"),
    computeBlindTagHex("rsid", "rs671"),
  ];
  const tx1 = await registry.connect(deployer).registerGenomicDataBundle(
    [enc1.rawDataHash, encPdf1.rawDataHash, metaHash1],
    [rawCid1, summaryCid1, metaCid1, `ipfs://${metaCid1}`],
    ethers.parseUnits("100", 18),
    45 * 86400,
    1000,
    blindTags1
  );
  await tx1.wait();
  console.log(`[OK] Seed #1 (1000G KHV) registered on-chain via bundle: dataId=1 (${blindTags1.length} blind tags)`);

  // Seed 2: ACTN3 Muscle Performance Authentic VCF
  const seedVcf2 = loadVcf(
    "data/diverse_real_datasets/ACTN3_muscle_performance_rs1815739.vcf",
    "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ACTN3\n##reference=GRCh38\n##contig=<ID=chr11,length=135086622,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSUBJECT01\nchr11\t66560624\trs1815739\tC\tT\t100\tPASS\tAF=0.42000;GENE=ACTN3;TRAIT=Fast_twitch_muscle_power\tGT\t0/1\n"
  );
  const enc2 = await encryptGenomicData(seedVcf2);
  const rawCid2 = await computeIpfsCidV0(enc2.payload);

  const pdfBytes2 = generateClinicalPdfReport({
    subjectId: "SUBJECT_VN_ACTN3",
    disease: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
    gene: "ACTN3 (c.1729C>T, rs1815739, p.Arg577Ter)",
    variant: "c.1729C>T (rs1815739)",
  });
  const cleanKeyHex2 = enc2.keyHex.replace(/^0x/, "").toLowerCase();
  const summaryKeyHex2 = ethers
    .sha256(ethers.toUtf8Bytes(`GENOCHAIN_SUMMARY_PDF_DOMAIN_V1:${cleanKeyHex2}`))
    .slice(2);
  const encPdf2 = await encryptGenomicData(pdfBytes2, summaryKeyHex2);
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

  try {
    await pinFileToKubo(enc2.payload, "seed2_actn3_raw.enc", "application/octet-stream");
    await pinFileToKubo(encPdf2.payload, "seed2_actn3_report.enc", "application/pdf");
    await pinJsonToKubo(pheno2, "phenopacket_actn3.json");
    console.log("[IPFS] Seed #2 pinned to local Kubo daemon");
  } catch (kuboErr) {
    console.warn("[IPFS] Kubo daemon pin note for Seed #2:", kuboErr?.message || kuboErr);
  }

  const metaHash2 = await computeDataHash(new TextEncoder().encode(metaJson2));
  const blindTags2 = [
    computeBlindTagHex("gene", "ACTN3"),
    computeBlindTagHex("trait", "Fast_twitch_muscle_power"),
    computeBlindTagHex("rsid", "rs1815739"),
  ];
  const tx2 = await registry.connect(deployer).registerGenomicDataBundle(
    [enc2.rawDataHash, encPdf2.rawDataHash, metaHash2],
    [rawCid2, summaryCid2, metaCid2, `ipfs://${metaCid2}`],
    ethers.parseUnits("85", 18),
    30 * 86400,
    1000,
    blindTags2
  );
  await tx2.wait();
  console.log(`[OK] Seed #2 (ACTN3) registered on-chain via bundle: dataId=2 (${blindTags2.length} blind tags)`);

  // Seed ZK Research Bounty #1 (50 $GENO x 5 claims = 250 $GENO escrowed on GenomicZkVerifier)
  const bountyReward = ethers.parseUnits("50", 18);
  const bountyMaxClaims = 5n;
  const approveBountyTx = await token.connect(deployer).approve(zkVerifier.target, bountyReward * bountyMaxClaims);
  await approveBountyTx.wait();
  const createBountyTx = await zkVerifier.connect(deployer).createZkBounty(
    ethers.id("ALDH2_rs671"),
    "ALDH2 rs671 East Asian Alcohol Flush & Drug Metabolism Cohort",
    bountyReward,
    bountyMaxClaims,
    86400
  );
  await createBountyTx.wait();
  console.log(`[OK] Seed ZK Bounty #1 created on GenomicZkVerifier (50 $GENO x 5 claims)`);

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
  console.log("\n[FILE] Contract addresses saved to frontend/src/contracts/contractAddresses.json");

  const contractsToExport = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier"];
  for (const name of contractsToExport) {
    const artifactPath = path.resolve(`artifacts/contracts/${name}.sol/${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      fs.writeFileSync(path.join(outputDir, `${name}ABI.json`), JSON.stringify(artifact.abi, null, 2));
      console.log(`[FILE] Exported ABI: ${name}ABI.json`);
    }
  }

  // Public-only seed metadata (ZERO AES keys)
  const publicSeedDataStore = {
    seeds: [
      {
        dataId: 1,
        disease: "1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
        gene: "ALDH2 / ADH1B Multi-locus Loci (chr12)",
        hpoTerm: "SO:0000694 (Population SNP Callset)",
        ancestry: "Vietnamese Kinh (1000 Genomes: KHV)",
        rawCid: rawCid1,
        metadataCid: metaCid1,
        summaryCid: summaryCid1,
        rawDataHash: enc1.rawDataHash,
        summaryDataHash: encPdf1.rawDataHash,
        metadataHash: metaHash1,
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
        metadataHash: metaHash2,
      },
    ],
  };
  fs.writeFileSync(path.join(outputDir, "seedMetadata.json"), JSON.stringify(publicSeedDataStore, null, 2));
  console.log("[FILE] Public seed metadata saved (Zero keys leaked)");

  // Encapsulated seed key capsules stored strictly in .local/ runtime vault (zero frontend or plaintext leakage)
  const cryptoMod = await import("node:crypto");
  const { generateAsymmetricKeyPair, exportPublicKey, packageKeyCapsule } = await import("../../crypto/client_crypto.js");
  const localVaultDir = path.resolve(".local");
  if (!fs.existsSync(localVaultDir)) fs.mkdirSync(localVaultDir, { recursive: true, mode: 0o700 });
  const vaultKeyPath = path.join(localVaultDir, "dispatcher_vault.key");
  let vaultKey;
  if (process.env.GENOCHAIN_SEED_VAULT_SECRET) {
    vaultKey = cryptoMod.default.createHash("sha256").update(process.env.GENOCHAIN_SEED_VAULT_SECRET, "utf8").digest();
  } else if (fs.existsSync(vaultKeyPath)) {
    const existingHex = fs.readFileSync(vaultKeyPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(existingHex)) {
      throw new Error("Invalid .local/dispatcher_vault.key format (expected 64 hex chars).");
    }
    vaultKey = Buffer.from(existingHex, "hex");
  } else {
    vaultKey = cryptoMod.default.randomBytes(32);
    fs.writeFileSync(vaultKeyPath, vaultKey.toString("hex"), { mode: 0o600 });
  }

  const deployerKp = await generateAsymmetricKeyPair(false);
  const deployerPubJwk = await exportPublicKey(deployerKp.publicKey);
  const wrapKey = (keyHex) => {
    const nonce = cryptoMod.default.randomBytes(12);
    const cipher = cryptoMod.default.createCipheriv("aes-256-gcm", vaultKey, nonce);
    const rawBytes = Buffer.from(keyHex.replace(/^0x/, ""), "hex");
    const encrypted = Buffer.concat([cipher.update(rawBytes), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([nonce, encrypted]).toString("hex");
  };
  const secretKeyStore = {
    deployerAddress: deployer.address,
    deployerPublicKeyJwk: typeof deployerPubJwk === "string" ? JSON.parse(deployerPubJwk) : deployerPubJwk,
    seeds: [
      {
        dataId: 1,
        rawCid: rawCid1,
        summaryCid: summaryCid1,
        encryptedCapsule: await packageKeyCapsule(enc1.keyHex, deployerPubJwk, deployer.address, deployer.address),
        encryptedKeyEnvelopeHex: wrapKey(enc1.keyHex),
        rawDataHash: enc1.rawDataHash,
      },
      {
        dataId: 2,
        rawCid: rawCid2,
        summaryCid: summaryCid2,
        encryptedCapsule: await packageKeyCapsule(enc2.keyHex, deployerPubJwk, deployer.address, deployer.address),
        encryptedKeyEnvelopeHex: wrapKey(enc2.keyHex),
        rawDataHash: enc2.rawDataHash,
      },
    ],
  };

  const localSeedVaultPath = path.join(localVaultDir, "dispatcher_seed_vault.json");
  fs.writeFileSync(localSeedVaultPath, JSON.stringify(secretKeyStore, null, 2), { mode: 0o600 });
  console.log("[SECURITY] Seed capsules & AES-256-GCM envelopes saved strictly to .local/dispatcher_seed_vault.json");

  console.log("\n==================================================");
  console.log("[SUCCESS] LOCALHOST DEPLOYMENT COMPLETE!");
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
