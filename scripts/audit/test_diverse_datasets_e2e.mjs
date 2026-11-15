import fs from "fs";
import path from "path";
import {
  generateAsymmetricKeyPair,
  exportPublicKey,
  encryptGenomicData,
  decryptGenomicData,
  packageKeyCapsule,
  decryptKeyCapsule,
  computeDataHash
} from "../../crypto/client_crypto.js";
import { parseVcfMetadata } from "../../frontend/src/services/vcfService.js";

console.log("=".repeat(88));
console.log("GENOCHAIN: DIVERSE DATASET COMPREHENSIVE COMPATIBILITY & CRYPTO VERIFICATION");
console.log("=".repeat(88));

const testTargets = [
  // 1. GA4GH Phenopackets v2 (JSON)
  {
    name: "GA4GH_Phenopacket_ABCA4 (Stargardt)",
    filePath: "data/diverse_real_datasets/GA4GH_Phenopacket_ABCA4_PMID_10874631_II_2.json",
    category: "GA4GH Phenopacket v2"
  },
  {
    name: "GA4GH_Phenopacket_ADA (Immune SCID)",
    filePath: "data/diverse_real_datasets/GA4GH_Phenopacket_ADA_PMID_1680289_patient.json",
    category: "GA4GH Phenopacket v2"
  },
  {
    name: "GA4GH_Phenopacket_FBN1 (Marfan Locus)",
    filePath: "data/diverse_real_datasets/GA4GH_Phenopacket_FBN1_PMID_10756346_Patient_B13.json",
    category: "GA4GH Phenopacket v2"
  },

  // 2. Gold Standard Benchmark VCFs (GATK / SAMtools / BCFtools)
  {
    name: "BCFtools_annotate_multi (Multiallelic)",
    filePath: "data/diverse_real_datasets/BCFtools_annotate_multi.vcf",
    category: "Benchmark VCF"
  },

  // 3. Pure Molecular Genetics Panels (dbSNP & 1000 Genomes Traits)
  {
    name: "ACTN3_rs1815739 (Muscle Sprint Power)",
    filePath: "data/diverse_real_datasets/ACTN3_muscle_performance_rs1815739.vcf",
    category: "Molecular Trait VCF"
  },
  {
    name: "EDAR_rs3827760 (Hair Thickness)",
    filePath: "data/diverse_real_datasets/EDAR_hair_thickness_rs3827760.vcf",
    category: "Molecular Trait VCF"
  },
  {
    name: "HERC2_rs12913832 (Eye Color)",
    filePath: "data/diverse_real_datasets/HERC2_eye_color_rs12913832.vcf",
    category: "Molecular Trait VCF"
  },
  {
    name: "TAS2R38_rs713598 (Bitter Taste)",
    filePath: "data/diverse_real_datasets/TAS2R38_bitter_taste_rs713598.vcf",
    category: "Molecular Trait VCF"
  },

  // 4. Raw Sequencing Reads & FASTA Reference
  {
    name: "Illumina_NGS_reads (FASTQ)",
    filePath: "data/diverse_real_datasets/Illumina_NGS_reads_sample.fastq",
    category: "FASTQ Sequencing Reads"
  },
  {
    name: "Illumina_WGS_reads (FASTQ)",
    filePath: "data/diverse_real_datasets/Illumina_WGS_reads_sample.fastq",
    category: "FASTQ Sequencing Reads"
  },
  {
    name: "HTSLIB_reference_c1 (FASTA)",
    filePath: "data/diverse_real_datasets/HTSLIB_reference_c1.fa",
    category: "FASTA Contig Reference"
  },
  {
    name: "HTSLIB_reference_auxf (FASTA)",
    filePath: "data/diverse_real_datasets/HTSLIB_reference_auxf.fa",
    category: "FASTA Contig Reference"
  },
  {
    name: "GRCh38_chrM (Mitochondrial Genome)",
    filePath: "data/diverse_real_datasets/GRCh38_chrM_mitochondrial.fa",
    category: "FASTA Contig Reference"
  },

  // 5. Vietnamese Population Cohorts (1000 Genomes Project)
  {
    name: "KHV_chr12_1000genomes (Vietnamese Kinh Cohort)",
    filePath: "data/diverse_real_datasets/KHV_chr12_1000genomes.vcf",
    category: "Vietnamese Population VCF"
  }
];

async function runTest() {
  // Generate researcher RSA-OAEP 2048-bit keypair (extractable: false)
  const researcherKeypair = await generateAsymmetricKeyPair(false);
  const researcherAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const donorAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  let passedCount = 0;

  for (const t of testTargets) {
    const fullPath = path.resolve(t.filePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`[FATAL ERROR] Dataset file missing: ${t.filePath}`);
      process.exit(1);
    }

    const rawContent = fs.readFileSync(fullPath, "utf-8");
    const rawBytes = Buffer.byteLength(rawContent, "utf-8");
    if (rawBytes === 0) {
      console.error(`[FATAL ERROR] Dataset file is empty: ${t.filePath}`);
      process.exit(1);
    }
    const filename = path.basename(t.filePath);

    // 1. Metadata extraction & Bioinformatics parsing
    const parsed = parseVcfMetadata(rawContent, filename);
    if (!parsed || !parsed.detectedGene) {
      console.error(`[FATAL ERROR] Bioinformatics parsing failed for ${t.name}`);
      process.exit(1);
    }

    // 2. Client-side WebCrypto authenticated encryption (AES-GCM 256)
    const encResult = await encryptGenomicData(rawContent);
    const { keyHex, payload, rawDataHash, iv, ciphertext } = encResult;

    // 3. Verify on-chain SHA-256 anchor computation
    const computedHash = await computeDataHash(payload);
    if (computedHash.toLowerCase() !== rawDataHash.toLowerCase()) {
      console.error(`[FATAL ERROR] Hash mismatch for ${t.name}: ${computedHash} vs ${rawDataHash}`);
      process.exit(1);
    }

    // 4. Asymmetric Key Encapsulation (RSA-OAEP 2048-bit)
    const capsuleJson = await packageKeyCapsule(
      keyHex,
      researcherKeypair.publicKey,
      researcherAddress,
      donorAddress
    );

    // 5. Decapsulation with Researcher's non-extractable private key
    const { keyHex: unwrappedKeyHex } = await decryptKeyCapsule(capsuleJson, researcherKeypair.privateKey);

    // 6. In-Memory Decryption
    const decryptedContent = await decryptGenomicData(ciphertext, iv, unwrappedKeyHex, true);

    // 7. Byte-for-byte equality verification
    if (decryptedContent !== rawContent) {
      console.error(`[FATAL ERROR] Decryption fidelity failure for ${t.name}! Plaintexts do not match.`);
      process.exit(1);
    }

    passedCount++;
    console.log(
      `[PASS] ${t.name.padEnd(46)} | Size: ${String(rawBytes).padStart(6)} B | ` +
      `Gene: ${parsed.detectedGene.substring(0, 18).padEnd(18)} | ` +
      `Disease/Trait: ${parsed.detectedDisease.substring(0, 20).padEnd(20)} | Hash: ${rawDataHash.substring(0, 10)}...`
    );
  }

  if (passedCount !== testTargets.length) {
    console.error(`[FATAL ERROR] Incomplete pass: ${passedCount}/${testTargets.length}`);
    process.exit(1);
  }

  console.log("=".repeat(88));
  console.log(`VERIFICATION RESULT: ${passedCount}/${testTargets.length} Diverse Datasets 100% Genuine Pass!`);
  console.log(" [✓] Bioinformatics Metadata Extraction: All formats parsed (GA4GH, VCF, FASTQ, FASTA)");
  console.log(" [✓] Client-Side WebCrypto AES-GCM 256 Authenticated Encryption: 100% Success");
  console.log(" [✓] On-Chain Ciphertext Package SHA-256 Anchor Integrity: 100% Match");
  console.log(" [✓] Real Asymmetric RSA-OAEP 2048-bit Key Capsule Packaging: 100% Success");
  console.log(" [✓] Non-Extractable Private Key Decapsulation: 100% Success");
  console.log(" [✓] Zero-Leakage In-Memory Decryption Fidelity: 100% Byte-for-byte Identity Match");
  console.log("=".repeat(88));
}

runTest().catch((err) => {
  console.error("Test execution aborted with error:", err);
  process.exit(1);
});
