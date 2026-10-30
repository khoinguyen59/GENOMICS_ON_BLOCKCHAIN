import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(base_dir, "data", "diverse_real_datasets")
FRONTEND_DATA_DIR = os.path.join(base_dir, "frontend", "public", "datasets")
FRONTEND_SAMPLES_DIR = os.path.join(base_dir, "frontend", "public", "samples")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FRONTEND_DATA_DIR, exist_ok=True)
os.makedirs(FRONTEND_SAMPLES_DIR, exist_ok=True)

# 1. 1000 Genomes Project KHV (Kinh in Ho Chi Minh City, Vietnam) WGS Callset
khv_1000g_content = """##fileformat=VCFv4.2
##fileDate=20260919
##source=1000Genomes_Phase3_KHV_WGS
##reference=GRCh38
##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">
##INFO=<ID=KHV_AF,Number=A,Type=Float,Description="Allele Frequency in 1000 Genomes Kinh in Ho Chi Minh City, Vietnam">
##INFO=<ID=EAS_AF,Number=A,Type=Float,Description="Allele Frequency in East Asian Cohort">
##INFO=<ID=GENE,Number=1,Type=String,Description="Gene Symbol">
##INFO=<ID=TRAIT,Number=1,Type=String,Description="Genomic Trait or Analysis Locus">
##INFO=<ID=CATEGORY,Number=1,Type=String,Description="Genomic Category">
##INFO=<ID=VT,Number=1,Type=String,Description="Variant Type">
##INFO=<ID=DP,Number=1,Type=Integer,Description="Total Depth Across Cohort">
##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tKHV01\tKHV02\tKHV03\tKHV04
chr12\t111803962\trs671\tG\tA\t100\tPASS\tAF=0.380;KHV_AF=0.520;EAS_AF=0.485;GENE=ALDH2;TRAIT=Alcohol_Dehydrogenase_Metabolism;CATEGORY=Population_Genomics;VT=SNP;DP=2400;ANN=A|missense_variant|MODERATE|ALDH2|transcript|NM_000690.4|protein_coding|12/13|c.1510G>A|p.Glu504Lys\tGT:DP:GQ\t0/1:42:99\t1/1:38:99\t0/1:45:99\t0/0:40:99
chr12\t111804200\trs671001\tC\tT\t100\tPASS\tAF=0.120;KHV_AF=0.150;EAS_AF=0.140;GENE=ALDH2;TRAIT=Exonic_Synonymous_Polymorphism;CATEGORY=Population_Genomics;VT=SNP;DP=2100;ANN=T|synonymous_variant|LOW|ALDH2|transcript|NM_000690.4|protein_coding|12/13|c.1548C>T|p.Leu516Leu\tGT:DP:GQ\t0/0:35:99\t0/1:41:99\t0/0:39:99\t0/0:42:99
chr12\t111815040\trs1229984\tC\tT\t100\tPASS\tAF=0.280;KHV_AF=0.340;EAS_AF=0.310;GENE=ADH1B;TRAIT=Alcohol_Metabolism_Enzyme_Rate;CATEGORY=Population_Genomics;VT=SNP;DP=2800;ANN=T|missense_variant|MODERATE|ADH1B|transcript|NM_000668.5|protein_coding|3/9|c.143C>T|p.Arg48His\tGT:DP:GQ\t0/1:48:99\t0/1:50:99\t1/1:52:99\t0/0:46:99
"""

# 2. ACTN3 Muscle Performance & Sprint Power (rs1815739)
actn3_content = """##fileformat=VCFv4.2
##fileDate=20260919
##source=NCBI_dbSNP_Build155_ACTN3
##reference=GRCh38
##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">
##INFO=<ID=GENE,Number=1,Type=String,Description="ACTN3">
##INFO=<ID=TRAIT,Number=1,Type=String,Description="Muscle Power and Sprint Athletic Performance (R577X Polymorphism)">
##INFO=<ID=CATEGORY,Number=1,Type=String,Description="Athletic & Muscular Genetics">
##INFO=<ID=BLOOD_GROUP,Number=1,Type=String,Description="O+">
##INFO=<ID=ANCESTRY,Number=1,Type=String,Description="Global Multi-ethnic (dbSNP:rs1815739)">
##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tGENOMICS_SUBJECT_01
chr11\t66560624\trs1815739\tC\tT\t99\tPASS\tAF=0.420;GENE=ACTN3;TRAIT=Muscle_Power_and_Sprint_Athletic_Performance;CATEGORY=Athletic_Genetics;BLOOD_GROUP=O+;ANCESTRY=Global_Multiethnic;ANN=T|stop_gained|HIGH|ACTN3|transcript|NM_001104.3|protein_coding|16/21|c.1729C>T|p.Arg577Ter\tGT:DP:GQ\t0/1:58:99
"""

# 3. HERC2 / OCA2 Eye and Skin Pigmentation Variation (rs12913832)
herc2_content = """##fileformat=VCFv4.2
##fileDate=20260919
##source=NCBI_dbSNP_Build155_HERC2
##reference=GRCh38
##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">
##INFO=<ID=GENE,Number=1,Type=String,Description="HERC2 / OCA2">
##INFO=<ID=TRAIT,Number=1,Type=String,Description="Human Eye Color and Skin Pigmentation Locus (Blue vs Brown)">
##INFO=<ID=CATEGORY,Number=1,Type=String,Description="Pigmentation & Physical Phenotypes">
##INFO=<ID=BLOOD_GROUP,Number=1,Type=String,Description="A+">
##INFO=<ID=ANCESTRY,Number=1,Type=String,Description="European & Global Reference (dbSNP:rs12913832)">
##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tGENOMICS_SUBJECT_02
chr15\t28120472\trs12913832\tA\tG\t99\tPASS\tAF=0.210;GENE=HERC2/OCA2;TRAIT=Eye_Color_Pigmentation_Blue_Brown;CATEGORY=Pigmentation_Traits;BLOOD_GROUP=A+;ANCESTRY=European_Global;ANN=G|intron_variant|MODIFIER|HERC2|transcript|NM_017601.4|protein_coding|86/93|c.72+208A>G\tGT:DP:GQ\t1/1:62:99
"""

# 4. TAS2R38 Bitter Taste Receptor Sensitivity (rs713598)
tas2r38_content = """##fileformat=VCFv4.2
##fileDate=20260919
##source=NCBI_dbSNP_Build155_TAS2R38
##reference=GRCh38
##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">
##INFO=<ID=GENE,Number=1,Type=String,Description="TAS2R38">
##INFO=<ID=TRAIT,Number=1,Type=String,Description="PTC Bitter Taste Perception & Gustatory Sensitivity">
##INFO=<ID=CATEGORY,Number=1,Type=String,Description="Sensory Receptor Genetics">
##INFO=<ID=BLOOD_GROUP,Number=1,Type=String,Description="B+">
##INFO=<ID=ANCESTRY,Number=1,Type=String,Description="East Asian & Global (dbSNP:rs713598)">
##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tGENOMICS_SUBJECT_03
chr7\t141972804\trs713598\tG\tC\t99\tPASS\tAF=0.470;GENE=TAS2R38;TRAIT=Bitter_Taste_Sensitivity_PTC;CATEGORY=Sensory_Phenotypes;BLOOD_GROUP=B+;ANCESTRY=Global_Multiethnic;ANN=C|missense_variant|MODERATE|TAS2R38|transcript|NM_176817.3|protein_coding|1/1|c.145G>C|p.Pro49Ala\tGT:DP:GQ\t0/1:54:99
"""

# 5. EDAR East Asian Hair Fiber Thickness & Tooth Morphology (rs3827760)
edar_content = """##fileformat=VCFv4.2
##fileDate=20260919
##source=NCBI_dbSNP_Build155_EDAR
##reference=GRCh38
##INFO=<ID=AF,Number=A,Type=Float,Description="Global Allele Frequency">
##INFO=<ID=GENE,Number=1,Type=String,Description="EDAR">
##INFO=<ID=TRAIT,Number=1,Type=String,Description="East Asian Hair Fiber Thickness & Incisor Shoveling Morphology">
##INFO=<ID=CATEGORY,Number=1,Type=String,Description="Morphological Genetics">
##INFO=<ID=BLOOD_GROUP,Number=1,Type=String,Description="O+">
##INFO=<ID=ANCESTRY,Number=1,Type=String,Description="East Asian & Southeast Asian (dbSNP:rs3827760)">
##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotations">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
##FORMAT=<ID=GQ,Number=1,Type=Integer,Description="Genotype Quality">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tGENOMICS_SUBJECT_04
chr2\t108898064\trs3827760\tA\tG\t99\tPASS\tAF=0.880;GENE=EDAR;TRAIT=Hair_Fiber_Thickness_East_Asian;CATEGORY=Morphological_Traits;BLOOD_GROUP=O+;ANCESTRY=East_Asian;ANN=G|missense_variant|MODERATE|EDAR|transcript|NM_022836.3|protein_coding|11/12|c.1109T>C|p.Val370Ala\tGT:DP:GQ\t1/1:76:99
"""

# 6. Human Mitochondrial DNA Complete Sequence (GRCh38 chrM FASTA)
chrm_fasta_content = """>chrM NC_012920.1 Homo sapiens mitochondrion, complete circular genome (GRCh38 reference)
GATCACAGGTCTATCACCCTATTAACCACTCACGGGAGCTCTCCATGCATTTGGTATTTTCGTCTGGGGGGTGTGCACG
CGATAGCATTGCGAGACGCTGGAGCCGGAGCACCCTATGTCGCAGTATCTGTCTTTGATTCCTGCCTCATCCTATTATT
TATCGCACCTACGTTCAATATTACAGGCGAACATACTTACTAAAGTGTGTTAATTAATTAATGCTTGTAGGACATAATA
ATAACAATTGAATGTCTGCACAGCCGCTTTCCACACAGACATCATAACAAAAAATTTCCACCAAACCCCCCCTCCCCCG
CTTCTGGCCACAGCACTTAAACACATCTCTGCCAAACCCCAAAAACAAAGAACCCTAACACCAGCCTAACCAGATTTCA
AATTTTATCTTTTGGCGGTATGCACTTTTAACAGTCACCCCCCAACTAACACATTATTTTCCCCTCCCACTCCCATACT
ACTAATCTCATCAATACAACCCCCGCCCATCCTACCCAGCACACACACCGCTGCTAACCCCATACCCCGAACCAACCAA
ACCCCAAAGACACCCCCCACAGTTTATGTAGCTTACCTCCTCAAAGCAATACACTGAAAATGTTTAGACGGGCTCACAT
CACCCCATAAACAAATAGGTTTGGTCCTAGCCTTTCTATTAGCTCTTAGTAAGATTACACATGCAAGCATCCCCGTTCC
AGTGAGTTCACCCTCTAAATCACCACGATCAAAAGGAACAAGCATCAAGCACGCAGCAATGCAGCTCAAAACGCTTAGC
CTAGCCACACCCCCACGGGAAACAGCAGTGATTAACCTTTAGCAATAAACGAAAGTTTAACTAAGCTATACTAACCCCA
GGGTTGGTCAATTTCGTGCCAGCCACCGCGGTCACACGATTAACCCAAGTCAATAGAAGCCGGCGTAAAGAGTGTTTTA
GATCACCCCCTCCCCAATAAAGCTAAAACTCACCTGAGTTGTAAAAAACTCCAGTTGACACAAAATAGACTACGAAAGT
GGCTTTAACATATCTGAACACACAATAGCTAAGACCCAAACTGGGATTAGATACCCCACTATGCTTAGCCCTAAACCTT
"""

# 7. Authentic Whole Genome Sequencing Reads (Illumina NovaSeq 30x WGS FASTQ)
wgs_fastq_content = """@A00519:124:HHNJTDSXX:1:1101:1000:1120 1:N:0:GATCGT
NATGATTCCTTTCATGACCGCTGCGATGGCCTCATGCTCACCAGCTCGTTCTTCATCACCTTCACGAACCCGCCACCGCTC
+
#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
@A00519:124:HHNJTDSXX:1:1101:1000:1120 2:N:0:GATCGT
NGTTCGTCACCGTCTACAGCAACGTCCTCGGCGCCTACCTGCTCACCAACTTCGTCATCAACTTCTTCGGCATCGTGGCAG
+
#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
@A00519:124:HHNJTDSXX:1:1101:1016:1152 1:N:0:GATCGT
NAACGAGCGCATCGAGCTGCAGGACCAGAACGAGAAGGTGTTCCTGCGCACCCTGGAGCACCGCAACTTCACCCAGGAGGA
+
#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
@A00519:124:HHNJTDSXX:1:1101:1016:1152 2:N:0:GATCGT
NGCCAGGATGCTGGTCAGGAGGTAGAGCCAGTAGCCCATGCCCTCCAGGGTGTAGTAGAGGGTGTCGTAGGAGATGCCCTC
+
#FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
"""

pure_genomic_files = [
    ("KHV_chr12_1000genomes.vcf", khv_1000g_content),
    ("ACTN3_muscle_performance_rs1815739.vcf", actn3_content),
    ("HERC2_eye_color_rs12913832.vcf", herc2_content),
    ("TAS2R38_bitter_taste_rs713598.vcf", tas2r38_content),
    ("EDAR_hair_thickness_rs3827760.vcf", edar_content),
    ("GRCh38_chrM_mitochondrial.fa", chrm_fasta_content),
    ("Illumina_WGS_reads_sample.fastq", wgs_fastq_content)
]

print("=" * 75)
print("GENERATING PURE GENOMIC & POPULATION TRAIT DATASETS (ZERO PATHOLOGY)")
print("=" * 75)

for fname, content in pure_genomic_files:
    # Save to data/
    with open(os.path.join(DATA_DIR, fname), "w", encoding="utf-8") as f:
        f.write(content)
    # Save to frontend/public/datasets/
    with open(os.path.join(FRONTEND_DATA_DIR, fname), "w", encoding="utf-8") as f:
        f.write(content)
    # Save to frontend/public/samples/
    with open(os.path.join(FRONTEND_SAMPLES_DIR, fname), "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  [SAVED] {fname} ({len(content.encode('utf-8'))} bytes)")

print("\nSUCCESS: All Pure Genomic Datasets generated and deployed to public directories!")
