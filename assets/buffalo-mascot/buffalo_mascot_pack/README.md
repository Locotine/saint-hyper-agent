# Buffalo Isometric Mascot & Office Asset Pack (100% Spec)

## 1. Cấu trúc thư mục

- `atlases/@1x/`: Toàn bộ PNG nền trong suốt RGBA 32-bit chuẩn `@1x` kèm file `.json` định dạng **TexturePacker** (tương thích PixiJS, Phaser, Electron Canvas, Unity, Godot, Aseprite).
- `atlases/@2x/`: Toàn bộ PNG độ phân giải cao `@2x` (Retina / HiDPI) kèm file `.json` tương ứng (`meta.scale = "2"`).
- `palette.json`: Bảng mã màu chuẩn đồng bộ cho 6 nhân vật (Supervisor + 5 chuyên viên), nội thất văn phòng trắng tối giản và UI.
- `LICENSE.txt`: Giấy phép cấp toàn quyền sử dụng & thương mại hoá trong dự án.

## 2. Danh sách 9 Spritesheet Atlases (Mỗi bộ đều có `@1x` & `@2x`)

1. `skin_01_supervisor` (.png + .json): Quản lý (Áo ba lỗ đỏ `#D92B2B`, sừng `#FCE08B`) — đủ 4 hướng (`SE`, `SW`, `NE`, `NW`) × 62 frames = **248 frames**.
2. `skin_02_file_agent` (.png + .json): Chuyên viên File (Khăn tím `#6B3FA0`, sừng cam `#FF7A1A`) — **248 frames**.
3. `skin_03_browser_agent` (.png + .json): Chuyên viên Browser (Khăn xanh ngọc `#1AB2B8`, sừng xanh lá `#8CE071`) — **248 frames**.
4. `skin_04_computer_agent` (.png + .json): Chuyên viên Computer (Khăn xanh lá `#4B9E58`, sừng xám `#D8DCE3`) — **248 frames**.
5. `skin_05_app_agent` (.png + .json): Chuyên viên App (Khăn vàng `#F5B81D`, sừng vàng `#FFD026`) — **248 frames**.
6. `skin_06_search_agent` (.png + .json): Chuyên viên Search (Áo + khăn xanh dương `#1466C6`, sừng xanh băng `#8AC4FF`) — **248 frames**.
7. `buffalo_rig_layers` (.png + .json): Bộ tách lớp Modular Rig (`shadow`, `base_body`, `horns_tintable`, `outfit_scarf_tintable`, `outfit_tank_tintable`, `outfit_jacket_tintable`, `hand_props`) để ghép hoặc đổi màu động bằng code runtime.
8. `office_environment_and_props` (.png + .json):
   - Đạo cụ rời: `coffee_cup`, `dumbbell`, `report_sheet`, `gamepad` (+ 5 đạo cụ chuyên viên).
   - Môi trường Isometric 2:1 (`64x32` ở `@1x`): Sàn trắng, 3 thảm phân khu, tường thẳng SE/SW, tường góc, cửa văn phòng, cửa sổ kính, 1 bàn Quản lý lớn + 5 bàn chuyên viên, ghế xoay tách lớp `seat` và `backrest` (để kẹp nhân vật ngồi giữa đúng chiều sâu Z), màn hình 4 trạng thái (`monitor_off`, `monitor_working`, `monitor_pending`, `monitor_error`), quầy + máy cà phê, thảm gym + giá tạ + máy chạy bộ, cửa WC đèn xanh (rảnh) & đèn đỏ (bận) + bồn cầu, beanbag cam + kệ TV/console, cây xanh, bảng trắng.
9. `ui_overlays` (.png + .json):
   - Bong bóng trạng thái: `bubble_zzz`, `bubble_alert`, `bubble_question`, `bubble_done_tick`, `bubble_typing_00..02`.
   - Khung trống 9-slice kèm trường `borders` trong JSON: `speech_frame_light_9slice`, `speech_frame_dark_9slice` (+ đuôi thoại rời `speech_tail_*`), `nameplate_dark_9slice`, `nameplate_light_9slice`.

## 3. Thông số kỹ thuật Isometric & Điểm neo (Anchor / Pivot)

- Ô lưới sàn Isometric 2:1: `64×32 px` (`@1x`) / `128×64 px` (`@2x`).
- Khung nhân vật: `64×80 px` (`@1x`) / `128×160 px` (`@2x`).
- Điểm neo nhân vật (`pivot`): `{"x": 0.5, "y": 0.85}` (tọa độ pixel `x=32, y=68` ở `@1x` — nằm chính giữa hai bàn chân).
- Chuỗi 13 key animations trong mỗi JSON (`animations` object):
  `idle` (4), `walk` (8), `sit_type` (4), `sit_rest` (2), `doze` (4), `coffee_idle` (4), `coffee_walk` (8), `lift_weights` (6), `beanbag_game` (4), `chat` (4), `alert` (2), `carry_report` (8), `celebrate` (4).
