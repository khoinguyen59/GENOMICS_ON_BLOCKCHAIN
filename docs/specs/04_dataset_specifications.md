# ĐẶC TẢ THÔNG TIN DỮ LIỆU HỆ GEN (GENOMIC DATASET SPECIFICATIONS)

> **Mã Tài Liệu:** `SPEC-DATASET-04`  
> **Dự Án:** GenoChain — Nền Tảng Quản Lý & Chia Sẻ Dữ Liệu Di Truyền Trên Blockchain (IS355 - ĐHQG-HCM UIT)  
> **Mục Đích:** Tách bạch toàn bộ thông tin chi tiết về các bộ dữ liệu mẫu, định dạng tệp, cấu trúc metadata ra khỏi tầng Quy chuẩn Hệ thống (System Rules).  
> **Nguyên Tắc Quản Trị:** Tài liệu này là tệp thông tin tham chiếu độc lập (Informational Reference). Mọi thay đổi, bổ sung hoặc tái cấu trúc dữ liệu di truyền được thực hiện tại đây mà không làm thay đổi các quy tắc kỹ thuật cốt lõi trong `AGENTS.md`.

---

## 1. Nguyên Lý Trừu Tượng Hóa Dữ Liệu (Data-Agnostic Infrastructure)

Hạ tầng GenoChain (Smart Contracts, WebCrypto Client-Side Encryption, IPFS Storage) được thiết kế theo mô hình **trừu tượng hóa dữ liệu (Data-Agnostic)**:
1. **Tầng Blockchain (Smart Contracts):** Không giả định hay kiểm tra cấu trúc nội dung sinh học của tệp. Hợp đồng chỉ lưu trữ mã băm toàn vẹn `rawDataHash` (SHA-256), địa chỉ IPFS `rawCiphertextCid`, `summaryCiphertextCid`, `metadataCid`, giá `price`, thời hạn `accessDuration` và bản quyền tác giả `royaltyBps` (EIP-2981).
2. **Tầng Mật Mã (Client-Side WebCrypto):** Thực hiện mã hóa đối xứng AES-GCM 256-bit (hỗ trợ cả khối đơn lẫn container phân đoạn `GNC2` `64 KB` với `25-byte AAD`, tương thích ngược giải mã `GNC1`) trên luồng nhị phân bất kỳ (ArrayBuffer) và bọc khóa phiên đối xứng bằng khóa công khai RSA-OAEP 2048-bit của người mua.
3. **Tầng Lưu Trữ (IPFS Dual-Engine):** Lưu trữ ciphertext nhị phân nguyên vẹn với định dạng IPFS Multihash chuẩn (CIDv0 `Qm...` hoặc CIDv1 `bafy...`).

---

## 2. Các Định Dạng Tệp Dữ Liệu Được Hỗ Trợ

| Định Dạng | Mô Tả Kỹ Thuật | Phạm Vi Sử Dụng | Tiêu Chuẩn Tham Chiếu |
| :--- | :--- | :--- | :--- |
| **VCF v4.2 / VCF.GZ** | *Variant Call Format & BGZF Compressed VCF* | Lưu trữ các biến dị nucleotide đơn (SNP), đột biến thêm/mất đoạn (Indel) dạng văn bản hoặc nén nhị phân nguyên vẹn | GA4GH / HTSlib Specification |
| **BAM / Crypt4GH** | *Binary Alignment Map & `.c4gh` Container* | Đóng gói và truyền tải luồng nhị phân căn chỉnh giải trình tự hoặc container mã hóa chuẩn y sinh mà không biến đổi UTF-8 | SAM/BAM & GA4GH Crypt4GH |
| **FASTQ** | *Raw NGS Sequencing Reads* | Chuỗi nucleotide đọc thô kèm thang điểm chất lượng Phred (+33 Q30) từ máy giải trình tự Illumina | Sequence Read Archive (SRA) |
| **FASTA** | *Reference Contigs & Assemblies* | Trình tự nucleotide tham chiếu hệ gen ty thể (chrM) và các contig nhiễm sắc thể GRCh38 | NCBI / RefSeq Standards |
| **JSON** | *GA4GH Phenopackets v2* | Metadata mô tả kiểu hình, tính trạng, cơ sở dữ liệu đối chiếu (dbSNP, ClinVar, Ensembl) | GA4GH Phenopacket Schema v2 |
| **PDF** | *Research & Diagnostic Summary* | Báo cáo tóm tắt phân tích di truyền học hoặc chứng chỉ kiểm nghiệm giải trình tự | Standard Encrypted Binary PDF |

---

## 3. Danh Mục 13 Bộ Dữ Liệu Mẫu (Preset Catalog)

Toàn bộ 13 dataset mẫu dưới đây được tích hợp sẵn trong hai thư mục tĩnh của Frontend — **`frontend/public/samples/`** (URL `/samples/`, 4 mẫu biến thể đơn lẻ: `ALDH2`, `LCT`, `ABCC11`, `CYP1A2`) và **`frontend/public/datasets/`** (URL `/datasets/`, 9 bộ đối chứng quần thể & giải trình tự: `KHV_1000G`, `NA12878_GIAB`, `ACTN3`, `HERC2`, `TAS2R38`, `EDAR`, `Illumina_WGS_reads_sample.fastq`, `GRCh38_chrM_mitochondrial.fa`, `SAMtools_bcftools_view.vcf`) — và ánh xạ đầy đủ qua `frontend/src/services/vcf/presetCatalog.js`:

| ID Preset | Tên Dữ Liệu Mẫu | Gen / Locus | Biến Dị (rsId) | Phân Loại | Đường Dẫn Tĩnh | Giá ($GENO) | Thời Hạn | Quần Thể |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| `KHV_1000G` | 1000 Genomes Project Quần thể Kinh TP.HCM | ALDH2 / ADH1B | chr12 Callset | Population Genetics | `/datasets/` | 100 | 45 ngày | Vietnamese Kinh (KHV) |
| `NA12878_GIAB` | Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB | GIAB NA12878 Chr20 Germline WGS | Benchmark Callset | Reference Benchmark | `/datasets/` | 110 | 90 ngày | European (CEU Utah) |
| `ACTN3_PERFORMANCE` | Cấu Trúc Sợi Cơ Co Nhanh & Tốc Độ Điền Kinh | ACTN3 (c.1729C>T) | rs1815739 (R577X) | Physical Traits & Performance | `/datasets/` | 85 | 30 ngày | Global Multi-ethnic |
| `HERC2_PIGMENTATION` | Sắc Tố Màu Mắt & Tóc / Da | HERC2 / OCA2 | rs12913832 | Physical Traits & Performance | `/datasets/` | 70 | 30 ngày | European & Global Panel |
| `TAS2R38_TASTE` | Cảm Nhận Vị Giác Đắng Hợp Chất PTC | TAS2R38 (p.Pro49Ala)| rs713598 | Sensory & Metabolism | `/datasets/` | 65 | 30 ngày | East & Southeast Asian |
| `EDAR_MORPHOLOGY` | Độ Dày Sợi Tóc & Hình Thái Răng Đông Á | EDAR (p.Val370Ala) | rs3827760 | Physical Traits & Performance | `/datasets/` | 75 | 30 ngày | East & Southeast Asian |
| `LCT_LACTASE` | Dung Nạp Đường Sữa Ở Người Trưởng Thành | MCM6 / LCT | rs4988235 | Sensory & Metabolism | `/samples/` | 75 | 30 ngày | Vietnamese Kinh |
| `ALDH2_METABOLISM` | Đỏ Mặt Khi Uống Rượu & Chuyển Hóa Cồn | ALDH2 (p.Glu504Lys) | rs671 | Sensory & Metabolism | `/samples/` | 80 | 30 ngày | Vietnamese Kinh |
| `ABCC11_EARWAX` | Đặc Tính Ráy Tai Khô & Mồ Hôi Tuyến Apocrine | ABCC11 (p.Gly180Arg)| rs17822931 | Physical Traits & Performance | `/samples/` | 60 | 30 ngày | Vietnamese Kinh |
| `CYP1A2_CAFFEINE` | Dược Di Truyền: Tốc Độ Thanh Thải Cafein Gan | CYP1A2 (*1F) | rs762551 | Pharmacogenomics | `/samples/` | 90 | 45 ngày | East Asian Panel |
| `WGS_FASTQ_READS` | Đọc Trình Tự Toàn Bộ Hệ Gen Người 30x | Whole Genome | NovaSeq Reads Q30 | Reference Benchmark | `/datasets/` | 120 | 30 ngày | Illumina Platform |
| `CHRM_MITOCHONDRIAL`| Hệ Gen Ty Thể Toàn Phần Tham Chiếu (16.5kb) | chrM Circular | NC_012920.1 | Reference Benchmark | `/datasets/` | 50 | 30 ngày | GRCh38 Standard |
| `SAMTOOLS_REF_PANEL`| Bộ Biến Dị Đối Chứng Đa Mẫu Nhiễm Sắc Thể | Autosome & Allosome| Multi-Sample VCF | Reference Benchmark | `/datasets/` | 95 | 45 ngày | 1000G Trio Panel |

---

## 4. Cấu Trúc Metadata Chuẩn GA4GH Phenopackets v2 (JSON Schema)

Mỗi dataset khi đăng ký on-chain đều có một tệp metadata JSON công khai được tạo bởi [`ipfs/phenopacket_builder.js`](../../ipfs/phenopacket_builder.js) và tải lên IPFS (`metadataCid`) theo đúng cấu trúc GA4GH Phenopackets v2 (ẩn danh chủ thể `ANON_...`, ẩn HGVS chi tiết, không chứa base nucleotide thô):

```json
{
  "id": "phenopacket-ANON_7f3a1b9c2d4e5f60",
  "files": [
    {
      "uri": "ipfs://Qm...",
      "individualToFileIdentifiers": { "ANON_7f3a1b9c2d4e5f60": "ANON_7f3a1b9c2d4e5f60.vcf" },
      "fileAttributes": {
        "fileFormat": "VCF v4.2",
        "genomeAssembly": "GRCh38",
        "isEncrypted": "true",
        "encryptionAlgorithm": "AES-256-GCM",
        "rawDataHash": "0x..."
      }
    }
  ],
  "subject": {
    "id": "ANON_7f3a1b9c2d4e5f60",
    "sex": "FEMALE",
    "karyotypicSex": "XX",
    "taxonomy": { "id": "NCBITaxon:9606", "label": "Homo sapiens" },
    "vitalStatus": { "status": "ALIVE" }
  },
  "measurements": [
    {
      "assay": { "id": "LOINC:882-1", "label": "ABO and Rh group [Type] in Blood" },
      "value": { "ontologyClass": { "id": "SNOMED:278149003", "label": "O+" } }
    }
  ],
  "phenotypicFeatures": [
    { "type": { "id": "SO:0000694", "label": "Population Genomic SNP Callset" }, "excluded": false },
    { "type": { "id": "HANCESTRO:0021", "label": "Vietnamese Kinh (1000 Genomes: KHV)" }, "excluded": false }
  ],
  "diseases": [
    { "term": { "id": "SO:0000694", "label": "1000 Genomes Project - KHV Cohort WGS" } }
  ],
  "interpretations": [
    {
      "id": "interpretation-ANON_7f3a1b9c2d4e5f60",
      "progressStatus": "COMPLETED",
      "diagnosis": {
        "disease": { "id": "SO:0000694", "label": "1000 Genomes Project - KHV Cohort WGS" },
        "genomicInterpretations": [
          {
            "subjectOrBiosampleId": "ANON_7f3a1b9c2d4e5f60",
            "interpretationStatus": "CONTRIBUTORY",
            "variantInterpretation": {
              "acmgPathogenicityClassification": "BENIGN",
              "variationDescriptor": {
                "id": "rs671",
                "geneContext": { "valueId": "HGNC:404", "symbol": "ALDH2" },
                "vcfRecord": { "genomeAssembly": "GRCh38", "chrom": "chr12", "pos": 111803962, "id": "rs671" },
                "expressions": [{ "syntax": "hgvs", "value": "[REDACTED_PROTECTED_UNDER_ENCRYPTED_PAYLOAD]" }],
                "allelicState": { "id": "GENO:0000135", "label": "0/1 Heterozygous" }
              }
            }
          }
        ]
      }
    }
  ],
  "metaData": {
    "created": "2026-01-01T00:00:00.000Z",
    "createdBy": "GenomicsBlockchainRegistry_v2",
    "resources": [
      {
        "id": "so",
        "name": "Sequence Ontology",
        "url": "http://purl.obolibrary.org/obo/so.owl",
        "version": "2026-01-01",
        "namespacePrefix": "SO",
        "iriPrefix": "http://purl.obolibrary.org/obo/SO_"
      },
      {
        "id": "hancestro",
        "name": "Human Ancestry Ontology",
        "url": "http://purl.obolibrary.org/obo/hancestro.owl",
        "version": "2026-01-01",
        "namespacePrefix": "HANCESTRO",
        "iriPrefix": "http://purl.obolibrary.org/obo/HANCESTRO_"
      },
      {
        "id": "loinc",
        "name": "Logical Observation Identifiers Names and Codes",
        "url": "https://loinc.org",
        "version": "2.77",
        "namespacePrefix": "LOINC",
        "iriPrefix": "https://loinc.org/"
      },
      {
        "id": "snomed",
        "name": "SNOMED Clinical Terms",
        "url": "https://www.snomed.org",
        "version": "2026-01-01",
        "namespacePrefix": "SNOMED",
        "iriPrefix": "http://snomed.info/id/"
      },
      {
        "id": "geno",
        "name": "Genotype Ontology",
        "url": "http://purl.obolibrary.org/obo/geno.owl",
        "version": "2026-01-01",
        "namespacePrefix": "GENO",
        "iriPrefix": "http://purl.obolibrary.org/obo/GENO_"
      },
      {
        "id": "ncbitaxon",
        "name": "NCBI Organismal Classification",
        "url": "http://purl.obolibrary.org/obo/ncbitaxon.owl",
        "version": "2026-01-01",
        "namespacePrefix": "NCBITaxon",
        "iriPrefix": "http://purl.obolibrary.org/obo/NCBITaxon_"
      },
      {
        "id": "hgnc",
        "name": "HUGO Gene Nomenclature Committee",
        "url": "https://www.genenames.org",
        "version": "2026-01-01",
        "namespacePrefix": "HGNC",
        "iriPrefix": "https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:"
      }
    ],
    "phenopacketSchemaVersion": "2.0.0",
    "externalReferences": [
      { "id": "GENOMICS_BLOCKCHAIN_INTEGRITY", "description": "SHA-256 rawDataHash: 0x..." },
      { "id": "GENOCHAIN_CLINICAL_SIGNIFICANCE", "description": "Population Genetics" }
    ]
  }
}
```

---

## 5. Hướng Dẫn Sửa Đổi & Mở Rộng Dataset Sau Này

Khi muốn thêm bộ dữ liệu mới hoặc thay thế dữ liệu phục vụ nghiên cứu lâm sàng / bài tập thực hành khác:
1. **Bước 1 (Thêm tệp nguồn):** Đặt tệp dữ liệu (`.vcf`, `.vcf.gz`, `.bam`, `.c4gh`, `.fastq`, `.fa`, `.pdf`) vào thư mục `frontend/public/samples/` hoặc `frontend/public/datasets/`.
2. **Bước 2 (Khai báo cấu hình):** Bổ sung mục cấu hình mới vào `frontend/src/services/vcf/presetCatalog.js`.
3. **Bước 3 (Cập nhật seed metadata nếu cần):** Chạy `npx hardhat run scripts/deploy/deploy.js --network localhost` để mã hóa, ghim IPFS và đồng bộ `frontend/src/contracts/seedMetadata.json`.
4. **Không cần chỉnh sửa Smart Contract:** Smart Contract chấp nhận bất kỳ tệp dữ liệu nào mà không đòi hỏi chỉnh sửa logic hay cấu trúc hợp đồng.