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
  computeDataHash,
} from "../../crypto/client_crypto.js";
import { buildPhenopacket } from "../../ipfs/phenopacket_builder.js";
import { computeIpfsCidV0, cacheLocalIpfsContent } from "../../ipfs/pinata_uploader.js";
import { pinFileToKubo, pinJsonToKubo, getKuboRpcEndpoint } from "../../ipfs/kubo_client.js";
import { runLocalGroth16Ceremony } from "../demo/zk_ceremony_helper.mjs";

const VAULT_KDF_DOMAIN = "GENOCHAIN_SEED_VAULT_KDF_V2";
const VAULT_KDF_ITERATIONS = 210000;

function parseEnvFlag(name) {
  const val = String(process.env[name] || "").trim().toLowerCase();
  return val === "1" || val === "true" || val === "yes";
}

function loadOrCreateDispatcherVaultKey() {
  if (process.env.GENOCHAIN_SEED_VAULT_SECRET) {
    const secret = String(process.env.GENOCHAIN_SEED_VAULT_SECRET);
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.pbkdf2Sync(
      Buffer.from(`${VAULT_KDF_DOMAIN}:${secret}`, "utf8"),
      salt,
      VAULT_KDF_ITERATIONS,
      32,
      "sha256"
    );
    return {
      key: derivedKey,
      kdfMeta: {
        mode: "env-pbkdf2",
        algorithm: "PBKDF2-HMAC-SHA256",
        iterations: VAULT_KDF_ITERATIONS,
        saltHex: salt.toString("hex"),
        domain: VAULT_KDF_DOMAIN,
      },
    };
  }
  const localDir = path.resolve(process.env.LOCAL_VAULT_DIR || ".local");
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
  }
  const keyPath = path.join(localDir, "dispatcher_vault.key");
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("Invalid .local/dispatcher_vault.key format (expected 64 hex chars).");
    }
    return {
      key: Buffer.from(hex, "hex"),
      kdfMeta: { mode: "keyfile", algorithm: "raw-256" },
    };
  }
  const randomKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, randomKey.toString("hex"), { mode: 0o600 });
  return {
    key: randomKey,
    kdfMeta: { mode: "keyfile", algorithm: "raw-256" },
  };
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

  const requireIpfs = parseEnvFlag("REQUIRE_IPFS");
  const skipSeeding = parseEnvFlag("SKIP_SEEDING");
  const disableFaucet = parseEnvFlag("DISABLE_FAUCET");
  const skipZkCeremony = parseEnvFlag("SKIP_ZK_CEREMONY");
  const enableTimelock = parseEnvFlag("ENABLE_TIMELOCK");
  const rawFaucetVoucherSigner = String(process.env.FAUCET_VOUCHER_SIGNER || "").trim();
  const rawCapsuleDispatcher = String(process.env.CAPSULE_DISPATCHER_ADDRESS || "").trim();
  const rawInitialLabAttestor = String(process.env.INITIAL_LAB_ATTESTOR || "").trim();

  const kuboRpcPreflight = getKuboRpcEndpoint();
  if (requireIpfs && !skipSeeding) {
    let preflightOk = false;
    try {
      const probe = await fetch(`${kuboRpcPreflight}/api/v0/version`, { method: "POST", signal: AbortSignal.timeout(1200) });
      preflightOk = Boolean(probe && probe.ok);
    } catch (_) {
      preflightOk = false;
    }
    if (!preflightOk) {
      throw new Error(
        `[IPFS] REQUIRE_IPFS=1 is enabled, but local Kubo daemon is not reachable at ${kuboRpcPreflight}. Aborting deployment before sending transactions.`
      );
    }
  }

  const targetNetwork =
    process.env.DEPLOY_TARGET_NETWORK || hre.network?.name || hre.globalOptions?.network || "localhost";
  const connection = await hre.network.connect(targetNetwork);
  const { ethers } = connection;
  const [deployer, account1, researcher] = await ethers.getSigners();
  console.log(`Target Network     : ${targetNetwork}`);
  console.log(`Deployer Address   : ${deployer.address}`);
  if (account1) {
    console.log(`Provider (#1)      : ${account1.address}`);
  }
  if (researcher) {
    console.log(`Researcher (#2)    : ${researcher.address}`);
  }
  console.log(`Production Flags   : SKIP_SEEDING=${skipSeeding ? 1 : 0}, DISABLE_FAUCET=${disableFaucet ? 1 : 0}, ENABLE_TIMELOCK=${enableTimelock ? 1 : 0}`);

  let faucetVoucherSigner = null;
  if (rawFaucetVoucherSigner) {
    if (!ethers.isAddress(rawFaucetVoucherSigner)) {
      throw new Error(`[TOKEN] Invalid FAUCET_VOUCHER_SIGNER address: "${rawFaucetVoucherSigner}"`);
    }
    const normalizedSigner = ethers.getAddress(rawFaucetVoucherSigner);
    if (normalizedSigner === ethers.ZeroAddress) {
      throw new Error(`[TOKEN] Invalid FAUCET_VOUCHER_SIGNER: zero address (${ethers.ZeroAddress}) is forbidden.`);
    }
    faucetVoucherSigner = normalizedSigner;
  }

  let configuredCapsuleDispatcher = null;
  if (rawCapsuleDispatcher) {
    if (!ethers.isAddress(rawCapsuleDispatcher)) {
      throw new Error(`[ROLE] Invalid CAPSULE_DISPATCHER_ADDRESS: "${rawCapsuleDispatcher}"`);
    }
    const normDisp = ethers.getAddress(rawCapsuleDispatcher);
    if (normDisp === ethers.ZeroAddress) {
      throw new Error(`[ROLE] Invalid CAPSULE_DISPATCHER_ADDRESS: zero address (${ethers.ZeroAddress}) is forbidden.`);
    }
    configuredCapsuleDispatcher = normDisp;
  }

  let configuredLabAttestor = null;
  if (rawInitialLabAttestor) {
    if (!ethers.isAddress(rawInitialLabAttestor)) {
      throw new Error(`[ZK] Invalid INITIAL_LAB_ATTESTOR address: "${rawInitialLabAttestor}"`);
    }
    const normLab = ethers.getAddress(rawInitialLabAttestor);
    if (normLab === ethers.ZeroAddress) {
      throw new Error(`[ZK] Invalid INITIAL_LAB_ATTESTOR: zero address (${ethers.ZeroAddress}) is forbidden.`);
    }
    configuredLabAttestor = normLab;
  }

  // Fail-fast Timelock governance env validation BEFORE sending any deployment transactions (0 gas wasted)
  let timelockConfig = null;
  if (enableTimelock) {
    const rawDelayEnv = process.env.TIMELOCK_DELAY_SEC;
    let minDelaySec = 172800;
    if (rawDelayEnv !== undefined && String(rawDelayEnv).trim() !== "") {
      const trimmedDelay = String(rawDelayEnv).trim();
      if (!/^\d+$/.test(trimmedDelay)) {
        throw new Error(
          `[GOV] Invalid TIMELOCK_DELAY_SEC="${rawDelayEnv}": must be a non-negative integer number of seconds.`
        );
      }
      const parsedDelay = Number(trimmedDelay);
      if (!Number.isSafeInteger(parsedDelay) || parsedDelay < 0) {
        throw new Error(
          `[GOV] Invalid TIMELOCK_DELAY_SEC="${rawDelayEnv}": must be a non-negative safe integer.`
        );
      }
      if (parsedDelay < 60) {
        console.warn(`[GOV] Clamping TIMELOCK_DELAY_SEC=${parsedDelay}s up to minimum safe delay 60s.`);
      }
      minDelaySec = Math.max(60, parsedDelay);
    }

    const parseAddressListEnv = (envName, fallbackList, allowZeroAddress = false) => {
      const raw = process.env[envName];
      if (raw === undefined || String(raw).trim() === "") {
        return fallbackList;
      }
      const list = String(raw)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (list.length === 0) {
        throw new Error(`[GOV] Invalid ${envName}: must contain at least one valid EVM address.`);
      }
      const seen = new Set();
      const deduped = [];
      for (const addr of list) {
        if (!ethers.isAddress(addr)) {
          throw new Error(`[GOV] Invalid EVM address in ${envName}: "${addr}"`);
        }
        const normalized = ethers.getAddress(addr);
        if (!allowZeroAddress && normalized === ethers.ZeroAddress) {
          throw new Error(`[GOV] Invalid ${envName}: zero address (${ethers.ZeroAddress}) is forbidden.`);
        }
        const lower = normalized.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          deduped.push(normalized);
        }
      }
      return deduped;
    };

    const timelockProposers = parseAddressListEnv("TIMELOCK_PROPOSERS", [deployer.address], false);
    const timelockExecutors = parseAddressListEnv("TIMELOCK_EXECUTORS", [deployer.address], true);

    let timelockAdmin = ethers.ZeroAddress;
    if (process.env.TIMELOCK_ADMIN !== undefined && String(process.env.TIMELOCK_ADMIN).trim() !== "") {
      const rawAdmin = String(process.env.TIMELOCK_ADMIN).trim();
      if (!ethers.isAddress(rawAdmin)) {
        throw new Error(`[GOV] Invalid TIMELOCK_ADMIN address: "${rawAdmin}"`);
      }
      timelockAdmin = rawAdmin;
    }

    timelockConfig = {
      minDelaySec,
      proposers: timelockProposers,
      executors: timelockExecutors,
      admin: timelockAdmin,
    };
  }

  // Capture block height BEFORE deploying the first contract so historical log scans
  // (OpenSeaActivityFeed, datasetService, capsule_dispatcher) never miss seed or genesis events.
  const deployStartBlock = Number(await ethers.provider.getBlockNumber());
  console.log(`[CHAIN] Pre-deploy start block: ${deployStartBlock}`);

  // 1. Deploy GenomicToken (ERC-20)
  console.log("\n1. Deploying GenomicToken ($GENO)...");
  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(deployer.address);
  await token.waitForDeployment();
  console.log(`[OK] GenomicToken deployed at: ${token.target}`);

  // Apply production faucet policy BEFORE optional Timelock handoff
  if (disableFaucet || faucetVoucherSigner) {
    const enabled = !disableFaucet;
    const voucherRequired = Boolean(faucetVoucherSigner);
    const signerAddr = faucetVoucherSigner || ethers.ZeroAddress;
    const faucetCfgTx = await token.connect(deployer).setFaucetConfig(enabled, voucherRequired, signerAddr);
    await faucetCfgTx.wait();
    console.log(
      `[TOKEN] Faucet policy configured: enabled=${enabled}, voucherRequired=${voucherRequired}, signer=${signerAddr}`
    );
  }

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

  // Least-privilege Capsule Dispatcher assignment:
  // - Under SKIP_SEEDING=1 (production), ONLY authorize CAPSULE_DISPATCHER_ADDRESS if explicitly configured.
  // - Under default local dev seeding (SKIP_SEEDING != 1), authorize configured address or deployer.
  const targetDispatcher = configuredCapsuleDispatcher || (!skipSeeding ? deployer.address : null);
  if (targetDispatcher) {
    const dispTx = await registry.connect(deployer).setCapsuleDispatcher(targetDispatcher);
    await dispTx.wait();
    console.log(`[OK] Capsule Dispatcher authorized: ${targetDispatcher}`);
  } else {
    const disableDispTx = await registry.connect(deployer).disableCapsuleDispatcher();
    await disableDispTx.wait();
    const verifiedDispatcher = await registry.capsuleDispatcher();
    if (verifiedDispatcher !== ethers.ZeroAddress) {
      throw new Error(
        `[PROD] Failed to disable capsuleDispatcher on-chain: expected ${ethers.ZeroAddress}, got ${verifiedDispatcher}`
      );
    }
    console.log(
      `[PROD] SKIP_SEEDING=1 & CAPSULE_DISPATCHER_ADDRESS unset -> capsuleDispatcher disabled to ${verifiedDispatcher} on-chain (least-privilege sovereign mode).`
    );
  }

  // Run local BN254 Groth16 ceremony setup on GenomicZkVerifier (skip only if SKIP_ZK_CEREMONY=1)
  if (!skipZkCeremony) {
    const crsRecord = await runLocalGroth16Ceremony(zkVerifier, deployer);
    console.log(`[OK] Configured BN254 Groth16 Ceremony Verification Key (vkEpoch=${crsRecord.vkEpoch}).`);
  } else {
    console.log("[ZK] SKIP_ZK_CEREMONY=1 -> Skipped local Groth16 VK setup.");
  }

  // Least-privilege Lab Attestor assignment (always enforces requireLabAttestation=true):
  // - Under SKIP_SEEDING=1, ONLY approve INITIAL_LAB_ATTESTOR if explicitly configured.
  // - Under default local dev seeding (SKIP_SEEDING != 1), approve configured address or deployer.
  const targetLabAttestor = configuredLabAttestor || (!skipSeeding ? deployer.address : null);
  if (targetLabAttestor) {
    await (await zkVerifier.connect(deployer).setApprovedLabAttestor(targetLabAttestor, true)).wait();
    console.log(`[OK] Certified Lab Attestor approved (${targetLabAttestor}).`);
  } else {
    console.log("[PROD] SKIP_SEEDING=1 & INITIAL_LAB_ATTESTOR unset -> zero initial lab attestors approved (deployer least-privilege).");
  }
  await (await zkVerifier.connect(deployer).setRequireLabAttestation(true)).wait();
  console.log("[OK] requireLabAttestation=true enforced on GenomicZkVerifier.");

  const publicSeeds = [];
  const secretSeeds = [];
  let dispatcherVaultMeta = { mode: "none", algorithm: "none" };

  if (!skipSeeding) {
    // Fund Account #1 (Provider) and Account #2 (Researcher) with 2,000 $GENO each
    if (account1) {
      const f1 = await token.connect(deployer).transfer(account1.address, ethers.parseUnits("2000", 18));
      await f1.wait();
    }
    if (researcher) {
      const f2 = await token.connect(deployer).transfer(researcher.address, ethers.parseUnits("2000", 18));
      await f2.wait();
    }
    console.log("[OK] Funded Account #1 & Account #2 with 2,000 $GENO each.");

    // Seed BOTH ZK Research Bounty #1 (50 $GENO x 5 claims = 250 $GENO)
    // AND Bounty #2 (60 $GENO x 5 claims = 300 $GENO) as Certified Lab-Attested bounties (zero unattested Sybil bounties)
    const bountyReward = ethers.parseUnits("50", 18);
    const bountyMaxClaims = 5n;
    const attestedBountyReward = ethers.parseUnits("60", 18);
    const attestedBountyMaxClaims = 5n;
    const totalSeedBountyFunding = bountyReward * bountyMaxClaims + attestedBountyReward * attestedBountyMaxClaims;
    const approveBountyTx = await token.connect(deployer).approve(zkVerifier.target, totalSeedBountyFunding);
    await approveBountyTx.wait();
    const createBountyTx = await zkVerifier.connect(deployer).createAttestedZkBounty(
      ethers.id("ALDH2_rs671"),
      "ALDH2 rs671 East Asian Certified Lab-Attested Metabolism Cohort",
      bountyReward,
      bountyMaxClaims,
      86400,
      deployer.address
    );
    await createBountyTx.wait();
    console.log(`[OK] Seed ZK Bounty #1 created on GenomicZkVerifier (50 $GENO x 5 claims, Certified Lab-Attested by ${deployer.address}).`);

    const createAttestedBountyTx = await zkVerifier.connect(deployer).createAttestedZkBounty(
      ethers.id("ACTN3_rs1815739"),
      "ACTN3 rs1815739 Certified Sequencing-Lab Attested Athletic Cohort",
      attestedBountyReward,
      attestedBountyMaxClaims,
      86400,
      deployer.address
    );
    await createAttestedBountyTx.wait();
    console.log(`[OK] Seed ZK Bounty #2 created on GenomicZkVerifier (60 $GENO x 5 claims, Certified Lab-Attested by ${deployer.address}).`);

    // 5. Seed 13 Authenticated Pure Genomic & Population Reference Cohorts On-Chain
    console.log("\n5. Seeding 13 authentic pure genomic cohorts on-chain...");

  // Load real NA12878 GIAB benchmark VCF if available
  let na12878RealVcf = "";
  const na12878Path = path.resolve("data/downloaded_real_samples/NA12878_chr20_sample.vcf");
  if (fs.existsSync(na12878Path)) {
    na12878RealVcf = fs.readFileSync(na12878Path, "utf8");
    console.log(`[OK] Loaded authentic Broad Institute GIAB NA12878 VCF (${na12878RealVcf.length} bytes)`);
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
  const wgsFastq = loadVcf("data/diverse_real_datasets/Illumina_WGS_reads_sample.fastq", "@A00519:124:HHNJTDSXX:1:1101:1000:1120 1:N:0:GATCGT\nNATGATTCCTTTCATGACCGCTGCGATGGCCTCATGCTCACCAGCTCGTTCTTCATCACCTTCACGAACCCGCCACCGCTC\n+\n#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF\n");
  const chrmFasta = loadVcf("data/diverse_real_datasets/GRCh38_chrM_mitochondrial.fa", ">chrM NC_012920.1 Homo sapiens mitochondrion, complete circular genome (GRCh38 reference)\nGATCACAGGTCTATCACCCTATTAACCACTCACGGGAGCTCTCCATGCATTTGGTATTTTCGTCTGGGGGGTGTGCACG\n");
  const samtoolsVcf = loadVcf("data/downloaded_real_samples/SAMtools_bcftools_view.vcf", "##fileformat=VCFv4.2\n##reference=GRCh37\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA00001\n20\t76962\trs6111385\tT\tC\t999\tPASS\tDP=911531\tGT\t0/1\n");

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
      ancestry: "Vietnamese Kinh (1000 Genomes: KHV, HANCESTRO:0021)",
      hpoTerm: "SO:0000694 (Population SNP Callset)",
      region: "Vietnamese (Kinh)",
      bloodGroup: "O+",
      clinvarId: "1000G:KHV",
      fileFormat: "VCF v4.2",
      platform: "1000 Genomes WGS",
      priceGeno: "100",
      durationDays: 45,
      vcfContent: khvVcf,
      phenotypes: [{ id: "SO:0000694", label: "Population SNP Callset" }],
      variants: [{ gene: "ALDH2", chrom: "chr12", pos: 111803962, rsId: "rs671", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
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
      ancestry: "Global Multi-ethnic Cohort (HANCESTRO:0004)",
      hpoTerm: "SO:0001587 (Stop-gained)",
      region: "Global",
      bloodGroup: "O+",
      clinvarId: "dbSNP:rs1815739",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "85",
      durationDays: 30,
      vcfContent: actn3Vcf,
      phenotypes: [{ id: "SO:0001587", label: "Fast-twitch muscle fiber trait" }],
      variants: [{ gene: "ACTN3", chrom: "chr11", pos: 66560624, rsId: "rs1815739", hgvs: "c.1729C>T", zygosity: "heterozygous" }],
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
      ancestry: "Vietnamese Kinh / East Asian (HANCESTRO:0021)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "East Asian",
      bloodGroup: "A+",
      clinvarId: "dbSNP:rs671",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "80",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ALDH2\n##reference=GRCh38\n##contig=<ID=chr12,length=133275309,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_01\nchr12\t111803962\trs671\tG\tA\t999\tPASS\tAF=0.380;GENE=ALDH2;TRAIT=Alcohol_sensitivity;CLNSIG=Affects;CLNDN=Alcohol_sensitivity;ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|c.1510G>A|p.Glu504Lys\tGT:GQ:DP\t0/1:99:55\n",
      phenotypes: [
        { id: "SO:0001583", label: "Alcohol dehydrogenase variant" },
        { id: "SO:0001818", label: "Protein altering variant" },
      ],
      variants: [{ gene: "ALDH2", chrom: "chr12", pos: 111803962, rsId: "rs671", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
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
      ancestry: "Vietnamese / Southeast Asian (HANCESTRO:0021)",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "Southeast Asian",
      bloodGroup: "AB+",
      clinvarId: "dbSNP:rs4988235",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "75",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_LCT\n##reference=GRCh38\n##contig=<ID=chr2,length=242193529,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_02\nchr2\t135851076\trs4988235\tC\tT\t999\tPASS\tAF=0.740;GENE=LCT;TRAIT=Lactase_persistence;CLNSIG=Benign/Protective;CLNDN=Lactase_persistence;ANN=T|regulatory_variant|MODIFIER|LCT|transcript|NM_002299.4|c.-13910C>T|LactasePersistence\tGT:GQ:DP\t1/1:99:70\n",
      phenotypes: [
        { id: "SO:0001627", label: "Lactase persistence locus" },
      ],
      variants: [{ gene: "LCT", chrom: "chr2", pos: 135851076, rsId: "rs4988235", hgvs: "c.-13910C>T", zygosity: "homozygous" }],
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
      ancestry: "East Asian (HANCESTRO:0009)",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "East Asian",
      bloodGroup: "O-",
      clinvarId: "dbSNP:rs762551",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "90",
      durationDays: 45,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_CYP1A2\n##reference=GRCh38\n##contig=<ID=chr15,length=101991189,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_EA_03\nchr15\t74749576\trs762551\tA\tC\t999\tPASS\tAF=0.680;GENE=CYP1A2;TRAIT=Caffeine_metabolism;CLNSIG=Drug_response;CLNDN=Caffeine_metabolism;ANN=C|regulatory_variant|MODIFIER|CYP1A2|transcript|NM_000761.5|c.-163A>C|SlowCaffeineMetabolizer\tGT:GQ:DP\t0/1:99:50\n",
      phenotypes: [{ id: "SO:0001627", label: "Caffeine clearance speed" }],
      variants: [{ gene: "CYP1A2", chrom: "chr15", pos: 74749576, rsId: "rs762551", hgvs: "c.-163A>C", zygosity: "heterozygous" }],
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
      ancestry: "Vietnamese / East Asian (HANCESTRO:0021)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "East Asian",
      bloodGroup: "B-",
      clinvarId: "dbSNP:rs17822931",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "60",
      durationDays: 30,
      vcfContent:
        "##fileformat=VCFv4.2\n##fileDate=20260919\n##source=NCBI_dbSNP_Build155_ABCC11\n##reference=GRCh38\n##contig=<ID=chr16,length=90338345,assembly=GRCh38>\n##INFO=<ID=AF,Number=A,Type=Float,Description=\"Global Allele Frequency\">\n##INFO=<ID=GENE,Number=1,Type=String,Description=\"Gene Symbol\">\n##INFO=<ID=TRAIT,Number=1,Type=String,Description=\"Genomic Trait\">\n##INFO=<ID=CLNSIG,Number=.,Type=String,Description=\"Clinical Significance\">\n##INFO=<ID=CLNDN,Number=.,Type=String,Description=\"ClinVar Disease Name\">\n##INFO=<ID=ANN,Number=.,Type=String,Description=\"Functional Annotations\">\n##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"Genotype Quality\">\n##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tDONOR_VN_KINH_04\nchr16\t48224287\trs17822931\tC\tT\t999\tPASS\tAF=0.820;GENE=ABCC11;TRAIT=Cerumen_type;CLNSIG=Benign;CLNDN=Cerumen_type;ANN=T|missense_variant|MODERATE|ABCC11|transcript|NM_033151.3|c.538G>A|p.Gly180Arg|DryEarwax\tGT:GQ:DP\t1/1:99:85\n",
      phenotypes: [{ id: "SO:0001583", label: "Cerumen apocrine phenotype" }],
      variants: [{ gene: "ABCC11", chrom: "chr16", pos: 48224287, rsId: "rs17822931", hgvs: "c.538G>A", zygosity: "homozygous" }],
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
      ancestry: "European CEPH / Utah Pedigree 1463 (HANCESTRO:0005)",
      hpoTerm: "SO:0001483 (Benchmark Truth)",
      region: "Global / CEU",
      bloodGroup: "O+",
      clinvarId: "GIAB:NA12878",
      fileFormat: "VCF v4.2",
      platform: "GATK Pipeline",
      priceGeno: "110",
      durationDays: 90,
      vcfContent: na12878RealVcf,
      phenotypes: [{ id: "SO:0001483", label: "Reference standard" }],
      variants: [{ gene: "ZNF343", chrom: "chr20", pos: 14370, rsId: "GIAB-NA12878", genomeAssembly: "GRCh37", hgvs: "c.14370G>A", zygosity: "heterozygous" }],
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
      ancestry: "European & Global Reference Panel (HANCESTRO:0005)",
      hpoTerm: "SO:0001627 (Regulatory)",
      region: "Global",
      bloodGroup: "A-",
      clinvarId: "dbSNP:rs12913832",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "70",
      durationDays: 30,
      vcfContent: herc2Vcf,
      phenotypes: [{ id: "SO:0001627", label: "Human eye color pigmentation" }],
      variants: [{ gene: "HERC2", chrom: "chr15", pos: 28120472, rsId: "rs12913832", hgvs: "c.72+208A>G", zygosity: "heterozygous" }],
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
      ancestry: "East Asian & Southeast Asian (HANCESTRO:0021)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "Southeast Asian",
      bloodGroup: "B+",
      clinvarId: "dbSNP:rs713598",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "65",
      durationDays: 30,
      vcfContent: tas2r38Vcf,
      phenotypes: [{ id: "SO:0001583", label: "Bitter taste perception" }],
      variants: [{ gene: "TAS2R38", chrom: "chr7", pos: 141972804, rsId: "rs713598", hgvs: "c.145G>C", zygosity: "heterozygous" }],
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
      ancestry: "Vietnamese / East Asian (HANCESTRO:0021)",
      hpoTerm: "SO:0001583 (Missense)",
      region: "Southeast Asian",
      bloodGroup: "AB-",
      clinvarId: "dbSNP:rs3827760",
      fileFormat: "VCF v4.2",
      platform: "Illumina NovaSeq",
      priceGeno: "75",
      durationDays: 30,
      vcfContent: edarVcf,
      phenotypes: [{ id: "SO:0001583", label: "Hair thickness and morphology" }],
      variants: [{ gene: "EDAR", chrom: "chr2", pos: 108898064, rsId: "rs3827760", hgvs: "c.1109T>C", zygosity: "homozygous" }],
    },
    {
      dataId: 11,
      chromosome: "WGS",
      pos: 1000,
      rsId: "NovaSeq-WGS-30x",
      geneSymbol: "FASTQ",
      gene: "Whole Human Genome 30x WGS Reads",
      disease: "Giải Trình Tự Toàn Bộ Hệ Gen Người Đọc Thô 30x (Illumina NovaSeq WGS Reads)",
      clinicalSignificance: "NGS Sequencing Reads",
      consequence: "snv_sequencing_read",
      zygosity: "Multi-read Q30",
      assembly: "GRCh38",
      ancestry: "Illumina Sequencing Platform (HANCESTRO:0004)",
      hpoTerm: "SO:0001483 (snv_sequencing_read FASTQ Q30)",
      region: "Global Sequencing Benchmark",
      bloodGroup: "O+",
      clinvarId: "SRA:NovaSeq30x",
      fileFormat: "FASTQ (Reads)",
      platform: "Illumina NovaSeq",
      priceGeno: "120",
      durationDays: 30,
      vcfContent: wgsFastq,
      phenotypes: [{ id: "SO:0001483", label: "Human Whole Genome 30x Reads" }],
      variants: [{ gene: "FASTQ", chrom: "WGS", pos: 1000, rsId: "NovaSeq-WGS-30x", hgvs: "WGS_READ_SET", zygosity: "heterozygous" }],
    },
    {
      dataId: 12,
      chromosome: "chrM",
      pos: 1,
      rsId: "NC_012920.1",
      geneSymbol: "FASTA",
      gene: "Mitochondrial Genome (16,569 bp Circular)",
      disease: "Trình Tự Tham Chiếu Toàn Bộ Hệ Gen Ty Thể Người (chrM Circular Genome)",
      clinicalSignificance: "Reference Benchmark",
      consequence: "circular_chromosome_contig",
      zygosity: "Haploid (chrM)",
      assembly: "rCRS",
      ancestry: "GRCh38 / NC_012920.1 Reference (HANCESTRO:0004)",
      hpoTerm: "SO:0000340 (Circular Chromosome Contig)",
      region: "Global Reference",
      bloodGroup: "O+",
      clinvarId: "RefSeq:NC_012920.1",
      fileFormat: "FASTA (Sequence)",
      platform: "GRCh38 Reference",
      priceGeno: "50",
      durationDays: 30,
      vcfContent: chrmFasta,
      phenotypes: [{ id: "SO:0000340", label: "Circular mitochondrial reference contig" }],
      variants: [{ gene: "chrM", chrom: "chrM", pos: 1, rsId: "NC_012920.1", genomeAssembly: "rCRS", hgvs: "NC_012920.1", zygosity: "homozygous" }],
    },
    {
      dataId: 13,
      chromosome: "chr20",
      pos: 76962,
      rsId: "rs6111385",
      geneSymbol: "SAMTOOLS",
      gene: "SAMtools / BCFtools Multi-sample Panel",
      disease: "Bộ Gọi Biến Dị Đa Mẫu Nhiễm Sắc Thể Thường & Giới Tính (chr11, chr20, chrX, chrY)",
      clinicalSignificance: "Reference Benchmark",
      consequence: "missense_variant",
      zygosity: "Multi-sample (0/1, 1/1)",
      assembly: "GRCh37",
      ancestry: "1000 Genomes Reference Panel (HANCESTRO:0004)",
      hpoTerm: "SO:0000694 (Multi-sample Variant Callset)",
      region: "Global Multi-ancestry",
      bloodGroup: "A+",
      clinvarId: "1000G:NA00001",
      fileFormat: "VCF v4.2",
      platform: "SAMtools Panel",
      priceGeno: "95",
      durationDays: 45,
      vcfContent: samtoolsVcf,
      phenotypes: [{ id: "SO:0000694", label: "Multi-sample autosome and sex chromosome callset" }],
      variants: [{ gene: "SAMTOOLS", chrom: "chr20", pos: 76962, rsId: "rs6111385", genomeAssembly: "GRCh37", hgvs: "g.76962T>C", zygosity: "heterozygous" }],
    },
  ];

  const dispatcherVault = loadOrCreateDispatcherVaultKey();
  dispatcherVaultMeta = dispatcherVault.kdfMeta;

  const kuboRpc = getKuboRpcEndpoint();
  let kuboReachable = false;
  try {
    const probe = await fetch(`${kuboRpc}/api/v0/version`, { method: "POST", signal: AbortSignal.timeout(1200) });
    kuboReachable = Boolean(probe && probe.ok);
  } catch (_) {
    kuboReachable = false;
  }
  if (kuboReachable) {
    console.log(`[IPFS] Local Kubo daemon detected at ${kuboRpc}; seeded cohorts will be pinned.`);
  } else if (requireIpfs) {
    throw new Error(
      `[IPFS] REQUIRE_IPFS=1 is enabled, but local Kubo daemon is not reachable at ${kuboRpc}. Aborting deployment.`
    );
  } else {
    console.warn(
      `[WARN] Local Kubo daemon not reachable at ${kuboRpc}. Running in offline local-cache mode (set REQUIRE_IPFS=1 to fail closed). Start Kubo and re-run deploy.js to pin all 13 cohort artifacts to IPFS.`
    );
  }

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
    const summaryKeyHex = crypto.randomBytes(32).toString("hex");
    const encPdf = await encryptGenomicData(pdfBytes, summaryKeyHex);
    const summaryCid = await computeIpfsCidV0(encPdf.payload);

    // 3. Build Phenopacket v2 metadata (L-01: include bloodGroup, clinicalSignificance, zygosity for all 13 cohorts)
    const pheno = buildPhenopacket({
      subjectId: `SEED_COHORT_${String(c.dataId).padStart(2, "0")}`,
      disease: c.disease,
      clinicalSignificance: c.clinicalSignificance,
      zygosity: c.zygosity,
      bloodGroup: c.bloodGroup,
      phenotypes: c.phenotypes,
      variants: c.variants,
      ancestry: c.ancestry,
      fileFormat: c.fileFormat || "VCF v4.2",
      format: c.fileFormat || "VCF v4.2",
      chromosome: c.chromosome,
      rsId: c.rsId,
      pos: c.pos,
      genomeAssembly: c.assembly,
      rawDataHash: enc.rawDataHash,
      rawCid: rawCid,
      summaryCid: summaryCid,
      summaryDataHash: encPdf.rawDataHash,
      fileSize: Buffer.byteLength(c.vcfContent, "utf8"),
    });
    const metaJson = JSON.stringify(pheno, null, 2);
    const metaCid = await computeIpfsCidV0(metaJson);
    const metaHash = await computeDataHash(new TextEncoder().encode(metaJson));

    // 4. Cache in dual-engine local cache and pin to local Kubo if reachable
    cacheLocalIpfsContent(rawCid, enc.payload);
    cacheLocalIpfsContent(summaryCid, encPdf.payload);
    cacheLocalIpfsContent(metaCid, new TextEncoder().encode(metaJson));
    if (kuboReachable) {
      try {
        const pRaw = await pinFileToKubo(enc.payload, `seed${c.dataId}_raw.enc`, "application/octet-stream", kuboRpc);
        const pSum = await pinFileToKubo(encPdf.payload, `seed${c.dataId}_report.enc`, "application/pdf", kuboRpc);
        const pMeta = await pinJsonToKubo(pheno, `phenopacket_seed${c.dataId}.json`, kuboRpc);
        if (requireIpfs && (!pRaw?.cid || !pSum?.cid || !pMeta?.cid)) {
          throw new Error(
            `Kubo returned null pin result for Seed #${c.dataId} (raw=${pRaw?.cid || "null"}, sum=${pSum?.cid || "null"}, meta=${pMeta?.cid || "null"})`
          );
        }
        if (pRaw?.cid !== rawCid || pSum?.cid !== summaryCid || pMeta?.cid !== metaCid) {
          const diffMsg = `[IPFS] Kubo pinned CID diff for Seed #${c.dataId}: raw=${pRaw?.cid || "null"} (expected ${rawCid}), sum=${pSum?.cid || "null"} (expected ${summaryCid}), meta=${pMeta?.cid || "null"} (expected ${metaCid})`;
          if (requireIpfs) {
            throw new Error(diffMsg);
          }
          console.warn(diffMsg);
        }
      } catch (kuboErr) {
        if (requireIpfs) {
          throw new Error(`[IPFS] REQUIRE_IPFS=1 pin failure for Seed #${c.dataId}: ${kuboErr?.message || kuboErr}`);
        }
        console.warn(`[WARN] Kubo pin warning for Seed #${c.dataId}:`, kuboErr?.message || kuboErr);
      }
    }

    const COHORT_BLIND_SALT = ethers.id("GENOCHAIN_COHORT_SALT_V1");
    const computeBlindTagHex = (traitKey, traitValue) =>
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "string", "bytes32"],
          ["GENOCHAIN_BLIND_TAG_V1", traitKey, traitValue, COHORT_BLIND_SALT]
        )
      );
    const tagSet = new Set();
    const addTag = (k, val) => {
      const cleanVal = String(val || "").trim();
      if (cleanVal && tagSet.size < 16) {
        tagSet.add(computeBlindTagHex(k, cleanVal));
      }
    };
    addTag("gene", c.geneSymbol);
    addTag("gene", c.gene);
    if (Array.isArray(c.variants)) {
      for (const v of c.variants) addTag("gene", v?.gene);
    }
    addTag("disease", c.disease);
    addTag("trait", c.disease);
    addTag("trait", c.clinicalSignificance);
    addTag("hpo", c.hpoTerm);
    if (Array.isArray(c.phenotypes)) {
      for (const p of c.phenotypes) addTag("hpo", p?.id);
    }
    addTag("ancestry", c.ancestry);
    addTag("ancestry", c.region);
    addTag("rsid", c.rsId);
    const blindTags = Array.from(tagSet);

    // 5. Register on-chain via bundle (ensures bundle hashes / metadataHash parity matching deploy_localhost.js)
    const tx = await registry.connect(deployer).registerGenomicDataBundle(
      [enc.rawDataHash, encPdf.rawDataHash, metaHash],
      [rawCid, summaryCid, metaCid, `ipfs://${metaCid}`],
      ethers.parseUnits(c.priceGeno, 18),
      c.durationDays * 86400,
      1000, // 10% royalty
      blindTags
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
      format: c.fileFormat || "VCF v4.2",
      platform: c.platform || "Illumina NovaSeq",
      ancestry: c.ancestry,
      hpoTerm: c.hpoTerm,
      region: c.region,
      bloodGroup: c.bloodGroup,
      clinvarId: c.clinvarId,
      priceGeno: Number(c.priceGeno),
      durationDays: c.durationDays,
      rawCid: rawCid,
      metadataCid: metaCid,
      summaryCid: summaryCid,
      rawDataHash: enc.rawDataHash,
      summaryDataHash: encPdf.rawDataHash,
      metadataHash: metaHash,
    });

    // 7. Encapsulated seed key envelopes (AES-256-GCM wrapped under PBKDF2/keyfile vault key - zero plaintext AES keys on disk)
    secretSeeds.push({
      dataId: c.dataId,
      rawCid: rawCid,
      summaryCid: summaryCid,
      encryptedKeyEnvelopeHex: wrapSeedKeyForVault(enc.keyHex, dispatcherVault.key),
      encryptedSummaryKeyEnvelopeHex: wrapSeedKeyForVault(summaryKeyHex, dispatcherVault.key),
      rawDataHash: enc.rawDataHash,
    });
  }
  } else {
    console.log("\n[PROD] SKIP_SEEDING=1 -> Skipped demo funding, seed ZK bounties, and 13 demo genomic cohorts.");
  }

  // 5b. Optional Production Governance Timelock Handoff (ENABLE_TIMELOCK=1)
  let timelockAddress = null;
  let timelockHandoff = null;
  if (timelockConfig) {
    console.log(
      `\n[GOV] ENABLE_TIMELOCK=1 -> Deploying GenomicTimelock (minDelay=${timelockConfig.minDelaySec}s, proposers=${timelockConfig.proposers.length}, executors=${timelockConfig.executors.length}, admin=${timelockConfig.admin})...`
    );
    const GenomicTimelock = await ethers.getContractFactory("GenomicTimelock");
    const timelock = await GenomicTimelock.deploy(
      timelockConfig.minDelaySec,
      timelockConfig.proposers,
      timelockConfig.executors,
      timelockConfig.admin
    );
    await timelock.waitForDeployment();
    timelockAddress = timelock.target;
    console.log("[GOV] GenomicTimelock deployed to:", timelockAddress);

    // Initiate Ownable2Step transferOwnership to GenomicTimelock (Timelock executes acceptOwnership after minDelay)
    const handoffContracts = [
      ["GenomicToken", token],
      ["GenomicNFT", nft],
      ["GenomicsRegistry", registry],
      ["GenomicZkVerifier", zkVerifier],
    ];
    for (const [label, contractObj] of handoffContracts) {
      const txHand = await contractObj.connect(deployer).transferOwnership(timelockAddress);
      await txHand.wait();
      console.log(`[GOV] ${label}: initiated 2-step ownership transfer -> pendingOwner=${timelockAddress}`);
    }

    // Generate exact scheduleBatch / executeBatch calldata for Safe / multisig / timelock_accept_ownership.js
    const acceptIface = new ethers.Interface(["function acceptOwnership()"]);
    const acceptPayload = acceptIface.encodeFunctionData("acceptOwnership", []);
    const targets = handoffContracts.map(([, cObj]) => cObj.target);
    const values = handoffContracts.map(() => 0);
    const payloads = handoffContracts.map(() => acceptPayload);
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id(`GENOCHAIN_TIMELOCK_HANDOFF_${timelockAddress.toLowerCase()}`);
    const operationId = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
    const scheduleBatchCalldata = timelock.interface.encodeFunctionData("scheduleBatch", [
      targets,
      values,
      payloads,
      predecessor,
      salt,
      timelockConfig.minDelaySec,
    ]);
    const executeBatchCalldata = timelock.interface.encodeFunctionData("executeBatch", [
      targets,
      values,
      payloads,
      predecessor,
      salt,
    ]);
    timelockHandoff = {
      network: targetNetwork,
      timelockAddress,
      minDelaySec: timelockConfig.minDelaySec,
      targets,
      values,
      payloads,
      predecessor,
      salt,
      operationId,
      scheduleBatchCalldata,
      executeBatchCalldata,
    };
    console.log(`[GOV] Timelock acceptOwnership operationId: ${operationId}`);
    console.log(`[GOV] scheduleBatch calldata (${scheduleBatchCalldata.length} chars): ${scheduleBatchCalldata.slice(0, 66)}...`);
    console.log(`[GOV] executeBatch  calldata (${executeBatchCalldata.length} chars): ${executeBatchCalldata.slice(0, 66)}...`);
  }

  // 6. Save addresses and ABIs for frontend (dynamic network, chainId & pre-deploy deployedBlock)
  const liveNetwork = await ethers.provider.getNetwork();
  const liveChainId = Number(liveNetwork.chainId);
  const deployedBlock = deployStartBlock;
  const addresses = {
    network: targetNetwork,
    chainId: liveChainId,
    deployedBlock,
    deployedAt: new Date().toISOString(),
    GenomicToken: token.target,
    GenomicNFT: nft.target,
    GenomicsRegistry: registry.target,
    GenomicZkVerifier: zkVerifier.target,
    ...(timelockAddress ? { GenomicTimelock: timelockAddress } : {}),
    Deployer: deployer.address,
  };

  const outputContractsDir = path.resolve(process.env.OUTPUT_CONTRACTS_DIR || "frontend/src/contracts");
  if (!fs.existsSync(outputContractsDir)) {
    fs.mkdirSync(outputContractsDir, { recursive: true });
  }
  const addressesOutPath = path.join(outputContractsDir, "contractAddresses.json");
  fs.writeFileSync(
    addressesOutPath,
    JSON.stringify(addresses, null, 2)
  );
  console.log(`\n[FILE] Contract addresses saved to ${addressesOutPath} (deployedBlock=${deployedBlock})`);

  // Save Contract ABIs for frontend
  const contractsToExport = ["GenomicToken", "GenomicNFT", "GenomicsRegistry", "GenomicZkVerifier", "GenomicTimelock"];
  for (const name of contractsToExport) {
    const artifactPath = path.resolve(`artifacts/contracts/${name}.sol/${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const abiOutPath = path.join(outputContractsDir, `${name}ABI.json`);
      fs.writeFileSync(
        abiOutPath,
        JSON.stringify(artifact.abi, null, 2)
      );
      console.log(`[FILE] Exported ABI for ${name} to ${abiOutPath}`);
    }
  }

  // PUBLIC Metadata ONLY for frontend (Zero keys leaked)
  const publicSeedDataStore = {
    seeds: publicSeeds,
  };

  const seedMetadataOutPath = path.join(outputContractsDir, "seedMetadata.json");
  fs.writeFileSync(
    seedMetadataOutPath,
    JSON.stringify(publicSeedDataStore, null, 2)
  );
  console.log(`[FILE] Public seed metadata catalog saved to ${seedMetadataOutPath} (${publicSeeds.length} Cohorts, Zero keys leaked)`);

  // Private key envelopes saved strictly to git-ignored .local/ dispatcher vault
  const localVaultDir = path.resolve(process.env.LOCAL_VAULT_DIR || ".local");
  if (!fs.existsSync(localVaultDir)) {
    fs.mkdirSync(localVaultDir, { recursive: true, mode: 0o700 });
  }
  const secretKeyStore = {
    vaultVersion: 2,
    vaultKdf: dispatcherVaultMeta,
    deployerAddress: deployer.address,
    seeds: secretSeeds,
  };
  const vaultOutPath = path.join(localVaultDir, "dispatcher_seed_vault.json");
  fs.writeFileSync(
    vaultOutPath,
    JSON.stringify(secretKeyStore, null, 2),
    { mode: 0o600 }
  );
  console.log(`[SECURITY] Seed secret envelopes saved strictly to ${vaultOutPath} (vaultVersion=2, kdf=${dispatcherVaultMeta.algorithm})`);

  if (timelockHandoff) {
    timelockHandoff.chainId = liveChainId;
    const handoffOutPath = path.join(localVaultDir, "timelock_handoff.json");
    fs.writeFileSync(
      handoffOutPath,
      JSON.stringify(timelockHandoff, null, 2),
      { mode: 0o600 }
    );
    console.log(`[GOV] Saved Timelock batch handoff payload to ${handoffOutPath}`);
  }

  console.log("\n==================================================");
  console.log(`[SUCCESS] DEPLOYMENT FINISHED SUCCESSFULLY (${publicSeeds.length} COHORTS SEEDED)!`);
  console.log("==================================================");
}

try {
  await main();
} catch (error) {
  console.error("Deployment failed:", error);
  process.exit(1);
}