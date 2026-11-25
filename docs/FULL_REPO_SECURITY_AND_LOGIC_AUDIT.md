# Báo Cáo Rà Soát Bảo Mật & Logic Toàn Bộ Repository (GenoChain)

> **Phạm vi kiểm toán:** Toàn bộ mã nguồn tại `d:\Năm 4\Blockchain\geno-bak` bao gồm:
> 1. **Smart Contracts & ZK-SNARKs:** `contracts/` (7 hợp đồng chính + interfaces + mocks), `circuits/`, `scripts/deploy/`, `scripts/zk/`
> 2. **Backend Python & Hạ tầng Triển khai:** `deploy/ipfs_access_gateway.py`, `scripts/demo/capsule_dispatcher.py`, `scripts/demo/web3_demo.py`, `deploy/docker-compose.vps.yml`, `deploy/Caddyfile.example`, `deploy/Dockerfile.*`, `deploy/kubo-private-init.sh`, `deploy/generate_swarm_key.py`
> 3. **Client Crypto, IPFS & Frontend React/Web3:** `crypto/`, `ipfs/`, `frontend/src/`, `frontend/index.html`, `frontend/vite.config.js`
>
> **Phương pháp:** Đọc kiểm chứng trực tiếp mã nguồn từng dòng, đối chiếu chéo giữa các tầng (Contract <-> Python <-> Frontend), và chạy bộ kiểm tra tĩnh cục bộ (Slither report, `py_compile`, `i18n_parity.mjs`, `ui_ux_adversarial_suite.mjs`, `academic_hygiene_toolkit.py`).

---

## 1. Bảng Tổng Hợp Kết Quả Rà Soát

| Tầng Hệ Thống | Critical | High | Medium | Low / Info | Đánh Giá Chung |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Smart Contracts (`contracts/`) & ZK (`circuits/`)** | 0 | 0 | 0 | 5 | **Rất vững** — 0 lỗi rút tiền/Reentrancy/ZK; chỉ có các tình huống biên thiết kế (edge cases). |
| **Python Gateway, Dispatcher & Hạ tầng (`deploy/`, `scripts/demo/`)** | 0 | 3 | 5 | 5 | **Chặn tốt auth/SSRF/GDPR**, nhưng có **3 lỗ hổng DoS/vượt giới hạn tốc độ mức High** và **2 rủi ro đốt gas/nonce ở Dispatcher**. |
| **Frontend, Crypto & IPFS Client (`frontend/`, `crypto/`, `ipfs/`)** | 0 | 6 | 5 | 4 | **Không có lỗ hổng XSS trực tiếp**, nhưng có **6 lỗi logic/bảo mật mức High** (bypass Private Gateway khi lưu modal, crash toàn sàn từ metadata, rò rỉ `subjectId` gốc, livelock polling...). |
| **TỔNG CỘNG** | **0** | **9** | **10** | **14** | Cần ưu tiên xử lý các mục **High** nếu triển khai thực tế; phần Smart Contract đã rất an toàn cho đồ án. |

---

## 2. Các Phát Hiện Mức HIGH (Ưu Tiên Khắc Phục Cao)

### [H-01] Tầng IPFS/Frontend — Cổng Kubo RPC không xác thực bị gọi TRƯỚC Private IPFS Gateway (kích hoạt tự động qua `IpfsSettingsModal`)
- **Vị trí:** `ipfs/kubo_client.js:914-925`, `frontend/src/context/Web3Context.jsx:104-108, 128-129`
- **Vấn đề (dễ hiểu):**
  - Ở luồng **tải lên (upload)** (`ipfs/pinata_uploader.js:139-147`), khi đã cấu hình Private IPFS Gateway (có xác thực chữ ký SIWE), hệ thống khóa chặt không bao giờ gọi Kubo RPC cục bộ.
  - Nhưng ở luồng **tải xuống (read)** (`fetchFromKuboGateway` dòng 924): `const shouldProbeKuboRpc = Boolean(kuboRpc && (explicitRpc || !isPrivateGatewayConfigured));` — nếu `explicitRpc` có giá trị, nó sẽ gọi Kubo RPC **không xác thực** trước khi gọi Private Gateway.
  - Đáng chú ý, khi người dùng mở hộp thoại `IpfsSettingsModal` để nhập địa chỉ Private Gateway và bấm Lưu, ô Kubo RPC đang điền sẵn `"http://127.0.0.1:5001"` sẽ bị `Web3Context.jsx:128` lưu vào `sessionStorage["GENO_KUBO_RPC"]`. Từ đó `explicitRpc` luôn khác rỗng và mọi lượt đọc file sẽ chọc thẳng vào Kubo RPC không cần chữ ký SIWE.
- **Tác động:** Vô hiệu hóa cơ chế kiểm soát truy cập SIWE và kiểm tra thu hồi quyền trên Private Gateway trong các môi trường có chạy đồng thời node cục bộ.
- **Cách khắc phục:**
  - Sửa `ipfs/kubo_client.js:924` thành `const shouldProbeKuboRpc = Boolean(kuboRpc && !isPrivateGatewayConfigured);`.
  - Trong `Web3Context.jsx:128-137`, khi lưu một Private IPFS Gateway khác local, tự động xóa `GENO_KUBO_RPC` nếu giá trị vẫn là `http://127.0.0.1:5001` hoặc `/ipfs-rpc`.

---

### [H-02] Tầng Frontend — Lỗi Crash Trắng Trang Toàn Sàn (Stored DoS) Do Không Kiểm Tra Kiểu Dữ Liệu JSON Từ IPFS Phenopacket
- **Vị trí:** `frontend/src/hooks/useGenomicCatalog.js:338-342, 352-358, 392-407`, `frontend/src/utils/asyncResilience.js:358-364`, `frontend/src/App.jsx:475-487`
- **Vấn đề (dễ hiểu):**
  - Bất kỳ ai cũng có thể tự đăng ký một bộ dữ liệu lên `GenomicsRegistry` với file JSON Phenopacket hợp lệ về mã băm SHA-256 nhưng cố tình đặt sai kiểu dữ liệu JSON (ví dụ: đặt `files: {}` thay vì mảng `[]`, hoặc đặt `diseases[0].term.label: {"a": 1}` thay vì chuỗi chữ).
  - Trong `useGenomicCatalog.js`, các dòng gọi `.find(...)`, `.startsWith(...)` nằm **ngoài khối `try/catch`**. Khi văng `TypeError`, `runWithConcurrency` hủy toàn bộ vòng lặp tải danh mục -> **1 bộ dữ liệu xấu làm liệt toàn bộ sàn giao dịch của mọi người dùng**.
  - Nếu `label` là object JSON, React sẽ văng lỗi trắng trang (`Objects are not valid as a React child`) vì `App.jsx` không có `ErrorBoundary`.
- **Tác động:** Kẻ xấu chỉ cần đăng ký 1 dataset giả là làm sập giao diện sàn giao dịch cho tất cả mọi người.
- **Cách khắc phục:**
  - Viết hàm tiện ích `asSafeString(val, fallback)` và `asArray(val)` bọc mọi trường đọc từ `ipfsMeta` trong `useGenomicCatalog.js`.
  - Bọc hàm xử lý từng dataset trong `try/catch` riêng để 1 dataset lỗi không hủy cả danh sách.
  - Bọc `<App />` trong một React `ErrorBoundary`.

---

### [H-03] Tầng Build/Frontend — Tự Động Tắt Chế Độ Bảo Vệ Production (CSP & Fail-Closed IPFS) Khi Quên Biến Môi Trường `VITE_CHAIN_ID`
- **Vị trí:** `frontend/vite.config.js:21-47`, `ipfs/kubo_client.js:6-9, 68-93`, `ipfs/pinata_uploader.js:270-287`
- **Vấn đề (dễ hiểu):**
  - `Web3Context.jsx:30-34` tự đọc `chainId` từ file `contractAddresses.json` nếu thiếu biến môi trường `VITE_CHAIN_ID`.
  - Ngược lại, `frontend/vite.config.js:45-47` **chỉ đọc `VITE_CHAIN_ID` và bỏ qua `contractAddresses.json`**. Nếu deploy lên mạng thật (vd: Sepolia `11155111`) rồi chạy `npm run build` mà quên truyền `VITE_CHAIN_ID=11155111`, biến biên dịch `__GENOCHAIN_NON_LOCAL_CHAIN__` sẽ thành `false`.
- **Tác động:** Âm thầm vô hiệu hóa cùng lúc 3 lớp bảo vệ: (1) không lọc bỏ `127.0.0.1`/`localhost` khỏi CSP trong `index.html`, (2) đóng gói mặc định URL `127.0.0.1:5001/8080` vào JS production, và (3) tắt cơ chế fail-closed khiến CID riêng tư có thể rơi về cổng IPFS công cộng (`ipfs.io`, `dweb.link`, `pinata.cloud`).
- **Cách khắc phục:** Trong `frontend/vite.config.js`, đọc dự phòng `chainId` từ `frontend/src/contracts/contractAddresses.json` tương tự `Web3Context.jsx`.

---

### [H-04] Tầng Privacy/Crypto — Rò Rỉ `subjectId` Gốc Chưa Ẩn Danh Ra Tên File Upload & Báo Cáo PDF
- **Vị trí:** `frontend/src/services/datasetService.js:272-277, 289-302`, `ipfs/phenopacket_builder.js:243-246`, `frontend/src/services/vcf/vcfParser.js:187-191`
- **Vấn đề (dễ hiểu):**
  - `buildPhenopacket()` ẩn danh hóa `subjectId` thành `ANON_<hash 128-bit>` rất cẩn thận.
  - Tuy nhiên, trong `publishGenomicDataset()` (`datasetService.js`), biến `subjectId` **gốc** (có thể được `vcfParser.js` tự tách từ cột 10 trong file VCF — ngoài thực tế thường là mã bệnh án MRN hoặc tên bệnh nhân) lại được truyền thẳng vào tên file tải lên (`${subjectId}_raw`, `${subjectId}_report` -> gửi dạng rõ qua header `X-GenoChain-Filename` lên Private Gateway hoặc tên file lên Pinata Cloud) và in thẳng vào báo cáo PDF lâm sàng.
- **Tác động:** Rò rỉ thông tin định danh cá nhân (PII/PHI) trên đường truyền/metadata lưu trữ, đi ngược nguyên tắc ẩn danh dữ liệu di truyền.
- **Cách khắc phục:** Xuất hàm `pseudonymizeSubjectId()` từ `ipfs/phenopacket_builder.js`, ẩn danh hóa `subjectId` thành `safeSubjectId` một lần duy nhất ở đầu `publishGenomicDataset()` rồi mới dùng cho PDF, tên file upload và Phenopacket.

---

### [H-05] Tầng Crypto/Storage — Xung Đột Key Capsule Giữa Nhiều Tài Khoản Trong IndexedDB Làm Hỏng File Sao Lưu Vault
- **Vị trí:** `crypto/storage/key_vault.js:257-267, 285` (`getAllBuyerCapsulesPersistent`), `314-324, 339` (`getAllOwnerCapsulesPersistent`)
- **Vấn đề (dễ hiểu):**
  - Kho `vault_capsules` trong IndexedDB lưu chung capsule của mọi ví dùng trên cùng trình duyệt, phân tách bằng tiền tố `buyer:<địa_chỉ>:<rawCid>` hoặc `<địa_chỉ>:<rawCid>`.
  - Khi quét bằng `openCursor()`, hàm `matchesBuyer` và `matchesAccount` vẫn mở JSON bên trong các key **đã thuộc địa chỉ ví khác** để kiểm tra trường không được xác thực `parsed.recipient` / `parsed.owner`, rồi ghi đè vào `capsuleMap` theo `rawCid`.
- **Tác động:** Nếu trên cùng trình duyệt có 2 ví (hoặc một người bán độc hại gửi capsule giả mạo trường `recipient` cho ví B trùng địa chỉ ví A cho cùng `rawCid`), dữ liệu của ví B sẽ ghi đè lên capsule thật của ví A khi xuất Sovereign Key Vault, làm mất khóa AES trong file backup của ví A.
- **Cách khắc phục:** `getAllBuyerCapsulesPersistent` chỉ khớp chặt theo tiền tố `key.startsWith(scopePrefix)`. Ở `getAllOwnerCapsulesPersistent`, chỉ dùng fallback đọc `parsed.owner` cho các key cũ không có tiền tố ví (`global:` hoặc không chứa `:`) và tuyệt đối không cho fallback ghi đè kết quả khớp đúng tiền tố.

---

### [H-06] Tầng Frontend — Vòng Lặp Polling Bị Treo Vĩnh Viễn (Livelock) Khi Đồng Bộ Danh Mục Chậm Hơn 2.5 Giây
- **Vị trí:** `frontend/src/features/researcher/LicensedDatasetsView.jsx:137-143`, `frontend/src/hooks/useGenomicCatalog.js:210, 420, 507`, `ipfs/pinata_uploader.js:230`
- **Vấn đề (dễ hiểu):**
  - Khi đang chờ người bán giao chìa khóa, `LicensedDatasetsView` chạy `setInterval(() => fetchOnChainDatasets(account), 2500)` mỗi 2.5 giây mà không đợi lần gọi trước chạy xong.
  - Mỗi lần gọi mới lại tăng `fetchSeqRef.current`, làm hủy ngang lần tải trước trước khi kịp cập nhật giao diện (`setRawDatasets`). Vì mỗi lần quét đầy đủ có thể mất > 2.5 giây (riêng timeout tải metadata IPFS đã là `3500ms`), mọi lượt gọi đều tự hủy nhau liên tiếp!
- **Tác động:** Giao diện bị kẹt mãi ở trạng thái đang chờ dù chìa khóa đã giao xong trên chuỗi, đồng thời bắn yêu cầu liên tục mỗi 2.5 giây làm nghẽn RPC/IPFS.
- **Cách khắc phục:** Đổi `setInterval` sang vòng lặp `async` dùng `setTimeout` nối tiếp (`await fetchOnChainDatasets(account)` xong mới hẹn tiếp 2.5 giây sau).

---

### [H-07] Tầng Python Gateway — Tấn Công Từ Chối Dịch Vụ (DoS) Toàn Hệ Thống Qua `GET /ipfs/*` Làm Đầy Kho Nonce Chung
- **Vị trí:** `deploy/ipfs_access_gateway.py:1894-1903` (`NonceStore.consume_checked`), `5719-5832` (`do_GET`)
- **Vấn đề (dễ hiểu):**
  - `NonceStore` đặt trần **toàn cục** là `100,000` nonce cho mọi người dùng tải xuống trong vòng 11 phút (`TTL = 660s`); khi đầy sẽ trả `HTTP 429` cho tất cả mọi người.
  - Khác với `do_POST` có `UploadRateLimiter`, hàm `do_GET` **không giới hạn tần suất theo từng ví hoặc IP**. Một ví sở hữu 1 dataset nhỏ (1 byte) có thể gửi liên tiếp 100.000 request `GET` hợp lệ để làm đầy giỏ nonce chung.
- **Tác động:** Một tài khoản duy nhất có thể khóa cứng toàn bộ lượt tải dữ liệu của mọi nhà nghiên cứu khác trên toàn hệ thống trong tối đa 11 phút.
- **Cách khắc phục:** Thêm giới hạn tốc độ tải xuống theo từng địa chỉ ví / IP và đặt trần nonce riêng cho mỗi ví trong `NonceStore` (ví dụ tối đa `1,000` nonce/ví trong 11 phút).

---

### [H-08] Tầng Python Gateway — Vượt Giới Hạn Dung Lượng & Tốc Độ Upload (525 MiB/lần) Bằng Cách Gửi Sai SHA-256 Hoặc Ngắt Kết Nối Sớm
- **Vị trí:** `deploy/ipfs_access_gateway.py:5343-5426, 5697-5705` (`do_POST`)
- **Vấn đề (dễ hiểu):**
  - `do_POST` ghi toàn bộ file tải lên (tối đa `525 MiB`) ra ổ đĩa tạm (`spool`) rồi mới kiểm tra `actual_sha != norm_sha` (dòng 5422) hoặc bắt lỗi ngắt kết nối sớm (dòng 5406).
  - Ở các nhánh lỗi này, biến `committed` vẫn là `False` và nonce upload chưa bị tiêu thụ -> khối `finally` gọi `upload_limiter.release(res_token)`, **hoàn trả lại 100% hạn mức dung lượng và số lượt tải**.
- **Tác động:** Một ví đủ điều kiện chỉ cần ký **1 chữ ký SIWE duy nhất** (dùng lại được trong 10 phút) rồi liên tục bơm các gói 525 MiB cố tình sai SHA-256 (hoặc ngắt kết nối ở byte cuối), vượt hoàn toàn hạn mức 2 GiB/giờ và 10 GiB/giờ toàn hệ thống để làm cạn băng thông & I/O ổ cứng VPS.
- **Cách khắc phục:** Đếm số byte thực tế đã ghi vào `spool` (`bytes_spooled`); khi xảy ra sai SHA-256 hoặc ngắt kết nối sớm (`bytes_spooled > 0`), vẫn ghi nhận `bytes_spooled` vào `upload_limiter.commit(...)` và tiêu thụ luôn nonce khi sai SHA-256.

---

### [H-09] Tầng Python Gateway — Bão Hòa 64 Worker & Kẹt Luồng Nhận Kết Nối (Acceptor) Từ Request POST Chưa Xác Thực
- **Vị trí:** `deploy/ipfs_access_gateway.py:4823-4848` (`BoundedThreadingHTTPServer.process_request`), `4996-5038` (`_drain_bounded_unread_post_body`), `5220-5278` (`do_POST`)
- **Vấn đề (dễ hiểu):**
  1. Trước cả khi kiểm tra chữ ký SIWE, `do_POST` lưu `Content-Length` vào `self._post_unread_cl`. Một request **chưa đăng nhập** gửi header `Content-Length: 1` nhưng không gửi body sẽ bị từ chối `401` kèm cờ `early_abort_post=True`, ép worker ngồi chờ xả body suốt **2 giây** (`EARLY_ABORT_DRAIN_TIMEOUT_SEC = 2.0`). Chỉ cần 32 request/giây là nghẽn toàn bộ 64 worker.
  2. Luồng nhận kết nối duy nhất (`process_request`, dòng 4824) gọi `self._worker_sem.acquire(timeout=5.0)` **chặn đồng bộ 5 giây**, làm tê liệt tốc độ tiếp nhận kết nối mới xuống còn 0.2 kết nối/giây.
  3. Chưa có tổng thời gian tối đa (wall-clock deadline) cho toàn bộ quá trình đọc body (chỉ có timeout theo từng lần `recv` 30s -> dễ bị tấn công kiểu Slowloris rỉ rả 1 byte mỗi 25 giây).
- **Cách khắc phục:** Dùng `acquire(blocking=False)` trong `process_request()`; bỏ bước xả body 2s đối với lỗi `401`/`404` chưa xác thực; thêm deadline tổng thời gian cho toàn bộ request upload trong cả Python Gateway và `Caddyfile.example`.

---

## 3. Các Phát Hiện Mức MEDIUM (Rủi Ro Trung Bình / Bất Đồng Bộ Logic)

### [M-01] Tầng Frontend — Giữ Nhầm Cặp Khóa RSA Cũ Khi Chuyển Ví Trong `connectWallet` & Lệch Trạng Thái `account` Khi Sai Mạng
- **Vị trí:** `frontend/src/context/Web3Context.jsx:461-488, 876-887`
- **Vấn đề:** Khi chuyển từ Ví A sang Ví B bằng `connectWallet`, code xóa cache bộ nhớ nhưng **quên gọi `setResearcherKeyPair(null)`** trước các lệnh `await`. Nếu khởi tạo khóa cho Ví B lỗi, cặp khóa RSA của Ví A vẫn gắn vào Ví B (nếu người dùng bấm đăng ký khóa công khai, khóa của Ví A sẽ bị ghi nhầm cho Ví B trên chuỗi). Tương tự, khi đổi tài khoản trên MetaMask lúc đang ở sai mạng (`!onLocal`, dòng 876), `signer` và `contracts` bị xóa nhưng `account` vẫn giữ địa chỉ cũ.
- **Cách khắc phục:** Gọi `setResearcherKeyPair(null)` và `setIsPubKeyRegisteredOnChain(false)` ngay lập tức trong `connectWallet` (giống `connectLocalAccount`), và xóa `accountRef.current = ""` + `setAccount("")` trong nhánh `!onLocal` của `handleAccountsChanged`.

### [M-02] Tầng Crypto — Chưa Xóa Trắng Bộ Nhớ Đệm (Zero-Fill) Cho Khóa/Bản Rõ Tạm & Giải Mã Chuỗi Text 2 Lần Gây Tốn 3x RAM
- **Vị trí:** `crypto/storage/key_vault.js:555, 663, 773, 848`, `crypto/core/symmetric.js:37, 60, 67`, `crypto/core/asymmetric.js:229, 346, 378`, `crypto/core/streaming.js:253-305`, `frontend/src/services/datasetService.js:886-891, 924-931`
- **Vấn đề:** Các mảng byte chứa khóa AES, nội dung JSON sao lưu Vault, và `resultBytes` khi giải mã phân đoạn bị lỗi giữa chừng chưa được `.fill(0)` trong `finally`. Riêng `datasetService.js:924-931` giải mã UTF-8 toàn bộ file text tới **2 lần** (1 lần trong `isBinaryGenomicPayload` rồi vứt đi, 1 lần ở dòng 931) mà không xóa trắng `rawBytes`, gây tốn gấp ~3 lần RAM với file lớn. Ngoài ra `importKeyFromHex` luôn đặt `extractable: true` kể cả lúc chỉ dùng để giải mã.
- **Cách khắc phục:** Bọc `.fill(0)` trong `try/finally` cho các bộ đệm khóa/bản rõ tạm, gộp bước kiểm tra binary + decode UTF-8 thành 1 lần duy nhất, và truyền `extractable = false` cho các luồng chỉ giải mã.

### [M-03] Tầng Frontend — Lỗ Hổng Vượt Bộ Lọc Regex `sanitizeGenomicMetadata` Khi Dùng Ký Tự `<` Bên Trong Thuộc Tính HTML
- **Vị trí:** `frontend/src/utils/asyncResilience.js:180-186`
- **Vấn đề:** Biểu thức chính quy `<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/][^<>]*)?>` dừng khớp nếu bên trong giá trị thuộc tính có ký tự `<` (ví dụ `<iframe title="<" srcdoc="...">` hoặc `<meta title="<" http-equiv="refresh" ...>`). Hiện tại React hiển thị chuỗi dưới dạng text node (không dùng `dangerouslySetInnerHTML`) nên **chưa thể khai thác XSS ngay trên giao diện hiện có**, nhưng hàm sanitizer này lại cho phép giữ lại thẻ HTML (`<b>`, `<i>`...) nên sẽ thành lỗ hổng XSS tiềm ẩn nếu tái sử dụng ở nơi render HTML.
- **Cách khắc phục:** Nếu chỉ hiển thị text thuần trong React, thoát/loại bỏ toàn bộ `<` và `>` ngoài danh sách VCF chuẩn (`<DEL>`, `<INS>`...) và bỏ cơ chế giữ lại thẻ HTML định dạng; hoặc dùng DOMPurify nếu cần render HTML.

### [M-04] Tầng Crypto — `restoreWalletKeyBackup` Không Báo `keyRotated: true` Khi Khôi Phục Backup Phi Trích Xuất Lên Thiết Bị Có Cặp Khóa Khác
- **Vị trí:** `crypto/storage/key_vault.js:881-895`
- **Vấn đề:** Khi khôi phục file backup `privJwk: null` lên Thiết bị B (nơi trình duyệt đã tự sinh sẵn một cặp khóa RSA mới `KP_B`), code thấy `existing && existing.privateKey` nên giữ nguyên `KP_B` mà **không so sánh modulus `n` với `pubJwk.n` trong file backup**, khiến `requiresPublicKeyReRegistration` trả về `false` dù khóa trên chuỗi đã bị lệch với khóa cục bộ.
- **Cách khắc phục:** Xuất `existing.publicKey` sang JWK và đặt `keyRotated = true` nếu `existingPubJwk.n !== pubJwk.n`.

### [M-05] Tầng Frontend — Chính Sách CSP `default-src https:` Quá Rộng & Hạn Chế Chống Clickjacking Qua Thẻ `<meta>`
- **Vị trí:** `frontend/index.html:6`
- **Vấn đề:** Để `https:` trong `default-src` khiến `frame-src`, `child-src`, `worker-src`, `media-src` kế thừa quyền nạp từ bất kỳ tên miền HTTPS nào. Ngoài ra, thẻ `<meta>` không hỗ trợ chỉ thị `frame-ancestors` chống Clickjacking.
- **Cách khắc phục:** Thu hẹp `default-src 'self'`, thêm rõ `frame-src 'none'; worker-src 'self' blob:; media-src 'none';`, và cấu hình header HTTP `X-Frame-Options: DENY` + `frame-ancestors 'none'` ở máy chủ lưu trữ frontend (Nginx/Caddy/Cloudflare Pages).

### [M-06] Tầng Python Gateway — `/healthz` Công Khai Gây Khuếch Đại RPC/Kubo Và Làm Lộ Toàn Bộ Chỉ Số Nội Bộ Của `/metrics`
- **Vị trí:** `deploy/ipfs_access_gateway.py:5076-5085`, `deploy/Caddyfile.example:20-35`
- **Vấn đề:** `Caddyfile.example` khóa `/metrics` chỉ cho `127.0.0.1`, nhưng `/healthz` lại mở công khai và trả về toàn bộ biến `**snap` (lộ sạch số liệu thống kê nội bộ). Đồng thời mỗi request `GET /healthz` đều gọi trực tiếp RPC + Kubo không có cache, dễ bị lợi dụng để đốt hạn mức RPC.
- **Cách khắc phục:** Chỉ trả `{status, rpcConnected, kuboConnected}` trên `/healthz` và cache kết quả kiểm tra trong 5–10 giây.

### [M-07] Tầng Python Gateway — Khuếch Đại Truy Vấn RPC `O(N)` Trong Catalog Index & Lỗi Bỏ Qua Timeout 15s Của Refresh Đồng Thời
- **Vị trí:** `deploy/ipfs_access_gateway.py:2147-2163, 2193-2222, 2411-2422, 2543-2551`
- **Vấn đề:** `get_original_creator(tokenId)` không có bộ nhớ đệm dù `originalCreator` bất biến sau khi đúc NFT, gây ra hàng loạt lệnh `eth_call` lặp lại theo số lượng dataset. Khi quá trình refresh vượt 15 giây, các luồng upload chờ ở `wait_ev.wait(timeout=15.0)` không kiểm tra kết quả `False` (hết giờ) mà chạy tiếp bằng dữ liệu cũ thay vì từ chối an toàn `502`.
- **Cách khắc phục:** Cache vĩnh viễn `originalCreatorOf(tokenId)` trong `Web3RegistryAdapter`, và bắt buộc trả lỗi `502` nếu `wait_ev.wait(timeout=15.0)` trả về `False`.

### [M-08] Tầng Python Gateway — Khuếch Đại 5 Lệnh RPC Không Cache Trên Mỗi Request Upload Từ Ví Rác
- **Vị trí:** `deploy/ipfs_access_gateway.py:2224-2289` (`check_uploader_eligibility`)
- **Vấn đề:** Kẻ tấn công có thể tạo vô số ví EOA rỗng, ký chữ ký upload hợp lệ offline và bắn vào `POST /api/v0/upload`. Mỗi request bị từ chối vẫn kích hoạt 5 lệnh RPC tuần tự (gồm cả `registry.zkVerifier()` chưa được cache) mà không có giới hạn theo IP hay negative cache.
- **Cách khắc phục:** Cache địa chỉ `zkVerifier`, thêm negative cache 30–60 giây cho các ví không đủ điều kiện, và giới hạn tốc độ theo IP ở Caddy.

### [M-09] Tầng Python Dispatcher — Không Giới Hạn Kích Thước Khóa RSA Tối Đa & Trần Gas/Phí (Rủi Ro Đốt ETH Ví Worker Gấp 10–15 Lần)
- **Vị trí:** `scripts/demo/capsule_dispatcher.py:539-576, 966-988, 1991-1993`
- **Vấn đề:** `_validate_rsa_pubkey` chỉ chặn `< 2048 bit` nhưng không chặn tối đa (OpenSSL chấp nhận khóa tới `16,384 bit`), và không đặt trần `max_gas_limit` hay `max_fee_per_gas`. Người mua có thể đăng ký khóa RSA cực lớn tạo capsule gần 8 KB tốn >5 triệu gas/lượt (gấp >10 lần bình thường), lặp lại tới 20 lần/giờ để rút cạn ví ETH của bot Dispatcher.
- **Cách khắc phục:** Chặn `MAX_RSA_KEY_BITS = 4096` và `e <= 65537`, đồng thời bổ sung tham số trần `--max-gas-limit` và `--max-fee-gwei`.

### [M-10] Tầng Python Dispatcher — Không Lưu `tx_hash` Đang Chờ Khi Timeout Biên Nhận, Gây Gửi Trùng Nonce & Đốt Gas Giao Dịch Revert
- **Vị trí:** `scripts/demo/capsule_dispatcher.py:2078-2144`
- **Vấn đề:** Khi mạng nghẽn và `wait_for_transaction_receipt(tx_hash, timeout=120)` hết giờ, bot vứt bỏ `tx_hash` cũ thay vì lưu vào checkpoint. Chu kỳ tiếp theo (6 giây sau) bot lấy nonce mới `N + 1` và gửi lại giao dịch trùng lặp; khi giao dịch `N` được đào xong thì toàn bộ giao dịch `N + 1, N + 2...` sẽ revert (`CapsuleAlreadyDelivered`) làm mất oan phí gas.
- **Cách khắc phục:** Lưu `inFlightTxHash` + `inFlightNonce` vào `pendingOrders` ngay sau khi broadcast; chu kỳ sau kiểm tra lại biên nhận của `inFlightTxHash` trước, nếu kẹt quá lâu thì thay thế (RBF) đúng nonce cũ thay vì cấp nonce mới.

---

## 4. Các Phát Hiện Mức LOW & Tình Huống Biên (Edge Cases)

### A. Tầng Smart Contracts (`contracts/`) — 5 Điểm Lưu Ý Thiết Kế
> **Khẳng định:** Không có lỗ hổng Critical/High/Medium nào trong 7 hợp đồng Solidity; toàn bộ 5 điểm dưới đây là các tình huống biên về nghiệp vụ/triển khai cần nắm rõ.

1. **[L-SC-01] Chuyển nhượng NFT trước khi giao khóa Escrow (`GenomicsRegistry.sol:653-658, 794-804`):** `dep.seller` được chốt theo chủ sở hữu tại thời điểm đặt cọc. Nếu Chủ A chuyển NFT cho Chủ B trước lúc giao khóa, Chủ B có quyền gọi `storeTransformedCapsule`, nhưng tiền giải ngân vẫn trả về `dep.seller` (Chủ A). *(Lưu ý: Hành vi giữ cố định `dep.seller` đang được khóa bắt buộc bởi test `A2-E03` trong `test/adversarial/agent2/EscrowGuarantee.test.js:110` để chống trục lợi sau khi đã giao khóa — **không nên tự ý sửa** nếu chưa cập nhật quy chuẩn thiết kế).*
2. **[L-SC-02] Phí tái sử dụng 5% yêu cầu giấy phép cũ chưa hết hạn (`GenomicsRegistry.sol:1317-1322`):** `recordStudyReuse` gọi `requireBuyerActiveAccess`; nếu giấy phép ban đầu (vd: 30 ngày) đã hết hạn thì nhà nghiên cứu không thể trả phí 5% mà phải mua lại giấy phép mới.
3. **[L-SC-03] Hàm cũ `registerGenomicData()` bỏ qua neo 2 mã băm phụ (`GenomicsRegistry.sol:474-486`):** Chỉ hàm `registerGenomicDataBundle()` mới neo đồng thời cả `rawDataHash`, `summaryHash` và `metadataHash`. Gọi hàm cũ trực tiếp sẽ để `summaryHash`/`metadataHash = 0` cho đến khi gọi thêm `anchorArtifactHashes()`.
4. **[L-SC-04] Huy hiệu ZK ẩn đi khi chuyển nhượng NFT (`GenomicsMetadataStore.sol:714`):** `_verifyZkBridge` đòi hỏi `nftOwner == originalCreatorOf(tokenId)` để chống chủ mới mạo danh người hiến gen gốc.
5. **[L-SC-05] Faucet mặc định mở trên mạng dev (`GenomicToken.sol:47-49`):** `faucetEnabled = true, faucetVoucherRequired = false` khi khởi tạo. Khi triển khai mạng công khai **bắt buộc** bật cờ `DISABLE_FAUCET=1` hoặc `FAUCET_VOUCHER_SIGNER=0x...` trong `scripts/deploy/deploy.js`.

### B. Tầng Frontend, Crypto & Python/Hạ Tầng — 9 Điểm Nhỏ
6. **[L-FE-01] `loadPersistentKeyPair` làm thay đổi biến toàn cục `activeVaultAccount` (`crypto/storage/key_vault.js:703-709`):** Khác với `loadOwnerCapsulePersistent` (đã cấm sửa biến toàn cục trên luồng đọc), `loadPersistentKeyPair` vẫn gán `activeVaultAccount = norm`, dễ gây đọc nhầm tài khoản cho các lời gọi không truyền `account`.
7. **[L-FE-02] File backup cũ `GENO-WALLET-BACKUP-v1` không có khóa domain và salt (`crypto/storage/key_vault.js:710-714, 823-858`):** Dễ bị tấn công phishing chữ ký khác tên miền hơn bản v2; nên yêu cầu xác nhận nâng cấp hoặc ngừng hỗ trợ bản v1.
8. **[L-FE-03] `AdminPortal.handleCreateZkBounty` gọi `approve` trước khi kiểm tra số dư (`frontend/src/features/admin/AdminPortal.jsx:562-570`):** Nếu ví thiếu `$GENO`, giao dịch `approve` vẫn tốn gas và để lại allowance treo trước khi `createZkBounty` revert.
9. **[L-FE-04] Timeout 15 giây của `waitForCommitRevealNextBlock` quá ngắn cho mạng Ethereum/Sepolia (`frontend/src/services/datasetService.js:139, 405-407`):** Mạng thật có block time ~12 giây; chỉ cần lỡ 1 slot (24 giây) là timeout sau khi `commitGenomicData` đã đào, làm mất `secretSalt` chưa kịp `reveal`. Nên nâng lên `>= 60,000ms` và lưu tạm `secretSalt` trong `sessionStorage` cho đến khi reveal xong.
10. **[L-PY-01] Khuếch đại sự kiện `ResearcherKeyRegistered` & không kiểm tra `stop_event` giữa vòng lặp tác vụ (`scripts/demo/capsule_dispatcher.py:1447-1456, 1669, 2290`):** Nên lấy timestamp block mới nhất 1 lần/chu kỳ, chỉ quét lại buyer đã từng có đơn hàng, và lưu checkpoint trước khi thoát khi nhận `SIGTERM`.
11. **[L-PY-02] Cửa sổ phân quyền tệp `swarm.key` (`deploy/generate_swarm_key.py:31-44`):** File khóa bí mật được tạo trước bằng umask mặc định (`0644`) rồi mới `os.chmod(0o600)`. Nên tạo nguyên tử với `os.open(..., 0o600)` và `O_NOFOLLOW`.
12. **[L-PY-03] Tái sử dụng mốc thời gian `now_val` trước khi stream 525 MiB (`deploy/ipfs_access_gateway.py:5253, 5641`):** Với file lớn mất nhiều phút để tải lên, `pinned_at` bị ghi lùi về thời điểm bắt đầu request khiến thời gian sống orphan-pin bị rút ngắn. Nên lấy `commit_now = max(now_val, int(clock()))` sau khi stream xong.
13. **[L-INFRA-01] Bảo mật triển khai Docker & Line-Ending (`deploy/docker-compose.vps.yml`, `deploy/kubo-private-init.sh`, `deploy/Dockerfile.*`):**
    - Thiếu file `.gitattributes` ép `*.sh text eol=lf` -> trên Windows, `kubo-private-init.sh` bị checkout thành `CRLF`, khi mount vào container Linux sẽ lỗi `/bin/sh` (`set -eu\r`) trước khi kịp tắt DHT/bootstrap công cộng!
    - Bí mật của `capsule-dispatcher` đang truyền qua biến môi trường thay vì Docker secrets `/run/secrets/*`; các container chưa cấu hình `pids_limit`; `caddy` chạy quyền `root` và chưa có `healthcheck`; base image `python:3.12-slim` chưa ghim SHA-256 digest.
14. **[L-DOC-01] Kiểm tra thông tin nhóm/tác giả & vệ sinh bản nộp:** Các file `contracts/*.sol` và `docs/reports/08_project_master_audit_and_architecture_report.md` đang ghi duy nhất tên 1 tác giả (`Nguyễn Trọng Khôi - MSSV: 23520783`). Cần đối chiếu lại thông tin thành viên nhóm trước khi nộp đồ án.

---

## 5. Khuyến Nghị Thứ Tự Hành Động

1. **Cho Đồ Án Môn Học (ưu tiên ngay & an toàn nhất):**
   - Tầng **Smart Contracts (`contracts/`)** hiện đã sạch lỗi bảo mật nghiêm trọng (`0` Critical/High/Medium). Hãy thực hiện 3 đầu việc đã lên kế hoạch trong `docs/SMART_CONTRACT_TODO.md` (`verify_deployment.js`, `RubricAndSecurityAudit.test.js`, và báo cáo đối chiếu) để hoàn thiện phần bạn phụ trách mà không làm vỡ 501 test.
   - Nên bổ sung ngay **`.gitattributes`** (`*.sh text eol=lf`) và sửa 2 lỗi dễ gặp khi demo trực tiếp là **`[H-01]`** (lỗi lưu `IpfsSettingsModal` ghi đè Private Gateway), **`[H-02]`** (bọc `try/catch` + `ErrorBoundary` chống crash sàn), và **`[H-06]`** (đổi `setInterval` sang `setTimeout` nối tiếp trong `LicensedDatasetsView`).
2. **Nếu Triển Khai Server VPS Thực Tế (Production):**
   - Khắc phục triệt để các mục **`[H-03]`**, **`[H-04]`**, **`[H-05]`**, **`[H-07]`**, **`[H-08]`**, **`[H-09]`** và **`[M-01]`..`[M-10]`** theo hướng dẫn chi tiết ở từng mục trên.
