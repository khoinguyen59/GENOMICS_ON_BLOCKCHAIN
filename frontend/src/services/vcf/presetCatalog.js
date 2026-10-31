/**
 * @file presetCatalog.js
 * @description Static reference genomic datasets catalog for GenoChain (<200 lines).
 *              Strictly non-pathological molecular genetics & population benchmarks.
 */

export const PRESET_CATALOG = {
  // 1. 1000 Genomes Project - Vietnamese Kinh Cohort
  KHV_1000G: {
    id: "KHV_1000G", file: "KHV_chr12_1000genomes.vcf", url: "/datasets/KHV_chr12_1000genomes.vcf", subjectId: "1000G_KHV_VN_01",
    titleVi: "1000 Genomes Project - Quần thể Người Kinh TP.HCM", titleEn: "1000 Genomes Project - Ho Chi Minh City Kinh Cohort",
    traitVi: "Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)", traitEn: "Ho Chi Minh City Kinh Population WGS Cohort",
    genomicTrait: "1000 Genomes Project - Quần thể Hệ Gen Người Kinh TP.HCM (KHV Cohort WGS)",
    geneSymbol: "ALDH2 / ADH1B Multi-locus Loci (chr12)", variantClass: "SO:0000694 - Population Genomic SNP Callset",
    ancestryRegion: "Vietnamese Kinh (1000 Genomes: KHV)", priceGeno: 100, durationDays: 45,
    category: "1000 Genomes Project", categoryVi: "1000 Genomes Project", categoryEn: "1000 Genomes Project",
    toastVi: "Đã nạp dữ liệu gen: 1000 Genomes Project Quần thể Kinh Việt Nam (KHV WGS)",
    toastEn: "Loaded dataset: 1000 Genomes Project Vietnamese Kinh Cohort (KHV WGS)"
  },

  // 2. NIST / GIAB High-Confidence Benchmark Reference Genome
  NA12878_GIAB: {
    id: "NA12878_GIAB", file: "NA12878_chr20_sample.vcf", url: "/datasets/NA12878_chr20_sample.vcf", subjectId: "NIST_GIAB_NA12878",
    titleVi: "Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB NA12878", titleEn: "NIST GIAB Golden Reference Benchmark NA12878",
    traitVi: "Bộ Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB (High-Confidence)", traitEn: "NIST GIAB High-Confidence Benchmark Callset",
    genomicTrait: "Bộ Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB (High-Confidence Benchmark Callset)",
    geneSymbol: "CHR20 RNA-seq Non-Ref Variant Cohort", variantClass: "SO:0001483 - Benchmark Truth Callset (GIAB)",
    ancestryRegion: "European (CEU Utah Trio)", priceGeno: 110, durationDays: 30,
    category: "Reference Genomes", categoryVi: "Chuẩn Đối Chứng", categoryEn: "Benchmarks",
    toastVi: "Đã nạp chuẩn hệ gen: NIST / GIAB NA12878 Chr20 Callset",
    toastEn: "Loaded reference: NIST / GIAB NA12878 Chr20 Callset"
  },

  // 3. ACTN3 Muscle Fiber Composition & Athletic Performance (rs1815739)
  ACTN3_PERFORMANCE: {
    id: "ACTN3_PERFORMANCE", file: "ACTN3_muscle_performance_rs1815739.vcf", url: "/datasets/ACTN3_muscle_performance_rs1815739.vcf", subjectId: "SUBJECT_VN_ACTN3",
    titleVi: "Cấu Trúc Sợi Cơ Co Nhanh & Tốc Độ Điền Kinh (ACTN3)", titleEn: "Fast-Twitch Muscle Fiber & Athletic Sprint Power (ACTN3)",
    traitVi: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X)", traitEn: "Fast-Twitch Muscle Fiber & Sprint Performance (R577X)",
    genomicTrait: "Đặc Tính Cấu Trúc Sợi Cơ Nhanh & Sức Bền Thể Thao (R577X Polymorphism)",
    geneSymbol: "ACTN3 (c.1729C>T, rs1815739, p.Arg577Ter)", variantClass: "SO:0001587 - Stop-Gained Nonsense Polymorphism",
    ancestryRegion: "Global Multi-ethnic Cohort", priceGeno: 85, durationDays: 30,
    category: "Physical Traits & Performance", categoryVi: "Tính Trạng Thể Chất", categoryEn: "Physical Traits",
    toastVi: "Đã nạp dữ liệu gen: ACTN3 Cấu trúc cơ bắp & sức bền thể thao (rs1815739)",
    toastEn: "Loaded dataset: ACTN3 Muscle fiber & athletic performance (rs1815739)"
  },

  // 4. HERC2 / OCA2 Eye & Skin Pigmentation (rs12913832)
  HERC2_PIGMENTATION: {
    id: "HERC2_PIGMENTATION", file: "HERC2_eye_color_rs12913832.vcf", url: "/datasets/HERC2_eye_color_rs12913832.vcf", subjectId: "SUBJECT_HERC2_01",
    titleVi: "Sắc Tố Màu Mắt & Tóc / Da (HERC2/OCA2 Locus)", titleEn: "Eye & Skin Melanin Pigmentation (HERC2/OCA2 Locus)",
    traitVi: "Đặc Tính Đa Hình Sắc Tố Màu Mắt & Da", traitEn: "Eye & Skin Melanin Pigmentation Variation",
    genomicTrait: "Đặc Tính Đa Hình Sắc Tố Màu Mắt & Da (Human Eye Color Variation)",
    geneSymbol: "HERC2 / OCA2 (c.72+208A>G, rs12913832)", variantClass: "SO:0001627 - Regulatory Intronic Variant",
    ancestryRegion: "European & Global Reference Panel", priceGeno: 70, durationDays: 30,
    category: "Physical Traits & Performance", categoryVi: "Tính Trạng Thể Chất", categoryEn: "Physical Traits",
    toastVi: "Đã nạp dữ liệu gen: HERC2/OCA2 Đa hình sắc tố màu mắt & da (rs12913832)",
    toastEn: "Loaded dataset: HERC2/OCA2 Eye and skin pigmentation (rs12913832)"
  },

  // 5. TAS2R38 Bitter Taste Receptor Sensitivity (rs713598)
  TAS2R38_TASTE: {
    id: "TAS2R38_TASTE", file: "TAS2R38_bitter_taste_rs713598.vcf", url: "/datasets/TAS2R38_bitter_taste_rs713598.vcf", subjectId: "SUBJECT_TAS2R38_VN",
    titleVi: "Cảm Nhận Vị Giác Đắng Hợp Chất PTC / Rau Xanh (TAS2R38)", titleEn: "Bitter Taste Perception & PTC Sensitivity (TAS2R38)",
    traitVi: "Khả Năng Cảm Nhận Vị Giác Đắng PTC / Rau Xanh", traitEn: "Bitter Taste Receptor Sensitivity (PTC Perception)",
    genomicTrait: "Đặc Tính Cảm Nhận Vị Giác Đắng PTC / Rau Xanh (Phenylthiocarbamide Perception)",
    geneSymbol: "TAS2R38 (c.145G>C, rs713598, p.Pro49Ala)", variantClass: "SO:0001583 - Missense Variant (Sensory Receptor)",
    ancestryRegion: "East Asian & Southeast Asian", priceGeno: 65, durationDays: 30,
    category: "Sensory & Metabolism", categoryVi: "Chuyển Hóa & Vị Giác", categoryEn: "Metabolism & Sensory",
    toastVi: "Đã nạp dữ liệu gen: TAS2R38 Thụ thể cảm nhận vị giác đắng PTC (rs713598)",
    toastEn: "Loaded dataset: TAS2R38 Bitter taste perception (rs713598)"
  },

  // 6. EDAR East Asian Hair Thickness & Tooth Morphology (rs3827760)
  EDAR_MORPHOLOGY: {
    id: "EDAR_MORPHOLOGY", file: "EDAR_hair_thickness_rs3827760.vcf", url: "/datasets/EDAR_hair_thickness_rs3827760.vcf", subjectId: "SUBJECT_EA_EDAR",
    titleVi: "Độ Dày Sợi Tóc & Hình Thái Răng Đông Á (EDAR)", titleEn: "East Asian Hair Thickness & Tooth Morphology (EDAR)",
    traitVi: "Độ Dày Sợi Tóc & Hình Thái Răng Đặc Trưng Đông Á (Val370Ala)", traitEn: "Hair Thickness & Tooth Morphology Variation (Val370Ala)",
    genomicTrait: "Đặc Tính Độ Dày Sợi Tóc & Hình Thái Răng Đặc Trưng Đông Á (Val370Ala)",
    geneSymbol: "EDAR (c.1109T>C, rs3827760, p.Val370Ala)", variantClass: "SO:0001583 - Adaptive Missense Variant",
    ancestryRegion: "East Asian & Southeast Asian", priceGeno: 75, durationDays: 30,
    category: "Morphological Traits", categoryVi: "Hình Thái Học", categoryEn: "Morphological Traits",
    toastVi: "Đã nạp dữ liệu gen: EDAR Độ dày sợi tóc & hình thái răng Đông Á (rs3827760)",
    toastEn: "Loaded dataset: EDAR Hair thickness & morphology (rs3827760)"
  },

  // 7. MCM6 / LCT Lactase Persistence Regulatory Locus (rs4988235)
  LCT_LACTASE: {
    id: "LCT_LACTASE", file: "LCT_lactose_intolerance_rs4988235.vcf", url: "/samples/LCT_lactose_intolerance_rs4988235.vcf", subjectId: "DONOR_VN_KINH_02",
    titleVi: "Khả Năng Dung Nạp Đường Sữa & Enzyme Lactase (MCM6/LCT)", titleEn: "Adult Lactase Persistence & Dairy Tolerance (MCM6/LCT)",
    traitVi: "Duy Trì Enzyme Lactase Ở Người Trưởng Thành", traitEn: "Lactase Persistence in Adulthood",
    genomicTrait: "Duy Trì Enzyme Lactase Ở Người Trưởng Thành (Lactase Persistence Locus)",
    geneSymbol: "MCM6 / LCT (c.-13910C>T, rs4988235)", variantClass: "SO:0001627 - Intronic Enhancer Polymorphism",
    ancestryRegion: "Vietnamese (Kinh Cohort)", priceGeno: 75, durationDays: 30,
    category: "Sensory & Metabolism", categoryVi: "Chuyển Hóa & Vị Giác", categoryEn: "Metabolism & Sensory",
    toastVi: "Đã nạp dữ liệu gen: MCM6/LCT Duy trì enzyme tiêu hóa đường sữa (rs4988235)",
    toastEn: "Loaded dataset: MCM6/LCT Lactase persistence locus (rs4988235)"
  },

  // 8. ALDH2 Alcohol Dehydrogenase Metabolic Locus (rs671)
  ALDH2_METABOLISM: {
    id: "ALDH2_METABOLISM", file: "ALDH2_alcohol_flush_rs671.vcf", url: "/samples/ALDH2_alcohol_flush_rs671.vcf", subjectId: "DONOR_VN_KINH_01",
    titleVi: "Đỏ Mặt Khi Uống Rượu & Tốc Độ Chuyển Hóa Cồn (ALDH2)", titleEn: "Alcohol Flushing & Acetaldehyde Clearance (ALDH2)",
    traitVi: "Tốc Độ Chuyển Hóa Acetaldehyde & Cồn", traitEn: "Acetaldehyde & Alcohol Metabolic Clearance Rate",
    genomicTrait: "Tốc Độ Chuyển Hóa Acetaldehyde & Cồn (Alcohol Dehydrogenase Locus)",
    geneSymbol: "ALDH2 (c.1510G>A, rs671, p.Glu504Lys)", variantClass: "SO:0001583 - Missense Polymorphism",
    ancestryRegion: "Vietnamese (Kinh Cohort)", priceGeno: 80, durationDays: 30,
    category: "Sensory & Metabolism", categoryVi: "Chuyển Hóa & Vị Giác", categoryEn: "Metabolism & Sensory",
    toastVi: "Đã nạp dữ liệu gen: ALDH2 Tốc độ chuyển hóa cồn (rs671)",
    toastEn: "Loaded dataset: ALDH2 Alcohol metabolism rate (rs671)"
  },

  // 9. ABCC11 Apocrine Secretion & Earwax Morphology (rs17822931)
  ABCC11_EARWAX: {
    id: "ABCC11_EARWAX", file: "ABCC11_earwax_type_rs17822931.vcf", url: "/samples/ABCC11_earwax_type_rs17822931.vcf", subjectId: "DONOR_VN_KINH_04",
    titleVi: "Đặc Tính Ráy Tai Khô & Tuyến Mồ Hôi Nách (ABCC11)", titleEn: "Dry Earwax Type & Apocrine Gland Secretion (ABCC11)",
    traitVi: "Đặc Tính Ráy Tai Khô & Tuyến Tiết Mồ Hôi Apocrine", traitEn: "Dry Earwax Type & Apocrine Gland Activity",
    genomicTrait: "Đặc Tính Ráy Tai Khô & Tuyến Tiết Mồ Hôi Apocrine Đông Á",
    geneSymbol: "ABCC11 (c.538G>A, rs17822931, p.Gly180Arg)", variantClass: "SO:0001583 - Missense Variant",
    ancestryRegion: "Vietnamese (Kinh Cohort)", priceGeno: 60, durationDays: 30,
    category: "Morphological Traits", categoryVi: "Hình Thái Học", categoryEn: "Morphological Traits",
    toastVi: "Đã nạp dữ liệu gen: ABCC11 Đặc tính ráy tai khô & tuyến apocrine (rs17822931)",
    toastEn: "Loaded dataset: ABCC11 Earwax type & apocrine secretion (rs17822931)"
  },

  // 10. CYP1A2 Hepatic Caffeine Clearance Rate (rs762551)
  CYP1A2_CAFFEINE: {
    id: "CYP1A2_CAFFEINE", file: "CYP1A2_caffeine_metabolism_rs762551.vcf", url: "/samples/CYP1A2_caffeine_metabolism_rs762551.vcf", subjectId: "DONOR_EA_03",
    titleVi: "Dược Di Truyền: Tốc Độ Thanh Thải Cafein Ở Gan (CYP1A2)", titleEn: "Pharmacogenomics: Hepatic Caffeine Clearance Rate (CYP1A2)",
    traitVi: "Dược Di Truyền: Tốc Độ Thanh Thải Cafein Ở Gan", traitEn: "Pharmacogenomics: Hepatic Caffeine Clearance Rate",
    genomicTrait: "Dược Di Truyền: Tốc Độ Thanh Thải Cafein Ở Gan (CYP1A2*1F Inducibility)",
    geneSymbol: "CYP1A2 (c.-163A>C, rs762551)", variantClass: "SO:0001627 - Intronic Regulatory Variant",
    ancestryRegion: "East Asian Panel", priceGeno: 90, durationDays: 45,
    category: "Sensory & Metabolism", categoryVi: "Chuyển Hóa & Vị Giác", categoryEn: "Metabolism & Sensory",
    toastVi: "Đã nạp dữ liệu gen: CYP1A2 Tốc độ thanh thải Cafein qua gan (rs762551)",
    toastEn: "Loaded dataset: CYP1A2 Hepatic caffeine clearance (rs762551)"
  },

  // 11. Whole Genome Sequencing Reads (Illumina NovaSeq FASTQ)
  WGS_FASTQ_READS: {
    id: "WGS_FASTQ_READS", file: "Illumina_WGS_reads_sample.fastq", url: "/datasets/Illumina_WGS_reads_sample.fastq", subjectId: "RUN_NOVASEQ_WGS",
    titleVi: "Đọc Trình Tự Toàn Bộ Hệ Gen Người 30x (NovaSeq FASTQ)", titleEn: "Human Whole Genome 30x Reads (NovaSeq FASTQ)",
    traitVi: "Giải Trình Tự Toàn Bộ Hệ Gen Người Đọc Thô 30x", traitEn: "Human Whole Genome High-Throughput 30x Reads",
    genomicTrait: "Giải Trình Tự Toàn Bộ Hệ Gen Người Đọc Thô 30x (Illumina NovaSeq WGS Reads)",
    geneSymbol: "Whole Human Genome 30x WGS Reads", variantClass: "SO:0001483 - snv_sequencing_read (FASTQ Q30)",
    ancestryRegion: "Illumina Sequencing Platform", priceGeno: 120, durationDays: 30,
    category: "NGS Sequencing Reads", categoryVi: "Giải Trình Tự", categoryEn: "Sequencing",
    toastVi: "Đã nạp dữ liệu giải trình tự thô: Illumina NovaSeq WGS FASTQ Reads",
    toastEn: "Loaded sequencing reads: Illumina NovaSeq WGS FASTQ Reads"
  },

  // 12. Complete Mitochondrial Genome (chrM FASTA)
  CHRM_MITOCHONDRIAL: {
    id: "CHRM_MITOCHONDRIAL", file: "GRCh38_chrM_mitochondrial.fa", url: "/datasets/GRCh38_chrM_mitochondrial.fa", subjectId: "REF_GRCH38_CHRM",
    titleVi: "Hệ Gen Ty Thể Toàn Phần Tham Chiếu (chrM Circular FASTA)", titleEn: "Human Mitochondrial Reference Genome (chrM FASTA)",
    traitVi: "Trình Tự Tham Chiếu Toàn Bộ Hệ Gen Ty Thể Người", traitEn: "Human Mitochondrial Reference Genome Sequence",
    genomicTrait: "Trình Tự Tham Chiếu Toàn Bộ Hệ Gen Ty Thể Người (chrM Circular Genome)",
    geneSymbol: "Mitochondrial Genome (16,569 bp Circular)", variantClass: "SO:0000340 - Circular Chromosome Contig",
    ancestryRegion: "GRCh38 / NC_012920.1 Reference", priceGeno: 50, durationDays: 30,
    category: "Reference Genomes", categoryVi: "Chuẩn Đối Chứng", categoryEn: "Benchmarks",
    toastVi: "Đã nạp dữ liệu hệ gen tham chiếu: Human Mitochondrial Genome chrM (FASTA)",
    toastEn: "Loaded reference genome: Human Mitochondrial Genome chrM (FASTA)"
  },

  // 13. SAMtools Multi-sample Reference Panel (VCF)
  SAMTOOLS_REF_PANEL: {
    id: "SAMTOOLS_REF_PANEL", file: "SAMtools_bcftools_view.vcf", url: "/datasets/SAMtools_bcftools_view.vcf", subjectId: "NA00001_1000G_TRIO",
    titleVi: "Tập Biến Dị Đối Chứng Đa Mẫu Nhiễm Sắc Thể (SAMtools)", titleEn: "Multi-Sample Autosome & Sex Chromosome Panel (SAMtools)",
    traitVi: "Bộ Gọi Biến Dị Đa Mẫu Nhiễm Sắc Thể Thường & Giới Tính", traitEn: "Multi-Sample Autosome & Sex Chromosome Callset",
    genomicTrait: "Bộ Gọi Biến Dị Đa Mẫu Nhiễm Sắc Thể Thường & Giới Tính (chr11, chr20, chrX, chrY)",
    geneSymbol: "SAMtools / BCFtools Multi-sample Panel", variantClass: "SO:0000694 - Multi-sample Variant Callset",
    ancestryRegion: "1000 Genomes Reference Panel", priceGeno: 95, durationDays: 45,
    category: "Reference Genomes", categoryVi: "Chuẩn Đối Chứng", categoryEn: "Benchmarks",
    toastVi: "Đã nạp tập biến dị đối chứng: SAMtools Multi-sample Panel",
    toastEn: "Loaded benchmark callset: SAMtools Multi-sample Panel"
  }
};
