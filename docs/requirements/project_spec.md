# ĐẶC TẢ THÔNG TIN DỰ ÁN & THAM SỐ ĐỘNG (PROJECT & DATASET SPECIFICATION)

> **Mã Tài Liệu:** `SPEC-PROJECT-REQUIREMENTS-01`  
> **Trạng Thái:** Sẵn sàng cập nhật linh hoạt (Dynamic Information File)  
> **Mục Đích:** Tập trung toàn bộ thông tin động (chủ thể học thuật, giảng viên, sinh viên, cấu hình môi trường, cổng kết nối, dung lượng, danh mục dataset, schema, liên kết tài liệu).  
> **Nguyên Tắc Quản Trị:** Toàn bộ thông tin thay đổi theo thời gian hoặc theo từng đợt triển khai được cập nhật trực tiếp tại tệp này. Bộ quy chuẩn điều hành (`AGENTS.md` và `.agents/rules/`) giữ vai trò nguyên lý phổ quát bất biến, tuyệt đối không bị ràng buộc cứng vào các thông số trong tệp này nhằm triệt tiêu nguy cơ làm nhiễu AI Agent.

---

## 1. Thông Tin Chủ Thể Học Thuật & Đề Tài

| Thuộc Tính | Giá Trị Cụ Thể | Ghi Chú Cập Nhật |
| :--- | :--- | :--- |
| **Tên Đề Tài** | Hệ Thống Quản Lý & Chia Sẻ Dữ Liệu Di Truyền Trên Blockchain (GenoChain) | Bài tập lớn / Đồ án thực hành |
| **Tên Môn Học** | Công nghệ Blockchain (Mã môn: **IS355**) | Khoa Hệ thống Thông tin |
| **Cơ Sở Đào Tạo** | Trường Đại học Công nghệ Thông tin — ĐHQG-HCM (**UIT**) | Khu phố 6, P. Linh Trung, TP. Thủ Đức, TP.HCM |
| **Giảng Viên Hướng Dẫn** | **ThS. Hà Lê Hoài Trung** | Học vị Thạc sĩ (ThS.) |
| **Sinh Viên Thực Hiện** | **Nguyễn Trọng Khôi** | Khóa tuyển sinh 2023 |
| **Mã Số Sinh Viên (MSSV)**| **23520783** | Khóa K18 |

---

## 2. Thông Số Cấu Hình Môi Trường & Mạng Lưới (Runtime & Infrastructure)

| Tham Số Môi Trường | Giá Trị Cấu Hình | Phương Thức Vận Hành |
| :--- | :--- | :--- |
| **Hệ Điều Hành** | Windows 10 / Windows 11 (64-bit) | Bọc toàn bộ lệnh shell trong `cmd /c "<command>"` |
| **Node.js & Trình Quản Lý Gói** | Node.js v22.13+ / npm v10.x+ | Quản lý phụ thuộc tại thư mục gốc và `frontend/` (tương thích Hardhat 3) |
| **Blockchain RPC Node (Local)** | `http://127.0.0.1:8545` (Hardhat Network) | Chain ID: `31337` (Mặc định 20 tài khoản cấp sẵn 10,000 ETH) |
| **Cổng Frontend Dev Server** | `http://localhost:3000` (Vite v8.x / Rollup) | Cổng cố định 3000, hỗ trợ HMR qua WebSocket |
| **IPFS Storage Dual-Engine** | Pinata Cloud REST API + Kubo Daemon RPC | Endpoint Kubo cục bộ: `http://127.0.0.1:5001/api/v0/add` |
| **Python Runtime** | Python 3.10+ (Web3.py v6+, eth-account, cryptography) | Sử dụng cho các kịch bản kiểm thử, demo CLI và thẩm định |

---

## 3. Các Giới Hạn Kỹ Thuật & Thông Số Kinh Tế Token (Tokenomics & Caps)

| Tham Số Kỹ Thuật | Giá Trị Giới Hạn | Ý Nghĩa / Chuẩn Áp Dụng |
| :--- | :--- | :--- |
| **Trần Bytecode Hợp Đồng** | **24,576 bytes** | Giới hạn tối đa của EVM theo tiêu chuẩn **EIP-170** |
| **Bytecode `GenomicsRegistry`** | **21,543 bytes** (Dư **3,033 bytes**) | Đã phân tách mô-đun phi lưu ký (`GenomicsMetadataStore` `10,800 B`, `GenomicsEscrowEngine` `8,735 B` với `onlyRegistry` cả trên đọc capsule) và nâng `optimizer.runs: 200` (`viaIR: true`), giữ nguyên `100%` lưu ký `$GENO`, trần `MAX_PRICE = 100M $GENO`, bỏ qua sự kiện trùng `updateDataStatus`, khóa tạm `EIP-1153`, `Ownable2Step` + `GenomicTimelock` tự trị (`5,279 B`, OpenZeppelin `TimelockController`, `admin=address(0)`, `ENABLE_TIMELOCK=1` & `timelock_accept_ownership.js`), `EscrowDeposit` đóng gói 5-slot, worker epoch O(1), `disableCapsuleDispatcher()` `0x0` & `setDispatcherOptOut`, đối xứng `grantDirectAccess` `onlyMutableDataOwner`, máy trạng thái ký quỹ tách rời toán học (`PauseState` + chống pause-pulsing & `getEscrowLockDeadline`/`setManualRelease` đối xứng trước/sau bàn giao), van xả tranh chấp `30 ngày`, `verifyDatasetBoundTrait`, `rescueTokens` `nonReentrant`, `GenomicNFT` (`15,667 B`, SWAR 32-byte `validateCapsule` `60,491`/`332,810` gas & `validateTokenUri` chặn XSS + trần `2048 B`), `GenomicZkVerifier` (`17,412 B`, `ZkBounty` đóng gói 10-slot, đa phòng lab `_slotAttestors`, cấp gas động `_isInSubgroupG2`) & `GenomicToken` (`5,371 B`, `IGenomicTokenFaucet`), đạt `0` cảnh báo Solhint (`--max-warnings 0`) và `0` lỗi High/Medium Slither |
| **Tổng Cung Khởi Tạo / Trần $GENO** | **10,000,000 $GENO** khởi tạo / trần cứng **100,000,000 $GENO** (`18` decimals) | Đúc khởi tạo cho Contract Owner khi deploy; `mint()` và faucet bị chặn cứng bởi `MAX_TOTAL_SUPPLY` |
| **Hạn Mức Faucet Mỗi Lần** | **1,000 $GENO** / lần gọi | Phục vụ thử nghiệm và nghiên cứu viên |
| **Thời Gian Cooldown Faucet** | **3,600 giây (1 giờ)** | Chống bòn rút Sybil kép trên cả `msg.sender` và `to`, chặn hợp đồng (`extcodesize == 0`) & khóa giao dịch tạm thời `EIP-1153` (`TLOAD`/`TSTORE`) |
| **Tỷ Lệ Bản Quyền Tác Giả (Royalty)**| Mặc định **10%** (`1,000 bps`), trần **`5,000 bps` (50%)** | Khấu trừ tự động theo tiêu chuẩn **EIP-2981** (`MAX_ROYALTY_BPS = 5000`) |
| **Cửa Sổ Tranh Chấp & Thời Hạn Truy Cập** | Tranh chấp: `1 giờ..30 ngày` (gia hạn thủ công tối đa `+7 ngày`); Truy cập: `<= 365 ngày` | Mặc định: 1 ngày (86,400s) trước khi cho phép rút hoàn 100% (`MAX_ACCESS_DURATION = 365 days`, `MAX_MANUAL_ESCROW_EXTENSION = 7 days`) |

---

## 4. Danh Mục & Đặc Tả Dữ Liệu Hệ Gen (Dataset Specifications)

### 4.1 Định dạng tệp dữ liệu được hỗ trợ
* **VCF v4.2 & VCF.GZ (Variant Call Format / BGZF):** Lưu trữ biến dị nucleotide đơn (SNP), thêm/mất đoạn (Indel) dạng văn bản hoặc nén nhị phân nguyên vẹn.
* **BAM & Crypt4GH (`.bam`, `.c4gh`):** Luồng nhị phân căn chỉnh giải trình tự và container mã hóa sinh học không biến đổi UTF-8.
* **FASTQ (NGS Raw Reads):** Chuỗi nucleotide đọc thô kèm thang điểm chất lượng Phred (+33 Q30) từ hệ máy giải trình tự Illumina.
* **FASTA (Chromosomal / Contigs):** Trình tự nucleotide tham chiếu hệ gen ty thể (chrM) và contig chuẩn GRCh38.
* **JSON (GA4GH Phenopackets v2):** Metadata công khai mô tả kiểu hình, tính trạng, cơ sở dữ liệu đối chiếu.
* **PDF (Genomic Report):** Báo cáo tóm tắt phân tích hoặc chứng chỉ giải trình tự mã hóa nhị phân.

### 4.2 Danh mục 13 bộ dữ liệu mẫu (Presets)
1. `KHV_1000G`: 1000 Genomes Project Quần thể Kinh TP.HCM (ALDH2 / ADH1B, chr12, 100 GENO).
2. `NA12878_GIAB`: Chuẩn Đối Chứng Hệ Gen Vàng NIST GIAB NA12878 (chr20 High-Confidence, 110 GENO).
3. `ACTN3_PERFORMANCE`: Cấu Trúc Sợi Cơ Nhanh & Tốc Độ Điền Kinh (ACTN3 R577X rs1815739, 85 GENO).
4. `HERC2_PIGMENTATION`: Sắc Tố Màu Mắt & Da (HERC2/OCA2 rs12913832, 70 GENO).
5. `TAS2R38_TASTE`: Cảm Nhận Vị Giác Đắng Hợp Chất PTC (TAS2R38 rs713598, 65 GENO).
6. `EDAR_MORPHOLOGY`: Độ Dày Sợi Tóc & Hình Thái Răng Đông Á (EDAR Val370Ala rs3827760, 75 GENO).
7. `LCT_LACTASE`: Dung Nạp Đường Sữa Ở Người Trưởng Thành (MCM6/LCT rs4988235, 75 GENO).
8. `ALDH2_METABOLISM`: Đỏ Mặt Khi Uống Rượu & Chuyển Hóa Cồn (ALDH2 Glu504Lys rs671, 80 GENO).
9. `ABCC11_EARWAX`: Đặc Tính Ráy Tai Khô & Mồ Hôi Tuyến Apocrine (ABCC11 Gly180Arg rs17822931, 60 GENO).
10. `CYP1A2_CAFFEINE`: Dược Di Truyền: Tốc Độ Thanh Thải Cafein Ở Gan (CYP1A2*1F rs762551, 90 GENO).
11. `WGS_FASTQ_READS`: Đọc Trình Tự Toàn Bộ Hệ Gen Người 30x (Illumina NovaSeq WGS FASTQ, 120 GENO).
12. `CHRM_MITOCHONDRIAL`: Hệ Gen Ty Thể Toàn Phần Tham Chiếu (chrM Circular FASTA 16.5kb, 50 GENO).
13. `SAMTOOLS_REF_PANEL`: Bộ Biến Dị Đối Chứng Đa Mẫu Nhiễm Sắc Thể (SAMtools/BCFtools Panel, 95 GENO).

### 4.3 Thư mục lưu trữ tệp dữ liệu trong Repository
* Tệp VCF / FASTQ / FASTA mẫu: `data/`, `frontend/public/samples/` (4 URL preset / 12 tệp trên đĩa) và `frontend/public/datasets/` (9 URL preset / 21 tệp đối chứng & đa định dạng trên đĩa)
* Tệp cấu hình Preset Frontend: `frontend/src/services/vcf/presetCatalog.js`
* Tệp Seed Metadata khởi tạo: `frontend/src/contracts/seedMetadata.json`

---

## 5. Tài Liệu Tham Chiếu & Quy Chuẩn Liên Quan

* **Đề Cương & Rubric Học Thuật (Scale A /40):** [`docs/specs/01_project_rubric.md`](../specs/01_project_rubric.md)
* **Đặc Tả Kỹ Thuật Đồ Án:** [`docs/specs/02_technical_requirements.md`](../specs/02_technical_requirements.md)
* **Bảng Kiểm Tra Tiêu Chí Nghiệm Thu:** [`docs/specs/03_evaluation_checklist.md`](../specs/03_evaluation_checklist.md)
* **Đặc Tả Chi Tiết Dataset Hệ Gen:** [`docs/specs/04_dataset_specifications.md`](../specs/04_dataset_specifications.md)
* **Kiến Trúc Kỹ Thuật & Lựa Chọn Công Nghệ:** [`docs/specs/05_technical_architecture_and_stack_selection.md`](../specs/05_technical_architecture_and_stack_selection.md)
* **Rubric Sẵn Sàng Sản Xuất (Scale B /40):** [`docs/specs/06_production_readiness_rubric.md`](../specs/06_production_readiness_rubric.md)
* **Báo Cáo Kiểm Toán Tổng Thể & Kiến Trúc:** [`docs/reports/08_project_master_audit_and_architecture_report.md`](../reports/08_project_master_audit_and_architecture_report.md)

---

## 6. Danh Mục Repositories & Bộ Công Cụ Kiểm Thử Độc Lập Bên Ngoài (Third-Party Testing Repos)

Khi thực thi **Tầng 3 của Quy trình Recheck Mã Nguồn** (INVARIANT-18), hệ thống tham chiếu và đối soát trực tiếp với danh mục các kho tri thức và bộ công cụ kiểm thử chuẩn ngành dưới đây. Danh mục này được cập nhật độc lập mà không làm thay đổi các quy chuẩn cốt lõi:

### 6.1. Smart Contract & Cryptography Testing Repositories
| Tên Repository / Công Cụ | Đơn Vị Phát Triển | Đường Dẫn Tham Chiếu (GitHub / Docs) | Miền Kiểm Thử & Phạm Vi Áp Dụng |
| :--- | :--- | :--- | :--- |
| **`SunWeb3Sec/DeFiHackLabs`** | SunWeb3Sec | `https://github.com/SunWeb3Sec/DeFiHackLabs` | PoC mô phỏng các vụ hack thực tế, tấn công privilege escalation, calldata collision, lỗ hổng logic DeFi. |
| **`tinchoabbate/damn-vulnerable-defi`** | Tincho Abbate | `https://github.com/tinchoabbate/damn-vulnerable-defi` | Các kịch bản khai thác DeFi kinh điển: Flash loan reentrancy, invariant break, oracle manipulation, DoS. |
| **`Vectorized/solady`** | Solady Team | `https://github.com/Vectorized/solady` | Bất biến đại số và an toàn truyền nhận token: `SafeTransferLib`, tối ưu hóa toán học vi phân, boundary math. |
| **`crytic/properties`** | Trail of Bits | `https://github.com/crytic/properties` | Hệ thống bất biến toán học hình thức: bảo toàn tổng cung ERC-20, tính duy nhất ERC-721, bảo vệ `address(0)`. |
| **`crytic/not-so-smart-contracts`** | Trail of Bits | `https://github.com/crytic/not-so-smart-contracts` | Danh mục mẫu lỗi bảo mật: unchecked external calls, integer overflow/underflow, access control bypass, DoS loop. |
| **`manifoldxyz/royalty-registry-solidity`** | Manifold | `https://github.com/manifoldxyz/royalty-registry-solidity` | Bộ test suite tham chiếu chuẩn **EIP-2981 Royalty**: tính toán phần trăm chính xác, bảo toàn số dư người bán & tác giả. |
| **`OpenZeppelin/openzeppelin-contracts`** | OpenZeppelin | `https://github.com/OpenZeppelin/openzeppelin-contracts` | Chuẩn triển khai gốc ERC-20, ERC-721URIStorage, ReentrancyGuard, Ownable v5.x. |
| **`neicnordic/crypt4gh`** | NeIC & GA4GH | `https://github.com/neicnordic/crypt4gh` | Tiêu chuẩn mã hóa phân đoạn GA4GH Crypt4GH: kiểm thử chunked streaming, phát hiện giả mạo từng bit nhị phân. |
| **`protofire/solhint`** | Protofire | `https://github.com/protofire/solhint` | Công cụ phân tích tĩnh bảo mật Solidity: Checks-Effects-Interactions, reentrancy, avoid-tx-origin. |
| **`crytic/slither`** | Trail of Bits | `https://github.com/crytic/slither` | Bộ quét tĩnh tự động phát hiện lỗ hổng logic và tối ưu hóa gas smart contract. |

### 6.2. UI/UX Frontend, Accessibility & Layout Stress Testing Repositories
| Tên Repository / Công Cụ | Đơn Vị Phát Triển | Đường Dẫn Tham Chiếu (GitHub / Docs) | Miền Kiểm Thử & Phạm Vi Áp Dụng |
| :--- | :--- | :--- | :--- |
| **`dequelabs/axe-core`** | Deque Labs | `https://github.com/dequelabs/axe-core` | Tiêu chuẩn kiểm toán khả năng tiếp cận (Accessibility WCAG 2.1/2.2 AA): độ tương phản màu sắc, nhãn ARIA, vai trò thẻ. |
| **`pa11y/pa11y`** | Pa11y Team | `https://github.com/pa11y/pa11y` | Công cụ CLI kiểm thử tự động A11y trên Headless Chrome hỗ trợ cả runner axe và htmlcs (WCAG2AAA). |
| **`GoogleChrome/lighthouse-ci`** | Google Chrome | `https://github.com/GoogleChrome/lighthouse-ci` | Bộ công cụ CI đo đạc Core Web Vitals (LCP, INP, CLS), Accessibility, Best Practices và SEO. |
| **`microsoft/playwright`** | Microsoft | `https://github.com/microsoft/playwright` | Framework E2E tự động hóa trình duyệt: kiểm thử đa độ phân giải (Mobile 375px, Tablet 768px, Desktop), chống tràn viền (overflow). |
| **`mapbox/pixelmatch`** | Mapbox | `https://github.com/mapbox/pixelmatch` | Thư viện so sánh ảnh pixel-by-pixel, phát hiện khác biệt thị giác (Visual Regression) với thuật toán nhận thức màu OKLab/HyAB. |
| **`stylelint/stylelint`** | Stylelint Team | `https://github.com/stylelint/stylelint` | Bộ linter tĩnh CSS: cưỡng chế tính nhất quán của Design System, cấm đơn vị đo tùy tiện, phát hiện lỗi cú pháp và class xung đột. |
| **`webpro-nl/knip`** | Webpro | `https://github.com/webpro-nl/knip` | Công cụ vệ sinh mã nguồn UI: phát hiện tệp component, exports và dependencies dư thừa không sử dụng. |
| **`facebook/memlab`** | Meta / Facebook | `https://github.com/facebook/memlab` | Framework phát hiện rò rỉ bộ nhớ JavaScript (Memory Leaks) trong các phiên tương tác dài của người dùng. |

### Hướng dẫn cập nhật danh mục Testing Repos:
- Khi có thêm nhu cầu kiểm thử với các công cụ hoặc repo mới (ví dụ: Halmos, Foundry Invariant Tests, BackstopJS, Responsively), bổ sung trực tiếp một dòng vào bảng trên.
