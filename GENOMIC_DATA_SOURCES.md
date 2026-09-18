# Danh Sách Link Dữ Liệu Di Truyền Người (Open Human Genomic Datasets)

Tài liệu này tổng hợp các đường link trực tiếp truy cập và tải dữ liệu di truyền người (Human Genomics) từ các tổ chức y sinh học và viện nghiên cứu quốc tế. Toàn bộ là dữ liệu thật, mở và tải miễn phí (không yêu cầu tài khoản trả phí).

---

## 1. Dữ Liệu Tải Trực Tiếp (Direct Download Links)

### 1.1. Harvard Personal Genome Project (Harvard PGP)
Dữ liệu giải trình tự bộ gen mở của các cá nhân hiến tặng thuộc Đại học Y Harvard (GS. George Church).
- **Cổng dữ liệu mở:** https://my.pgp-hms.org/public_genetic_data
- **File mẫu tải trực tiếp:**
  - **Mẫu huEDADD6:**
    - Link hồ sơ: https://my.pgp-hms.org/profile/huEDADD6
    - Link tải file 23andMe raw text (~16.2 MB): https://my.pgp-hms.org/user_file/download/1230
  - **Mẫu hu011C57 (Full Genome VCF & Exome):**
    - Link hồ sơ: https://my.pgp-hms.org/profile/hu011C57
    - Link danh mục file VCF Complete Genomics: https://my.pgp-hms.org/profile/hu011C57#genetic-data
  - **Mẫu huCA017E:**
    - Link hồ sơ: https://my.pgp-hms.org/profile/huCA017E
    - Chứa file Microarray `.txt` và Complete Genomics `.tsv`.

---

### 1.2. 1000 Genomes Project (EMBL-EBI & US NIH)
Dữ liệu biến thể toàn diện của 2.504 người thuộc 26 quần thể trên toàn cầu, bao gồm quần thể người Kinh Việt Nam.
- **Cổng tra cứu mẫu (Sample Portal):** https://www.internationalgenome.org/data-portal/sample
- **Quần thể người Kinh Việt Nam (`KHV` — Kinh in Ho Chi Minh City, 99 mẫu cá thể):** https://www.internationalgenome.org/data-portal/population/KHV
  - *Mẫu cá thể người Kinh cụ thể để kiểm tra và tải:*
    - **HG02059 (Nữ, TP.HCM):** https://www.internationalgenome.org/data-portal/sample/HG02059
    - **HG02060 (Nam, TP.HCM):** https://www.internationalgenome.org/data-portal/sample/HG02060
    - **HG02061 (Nữ, TP.HCM):** https://www.internationalgenome.org/data-portal/sample/HG02061
- **Thư mục FTP / HTTP tải trực tiếp file VCF Phase 3:**
  - Index thư mục: http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/
  - Link tải file VCF nhiễm sắc thể 22 (gọn nhất trong các NST thường):
    http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz
  - File danh sách phân bố mẫu và quần thể (sample-to-population mapping):
    http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/integrated_call_samples_v3.20130502.ALL.ped
- **AWS Open Data Registry (Tải qua S3 không tốn phí băng thông):**
  - Web portal: https://registry.opendata.aws/1000-genomes/
  - S3 Bucket URL: `s3://1000genomes/`

---

### 1.3. OpenSNP (Cộng đồng Dữ liệu Gen Cá nhân Nguồn Mở)
Hàng ngàn file dữ liệu thô (23andMe, AncestryDNA, FamilyTreeDNA) do chính chủ sở hữu chia sẻ công khai theo giấy phép CC0/Creative Commons.
- **Trang tổng hợp file dữ liệu thô:** https://opensnp.org/genotypes
- **Link tải file raw genotype thực tế:**
  - File 23andMe mẫu 1: https://opensnp.org/data/1.23andme.txt
  - File 23andMe mẫu 2: https://opensnp.org/data/2.23andme.txt
  - File AncestryDNA mẫu: https://opensnp.org/data/17.ancestry.txt

---

### 1.4. Genome in a Bottle (GIAB / NIST & US NIH)
Bộ dữ liệu chuẩn hóa hệ gen người (Gold Standard Benchmark) được sử dụng trên toàn cầu để kiểm định máy giải trình tự và thuật toán sinh tin học.
- **Trang chủ dự án NIST:** https://www.nist.gov/programs-projects/genome-bottle
- **Mẫu chuẩn thế giới NA12878 (HG001 - Nữ):**
  - Thư mục FTP/HTTP tải file VCF & FASTQ:
    https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/data/NA12878/
  - File VCF chuẩn đã gọi biến thể (Benchmark VCF):
    https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/release/NA12878_HG001/latest_result/

---

## 2. Link Tra Cứu Biến Thể & Kiểu Hình Đặc Điểm Thể Chất (dbSNP / Ensembl / ClinVar)

Dưới đây là các đường link tra cứu trực tiếp từng biến thể di truyền (SNP) đại diện cho các nhóm: đặc điểm thể chất, dinh dưỡng, chuyển hóa và nhóm máu:

### 2.1. Nhóm Đặc Điểm Thể Chất & Giác Quan (Physical & Sensory Traits)
- **ALDH2 (`rs671`) — Hội chứng đỏ mặt khi uống rượu bia (Alcohol Flush Reaction):**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs671
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs671
  - Tọa độ GRCh38: Chr12: 111803962 (G > A)
- **ABCC11 (`rs17822931`) — Kiểu hình ráy tai khô / ướt và mùi cơ thể:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs17822931
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs17822931
  - Tọa độ GRCh38: Chr16: 48224287 (G > A)
- **HERC2 / OCA2 (`rs12913832`) — Màu mắt (Xanh lam vs. Nâu):**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs12913832
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs12913832

---

### 2.2. Nhóm Chuyển Hóa & Dinh Dưỡng (Metabolism & Nutrigenomics)
- **MCM6 / LCT (`rs4988235`) — Khả năng dung nạp đường Lactose trong sữa ở tuổi trưởng thành:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs4988235
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs4988235
  - Tọa độ GRCh38: Chr2: 135851076 (C > T)
- **CYP1A2 (`rs762551`) — Tốc độ chuyển hóa Caffeine trong cà phê:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs762551
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs762551
  - Tọa độ GRCh38: Chr15: 74749576 (A > C)
- **MTHFR (`rs1801133`) — Hiệu suất chuyển hóa Folate (Vitamin B9) & Homocysteine:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs1801133
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs1801133

---

### 2.3. Nhóm Nhóm Máu Hệ ABO (Blood Group Determination)
- **ABO (`rs8176719`) — Quyết định nhóm máu O (mất đoạn Guanine làm mất kháng nguyên A/B):**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs8176719
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs8176719
  - Tọa độ GRCh38: Chr9: 133257521

---

### 2.4. Nhóm Sàng Lọc Người Lành Mang Gen Lặn (Carrier Screening)
- **HBB (`rs334`) — Biến thể HbS bệnh hồng cầu hình liềm / Thalassemia:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs334
  - Ensembl Browser: https://www.ensembl.org/Homo_sapiens/Variation/Explore?v=rs334
  - Tọa độ GRCh38: Chr11: 5227002 (A > T)
- **CFTR (`rs113993960` / DeltaF508) — Sàng lọc mang gen bệnh xơ nang (Cystic Fibrosis):**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs113993960
  - NCBI ClinVar: https://www.ncbi.nlm.nih.gov/clinvar/variation/7105/
- **BRCA1 (`rs80357906`) — Biến thể dòng mầm di truyền nguy cơ ung thư vú/buồng trứng gia đình:**
  - NCBI dbSNP: https://www.ncbi.nlm.nih.gov/snp/rs80357906
  - NCBI ClinVar: https://www.ncbi.nlm.nih.gov/clinvar/variation/17667/

---

## 3. Bảng Tóm Tắt Định Dạng Tệp Dữ Liệu Có Thể Sử Dụng

| Định dạng | Đuôi file | Nhà phát hành / Chuẩn | Nội dung bên trong | Nguồn tải |
| :--- | :--- | :--- | :--- | :--- |
| **VCF** | `.vcf`, `.vcf.gz` | GA4GH / SAMtools | Danh sách các biến thể di truyền (SNPs/Indels) so với hệ gen tham chiếu GRCh38 | 1000 Genomes, Harvard PGP, GIAB |
| **FASTQ** | `.fastq`, `.fq.gz` | Chuẩn máy giải trình tự | Toàn bộ chuỗi nucleotide thô (`A, T, C, G`) cùng chỉ số chất lượng Phred Score | 1000 Genomes FTP, GIAB |
| **Microarray Raw Call** | `.txt`, `.tsv` | 23andMe, AncestryDNA | Bảng gồm các cột: `rsid`, `chromosome`, `position`, `genotype` (ví dụ `rs671 12 111803962 AA`) | Harvard PGP, OpenSNP |
| **BAM / CRAM** | `.bam`, `.cram` | SAMtools / HTSlib | Dữ liệu giải trình tự đã được gióng hàng (alignment) lên nhiễm sắc thể | 1000 Genomes, AWS Open Data |
