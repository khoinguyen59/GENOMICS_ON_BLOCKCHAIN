import urllib.request
import ssl
import json

ctx = ssl._create_unverified_context()

def check_github_repo(owner_repo, path=""):
    url = f"https://api.github.com/repos/{owner_repo}/contents/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "GenomicsBlockchainAgent/1.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return [f["name"] for f in data if f["type"] == "file"]
    except Exception as e:
        print(f"Error {owner_repo}/{path}: {e}")
        return []

print("SAMTOOLS BCFTOOLS TEST FILES:")
bcftools_files = check_github_repo("samtools/bcftools", "test")
vcf_files = [f for f in bcftools_files if f.endswith(".vcf")]
print(f"Found {len(vcf_files)} VCF files: {vcf_files[:15]}")

print("\nHTSLIB TEST FILES:")
htslib_files = check_github_repo("samtools/htslib", "test")
htslib_vcfs = [f for f in htslib_files if f.endswith(".vcf") or f.endswith(".fa") or f.endswith(".fq")]
print(f"Found {len(htslib_vcfs)} genomic files: {htslib_vcfs[:15]}")

print("\nBIOPYTHON TEST FILES:")
biopython_files = check_github_repo("biopython/biopython", "Tests")
biopython_samples = [f for f in biopython_files if any(f.endswith(ext) for ext in [".vcf", ".fastq", ".fa", ".fasta"])]
print(f"Found {len(biopython_samples)} samples in Biopython: {biopython_samples[:15]}")
