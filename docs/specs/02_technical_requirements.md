# YÊU CẦU KỸ THUẬT & PHÂN TÍCH ĐẶC TẢ HỆ THỐNG
## DỰ ÁN: QUẢN LÝ VÀ CHIA SẺ DỮ LIỆU DI TRUYỀN TRÊN BLOCKCHAIN (GENOMICS ON BLOCKCHAIN)
> **Căn cứ tài liệu gốc:** [Bài tập 06: Xây dựng Hệ thống Quản lý và Chia sẻ Dữ liệu Di truyền trên Blockchain](01_project_rubric.md)  
> **Mục tiêu hệ thống:** Đạt điểm tuyệt đối **40/40 điểm** theo chuẩn chấm thi học thuật và thực tiễn kỹ thuật Web3 y sinh.

---

## 1. TỔNG QUAN BÀI TOÁN & TRIẾT LÝ HỆ THỐNG

### 1.1. Mô hình 3 thực thể tham gia
1. **Người dùng (Data Owner / Bệnh nhân / Người hiến gen):**
   - Sở hữu dữ liệu giải trình tự DNA cá nhân.
   - Nạp file dữ liệu gen, hệ thống tự động mã hóa bảo mật ngay tại máy khách trước khi đẩy lên mạng phi tập trung.
   - Nắm giữ bản quyền và nhận tiền bản quyền (Royalty) vĩnh viễn khi dữ liệu được khai thác nghiên cứu.
2. **Nhà nghiên cứu (Data Buyer / Biomedical Researcher):**
   - Tìm kiếm các bộ dữ liệu di truyền phù hợp với đề tài nghiên cứu qua sàn giao dịch (Marketplace).
   - Mua quyền truy cập có thời hạn bằng token tiện ích ERC-20.
   - Tải dữ liệu mã hóa về máy và giải mã bằng cặp khóa bảo mật cá nhân mà không làm lộ dữ liệu ra công cộng.
3. **Mạng lưới Blockchain (Ethereum / EVM Node):**
   - Đóng vai trò trọng tài phi tập trung: Lưu trữ bằng chứng toàn vẹn (Integrity Hash), kiểm soát quyền truy cập, vận hành hợp đồng ký quỹ thanh toán (Escrow) và thực thi chi trả tiền bản quyền thông qua truy vấn chuẩn EIP-2981 (`GenomicsRegistry` chủ động khấu trừ và thanh toán).

### 1.2. Triết lý bảo mật bất biến (Core Invariant)
> [!IMPORTANT]
> **"Dữ liệu không bao giờ được tồn tại ở dạng không mã hóa trên môi trường công cộng (IPFS/Blockchain)"**
> Mọi chuỗi ký tự base nucleotide thô (A, T, C, G) tuyệt đối không được xuất hiện ở dạng bản rõ (plaintext) trên Blockchain, trên IPFS, hoặc trong gói tin truyền tải qua mạng (Network Wire).

---

## 2. PHÂN TÍCH CHI TIẾT TỪNG CÂU TỪ THEO 4 TIÊU CHÍ ĐÁNH GIÁ (40 ĐIỂM)

---

### TIÊU CHÍ 1: XÂY DỰNG & TRIỂN KHAI HỢP ĐỒNG THÔNG MINH (10 ĐIỂM)

> *"Phát triển logic quản lý quyền sở hữu dữ liệu trên Ethereum."*

#### A. 3 Nghiệp vụ chính:
1. **`registerGenomicData()` - Đăng ký dữ liệu gen:**
   - *Câu từ đề bài:* *"Người dùng đăng ký mã Hash của dữ liệu DNA kèm theo các đặc điểm kiểu hình (phenotypes) cơ bản."*
   - *Phân tích kỹ thuật:*
     + **"Mã Hash của dữ liệu DNA":** Không lưu chuỗi base DNA lên chain vì chi phí gas cực lớn và vi phạm quyền riêng tư. Smart contract chỉ lưu trữ mã băm toàn vẹn `bytes32 rawDataHash` (SHA-256 của khối dữ liệu).
     + **"Kèm đặc điểm kiểu hình cơ bản":** Liên kết thông qua mã băm IPFS CID của file Metadata JSON (chuẩn GA4GH Phenopackets v2) chứa các thông số kiểu hình không định danh.
     + **Kích hoạt tự động đúc NFT:** Hợp đồng gọi hàm nội bộ mint một NFT ERC-721 đại diện quyền sở hữu cho người đăng ký.
2. **`grantAccess()` - Cấp quyền truy cập qua Ký quỹ Escrow:**
   - *Câu từ đề bài:* *"Cấp quyền truy cập dữ liệu cho một địa chỉ ví cụ thể (Nhà nghiên cứu) sau khi họ thanh toán."*
   - *Phân tích kỹ thuật:*
     + Cấp quyền cho địa chỉ ví cụ thể của Nhà nghiên cứu (`researcher`).
     + Phải diễn ra **"sau khi họ thanh toán"**: Thực thi cơ chế Ký quỹ Escrow tự động bằng hàm `transferFrom()` của token ERC-20.
     + Ghi nhận trạng thái cấp quyền `AccessGrant` với thời hạn hiệu lực (`expiresAt = block.timestamp + accessDuration`).
3. **`updateDataStatus()` - Thay đổi trạng thái chia sẻ:**
   - *Câu từ đề bài:* *"Cho phép người dùng tạm dừng chia sẻ hoặc thu hồi quyền truy cập dữ liệu bất cứ lúc nào."*
   - *Phân tích kỹ thuật:*
     + Quản lý theo enum 3 trạng thái: `Active (0)`, `Paused (1)`, `Revoked (2)`.
     + Khi dataset ở trạng thái `Paused` hoặc `Revoked`, hợp đồng lập tức chặn mọi giao dịch mua quyền truy cập mới từ Researcher (revert với `DataNotActive`).

#### B. 2 Ràng buộc logic bắt buộc:
1. **Bảo mật quyền hạn (`onlyDataOwner` modifier):**
   - *Câu từ đề bài:* *"Chỉ chủ sở hữu dữ liệu mới có quyền thay đổi mức phí hoặc cấp quyền xem dữ liệu."*
   - *Phân tích kỹ thuật:* Kiểm tra nghiêm ngặt địa chỉ người gọi (`msg.sender`) phải trùng khớp với `ownerOf(tokenId)`. Nếu địa chỉ lạ gọi hàm cập nhật trạng thái hoặc ủy quyền khóa, giao dịch phải revert với Custom Error `NotDataOwner()`.
2. **Kiểm tra tính hợp lệ (Escrow Payment Validation):**
   - *Câu từ đề bài:* *"Dữ liệu chỉ được cấp quyền nếu Nhà nghiên cứu đã chuyển đủ số tiền đặt cọc hoặc phí mua vào hợp đồng."*
   - *Phân tích kỹ thuật:* Nếu số dư hoặc hạn mức phê duyệt (`allowance`) token của Researcher nhỏ hơn mức giá niêm yết, giao dịch thanh toán phải thất bại và không có bất kỳ quyền truy cập nào được kích hoạt.

---

### TIÊU CHÍ 2: TƯƠNG TÁC QUA WEB3.PY / FRONTEND (10 ĐIỂM)

> *"Xây dựng lớp kết nối giữa người dùng và mạng lưới."*

#### A. Giao diện người dùng (Dual-Portal Interface):
1. **User Portal (Cổng thông tin người hiến gen):**
   - *Câu từ đề bài:* *"Cho phép người dùng kéo thả file dữ liệu gene, tự động mã hóa phía máy khách (Client-side encryption) trước khi tải lên."*
   - *Phân tích kỹ thuật:*
     + Tích hợp khu vực kéo thả (Drag & Drop Zone) hỗ trợ các định dạng file sinh học: `.vcf`, `.fastq`, `.fasta`.
     + Tự động đọc nội dung file vào RAM qua `FileReader` API và kích hoạt WebCrypto API (`crypto.subtle.encrypt`) sử dụng thuật toán **AES-256-GCM**.
     + Dữ liệu được mã hóa hoàn toàn trong trình duyệt trước khi tạo kết nối mạng tải lên IPFS.
2. **Researcher Marketplace (Sàn giao dịch dành cho nhà nghiên cứu):**
   - *Câu từ đề bài:* *"Giao diện tìm kiếm dữ liệu dựa trên các bộ lọc (ví dụ: nhóm máu, vùng địa lý, bệnh lý) mà không nhìn thấy dữ liệu thô."*
   - *Phân tích câu từ ngữ nghĩa:*
     + **Ý nghĩa của "(ví dụ: nhóm máu, vùng địa lý, bệnh lý)":** Cụm từ nằm trong ngoặc đơn có chữ "ví dụ", mang ý nghĩa minh họa trực quan.
     + **Thực tế dữ liệu gen thật:** Các nhà nghiên cứu di truyền học không thể nghiên cứu nếu chỉ có nhóm máu ABO. Dữ liệu gen thật trong file VCF đòi hỏi phải lọc theo: **Ký hiệu gen (Gene Symbol)**, **Nhiễm sắc thể (Chromosome)**, **Mã biến thể (rsID)**, **Phân loại lâm sàng (ACMG Clinical Significance)**, **Hệ quả phân tử (Molecular Consequence)**, **Kiểu gen hợp tử (Zygosity)**, và **Bản dựng hệ gen (Assembly: GRCh38)**.
     + **"Mà không nhìn thấy dữ liệu thô":** Thẻ hiển thị dataset chỉ trình bày các thông số mô tả (metadata), tuyệt đối không để lộ chuỗi nucleotide hay nội dung file gốc khi chưa mua bản quyền.

#### B. Cơ chế mã hóa nâng cao:
- *Câu từ đề bài:* *"Mã hóa: Đây là phần cực kỳ quan trọng trong Genomics. Sinh viên phải demo được việc mã hóa dữ liệu bằng Public Key của người nhận hoặc sử dụng cơ chế Proxy Re-encryption (nếu có thể) để đảm bảo dữ liệu không bị lộ trên đường truyền."*
- *Phân tích kỹ thuật:*
  + Áp dụng cơ chế **Gói Khóa Bất Đối Xứng (Asymmetric Key Encapsulation)** kết hợp **Proxy Re-encryption Capsule**:
  + Researcher sinh cặp khóa bất đối xứng RSA-OAEP 2048-bit trên trình duyệt (được bảo vệ với thuộc tính `extractable: false`).
  + Public Key của Researcher được đăng ký trên blockchain qua hàm `registerResearcherPublicKey()`.
  + Khi giao dịch mua hoàn tất, Data Owner hoặc Capsule Dispatcher đóng gói khóa đối xứng AES vào một **Key Capsule** mã hóa bằng Public Key của Researcher và lưu trữ on-chain (`storeTransformedCapsule`).
  + Chỉ duy nhất Researcher nắm giữ Private Key tương ứng mới có thể giải mã Capsule để lấy khóa AES phục hồi file di truyền.

#### C. Kịch bản Web3.py (`scripts/demo/web3_demo.py`):
- Thực thi độc lập bằng Python kết nối trực tiếp RPC node (`http://127.0.0.1:8545`), tương tác 100% qua EVM thật: gọi `registerGenomicData()`, thực thi `grantAccess()`, kiểm tra thanh toán Escrow, và gọi `updateDataStatus()`.

---

### TIÊU CHÍ 3: TÍCH HỢP IPFS (10 ĐIỂM)

> *"Lưu trữ dữ liệu giải trình tự gene (thường có dung lượng rất lớn)."*

#### A. 3 Loại dữ liệu lưu trữ bắt buộc (3 IPFS CIDs riêng biệt):
1. **File dữ liệu thô đã mã hóa (`.vcf.enc` / `.fastq.enc`):**
   - Payload nhị phân đã được mã hóa bằng AES-256-GCM.
   - Nhận mã định danh IPFS CID thứ nhất (`rawCiphertextCid`).
   - Nội dung trên IPFS là chuỗi byte nhị phân ngẫu nhiên, không thể đọc hiểu nếu không có khóa giải mã.
2. **File báo cáo tóm tắt kết quả phân tích gen (PDF):**
   - Báo cáo phân tích lâm sàng có cấu trúc chuẩn ISO 32000 / PDF-1.4 (bắt đầu bằng `%PDF-1.4` và kết thúc bằng `%%EOF`).
   - Cũng được mã hóa phía máy khách và lưu lên IPFS với CID thứ hai (`summaryCiphertextCid`).
3. **Metadata JSON phục vụ tìm kiếm:**
   - Cấu trúc theo chuẩn y sinh quốc tế **GA4GH Phenopackets v2**.
   - Lưu trữ công khai trên IPFS với CID thứ ba (`metadataCid`).
   - Chứa: Định danh mẫu (`subjectId`), Thuộc tính kiểu hình (`phenotypicFeatures` với mã HPO), Gen và biến thể liên quan, Mã hash toàn vẹn `rawDataHash`.
   - **Tuyệt đối không chứa chuỗi nucleotide thô hay thông tin danh tính cá nhân.**

#### B. 2 Thao tác thực thi:
- **Upload:** Tải các khối dữ liệu lên IPFS node (Kubo IPFS cục bộ hoặc Pinata Cloud API) và nhận mã hash CIDv0/CIDv1.
- **Retrieve & Verify:** Researcher sau khi có quyền truy cập sẽ lấy CID từ Smart Contract -> Tải khối dữ liệu mã hóa về bộ nhớ -> **Xác thực mã băm SHA-256 của file tải về trước khi giải mã** -> Giải mã Capsule lấy khóa AES -> Giải mã file phục hồi dữ liệu gốc 100%.

---

### TIÊU CHÍ 4: TẠO & TRIỂN KHAI TOKEN ERC-20 / NFT (10 ĐIỂM)

> *"Tích hợp Token để tạo nền kinh tế dữ liệu (Data Economy)."*

#### A. Hai loại Token tiêu chuẩn:
1. **ERC-20 (`GenomicToken - $GENO`):**
   - Tên: `"Genomic Token"`, Ký hiệu: `"GENO"`, Số thập phân: `18`.
   - Tổng cung: `10,000,000 $GENO` đúc ban đầu cho Deployer.
   - Trang bị hàm `faucet(address)` có cơ chế chống rút cạn (Rate-limit cooldown 1 giờ/lần nhận 1,000 $GENO).
2. **ERC-721 Data Ownership NFT (`GenomicNFT - GNFT`):**
   - Mỗi dataset sau khi đăng ký thành công sẽ đúc ra 1 NFT duy nhất đại diện cho quyền sở hữu dữ liệu.
   - Metadata NFT (`tokenURI`) lưu trữ các thuộc tính di truyền ẩn (traits) theo chuẩn OpenSea/ERC-721 Metadata.
   - Tích hợp chặt chẽ với chuẩn bản quyền **EIP-2981**.
   - Cơ chế bảo vệ: Chỉ có hợp đồng `GenomicsRegistry` mới có quyền đúc NFT (`modifier onlyRegistry`), ngăn chặn đúc khống từ bên ngoài.

#### B. Nghiệp vụ sử dụng:
1. **Payment (Thanh toán qua Escrow):**
   - Nhà nghiên cứu dùng token `$GENO` thanh toán phí mua quyền sử dụng dữ liệu.
2. **Royalty (Bản quyền dữ liệu vĩnh viễn qua EIP-2981 & Sàn Thực thi Chủ động):**
   - *Câu từ đề bài:* *"Thiết kế hàm để mỗi khi dữ liệu được sử dụng lại cho các nghiên cứu sau này, người dùng gốc vẫn nhận được một phần phí nhỏ (Tiền bản quyền dữ liệu)."*
   - *Phân tích kỹ thuật:*
     + Tỷ lệ bản quyền mặc định: **10% (1,000 basis points)** theo chuẩn giao diện báo hiệu **EIP-2981**.
     + Hàm `royaltyInfo(tokenId, salePrice)` trên `GenomicNFT` đóng vai trò chuẩn hóa thông tin truy vấn, trả về địa chỉ người tạo ban đầu (`originalCreator`) và số tiền bản quyền tương ứng.
     + Hợp đồng sàn `GenomicsRegistry` đóng vai trò thực thể chấp pháp chủ động (Active Enforcement Agent), gọi `royaltyInfo()` khi khớp lệnh mua bán hoặc giải phóng ký quỹ để khấu trừ và chi trả 10% token $GENO về ví người tạo lập gốc.
     + **Kịch bản thị trường thứ cấp:** Nếu chủ dữ liệu bán NFT cho người khác, mỗi khi có Researcher mua quyền sử dụng dữ liệu từ người sở hữu mới, Smart Contract `GenomicsRegistry` tự động truy vấn `royaltyInfo()`, trích 10% chuyển thẳng về ví của người tạo lập gốc và chuyển 90% cho người sở hữu hiện tại.

---

## 3. BẢNG SO SÁNH: VÍ DỤ ĐỀ BÀI vs BỘ LỌC DỮ LIỆU GEN THẬT

| Tiêu chí | Ví dụ trong đề bài | Chuẩn dữ liệu gen thật trong file VCF | Giải pháp tích hợp trong hệ thống |
| :--- | :--- | :--- | :--- |
| **Gen mục tiêu** | Chưa đề cập chi tiết | `INFO:GENE` (`ALDH2`, `ACTN3`, `HERC2`, `ABCC11`, `CYP1A2`, `LCT`...) | [PASS] **Lọc trực tiếp theo Gen** & Ô tìm kiếm ký hiệu gen |
| **Nhiễm sắc thể** | Chưa đề cập chi tiết | `#CHROM` (`chr2`, `chr11`, `chr12`, `chr15`, `chr16`, `chr20`, `chrM`...) | [PASS] **Bộ lọc Chromosome** chọn từng nhiễm sắc thể |
| **Mã biến thể** | Chưa đề cập chi tiết | `ID` (dbSNP rsID: `rs671`, `rs17822931`, `rs1815739`, `rs4988235`...) | [PASS] **Tìm kiếm theo rsID** liên kết cơ sở dữ liệu NCBI |
| **Phân loại tác động** | "Bệnh lý" (Minh họa) | `INFO:ANN` (Phân loại đặc tính phân tử theo dbSNP/1000G/GIAB) | [PASS] **Lọc theo Nhóm đặc tính phân tử**: Di truyền quần thể, Kiểu hình thể chất, Cảm quan & Chuyển hóa, Dược lý di truyền, Đối chứng chuẩn |
| **Hệ quả phân tử** | Chưa đề cập chi tiết | `INFO:ANN` (Annotation: `missense_variant`, `regulatory_region`, `synonymous`) | [PASS] **Lọc theo loại đột biến sinh học** |
| **Kiểu gen / Hợp tử** | Chưa đề cập chi tiết | `FORMAT:GT` (`0/1` Dị hợp tử, `1/1` Đồng hợp tử đột biến) | [PASS] **Lọc theo Zygosity** |
| **Quần thể dân tộc** | "Vùng địa lý" (Minh họa) | `INFO:ANCESTRY` / Chuẩn 1000 Genomes (`KHV` Kinh VN, `EAS` Đông Á, `CEU` Châu Âu) | [PASS] **Lọc theo Quần thể di truyền chuẩn 1000 Genomes** |
| **Nhóm máu** | "Nhóm máu" (Minh họa) | `INFO:BLOOD_GROUP` (`O+`, `A+`, `B+`, `AB+`) | [PASS] **Vẫn giữ bộ lọc Nhóm máu** để thỏa mãn sát từng chữ trong đề bài |

> **Kết luận kiến trúc:** Hệ thống sử dụng **Bộ Lọc Đa Tầng (Hybrid Multi-Attribute Filters)** kết hợp hoàn hảo giữa các trường ví dụ trong đề bài và các trường dữ liệu gen phân tử thực tế, giúp hệ thống vừa chuẩn xác theo đề, vừa mang tính học thuật chuyên sâu.

---

## 4. MA TRẬN KIỂM ĐỊNH ĐỐI KHÁNG ĐÃ THỰC THI (VERIFICATION MATRIX)

Toàn bộ hệ thống đã được kiểm thử thực tế theo chuẩn **Web3 STLC (ISO/IEC/IEEE 29119-2:2021 & ISTQB v4.0.1)** và vượt qua 100% các bài test:

| Nhóm kiểm tra | Hạng mục thực tế | Lệnh kiểm thử thực tế | Kết quả ghi nhận |
| :--- | :--- | :--- | :---: |
| **Smart Contract (Mocha/Hardhat)** | 496 Unit, Adversarial, Invariant, Fuzzing, Regression (`R18-01..06m`, `FIX-70c..f`) & OWASP Top 10 (2026) Tests (33 tệp) | `npx hardhat test` | **496/496 PASS (100%)** |
| **OWASP Top 10 (2026) & DeFiHackLabs** | 25 Tests phòng thủ SC01-SC10 & Định chuẩn $\Delta \text{Balance} = 0$ | `npx hardhat test test/OwaspTop10SmartContract2026Defense.test.js` | **25/25 PASS (100%)** |
| **Independent Stress Suite & Diverse Datasets** | 24 kiểm định đối kháng độc lập + 14 kịch bản đa định dạng sinh học (INV-11) | `independent_stress_suite.mjs` & `test_diverse_datasets_e2e.mjs` | **24/24 & 14/14 PASS (100%)** |
| **UI/UX Adversarial & WCAG 2.2 AA** | 15 kiểm định tĩnh UI/XSS/Sanitizer (`sanitizeGenomicMetadata`/`sanitizeMetadataTree`) + 702/702 khóa i18n + 34 online / 29 offline kịch bản axe-core (`wcag22aa`) + 4/4 live E2E Playwright | `ui_ux_adversarial_suite.mjs`, `audit_ui_ux_axe.py`, `e2e_fullstack_playwright.py` | **15/15, 34/34, 29/29 & 4/4 PASS (0 Violations)** |
| **Web3.py Tương tác & Cổng SIWE IPFS** | Tương tác trực tiếp EVM thật (`live_chain_audit.py`, `web3_demo.py`, `ipfs_access_gateway.py`, `capsule_dispatcher.py`) | `python scripts/demo/web3_demo.py` & Gate 16 | **PASS (100%)** |
| **Liêm Chính Học Thuật (UIT / IS355)** | 3/3 kiểm định tên trường, giảng viên, sinh viên (23520783), tỷ lệ hash | `python scripts/audit/academic_hygiene_toolkit.py --selftest` | **3/3 PASS (100%)** |
| **Phân Tích Tĩnh (Solhint & Slither)** | Quét toàn bộ 7 Smart Contracts tuân thủ quy chuẩn OpenZeppelin & CEI | `npm run lint:sol` & `slither . --exclude-dependencies` | **0 ERRORS / 0 WARNINGS & 0 High/Med** |
| **Build Frontend & CSP** | Compile bundle client-side production qua Vite (`231 modules`) + Sepolia CSP strip loopback | `npm --prefix frontend run build` | **BUILT (231 Modules, 0 Errors, 0 Loopback Leaks)** |
| **Bảo mật Plaintext** | Kiểm toán rò rỉ gói tin (Zero-Plaintext Transmission Wire Leak) | DevTools / E2E Inspection & Gate 18 | **0 Bytes Leaked** |
| **IPFS Integration** | Private Kubo `0.32.1` PNET (`Peers: 0`), CIDv0/CIDv1 parity, 40 live pins, verify SHA-256 trước giải mã | Gate 12, Gate 13, Gate 14, Gate 16 | **VERIFIED (100%)** |
| **Mẫu dữ liệu thật** | Nạp thực tế mẫu GIAB NA12878 (13.7 KB) và ALDH2 rs671 (13 cohort lành tính) | Live UI Session (`http://127.0.0.1:4173/`) | **VERIFIED (100%)** |

---

## 5. TỔ CHỨC LƯU TRỮ TÀI NGUYÊN VÀ BẰNG CHỨNG KIỂM ĐỊNH

Toàn bộ minh chứng thực nghiệm hiện còn trên đĩa đã được kiểm kê trung thực và lưu trữ trực tiếp trong thư mục dự án:
- **Tài liệu kiểm định chi tiết:** [`03_evaluation_checklist.md`](03_evaluation_checklist.md) (26 hạng mục kiểm tra toàn diện) và [`06_production_readiness_rubric.md`](06_production_readiness_rubric.md) (Thang B 40/40 sẵn sàng sản xuất).
- **Thư mục bằng chứng thực nghiệm:** [`docs/evidence/README.md`](../evidence/README.md) (22 ảnh chụp màn hình tươi từ phiên kiểm chứng sống WCAG 2.2 AA trực tuyến tại [`docs/evidence/live_screenshots/`](../evidence/live_screenshots/) cùng 8 tài sản minh họa còn nguyên vẹn tại `assets/readme/`; các bản ghi MP4/WebP lịch sử trước sự cố mất dữ liệu cục bộ 2026-11-23 07:29 AM đã bị mất vĩnh viễn và được công khai minh bạch tại mục lục bằng chứng).
- **Đặc tả tập dữ liệu hệ gen:** [`04_dataset_specifications.md`](04_dataset_specifications.md) và báo cáo kiểm toán tổng thể [`08_project_master_audit_and_architecture_report.md`](../reports/08_project_master_audit_and_architecture_report.md).
