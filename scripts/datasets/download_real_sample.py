import urllib.request
import ssl
import os

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out_dir = os.path.join(base_dir, "data", "downloaded_real_samples")
frontend_pub_dir = os.path.join(base_dir, "frontend", "public", "downloaded")
os.makedirs(out_dir, exist_ok=True)
os.makedirs(frontend_pub_dir, exist_ok=True)

samples = [
    {
        "name": "NA12878_chr20_sample.vcf",
        "url": "https://raw.githubusercontent.com/broadinstitute/gatk/master/src/test/resources/org/broadinstitute/hellbender/tools/walkers/rnaseq/ASEReadCounter/NA12878.chr20_2444518_2637800.RNAseq.NON_REF.vcf",
        "source": "Broad Institute GATK / GIAB Benchmark (NA12878 Chr20 RNA-seq Non-Ref)"
    },
    {
        "name": "SAMtools_bcftools_view.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/view.vcf",
        "source": "SAMtools / BCFtools Official Reference VCF Standard"
    },
    {
        "name": "BCFtools_annotate_id.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/annotate.id.vcf",
        "source": "SAMtools / BCFtools Variant Annotation & ID Standard"
    },
    {
        "name": "BCFtools_convert.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/convert.vcf",
        "source": "SAMtools / BCFtools Genotype Conversion Standard"
    },
    {
        "name": "BCFtools_aa.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/aa.vcf",
        "source": "SAMtools / BCFtools Amino Acid Variant Callset"
    },
    {
        "name": "BCFtools_ad_bias.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/ad-bias.vcf",
        "source": "SAMtools / BCFtools Allelic Depth Bias Benchmark"
    },
    {
        "name": "BCFtools_af_dist.vcf",
        "url": "https://raw.githubusercontent.com/samtools/bcftools/develop/test/af-dist.vcf",
        "source": "SAMtools / BCFtools Allele Frequency Distribution Benchmark"
    }
]

print("=" * 70)
print("DOWNLOADING AUTHENTIC SCIENTIFIC VCF SAMPLES (Broad Institute & SAMtools)")
print("=" * 70)

for s in samples:
    out_path = os.path.join(out_dir, s["name"])
    pub_path = os.path.join(frontend_pub_dir, s["name"])
    print(f"Downloading {s['name']}...")
    try:
        req = urllib.request.Request(s["url"], headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, context=ctx).read()
        with open(out_path, "wb") as f:
            f.write(data)
        with open(pub_path, "wb") as f:
            f.write(data)
        print(f"  [OK] Saved to {out_path} & {pub_path} ({len(data)} bytes)")
        
        # Analyze lines:
        lines = data.decode('utf-8', errors='ignore').splitlines()
        header_lines = [l for l in lines if l.startswith('#')]
        variant_lines = [l for l in lines if not l.startswith('#') and l.strip()]
        print(f"       Header lines: {len(header_lines)}, Variant records: {len(variant_lines)}")
        if variant_lines:
            print(f"       Sample record: {variant_lines[0][:80]}...")
        print("-" * 70)
    except Exception as e:
        print(f"  [ERROR] {e}")
        print("-" * 70)

print("\nAll sample downloads completed successfully!")
