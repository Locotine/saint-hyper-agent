Việc tích hợp mô hình Virtual Office Marvis Tencent (VOMT) vào một dự án **Electron \+ Rust** sẵn có mang lại lợi thế vượt trội so với kiến trúc mẫu Python FastAPI của cộng đồng: bạn có thể đặt toàn bộ nhân điều phối 1+5, trục sự kiện thời gian thực và hàng rào bảo mật cấp hệ điều hành thẳng vào tầng **Rust Core**, giữ **Electron** chuyên trách kết xuất không gian văn phòng cùng cửa sổ nổi, đồng thời biến **Claude**, **Codex** và **Antigravity** thành các động cơ thực thi đứng sau 6 chú Tiểu Ngưu Mã.

## **1\. Kiến trúc Ghép nối vào Dự án Electron \+ Rust Hiện hữu**

Để không phá vỡ cấu trúc ứng dụng đang chạy, toàn bộ tính năng của VOMT được thiết kế thành ba phân hệ cắm thêm (plug-in modules) khớp trực tiếp vào ngăn xếp hiện tại của bạn:

* **Tầng Giao diện (Electron Renderer):** Tổ chức lại không gian làm việc theo tỷ lệ 3 phân vùng chuẩn VOMT gồm thanh điều hướng trái (15%), khung hội thoại/terminal kèm ngăn xem trước tài liệu **Sidebar Preview** (40%) và khung **Virtual Office** (45%). Bổ sung chế độ thu gọn thành cửa sổ nổi góc trên bên phải màn hình (alwaysOnTop) để bạn vẫn nhìn thấy đàn ngựa chạy việc trực quan khi đang mở toàn màn hình bên Antigravity. Tầng đồ họa ưu tiên dùng **Pixi.js v8** (kế thừa kiến trúc MIT từ dự án PixOffice) kết hợp tìm đường A\* để giữ mức tải GPU cực thấp khi treo máy 24/7.  
* **Tầng Vỏ Ứng dụng (Electron Main & Preload):** Quản lý vòng đời cửa sổ chính, cửa sổ nổi góc phải, khay hệ thống chạy ngầm và hộp thoại xác thực sinh trắc học hoặc mật khẩu máy tính (Windows Hello, Touch ID) khi cần duyệt thao tác nhạy cảm. Luồng sự kiện từ Rust đẩy thẳng lên Renderer qua WebSocket cục bộ hoặc callback NAPI-RS để tránh làm nghẽn luồng chính của Electron.  
* **Tầng Nhân Điều phối (Rust Core Module):** Đóng gói thành một crate độc lập trong workspace Rust sẵn có. Tầng này thay thế hoàn toàn máy chủ Python để gánh vác bộ lập lịch đồ thị phụ thuộc (DAG), quản lý tiến trình con của các công cụ CLI, cổng khóa bảo mật L2, chỉ mục tệp cục bộ và các lệnh can thiệp hệ điều hành gốc.

## **2\. Quy hoạch Đội hình 1+5 Tiểu Ngưu Mã gắn với Claude, Codex và Antigravity**

Thay vì viết lại từ đầu từng tác tử AI đơn lẻ, bạn giữ nguyên hình tượng 6 chú ngựa đen sừng trâu quàng khăn đỏ của VOMT ở lớp hiển thị và ánh xạ từng nhân vật vào thế mạnh riêng của **Claude**, **Codex**, **Antigravity** cùng các thư viện hệ thống Rust:

| Nhân vật | Vai trò VOMT | Động cơ Chính | Nhiệm vụ Cốt lõi |
| :---- | :---- | :---- | :---- |
| **Marvis Supervisor** | Trưởng nhóm điều phối | Claude | Phân rã DAG, giao việc, nghiệm thu |
| **File Ngưu Mã** | Tệp và Tri thức | Rust \+ Codex | Thư mục ảo, sửa mã đa tệp |
| **Computer Ngưu Mã** | Hệ thống và Shell | Rust \+ Codex | Đọc phần cứng, chạy PTY, dọn rác |
| **App & IDE Ngưu Mã** | Ứng dụng và IDE | Antigravity | Đồng bộ phiên code, chạy test, xem diff |
| **Browser Ngưu Mã** | Trình duyệt Web | Extension \+ MCP | Thao tác DOM giữ phiên đăng nhập |
| **Search Ngưu Mã** | Tình báo và Tra cứu | Claude \+ MCP | Tìm kiếm đa vòng, tổng hợp tài liệu |

Bảng phân vai trên vận hành thông qua một bộ định tuyến động trong Rust chứ không khóa cứng vào mã nguồn. Khi bạn bật công tắc **Chế độ Riêng tư 0-upload** trên thanh điều hướng trái, bộ định tuyến lập tức ngắt các adapter đám mây và chuyển toàn bộ suy luận của cả 6 nhân vật về mô hình cục bộ (như dòng Qwen chạy qua Ollama hoặc llama.cpp tại máy khách) để xử lý tài liệu nhạy cảm mà không đẩy bất kỳ byte dữ liệu nào ra ngoài.

## **3\. Thiết kế Kỹ thuật Cầu nối Claude, Codex và Antigravity trong Rust**

### **3.1. Bộ Giải quyết Môi trường CLI Đa nền tảng (Environment Resolver)**

Khi khởi chạy ứng dụng Electron từ biểu tượng màn hình trên Windows, WSL hoặc macOS, tiến trình con thường không nhận đủ biến môi trường đường dẫn như khi gõ trong terminal, dẫn tới lỗi không tìm thấy công cụ dòng lệnh. Ngay lúc khởi động, tầng Rust cần chạy một bước nạp môi trường từ login shell, tự động dò tìm đường dẫn thực thi thực tế của Claude và Codex (bao gồm cả các tệp bọc lệnh trên Windows và đường dẫn gọi xuyên qua wsl.exe nếu đặt môi trường phát triển bên trong Linux) rồi lưu cố định vào cấu hình phiên chạy.

### **3.2. Adapter cho Claude: Điều phối Luồng JSON và Móc chặn Quyền L2**

Tầng Rust quản lý Claude thông qua tokio::process::Command ở chế độ luồng dữ liệu có cấu trúc (claude \-p \--output-format stream-json \--verbose, hoặc giữ phiên hội thoại liên tục qua \--input-format stream-json). Để ghép nối hoàn hảo với hàng rào an toàn của VOMT, hãy truyền cờ \--permission-prompt-tool trỏ thẳng về một công cụ MCP nội bộ do chính nhân Rust cung cấp. Mỗi khi Claude định thực thi lệnh xóa tệp, sửa cấu hình lõi hay tác động ra ngoài phạm vi dự án, công cụ MCP này lập tức giữ luồng chạy lại tại cổng L2 của Rust, phát sự kiện đổi trạng thái chú ngựa trên màn hình sang chờ duyệt và hiển thị thẻ xác nhận cứng ngay giữa khung chat.

### **3.3. Adapter cho Codex: Thực thi Cô lập và Khảo sát Chỉ đọc**

Với các tác vụ biến đổi tệp hàng loạt hoặc chạy kịch bản hệ thống của **File Ngưu Mã** và **Computer Ngưu Mã**, Rust gọi Codex qua luồng JSONL (codex exec \--json hoặc giao thức máy chủ ứng dụng qua stdio). Bạn áp dụng đúng quy trình hai bước của VOMT: ở pha đầu, Rust luôn ép cờ cô lập chỉ đọc (--sandbox read-only) để Codex quét danh sách tệp, dung lượng hoặc tiến trình bị ảnh hưởng rồi gửi bản tóm tắt lên giao diện; chỉ sau khi người dùng bấm phê duyệt trên thẻ xác nhận, Rust mới mở khóa phiên thực thi có quyền ghi trong thư mục được cấp phép.

### **3.4. Cầu nối Hai chiều với Antigravity**

* **Chiều Antigravity đồng bộ về Văn phòng ảo:** Khởi tạo một máy chủ MCP cục bộ ngay trong tiến trình Rust (giao tiếp qua Streamable HTTP hoặc SSE trên cổng nội bộ) và đăng ký vào danh sách MCP của Antigravity, kết hợp với trình theo dõi thay đổi không gian làm việc. Khi tác tử bên trong Antigravity bắt đầu sửa tệp, chạy kiểm thử hay xuất bản đối chiếu mã nguồn, sự kiện bắn về Rust sẽ đánh thức chú **App & IDE Ngưu Mã** đang ngủ gật hoặc uống cà phê chạy về bàn gõ phím, hiển thị bước thực thi trực tiếp trên đầu nhân vật và đẩy báo cáo sang ngăn xem trước của Electron.  
* **Chiều VOMT ủy quyền sang Antigravity:** Khi **Marvis Supervisor** phân rã một yêu cầu lớn mà trong đó có nhánh cần can thiệp sâu vào bối cảnh dự án đang mở sẵn trên IDE, Rust đóng gói StructuredTaskBrief đẩy vào hàng đợi tác vụ chung của máy chủ MCP để phiên Antigravity tiếp nhận xử lý và trả kết quả nghiệm thu ngược về bàn quản lý.

## **4\. Lộ trình Triển khai 5 Giai đoạn**

### **Giai đoạn 1: Dựng Không gian Văn phòng Pixi.js, Tiểu Ngưu Mã và Cửa sổ Nổi (Tuần 1 – 2\)**

> 1. Thêm phân hệ giao diện văn phòng ảo vào ứng dụng React/TypeScript bên trong Electron mà không làm ảnh hưởng các màn hình cũ; thiết lập bố cục 3 cột co giãn và chế độ cửa sổ nổi thu gọn góc trên bên phải màn hình.  
> 2. Xây dựng bản đồ lưới 2D/2.5D bằng Pixi.js v8 cùng thuật toán tìm đường tránh vật cản A\* ở tốc độ 60 FPS, bố trí 1 bàn Quản lý, 5 bàn chuyên viên và 4 phân khu sinh hoạt (Quầy cà phê, Thảm tập gym, Phòng vệ sinh có đèn báo bận, Ghế lười chơi game).  
> 3. Thiết kế bộ khung hoạt ảnh cho Tiểu Ngưu Mã tách thành các lớp độc lập (thân ngựa đen, cặp sừng trâu, khăn quàng đỏ và khe gắn đạo cụ cầm tay) để tái sử dụng cho cả 6 nhân vật và mở đường cho tính năng thay trang phục về sau.  
> 4. Lập trình máy trạng thái hành vi (DutyState) phía giao diện: các trạng thái nhàn rỗi (ngủ gật thả chữ Zzz, cầm cốc cà phê đi dạo, nâng tạ, đi vệ sinh, chụm đầu tán gẫu) chạy hoàn toàn bằng bộ đếm thời gian nội bộ trên trình kết xuất.  
* **Tiêu chí nghiệm thu:** Văn phòng hoạt động mượt ở 60 FPS, chuyển đổi trơn tru giữa chế độ 3 cột và widget nổi góc phải, tiêu thụ đúng 0 token khi chưa phát lệnh.

### **Giai đoạn 2: Xây dựng Nhân Điều phối Rust 1+5, Đồ thị DAG và Trục Sự kiện (Tuần 3\)**

> 1. Khởi tạo crate điều phối trong workspace Rust hiện hữu với trục phát sóng sự kiện bất đồng bộ (tokio::sync::broadcast) đẩy gói trạng thái chuẩn hóa (VomtEvent) lên giao diện Electron.  
> 2. Định nghĩa cấu trúc dữ liệu StructuredTaskBrief bằng serde chứa đầy đủ mục tiêu, mảnh ký ức liên quan, danh sách nút phụ thuộc và nhãn phân loại rủi ro bảo mật.  
> 3. Viết bộ lập lịch thực thi đồ thị không chu trình có hướng (DAG) trong Rust: tự động kích hoạt song song các tác vụ độc lập, gom đầu ra khi các nhánh hoàn tất và tự động tiêm chuỗi thời gian thực kèm múi giờ hệ thống vào mọi lượt gọi mô hình để triệt tiêu lỗi ảo giác ngày giờ.  
* **Tiêu chí nghiệm thu:** Phát thử một kịch bản giả lập gồm 3 nhánh song song từ Rust; trên màn hình Electron, chú ngựa Quản lý phát lệnh, 3 chú ngựa chuyên trách lập tức bỏ dở việc uống cà phê/tập gym chạy về bàn bật màn hình xanh làm việc, sau đó lần lượt đi bộ tới bàn Quản lý nộp kết quả.

### **Giai đoạn 3: Đấu nối Động cơ Claude, Codex và Antigravity (Tuần 4 – 5\)**

> 1. Thiết kế trait chung AgentEngine trong Rust với các phương thức khởi tạo phiên, nhận luồng sự kiện từng bước, hủy khẩn cấp và thống kê lượng token tiêu thụ.  
> 2. Cài đặt lần lượt 3 bộ chuyển đổi thực thi cho Claude, Codex và cầu nối MCP hai chiều với Antigravity, tích hợp sẵn bộ giải quyết đường dẫn môi trường đa nền tảng.  
> 3. Viết bộ biên dịch luồng sự kiện: ánh xạ trực tiếp các gói JSONL/stream từ Claude và Codex (đang đọc tệp nào, gọi công cụ gì, bao nhiêu token) thành dòng trạng thái nổi phía trên đầu chú Tiểu Ngưu Mã tương ứng và cập nhật tài liệu trực tiếp vào ngăn **Sidebar Preview**.  
* **Tiêu chí nghiệm thu:** Giao một yêu cầu thực tế từ khung chat để **Supervisor** (Claude) chia việc cho **File Ngưu Mã** (Codex) quét mã nguồn và **App & IDE Ngưu Mã** đồng bộ với Antigravity, tổng hợp thành báo cáo hoàn chỉnh ngay trên giao diện.

### **Giai đoạn 4: Cổng Bảo mật L2 (Hard Confirm), Công cụ Hệ điều hành và Chế độ 0-Upload (Tuần 6\)**

> 1. Cài đặt mô-đun cổng chặn an toàn trong Rust bằng kênh đợi tokio::sync::oneshot với 3 mức chính sách: cho qua tức thì với tác vụ chỉ đọc, khóa luồng chờ phê duyệt cứng kèm xác thực mật khẩu hệ điều hành với thao tác rủi ro cao, và từ chối tuyệt đối mọi giao dịch thanh toán.  
> 2. Nối công cụ chặn quyền MCP của Claude và cơ chế nâng cấp sandbox của Codex vào cổng L2 này; đồng bộ giao diện để khi bị chặn, chú ngựa tại bàn dừng gõ phím, xoay người hướng ra màn hình hiện dấu chấm than màu cam hổ phách khớp với thẻ duyệt bên khung hội thoại.  
> 3. Bổ sung bộ công cụ cấp hệ điều hành viết thuần bằng Rust: dùng sysinfo để đọc thông số phần cứng và chẩn đoán tiến trình, dùng notify kết hợp SQLite cùng chỉ mục vector cục bộ để tạo **Thư mục Ảo** tìm kiếm tệp không tốn token đám mây, và nối thêm đầu đọc Ollama cục bộ cho công tắc Riêng tư.  
* **Tiêu chí nghiệm thu:** Ra lệnh xóa thử một nhóm tệp rác; hệ thống thực hiện quét chỉ đọc trước, đóng băng tiến trình CLI tại cổng L2, yêu cầu xác thực trên Electron rồi mới thực thi xóa thật.

### **Giai đoạn 5: Tiện ích Trình duyệt, Lịch Định kỳ và Tối ưu Vận hành 24/7 (Tuần 7\)**

> 1. Xây dựng tiện ích trình duyệt Manifest V3 gọn nhẹ kết nối qua WebSocket cục bộ về nhân Rust cho **Browser Ngưu Mã**, cho phép đọc cây DOM và thao tác biểu mẫu ngay trên phiên đăng nhập sẵn có thay vì phải chụp ảnh màn hình chậm chạp.  
> 2. Tích hợp bộ lập lịch tác vụ định kỳ trong Rust kèm bước kiểm định toàn vẹn tệp đính kèm (kiểm tra đường dẫn tuyệt đối, dung lượng lớn hơn 0 byte, đọc thử chuỗi byte định danh đầu tệp và đối chiếu mã băm SHA-256 trước khi gửi hoặc xuất báo cáo).  
> 3. Tinh chỉnh hiệu năng chạy ngầm dài hạn: tự động hạ nhịp vẽ của khung Pixi.js xuống mức tối thiểu khi cả cửa sổ chính lẫn widget góc phải đều bị ẩn, đồng thời thiết lập trình quản lý thu dọn sạch các tiến trình CLI con khi đóng ứng dụng.  
* **Tiêu chí nghiệm thu:** Ứng dụng chạy bền bỉ trên khay hệ thống nhiều ngày liên tục không rò rỉ bộ nhớ hay sót tiến trình ngầm, thực thi chuẩn xác các lịch hẹn giờ tự động.

## **5\. Bốn Chốt chặn Kỹ thuật Quan trọng khi Ghép vào Dự án Thực tế**

* **Chống xung đột ghi tệp bằng Git Worktree:** Khi **Supervisor** phân phối tác vụ chạy song song cho cả Claude, Codex và phiên làm việc trên Antigravity trong cùng một kho mã nguồn, hai tác tử rất dễ ghi đè lên nhau. Tầng điều phối Rust cần cấp khóa theo phạm vi thư mục hoặc tự động tách mỗi Tiểu Ngưu Mã thực thi trên một nhánh git worktree tạm thời riêng biệt trước khi hợp nhất kết quả.  
* **Thu hồi triệt để cây tiến trình con (Chống Zombie Processes):** Các công cụ CLI như Claude hay Codex thường tự sinh thêm nhiều tiến trình shell con. Trong Rust, hãy gắn toàn bộ tiến trình khởi tạo vào Job Object trên Windows và Process Group trên Linux/WSL/macOS để mỗi khi người dùng bấm hủy trên thẻ L2 hoặc thoát Electron, toàn bộ nhánh tiến trình con bị đóng ngay lập tức.  
* **Gom nhóm sự kiện chống nghẽn giao diện (Event Batching):** Khi 5 tác tử cùng xả luồng văn bản và nhật ký lệnh tốc độ cao, việc bắn từng sự kiện rời rạc lên Renderer sẽ làm tụt khung hình hoạt ảnh của đàn ngựa. Hãy đặt một bộ đệm gom nhóm theo chu kỳ 50 mili-giây ở tầng Rust trước khi phát qua kênh giao tiếp lên Electron.  
* **Khóa cứng đường mạng ở tầng kiểu dữ liệu khi bật Chế độ Riêng tư:** Đừng chỉ ẩn tùy chọn trên giao diện; khi trạng thái phiên làm việc chuyển sang chế độ 0-upload, bộ định tuyến trong Rust phải từ chối khởi tạo các thể hiện của Claude hay Codex đám mây ngay tại tầng kiểm tra quyền thực thi.

Sơ đồ tương tác dưới đây mô hình hóa cấu trúc ghép nối giữa giao diện Electron, nhân điều phối Rust, cổng bảo mật L2 và ba động cơ Claude, Codex, Antigravity cùng 5 bước luân chuyển của một tác vụ thực tế:  
Điểm mấu chốt giúp kiến trúc này vận hành mượt trên dự án sẵn có là tách rời hoàn toàn vòng lặp hoạt ảnh 60 FPS trên Electron khỏi luồng điều phối tiến trình con trong Rust: ngay cả khi Claude hay Codex đang biên dịch hoặc suy luận sâu mất nhiều phút, không gian văn phòng vẫn phản hồi tức thì mà không làm đơ giao diện làm việc chính của bạn.