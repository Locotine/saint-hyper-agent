# Nội quy đội AI

Bộ luật chung cho mọi phiên Claude Code và Codex của dự án. Mỗi chủ đề chỉ một luật. Sửa luật phải được chủ văn phòng duyệt.
Văn phòng hiện mục mới đổi trong 24 giờ bằng nhãn MỚI.

## 1. Ranh giới — luôn hỏi chủ văn phòng
- Chỉ hỏi (ghi vào sổ Cần anh bằng `vp cananh hoi`) với: production; khóa hoặc secret mới; tiền, hoặc tiền AI vượt trần; xóa dữ liệu thật; đổi luật trong file này.
- Mọi việc khác trong quyền đã cấp thì Quản lý hoặc Điều phối tự quyết rồi báo kết quả. Không trình "anh chọn a/b/c" cho việc trong quyền.
- Không in, commit hay nhắn secret. Không hạ kiểm tra, tắt cổng hay nới giới hạn để che lỗi.

## 2. Căn cứ và bằng chứng
- SPEC trong `data/spec/` là căn cứ. Đọc đúng mục SPEC trước khi quyết.
- Bằng chứng duy nhất là **chạy thật** trên DEV, không lấy test giả làm bằng chứng. Đạt phải kèm nhật ký của đúng lượt chạy.
- Trạng thái 5 mức: đã viết code → kiểm riêng → tích hợp → chạy thật → triển khai đích. Bước chưa tới thì ghi "chưa kiểm chứng".

## 3. Đội và quyền
- Cấp bậc: chủ văn phòng → Quản lý → Điều phối → Kỹ sư (xem `CAP-BAC.md`, đội ngũ ở `DOI-NGU.md`).
- **Mỗi mảng một gói, một chủ.** Gói ở `data/goi/<gói>/viec.json`, do Quản lý hoặc Điều phối viết. Người làm chỉ đổi: đạt, bằng chứng, sha, ghi chú, số lần sửa (`vp goi dat|sua|ghichu`).
- Mỗi lỗi sửa tối đa 3 lần. Lần 3 vẫn hỏng thì dừng, ghi đã thử gì và báo Quản lý.

## 4. Nhận và trả việc — hòm thư
- Việc tới qua hòm thư, mỗi tin có mã `ht-…`.
- **Cuối mỗi lượt** chạy `vp tiep --toi "<tên vai của mình>"`. Còn tin thì đọc và làm; xong chạy `vp xong <mã> --ghi-chu "kết quả 1 dòng"` rồi `tiep` lại; hết tin mới dừng.
- Tin trùng, đã làm, hoặc hết hiệu lực cũng phải `vp xong <mã> --ghi-chu "hết hiệu lực: <lý do>"`.
- Cần người khác làm tiếp: `vp gui --toi "<vai>" --tu "<vai mình>" "[VIỆC] …"`. Một tin một việc, một người nhận, tối đa 10 dòng, câu đầu là việc.
- Không gửi tin chỉ để báo, không ACK, không CC.
- Bị chặn thì ghi rõ `[CHẶN]` ở câu trả lời (văn phòng tô đỏ) và báo người gỡ được.

## 5. Lên DEV — mỗi lúc một người
- Xếp hàng: `vp luot cho --goi <gói> --vai "<vai>"`. Tới lượt: `vp luot lay …`. Xong: `vp luot nha --vai "<vai>" --ket-qua dat|hong [--usd <tiền AI>]`.
- Lượt có thay đổi DEV tối đa 45 phút. Hỏng ở bước nào thì tự quay về bản trước rồi mới nhả lượt.
- Hỏng 2 lượt liền thì dừng, tìm gốc lỗi và có cách tái hiện ngoài DEV rồi mới lấy lượt tiếp.

## 6. Chất lượng
- Code sạch, ít lớp, không trùng trách nhiệm, không nuốt lỗi. Thứ gì có hạn thì có đường dọn.
- Chỉ xóa code hoặc cấu hình cũ khi đã chứng minh không còn ai dùng, làm thành thay đổi riêng.

## 7. Tiết kiệm và ghi chép
- Mỗi gói một phiên. Đọc đúng phạm vi cần đọc. Không dán log dài vào tin.
- Chat sẽ bị nén, chỉ file là còn: trước khi nghỉ hoặc nén, ghi "Đang dở" bằng `vp tiendo <gói> "…" --dang-do --vai "<vai>"`.
- Gặp lỗi mới mất ≥ 20 phút: `vp baihoc --the "<thẻ>" "bài học" --chan "cái chặn"`.

## 8. Báo cáo cho chủ văn phòng
- Kết luận trước, câu ngắn, tiếng Việt thường. Trả lời 4 câu: làm được gì, trên bản nào; bước đầu tiên còn hỏng; ai chịu trách nhiệm; cơ chế nào phát hiện sớm hơn.
- Từ chuyên môn mới thì giải thích một lần và ghi vào `TU-DIEN.md`.
