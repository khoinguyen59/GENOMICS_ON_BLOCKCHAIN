# Bài tập 06: XÂY DỰNG HỆ THỐNG QUẢN LÝ VÀ CHIA SẺ DỮ LIỆU DI TRUYỀN (GENOMICS ON BLOCKCHAIN)

## 1. Mô tả bài toán

Sinh viên xây dựng một nền tảng phi tập trung nơi:
- **Người dùng (Data Owner):** Tải lên dữ liệu giải trình tự gene đã được mã hóa.
- **Nhà nghiên cứu (Data Buyer):** Tìm kiếm và mua quyền truy cập dữ liệu để nghiên cứu.
- **Blockchain:** Quản lý quyền truy cập, tính toàn vẹn của dữ liệu và tự động thanh toán.

---

## 2. Yêu cầu thực hiện

### Tiêu chí 1: Xây dựng & Triển khai Hợp đồng thông minh (10 điểm)
Phát triển logic quản lý quyền sở hữu dữ liệu trên Ethereum.

#### 3 Nghiệp vụ chính:
- `registerGenomicData()`: Người dùng đăng ký mã Hash của dữ liệu DNA kèm theo các đặc điểm kiểu hình (phenotypes) cơ bản.
- `grantAccess()`: Cấp quyền truy cập dữ liệu cho một địa chỉ ví cụ thể (Nhà nghiên cứu) sau khi họ thanh toán.
- `updateDataStatus()`: Cho phép người dùng tạm dừng chia sẻ hoặc thu hồi quyền truy cập dữ liệu bất cứ lúc nào.

#### 2 Ràng buộc logic:
- **Bảo mật quyền hạn:** Chỉ chủ sở hữu dữ liệu mới có quyền thay đổi mức phí hoặc cấp quyền xem dữ liệu.
- **Kiểm tra tính hợp lệ:** Dữ liệu chỉ được cấp quyền nếu Nhà nghiên cứu đã chuyển đủ số tiền đặt cọc hoặc phí mua vào hợp đồng.

---

### Tiêu chí 2: Tương tác qua Web3.py / Frontend (10 điểm)
Xây dựng lớp kết nối giữa người dùng và mạng lưới.

#### Giao diện:
- **User Portal:** Cho phép người dùng kéo thả file dữ liệu gene, tự động mã hóa phía máy khách (Client-side encryption) trước khi tải lên.
- **Researcher Marketplace:** Giao diện tìm kiếm dữ liệu dựa trên các bộ lọc (ví dụ: nhóm máu, vùng địa lý, bệnh lý) mà không nhìn thấy dữ liệu thô.

#### Mã hóa:
- **Mã hóa:** Đây là phần cực kỳ quan trọng trong Genomics. Sinh viên phải demo được việc mã hóa dữ liệu bằng Public Key của người nhận hoặc sử dụng cơ chế Proxy Re-encryption (nếu có thể) để đảm bảo dữ liệu không bị lộ trên đường truyền.

---

### Tiêu chí 3: Tích hợp IPFS (10 điểm)
Lưu trữ dữ liệu giải trình tự gene (thường có dung lượng rất lớn).

#### 3 Loại dữ liệu lưu trữ:
1. File dữ liệu thô (ví dụ: định dạng `.vcf` hoặc `.fastq`) đã mã hóa.
2. File báo cáo tóm tắt kết quả phân tích gene (PDF).
3. Metadata JSON (Chứa các thông tin mô tả để nhà nghiên cứu tìm kiếm).

#### Thao tác:
- **Upload:** Đẩy file đã mã hóa lên IPFS và lấy mã CID.
- **Retrieve:** Nhà nghiên cứu sau khi được cấp quyền sẽ lấy CID từ Blockchain để tải file từ IPFS và giải mã bằng khóa riêng của họ.

---

### Tiêu chí 4: Tạo & triển khai Token ERC-20 / NFT (10 điểm)
Tích hợp Token để tạo nền kinh tế dữ liệu (Data Economy).

- **ERC-20 (Genomic Token):** Tạo một loại token dùng để thanh toán phí truy cập dữ liệu giữa Nhà nghiên cứu và Người dùng.
- **NFT (Data Ownership NFT):** Mỗi bộ dữ liệu gene của một cá nhân được đại diện bởi một NFT duy nhất. NFT này không chỉ xác nhận quyền sở hữu mà còn chứa các thuộc tính (traits) ẩn của dữ liệu đó.

#### Nghiệp vụ sử dụng:
- **Payment:** Nhà nghiên cứu dùng ERC-20 để trả tiền mua quyền truy cập.
- **Royalty:** Thiết kế hàm để mỗi khi dữ liệu được sử dụng lại cho các nghiên cứu sau này, người dùng gốc vẫn nhận được một phần phí nhỏ (Tiền bản quyền dữ liệu).

---

## 3. Quy trình thực hiện

1. **Thiết kế cấu trúc dữ liệu:** Xác định các thông tin nào được lưu On-chain (Mã hash, giá cả, quyền truy cập) và thông tin nào lưu Off-chain trên IPFS (Dữ liệu gene thô).
2. **Lập trình Smart Contract:** Tập trung vào việc bảo vệ quyền riêng tư và tự động hóa thanh toán.
3. **Xây dựng Frontend:** Chú trọng vào trải nghiệm người dùng trong việc mã hóa và giải mã file.
4. **Báo cáo:** Giải thích cách Blockchain giải quyết vấn đề "Tập trung hóa dữ liệu di truyền" (tránh việc các công ty lớn độc quyền sở hữu DNA của hàng triệu người).

---

## 4. Lưu ý quan trọng

> [!IMPORTANT]
> Sinh viên cần được nhắc nhở rằng dữ liệu di truyền là dữ liệu nhạy cảm nhất. Việc xây dựng hệ thống này phải tuân thủ triết lý:
> **"Dữ liệu không bao giờ được tồn tại ở dạng không mã hóa trên môi trường công cộng (IPFS/Blockchain)"**
