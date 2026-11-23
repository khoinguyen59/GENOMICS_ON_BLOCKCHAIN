# THANG ĐÁNH GIÁ MỨC ĐỘ SẴN SÀNG SẢN XUẤT DOANH NGHIỆP (SCALE B — PRODUCTION READINESS RUBRIC / 40 ĐIỂM)

> **Mã Tài Liệu:** `SPEC-PRODUCTION-READINESS-06`  
> **Phạm Vi Đánh Giá:** Đánh giá độc lập song song với Thang A Học Thuật ([`01_project_rubric.md`](01_project_rubric.md), `/40`) theo chuẩn doanh nghiệp Web3 / DeSci 6 tầng (Smart Contract + ZK + Crypto + Private IPFS VPS + Frontend Hardening + Reproducible DevSecOps).  
> **Điều Kiện Dừng Nghiệm Thu:** **CẢ HAI** thang điểm phải đồng thời đạt **`>= 39.00 / 40.00`** dưới đồng thuận độc lập 3 hệ thống (**Swarm**, **Teamwork**, **Boost**).

---

## 1. Nguyên Tắc Ranh Giới (In-Repo Engineering vs Off-Repo Mainnet Operations)

Để bảo đảm tính khách quan, minh bạch và không thổi phồng điểm số (zero score inflation):

1. **Phạm vi chấm điểm trực tiếp trong Thang B (`40.00 điểm`) — In-Repo Verifiable Production Engineering:**
   Toàn bộ mã nguồn hợp đồng thông minh, mạch ZK và artifact Groth16 không trapdoor, mô-đun mật mã WebCrypto, kiến trúc Private IPFS PNET + SIWE Access Gateway + GDPR Art. 17 Reconciler, dịch vụ tự động hóa Capsule Dispatcher, Frontend hardening (CSP, XSS, i18n, WCAG 2.2 AA), quy trình CI/CD, kịch bản triển khai chủ quyền Timelock, bộ kiểm thử đối kháng và 18 cổng kiểm chứng thực nghiệm chạy trực tiếp trên kho mã nguồn.
2. **Phạm vi vận hành ngoài kho mã nguồn (Off-Repo Mainnet Operations — công bố minh bạch, không giả lập):**
   Các yếu tố phụ thuộc tổ chức/tài chính bên ngoài kho mã nguồn — bao gồm kiểm toán pháp lý từ đơn vị bên thứ ba độc lập (Trail of Bits / OpenZeppelin / Spearbit), thuê máy chủ VPS thực tế có tên miền TLS thương mại, khóa cứng Hardware Security Module (HSM / Gnosis Safe đa chữ ký trên Ethereum/Base Mainnet), và cấp phát phí gas thật trên Mainnet — được tách bạch rõ ràng trong [`deploy/DEPLOYMENT_RUNBOOK.md`](../../deploy/DEPLOYMENT_RUNBOOK.md). Kho mã nguồn phải cung cấp đủ cấu hình, runbook, và kiểm chứng chạy thực tế trên mạng thử nghiệm cục bộ (`localhost 31337` + `Kubo 0.32.1 PNET`) cho mọi cơ chế này mà không được phép giả mạo bằng chứng Mainnet.

---

## 2. Ma Trận Chấm Điểm 4 Trụ Cột × 10 Điểm = 40.00 Điểm

### Trụ Cột B1: Bảo Mật Hợp Đồng Thông Minh, Quản Trị Chủ Quyền & Zero-Knowledge (10.00 điểm)

| Mã | Hạng Mục Kiểm Chứng Thực Nghiệm | Trọng Số | Tiêu Chí Đạt Tuyệt Đối |
| :---: | :--- | :---: | :--- |
| **B1.1** | Phân tách mô-đun phi lưu ký & giới hạn bytecode EVM | `2.50` | 7 hợp đồng sản xuất biên dịch `solc 0.8.24` (`cancun`, `viaIR`), đạt chuẩn **EIP-170** (`<= 24,576 B`) và **EIP-3860** (`<= 49,152 B`); `GenomicsMetadataStore` & `GenomicsEscrowEngine` dùng `onlyRegistry`, không `delegatecall`, giữ `100%` lưu ký `$GENO` tại `GenomicsRegistry` với `SafeERC20` & khóa tạm `EIP-1153`. |
| **B1.2** | Quản trị chủ quyền tối thiểu đặc quyền (`GenomicTimelock` + `Ownable2Step`) | `2.50` | Triển khai `ENABLE_TIMELOCK=1 SKIP_SEEDING=1 DISABLE_FAUCET=1` chứng minh `capsuleDispatcher == 0x0` (`disableCapsuleDispatcher()`), `faucetEnabled == false`, `admin == address(0)`, hoàn tất bàn giao quyền sở hữu `Ownable2Step` cho cả 4 hợp đồng qua `timelock_accept_ownership.js`. |
| **B1.3** | Máy trạng thái Escrow công bằng & đối xứng vòng đời (`INV-07`, `INV-16`) | `2.50` | Bảo vệ cửa sổ tranh chấp `[1h, 30d]`, gia hạn thủ công `<= +7d` (không bẫy hoàn tiền trước khi giao khóa), bù thời gian tạm dừng (`PauseState` + 15 phút chống pause-pulsing), van xả trọng tài 30 ngày (`claimDisputeTimeoutRefund`), khóa cứng `MAX_ROYALTY_BPS = 5000`, `0` wei dust loss, reset worker O(1) khi chuyển NFT. |
| **B1.4** | Mạch BN254 MiMC-7 Groth16 không trapdoor & phân tích tĩnh (`INV-12`) | `2.50` | Mạch R1CS 366 ràng buộc không biến tự do, biên dịch `genomic_variant.zkey` + `verification_key.json` (`IC=4`), `setupVerificationKeyV2` + `DowngradeNotAllowed`, kiểm tra nhóm con G2, cô lập `vkEpoch`, chứng thực đa phòng lab ECDSA, xóa RAM `wtns.fill(0)`; **Solhint `0/0`**, **Slither `0 High / 0 Medium`**. |

### Trụ Cột B2: Mật Mã Máy Khách, Private IPFS PNET & Bảo Mật Hạ Tầng Dịch Vụ (10.00 điểm)

| Mã | Hạng Mục Kiểm Chứng Thực Nghiệm | Trọng Số | Tiêu Chí Đạt Tuyệt Đối |
| :---: | :--- | :---: | :--- |
| **B2.1** | Mật mã đầu cuối & kho khóa chủ quyền (`INV-01`, `INV-04`, `INV-09`) | `2.50` | `AES-256-GCM` nguyên khối & luồng phân đoạn `GNC2` 64 KB (header 20B, AAD 25B, tương thích ngược `GNC1`), kiểm tra SHA-256 trước khi giải mã, khóa `RSA-OAEP 2048` phi trích xuất (`extractable: false`), sao lưu `GENOCHAIN-ENCRYPTED-KEY-VAULT-v2` (PBKDF2 600,000 vòng) & `GENO-WALLET-BACKUP-v2`. |
| **B2.2** | Mạng Kubo Private IPFS PNET cách ly tuyệt đối (`INV-08`) | `2.50` | Kubo `v0.32.1` chạy thực tế với `LIBP2P_FORCE_PNET=1`, khóa `swarm.key` CSPRNG, `Routing.Type=none`, `Bootstrap=[]`, xác nhận `ipfs swarm peers == 0`, khớp 100% mã băm CIDv0/CIDv1 thực nghiệm và ghim đủ 39 tạo phẩm của 13 cohort (`40` recursive pins trên Kubo) qua `REQUIRE_IPFS=1`. |
| **B2.3** | Cổng truy cập SIWE Private IPFS Gateway & GDPR Art. 17 (`deploy/ipfs_access_gateway.py`) | `2.50` | Xác thực chữ ký EIP-191 SIWE, chuẩn hóa multihash CIDv0/CIDv1, bảo vệ First-Claimant Ownership (đóng lỗ hổng cooldown & fail-closed `502` khi lỗi RPC), SQLite WAL giới hạn hạn mức nguyên tử + phân tách namespace nonce upload/download, chống HTTP smuggling (`501`/`400`), GDPR Art. 17 có đếm tham chiếu + Orphan-Pin TTL GC, và client fail-closed (`0` rò rỉ về cổng công cộng khi `401/404/503/timeout`). |
| **B2.4** | Tự động hóa Capsule Dispatcher & chuẩn dữ liệu GA4GH (`INV-11`) | `2.50` | `scripts/demo/capsule_dispatcher.py` truy vấn động `registry.genomicNFT()`, preflight `validateCapsule()` + `estimate_gas()`, lưu checkpoint bền vững, cung cấp `/healthz` & `/metrics` có giới hạn worker + hỗ trợ `HEAD`; toàn bộ dữ liệu mẫu đạt chuẩn GA4GH Phenopackets v2 (`validatePhenopacketSchema == valid`) với 100% biến thể phân tử lành tính (`0` `"PATHOGENIC"`/`"CAUSATIVE"`). |

### Trụ Cột B3: Gia Cố Giao Diện Web3, Khả Năng Tiếp Cận WCAG 2.2 AA & E2E Trình Duyệt (10.00 điểm)

| Mã | Hạng Mục Kiểm Chứng Thực Nghiệm | Trọng Số | Tiêu Chí Đạt Tuyệt Đối |
| :---: | :--- | :---: | :--- |
| **B3.1** | Chống XSS, Strict CSP & cô lập trạng thái ví (`INV-13`) | `2.50` | `0` điểm chèn HTML thô (`dangerouslySetInnerHTML`/`innerHTML`/`eval`); bộ lọc điểm bất động `sanitizeGenomicMetadata` & `sanitizeMetadataTree` (giữ nguyên `<DEL>`/`<INS>`, chặn `__proto__` và `<scr<script>ipt>`); bản build Sepolia tự động loại bỏ 100% nguồn loopback (`127.0.0.1`/`localhost`) khỏi CSP; đổi tài khoản ví xóa sạch bản rõ VCF trên DOM (`MED-02`). |
| **B3.2** | Song ngữ 100% EN/VI & hệ thống thiết kế thống nhất | `2.50` | `i18n_parity.mjs` ghi nhận `0` khóa `t()` tĩnh bị thiếu trên cả EN và VI, `verify_frontend_dictionaries.mjs` đạt 100%, đồng bộ đủ 5 ABI (bao gồm `GenomicTimelockABI.json`), loại bỏ 100% lớp CSS chưa định nghĩa, tệp chết (`sovereignDb.js`) và rò rỉ thương hiệu. |
| **B3.3** | Tuân thủ WCAG 2.2 AA đa khung hình & đa chủ đề (`INV-14`) | `2.50` | Bẫy tiêu điểm hộp thoại (`useModalFocusTrap`), kích thước vùng chạm tương tác `>= 24x24px`, vượt qua **100% kịch bản `axe-core` (`wcag22aa`) ở cả chế độ Offline lẫn Online với `0` vi phạm chặn**, lưu báo cáo tươi tại `docs/reports/ui_ux_axe_report.json`. |
| **B3.4** | Kiểm thử toàn trình trình duyệt thật (`e2e_fullstack_playwright.py`) | `2.50` | Chạy trình duyệt Chromium thật kết nối bản build production Vite + Hardhat EVM + Kubo IPFS vượt qua đủ 4 luồng nghiệp vụ chính (Mint 5% royalty, tạo bằng chứng Groth16 WASM trên trình duyệt + chứng thực Lab, mua Escrow + Dispatcher + F5 reload + giải mã VCF thật, đổi ví xóa sạch bản rõ DOM) với **`0` console/page errors**. |

### Trụ Cột B4: Chuỗi Công Cụ Tái Lập, CI/CD, 18 Cổng Kiểm Chứng & Liêm Chính Học Thuật (10.00 điểm)

| Mã | Hạng Mục Kiểm Chứng Thực Nghiệm | Trọng Số | Tiêu Chí Đạt Tuyệt Đối |
| :---: | :--- | :---: | :--- |
| **B4.1** | Môi trường tái lập & an toàn chuỗi cung ứng (`npm ci` + `npm audit`) | `2.50` | Khóa phiên bản Node `v22.15.0`, `package-lock.json` đồng bộ gốc & `frontend/`, `npm ci` thành công tuyệt đối, `npm audit --omit=dev` đạt **`0` lỗ hổng** ở cả hai nơi; môi trường Python `.venv` ghim phiên bản gói bảo mật; `py_compile` & `bash -n` đạt 100%. |
| **B4.2** | Bộ kiểm thử hồi quy & đối kháng toàn diện (`INV-17`) | `2.50` | 100% bài kiểm thử Mocha/Hardhat (bao gồm `test/RemediationRegression.test.js` cho `R18-01..R18-06` & `FIX-70c..f`), `24/24` stress suite độc lập, `14/14` bộ dữ liệu đa định dạng, `live_chain_audit.py` và `web3_demo.py` chạy thật trên EVM/Kubo đều đạt `100%` không bỏ qua hay làm yếu assertion. |
| **B4.3** | Vận hành 18 cổng kiểm chứng & vệ sinh tiến trình (`OPEN_PORTS == []`) | `2.50` | Thực thi nối tiếp đủ 18 cổng kiểm chứng trên trạng thái mã nguồn hiện hành, dọn dẹp sạch toàn bộ tiến trình nền (`OPEN_PORTS == []` trên các cổng `8545, 3000, 4173, 5001, 8080, 8090, 8091, 8092`), CI workflows (`ci.yml`, `security_ci.yml`) kiểm chứng đồng bộ `bash -n`, `slither`, và triển khai chủ quyền. |
| **B4.4** | Hồ sơ kỹ thuật, Đồ thị tri thức & Bộ Agent hiện đại (`INV-18`) | `2.50` | Tài liệu đầy đủ không bị cụt, **`0` liên kết chết**, công bố trung thực sự cố mất dữ liệu 2026-11-23 07:29 AM mà không ngụy tạo bằng chứng cũ, `graphify-out/GRAPH_REPORT.md` đồng bộ với mã nguồn/commit mới nhất, bộ `AGENTS.md` + `.agents/` chuẩn Antigravity 2.0 được gitignore và sao lưu ngoài tại `GENOCHAIN_AGENT_BACKUP`. |

---

## 3. Khung Khấu Trừ Theo Mức Độ Nghiêm Trọng (Objective Severity-Band Deductions)

Mỗi lỗi tồn đọng được xác minh thực nghiệm bởi kiểm toán viên độc lập (Swarm / Teamwork / Boost) sẽ bị khấu trừ trực tiếp khỏi trụ cột tương ứng:

| Mức Độ Nghiêm Trọng | Khấu Trừ / Lỗi | Tác Động Quy Chế Đồng Thuận |
| :--- | :---: | :--- |
| **`Critical` / `Fatal Functional Bug`** | `-3.00` đến `-5.00` điểm | **Tự động `REJECT`** — không thể đạt ngưỡng `>= 39.00/40`. |
| **`High` (Security / Protocol / Data Integrity)** | `-1.50` đến `-2.50` điểm | **Tự động `REJECT`** — bắt buộc khắc phục trước khi dừng. |
| **`Medium` (Functional Gap / Unverified Core Gate)** | `-0.50` đến `-1.00` điểm | Giảm điểm trụ cột; nếu tổng `< 39.00` bắt buộc khắc phục. |
| **`Low` / `Minor Robustness Risk`** | `-0.10` đến `-0.25` điểm | Ghi nhận minh bạch; chỉ chấp nhận nếu tổng hai thang vẫn `>= 39.00/40`. |
| **`Informational` / Off-Repo Mainnet Ops** | `0.00` điểm | Ghi chú công khai trong bảng giới hạn phạm vi ngoài kho mã nguồn. |

---

## 4. Quy Chuẩn Xác Minh 3 Hệ Thống (Tri-System Blind Verification)

1. Tác tử triển khai (`DeepCoder`) tuyệt đối không tự chấm điểm sản phẩm do mình sửa.
2. Ba hệ thống kiểm toán độc lập (**Swarm**, **Teamwork**, **Boost**) thực hiện kiểm chứng mù trên cùng commit cục bộ và xuất phiếu điểm tách biệt cho **Thang A (`/40`)** và **Thang B (`/40`)**.
3. Chỉ dừng tác vụ khi đồng thời thỏa mãn:
   - Đồng thuận **3/3 `APPROVE`** ở vòng kiểm tra đầu (hoặc **>= 2/3** sau vòng xác minh tranh chấp khi có 1 bên khác biệt);
   - Điểm đồng thuận **Thang A `>= 39.00 / 40.00`** VÀ **Thang B `>= 39.00 / 40.00`**;
   - `0` lỗi `Critical` / `High` / `Fatal Functional Bug`.
