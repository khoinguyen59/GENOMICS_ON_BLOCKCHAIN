import urllib.request
import ssl
import json
import os

ctx = ssl.create_default_context()

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(base_dir, "data", "diverse_real_datasets")
FRONTEND_DIR = os.path.join(base_dir, "frontend", "public", "datasets")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FRONTEND_DIR, exist_ok=True)

# INV-11 (Non-Pathological Payload Policy):
# Clinical/pathological Phenopackets (ABCA4, ADA, FBN1, CFTR, TP53) are intentionally
# excluded. Benign GA4GH Phenopacket v2 molecular trait fixtures (ALDH2, ACTN3, TAS2R38)
# are maintained locally under data/diverse_real_datasets/ and frontend/public/datasets/.
pheno_targets = []

# 3. Add SAMtools / BCFtools authentic VCFs
vcf_targets = [
    {
        "name": "BCFtools_csq_vep.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/csq/sample.vcf",
        "category": "Variant Call Format v4.2 (VEP Consequence Annotation)",
        "gene": "Multi-locus VEP Annotations"
    },
    {
        "name": "BCFtools_annotate_multi.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/annotate.multi.vcf",
        "category": "Variant Call Format v4.2 (Multiallelic Complex Loci)",
        "gene": "Multiallelic Reference Cohort"
    },
    {
        "name": "BCFtools_haploid.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/haploid.vcf",
        "category": "Variant Call Format v4.2 (ChrX/Y Hemizygous Callset)",
        "gene": "ChrX / ChrY Hemizygous"
    },
    {
        "name": "BCFtools_filter.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/filter.vcf",
        "category": "Variant Call Format v4.2 (Clinical Quality Filtered)",
        "gene": "High-Confidence Filtered"
    }
]

# 4. Add HTSLIB authentic FASTA
fasta_targets = [
    {
        "name": "HTSLIB_reference_c1.fa",
        "url": "https://raw.githubusercontent.com/samtools/htslib/develop/test/c1.fa",
        "category": "FASTA Genomic Reference Sequence",
        "gene": "Consensus Sequence chr1"
    },
    {
        "name": "HTSLIB_reference_auxf.fa",
        "url": "https://raw.githubusercontent.com/samtools/htslib/develop/test/auxf.fa",
        "category": "FASTA Exome Reference Contig",
        "gene": "Exome Target Contig"
    }
]

# 5. Add authentic FASTQ reads
fastq_sample_content = (
    "@SRR001666.1 071112_SLXA-EAS1_s_7:5:1:817:345 length=72\n"
    "GGGTGATGGCCGCTGCGATGGCCTCATGCTCACCAGCTCGTTCTTCATCACCTTCACGAACCCGCCACCGCTC\n"
    "+\n"
    "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII9IIIIIIIIIIIIIIIIIIIIIIIIIII+IIIIIIIIIIII\n"
    "@SRR001666.2 071112_SLXA-EAS1_s_7:5:1:801:338 length=72\n"
    "GTTCGTCACCGTCTACAGCAACGTCCTCGGCGCCTACCTGCTCACCAACTTCGTCATCAACTTCTTCGGCATC\n"
    "+\n"
    "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII\n"
    "@SRR001666.3 071112_SLXA-EAS1_s_7:5:1:943:786 length=72\n"
    "AACGAGCGCATCGAGCTGCAGGACCAGAACGAGAAGGTGTTCCTGCGCACCCTGGAGCACCGCAACTTCACCC\n"
    "+\n"
    "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII\n"
)

all_downloads = pheno_targets + vcf_targets + fasta_targets

print("\n" + "=" * 75)
print(f"DOWNLOADING {len(all_downloads)} DIVERSE DATASETS FROM REPUTABLE GENOMIC SOURCES")
print("=" * 75)

catalog = []

for item in all_downloads:
    out_data_path = os.path.join(DATA_DIR, item["name"])
    out_pub_path = os.path.join(FRONTEND_DIR, item["name"])
    print(f"Downloading {item['name']}...")
    try:
        req = urllib.request.Request(item["url"], headers={"User-Agent": "GenoChain-Researcher/1.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=12) as resp:
            content = resp.read()
            with open(out_data_path, "wb") as f:
                f.write(content)
            with open(out_pub_path, "wb") as f:
                f.write(content)
            print(f"  [SAVED] {len(content)} bytes -> {item['name']}")
            catalog.append({
                "name": item["name"],
                "size": len(content),
                "category": item["category"],
                "gene": item["gene"],
                "url": f"/datasets/{item['name']}"
            })
    except Exception as e:
        print(f"  [ERROR] {item['name']}: {e}")

# Save the FASTQ sample
fastq_name = "Illumina_NGS_reads_sample.fastq"
with open(os.path.join(DATA_DIR, fastq_name), "w", encoding="utf-8") as f:
    f.write(fastq_sample_content)
with open(os.path.join(FRONTEND_DIR, fastq_name), "w", encoding="utf-8") as f:
    f.write(fastq_sample_content)
catalog.append({
    "name": fastq_name,
    "size": len(fastq_sample_content.encode("utf-8")),
    "category": "FASTQ Raw Sequencing Reads (Illumina NGS)",
    "gene": "SRR001666 Whole Exome Reads",
    "url": f"/datasets/{fastq_name}"
})
print(f"  [SAVED] {len(fastq_sample_content)} bytes -> {fastq_name}")

# Also copy previously downloaded samples into frontend/public/datasets
old_samples = [
    "NA12878_chr20_sample.vcf",
    "SAMtools_bcftools_view.vcf",
    "BCFtools_annotate_id.vcf",
    "BCFtools_convert.vcf",
    "BCFtools_aa.vcf",
    "BCFtools_ad_bias.vcf",
    "BCFtools_af_dist.vcf"
]
for s in old_samples:
    old_p = os.path.join("data", "downloaded_real_samples", s)
    if os.path.exists(old_p):
        with open(old_p, "rb") as f:
            c = f.read()
        with open(os.path.join(FRONTEND_DIR, s), "wb") as f:
            f.write(c)
        catalog.append({
            "name": s,
            "size": len(c),
            "category": "Variant Call Format v4.2 (GATK / SAMtools Standard)",
            "gene": s.split("_")[0],
            "url": f"/datasets/{s}"
        })

# Write catalog JSON to data/diverse_real_datasets/ only (frontend reads presetCatalog.js + /datasets/*)
with open(os.path.join(DATA_DIR, "datasets_catalog.json"), "w", encoding="utf-8") as f:
    json.dump(catalog, f, indent=2)

print("\n" + "=" * 75)
print(f"SUCCESS: Catalog created with {len(catalog)} diverse datasets!")
print("=" * 75)
