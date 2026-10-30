import os
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
datasets_dir = os.path.join(base_dir, "frontend", "public", "datasets")
samples_dir = os.path.join(base_dir, "frontend", "public", "samples")

files_to_test = []
if os.path.exists(datasets_dir):
    for f in os.listdir(datasets_dir):
        if not f.endswith(".json") or "Phenopacket" in f:
            files_to_test.append((os.path.join(datasets_dir, f), f, "datasets"))

if os.path.exists(samples_dir):
    for f in os.listdir(samples_dir):
        files_to_test.append((os.path.join(samples_dir, f), f, "samples"))

print(f"Total files to test: {len(files_to_test)}")
print("=" * 70)

def parse_genomic_metadata(content, filename):
    lower_fn = filename.lower()
    
    # 1. GA4GH Phenopacket JSON
    if lower_fn.endswith(".json") or content.strip().startswith("{"):
        try:
            data = json.loads(content)
            subj = data.get("subject", {}).get("id", data.get("id", "PHENOPACKET_CASE"))
            
            # Disease detection
            disease = "Clinical Phenotype Case"
            if "interpretations" in data and len(data["interpretations"]) > 0:
                diag = data["interpretations"][0].get("diagnosis", {})
                disease = diag.get("disease", {}).get("label", disease)
            elif "diseases" in data and len(data["diseases"]) > 0:
                disease = data["diseases"][0].get("term", {}).get("label", disease)
                
            # Gene symbol detection
            gene = "GA4GH Genomic Descriptor"
            if "interpretations" in data and len(data["interpretations"]) > 0:
                gen_ints = data["interpretations"][0].get("diagnosis", {}).get("genomicInterpretations", [])
                for gi in gen_ints:
                    var_desc = gi.get("variantInterpretation", {}).get("variationDescriptor", {})
                    if "geneContext" in var_desc:
                        gene = var_desc["geneContext"].get("symbol", gene)
                        break
            
            # HPO detection
            hpo = "HP:0000001 — Phenotypic abnormality"
            if "phenotypicFeatures" in data and len(data["phenotypicFeatures"]) > 0:
                pf = data["phenotypicFeatures"][0]
                pf_type = pf.get("type", {})
                hpo = f"{pf_type.get('id', 'HP:0000001')} — {pf_type.get('label', 'Phenotypic feature')}"
                
            sex = data.get("subject", {}).get("sex", "Unknown")
            return {
                "type": "GA4GH_PHENOPACKET",
                "subjectId": subj,
                "disease": disease,
                "geneSymbol": gene,
                "hpoCode": hpo,
                "ancestryRegion": f"Global Registry (Sex: {sex})",
                "bloodGroup": "O+"
            }
        except Exception as e:
            pass

    # 2. FASTQ raw reads
    if lower_fn.endswith(".fastq") or lower_fn.endswith(".fq") or (content.startswith("@") and "\n+\n" in content[:500]):
        first_line = content.splitlines()[0]
        read_id = first_line[1:].split()[0]
        return {
            "type": "FASTQ_READS",
            "subjectId": f"RUN_{read_id[:12]}",
            "disease": "High-Throughput Sequencing Read Benchmark",
            "geneSymbol": "Exome / Transcriptome NGS Reads (Illumina)",
            "hpoCode": "SO:0001483 — snv_sequencing_read",
            "ancestryRegion": "Illumina NGS Platform",
            "bloodGroup": "O+"
        }

    # 3. FASTA contigs / reference
    if lower_fn.endswith(".fa") or lower_fn.endswith(".fasta") or content.startswith(">"):
        first_line = content.splitlines()[0]
        contig_id = first_line[1:].split()[0]
        return {
            "type": "FASTA_SEQUENCE",
            "subjectId": f"REF_{contig_id}",
            "disease": "Genomic Reference Assembly Contig",
            "geneSymbol": f"Contig {contig_id} (FASTA)",
            "hpoCode": "SO:0000340 — chromosome_arm",
            "ancestryRegion": "Consensus Reference Standard",
            "bloodGroup": "O+"
        }

    # 4. VCF (Variant Call Format)
    # Check known genes
    gene_map = {
        "aldh2": ("ALDH2 (c.1510G>A, rs671)", "Alcohol Flush Reaction (Hội chứng đỏ mặt cồn)", "HP:0001945 — Vasomotor flush response", "Vietnamese (Kinh)", "O+"),
        "lct": ("MCM6 / LCT (c.-13910C>T, rs4988235)", "Adult Lactose Intolerance (Dung nạp đường sữa)", "HP:0004789 — Lactose intolerance", "Vietnamese (Kinh)", "B+"),
        "mcm6": ("MCM6 / LCT (c.-13910C>T, rs4988235)", "Adult Lactose Intolerance (Dung nạp đường sữa)", "HP:0004789 — Lactose intolerance", "Vietnamese (Kinh)", "B+"),
        "cyp1a2": ("CYP1A2 (c.-163A>C, rs762551)", "Caffeine Metabolism Rate (Tốc độ chuyển hóa Cafein)", "PharmGKB:PA124 — Caffeine response", "East Asian (Han / Japanese)", "A+"),
        "abcc11": ("ABCC11 (c.538G>A, rs17822931)", "Dry Earwax & Apocrine Trait (Đặc trưng ráy tai khô)", "HP:0030058 — Dry cerumen trait", "Vietnamese (Kinh)", "O+"),
        "hbb": ("HBB (c.20A>T, rs334)", "Beta-Globin Hemoglobinopathy Carrier Screen", "HP:0001903 — Hemoglobinopathy", "Vietnamese (Kinh)", "B+"),
        "brca": ("BRCA1 (c.3454G>A, rs80357906)", "Hereditary Breast & Ovarian Carrier Screening", "HP:0003002 — Breast carcinoma risk", "Southeast Asian (Vietnamese)", "O+"),
        "cftr": ("CFTR (p.Phe508del, rs113993960)", "Cystic Fibrosis Carrier Screening (ClinVar Pathogenic)", "HP:0002099 — Abnormal pulmonary function", "Global / Multi-ethnic", "A+"),
        "apoe": ("APOE (epsilon 4 allele, rs429358)", "Late-Onset Alzheimer Disease Risk Assessment", "HP:0002511 — Alzheimer disease", "Global / Multi-ethnic", "O+"),
        "na12878": ("Chr20 RNA-seq Non-Ref Cohort (GIAB)", "CEPH/Utah Reference Genome Benchmark (GIAB NA12878)", "HP:0000001 — Reference Benchmark", "European (CEU)", "O+"),
        "samtools": ("BCFtools Multi-locus Panel", "Multi-sample Variant Call Standard", "HP:0000001 — Reference Cohort", "Global Multi-ancestry", "A+"),
    }

    content_upper = content.upper()
    lower_all = (filename + " " + content[:2000]).lower()
    
    for k, v in gene_map.items():
        if k in lower_all:
            return {
                "type": "VCF_KNOWN",
                "subjectId": f"DONOR_{filename.replace('.', '_')[:14].upper()}",
                "geneSymbol": v[0],
                "disease": v[1],
                "hpoCode": v[2],
                "ancestryRegion": v[3],
                "bloodGroup": v[4]
            }

    # Extract first variant line
    variant_locus = "Multi-locus Genomic Callset"
    for line in content.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 5:
            chrom, pos, var_id, ref, alt = parts[0], parts[1], parts[2], parts[3], parts[4]
            variant_locus = f"{chrom}:{pos} {ref}>{alt} ({var_id if var_id != '.' else 'SNP'})"
            break

    return {
        "type": "VCF_GENERIC",
        "subjectId": f"SAMPLE_{filename.replace('.', '_')[:12].upper()}",
        "geneSymbol": f"BCFtools Variant Callset ({variant_locus})",
        "disease": "Bioinformatics Reference Cohort & Variant Standard",
        "hpoCode": "HP:0000001 — Reference Benchmark",
        "ancestryRegion": "International Benchmark Panel",
        "bloodGroup": "O+"
    }

for path, fname, src in files_to_test:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        c = f.read()
    res = parse_genomic_metadata(c, fname)
    print(f"[{res['type']:18}] {fname:38} -> {res['geneSymbol'][:32]} | {res['disease'][:35]}")

print("=" * 70)
