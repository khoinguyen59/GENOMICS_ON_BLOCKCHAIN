# HƯỚNG DẪN KIỂM TOÁN ĐỘC LẬP BẰNG AI BÊN NGOÀI (ZERO-CONTEXT ADVERSARIAL AUDIT GUIDE)

> **Mục đích:** Hướng dẫn người dùng cách gửi mã nguồn GenoChain sang một AI độc lập hoàn toàn (ChatGPT, Claude, DeepSeek, v.v.) để nhận được báo cáo phản biện, vạch lỗi khách quan 100%, không bị ảnh hưởng bởi ngữ cảnh cũ hoặc các thiên kiến tự sinh.
> **Tệp dữ liệu kèm theo (tạo tùy chọn khi cần gửi AI ngoài, gitignored):** `dist_clean_audit/CLEAN_GENOCHAIN_GROUND_TRUTH.md` (hoặc đính kèm trực tiếp mã nguồn từ `contracts/`, `crypto/`, `ipfs/`, `deploy/`, `frontend/src/`).

---

## CÁCH THỰC HIỆN TRONG 3 BƯỚC

### BƯỚC 1: Mở một phiên làm việc MỚI HOÀN TOÀN (New Chat)
Mở một cửa sổ trò chuyện mới trên bất kỳ AI nào bạn muốn kiểm tra (ví dụ: Claude 3.5 Sonnet, ChatGPT-4o / o1, DeepSeek-R1). 
*Lưu ý:* Bắt buộc phải là cửa sổ chat mới để AI không mang theo ký ức hay định kiến từ các cuộc trò chuyện trước.

### BƯỚC 2: Tải lên hoặc dán tệp mã nguồn sạch
* **Cách 1 (Nếu AI hỗ trợ đính kèm file):** Kéo thả trực tiếp tệp `dist_clean_audit/CLEAN_GENOCHAIN_GROUND_TRUTH.md` (hoặc chuyển đổi sang `.docx` / `.txt` nếu cần) vào cửa sổ chat.
* **Cách 2 (Nếu AI nhận văn bản trực tiếp):** Mở tệp `dist_clean_audit/CLEAN_GENOCHAIN_GROUND_TRUTH.md`, sao chép toàn bộ nội dung và dán vào.

### BƯỚC 3: Dán đoạn Prompt Đối Kháng (Adversarial Prompt) dưới đây

---

## ĐOẠN PROMPT MẪU DÀNH CHO AI KIỂM TOÁN (COPY & PASTE)

```markdown
Bạn là một Lead Web3, Smart Contract & Applied Cryptography Security Auditor độc lập cấp độ doanh nghiệp (tương đương chuyên gia kiểm toán của OpenZeppelin, Trail of Bits, CertiK).

Tôi gửi cho bạn tệp mã nguồn và đặc tả kỹ thuật thực tế của dự án "GenoChain - Hệ thống Quản lý và Chia sẻ Dữ liệu Di truyền trên Blockchain" (Đề tài Bài tập lớn môn Công nghệ Blockchain IS355 - ĐH CNTT, ĐHQG-HCM).

YÊU CẦU KIỂM TOÁN ĐỐI KHÁNG ĐẶC BIỆT:
1. TUYỆT ĐỐI KHÔNG KHEN NGỢI: Hãy bỏ qua mọi lời khen ngợi xã giao ("dự án rất ấn tượng", "thiết kế rất tốt"...). Tôi chỉ cần sự thật khách quan.
2. VAI TRÒ ĐỐI KHÁNG KHẮT KHE: Hãy đóng vai một Black-hat Hacker và Lead Auditor khó tính nhất. Mục tiêu duy nhất của bạn là vạch lá tìm sâu, phát hiện các lỗ hổng bảo mật thực tế, rủi ro kiến trúc, lỗi logic kinh tế dòng tiền, bất đối xứng trạng thái, điểm yếu mật mã học hoặc điểm nghẽn hiệu năng.
3. RÀ SOÁT THEO 5 TRỌNG TÂM CỐT LÕI:
   - Trọng tâm 1 (Smart Contracts & EVM): Kiểm tra reentrancy, CEI pattern, phân quyền onlyOwner/onlyRegistry, giới hạn kích thước bytecode EIP-170, kinh tế gas EIP-2929/EIP-2981, rủi ro khi dùng hàm view trên blockchain công khai, và logic ký quỹ Escrow.
   - Trọng tâm 2 (Mật mã máy khách Web Crypto): Kiểm tra tính an toàn của AES-256-GCM (IV 12 bytes ngẫu nhiên, nguy cơ tái sử dụng Nonce, kiểm tra GMAC tag trước khi giải mã), cơ chế bọc khóa RSA-OAEP 2048-bit, hành vi của W3C Web Crypto API đối với khóa extractable: false, và rủi ro trước tấn công "Harvest Now, Decrypt Later" (HNDL).
   - Trọng tâm 3 (Toán học Zero-Knowledge Proofs BN254): Kiểm tra tính đúng đắn của hằng số trường đường cong BN254, cơ chế xác minh precompile 0x07/0x08, và đặc biệt là rủi ro xác thực nguồn dữ liệu đầu vào ("Garbage-In, Valid-Proof-Out").
   - Trọng tâm 4 (Lưu trữ IPFS & Quyền riêng tư Y sinh): Kiểm tra tính toàn vẹn của mã băm IPFS Multihash, rủi ro tấn công tái định danh (Linkage Attack) trên siêu dữ liệu GA4GH Phenopackets v2 (HANCESTRO, HPO terms), và khả năng thực thi Điều 17 GDPR (Right of Erasure) trên mạng IPFS công khai.
   - Trọng tâm 5 (Front-end Web3 & Trải nghiệm): Kiểm tra rò rỉ khóa trên bộ nhớ RAM, chống injection XSS từ IPFS metadata, xử lý lỗi RPC bất đồng bộ và đồng bộ trạng thái khi ngắt kết nối ví.

ĐỊNH DẠNG BÁO CÁO YÊU CẦU:
Với mỗi vấn đề phát hiện được, bạn hãy phân loại theo bảng mức độ nghiêm trọng:
- [CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL]
- Tên tệp và vị trí dòng mã chính xác
- Mô tả chi tiết bản chất lỗi kỹ thuật
- Kịch bản tấn công / khai thác thực tế (Proof-of-Concept Exploit)
- Giải pháp khắc phục hoặc mã nguồn thay thế chuẩn công nghiệp.
```

---

## LỢI ÍCH CỦA PHƯƠNG ÁN NÀY
1. **Triệt tiêu 100% thiên kiến:** AI ngoài không biết gì về các lần chat trước, không đọc các bản tự khen ngợi của các agent cũ.
2. **Kiểm tra trực tiếp trên mã nguồn thật:** Mọi phân tích sẽ bám sát từng dòng mã trong `contracts/`, `crypto/`, `ipfs/`, `frontend/`.
3. **Thu được báo cáo khách quan tuyệt đối:** Bạn sẽ có một góc nhìn trung thực, sắc sảo từ góc độ một kiểm toán viên an ninh chuyên nghiệp.