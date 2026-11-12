# Buffalo Mascot & Marvis-Style Office Asset Pack v2 (Tauri v2 + Multi-Provider + Nested Supervisor)

Ảnh tham chiếu bố cục: `Gemini_Generated_Image_745zp745zp745zp7.jpeg` (bản cũ: `Gemini_Generated_Image_lrcdllrcdllrcdll.jpeg`). Prompt sinh ảnh: [PROMPT.md](PROMPT.md).

## 1. Điểm nâng cấp cốt lõi ở bản v2
- **Chuẩn phối cảnh Marvis (Camera trực diện chúc 28°, cạnh bàn ngang 0°)**: Loại bỏ hoàn toàn góc nghiêng hình thoi Isometric cũ; nội thất dựng dạng 3D Clay trắng nhám đổ bóng Ambient Occlusion mềm sang trái-dưới.
- **Giữ nguyên Mascot Trâu 2D phẳng (`#111215`)**: Bảo toàn cặp sừng cong, chỏm tóc, mắt trắng sắc nét; cắt bỏ hoàn toàn lỗi thừa chân/bóng đen dưới đáy ghế khi ngồi làm việc.
- **Tách chuẩn Z-Index bàn & ghế**: Màn hình lật mặt về phía người xem (`monitor_*`); nhân vật ngồi quay lưng góc 3/4 (`NW/sit_type`, `NW/sit_rest`, `NW/doze`, `NW/coffee_idle`) nằm kẹp giữa `chair_*_seat` và `chair_*_backrest`.
- **Hỗ trợ Multi-Provider & Nested Sessions (Cha = Supervisor)**:
  - 6 huy hiệu Provider trong `ui_overlays`: `ui/provider_claude.png`, `ui/provider_openai.png`, `ui/provider_gemini.png`, `ui/provider_antigravity.png`, `ui/provider_kimi.png`, `ui/provider_local.png`.
  - Nội thất & huy hiệu riêng cho Session Cha lồng nhau: `env/desk_sub_supervisor.png`, `env/chair_sub_supervisor_{seat,backrest,full}.png`, `ui/badge_root_supervisor.png`, `ui/badge_nested_supervisor.png`, `ui/badge_subsession_link.png`.

## 2. Tích hợp vào Tauri v2 (Rust + Vite/PixiJS/Canvas)
- Đặt thư mục `atlases/` và `palette.json` vào `public/assets/buffalo_mascot_pack/` của frontend Tauri (hoặc load động qua `convertFileSrc` với `assetProtocol` bật trong `src-tauri/tauri.conf.json`).
- Chọn tự động `@2x` khi `window.devicePixelRatio >= 1.5` để nét căng trên màn hình Retina/HiDPI.
