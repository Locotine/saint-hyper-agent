# Handoff: Văn phòng ảo kiểu Marvis (office v2)

Ngày: 2026-11-12. Trạng thái: engine mới chạy được, đã thử với 8 agent giả. Chưa thử với thread thật, chưa commit.

## Mục tiêu

Thay office isometric cũ (route `/office-3d` và cửa sổ `/office-widget`) bằng office nhìn từ trên xuống, chuyển động giống Marvis Virtual Office (Tencent) nhất có thể:

- Hỗ trợ mọi provider.
- Số agent bằng số thread đang hoạt động, không giới hạn 6.
- Màu sừng/khăn ngẫu nhiên nhưng cố định theo từng thread.
- Tên lấy từ tiêu đề thread.

Bản quyền: **không** chép code hay asset của Tencent. Phần dưới chỉ là thông số hành vi rút ra từ phân tích tĩnh. Engine và hình vẽ đều tự viết. Nhân vật dựa trên con trâu của dự án (`assets/buffalo-mascot`, có license riêng).

## Code nằm ở đâu

Toàn bộ trong `apps/web/src/components/office/`:

| File                                                         | Vai trò                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `officeLayout.logic.ts`                                      | Bản đồ 17×14, ô 64px. Tự cao thêm 4 hàng cho mỗi 2 bàn vượt quá 6. Có lưới chặn, các điểm cửa/quầy nước/máy chạy/toilet, và `officeFitBoost` |
| `officeBehavior.logic.ts`                                    | Bảng 23 động tác (số frame, phân đoạn vào/loop/ra), `dutyAction`, quyết định lúc rảnh, `shouldLeave`, `agentColors`                          |
| `officeModel.logic.ts`                                       | `deriveDuty`, `assignOfficeDesks` (N bàn, thread giữ nguyên bàn, bàn 0 là bàn sếp), `monitorColor`                                           |
| `astar.ts`                                                   | A\* 4 hướng (đã bỏ `smoothPath`)                                                                                                             |
| `engine/buffaloRig.ts`                                       | Trâu nhìn ngang vẽ bằng Pixi Graphics: thân đen, sừng và khăn tô màu được. `poseFor(anim, frame)` trả về tư thế từng frame                   |
| `engine/character.ts`                                        | Phát động tác 24fps theo phân đoạn, đi từng ô ở 128px/s, nhãn tên, bong bóng nói. Mọi bước chờ đều huỷ được bằng `interrupt()`               |
| `engine/furniture.ts`                                        | Nền, tường, bàn, ghế, màn hình, quầy nước, máy chạy, toilet, cây. Có theme sáng/tối. Sắp lớp theo y                                          |
| `engine/officeEngine.ts`                                     | Pixi Application, ticker, chuyển trạng thái thành script hành vi, mèo, confetti, fit camera, theo dõi theme                                  |
| `useOfficeState.ts`                                          | Đọc thread từ store, trả về `desks` (danh sách bên trái) và `agents` (`OfficeEngineAgent[]`)                                                 |
| `OfficeCanvas.tsx`, `OfficeView.tsx`, `OfficeWidgetView.tsx` | Mount engine; chọn agent theo `threadId`                                                                                                     |
| `officeLogic.test.ts`                                        | 18 test: bố cục N=1/6/7/13, đường tới ghế, phân đoạn động tác, `dutyAction`, chỗ dùng một người, tối thiểu 4 người trong phòng, màu          |

Đã xoá: `officeScene.ts`, `officeMap.ts`, `officeAtlas.ts`, `apps/web/public/office/` (bộ isometric cũ, chưa từng commit; bản gốc vẫn ở `assets/buffalo-mascot`).

`apps/web/src/routeTree.gen.ts` có thêm 21 dòng. Đó là các route office (`_chat.office-3d.tsx`, `office-widget.tsx`), cần commit kèm.

Các thay đổi chưa commit trong working tree cũng thuộc đợt office (desktop widget, server `office3d` bị xoá…): `apps/desktop-rust/*`, `apps/server/src/effectServer.ts`, `apps/server/scripts/cli.ts`, `packages/contracts/src/ipc.ts`, `Sidebar.tsx`, `__root.tsx`. Chạy `git status` để xem đủ.

## Spec hành vi (lấy từ Marvis, đã áp vào code)

| Thông số              | Giá trị                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ô                     | 64px. Bàn cột trái: ghế ở cột 8, quay sang phải. Bàn cột phải: ghế ở cột 14, quay sang trái. Hàng bàn 2, 6, 10, 14…                                                               |
| Ô đứng trước khi ngồi | `seat ± 1` ô, phía hành lang                                                                                                                                                      |
| Tốc độ đi             | 128 px/s                                                                                                                                                                          |
| Mèo                   | 32 px/s, chạy nhanh ×4 khi chuột tới gần trong 32px, sống 180s                                                                                                                    |
| Sprite                | 24fps                                                                                                                                                                             |
| Render                | tối đa 60fps; 10fps khi cửa sổ mất focus; 2fps khi tab bị ẩn                                                                                                                      |
| Đứng chờ lúc rảnh     | ngẫu nhiên 10–30s rồi chọn một việc kéo dài 180s                                                                                                                                  |
| Việc lúc rảnh         | slacking (một người), talk, treadmill (một người), toilet (một người), sleep, coffee                                                                                              |
| Rời phòng             | trên 4 người trong phòng thì 50% rời; không bao giờ xuống dưới 4                                                                                                                  |
| Rê chuột              | 0,5s trên trâu đang slacking/sleep thì nó giật mình (peek)                                                                                                                        |
| Bong bóng             | 3s mỗi câu; trạng thái `!` approval, `?` input, `×` error, `z z` ngủ                                                                                                              |
| Phân đoạn             | standby: vào 0–18 rồi loop. sleeping: loop 0–47, ra 47–66. running_treadmill: vào 0–27. pooping: vào 0–66. on_chair = off_chair chạy ngược. Cốc cà phê hiện ở frame 5–27 và từ 65 |
| Màu nền               | `#F7F7F7` sáng / `#1C1C1C` tối                                                                                                                                                    |
| Camera                | fit khung, lần đầu zoom ×1,1 rồi giảm dần về ×1 trong 0,6s (smoothstep)                                                                                                           |

Chuyển trạng thái thread thành hành động:

| Trạng thái thread           | Hành động | Trâu làm gì                                                           |
| --------------------------- | --------- | --------------------------------------------------------------------- |
| Mới xuất hiện               | DISPATCH  | Vào từ cửa, rồi làm theo trạng thái hiện tại                          |
| idle → working              | START     | Ngồi vào bàn, gõ phím (`working`)                                     |
| idle → working, là subagent | SUB_START | Tới bàn thread cha, `talking_on_stand`, `ticket`, rồi về bàn làm việc |
| → approval / input          | ATTENTION | Ngồi, `high_press`                                                    |
| → error                     | ERROR     | `fall_down`, `sorry`, rồi ngồi `sigh`                                 |
| working → idle              | COMPLETE  | Đứng dậy, `cheer_main` kèm confetti, rồi sang chế độ rảnh             |
| Bị archive hoặc quá 2 giờ   | (xoá)     | `leaving`, đi ra cửa                                                  |

## Khác so với plan ban đầu

- Plan định xuất PNG sprite sheet (`generate.ts`, `public/office/v2`, trang duyệt frame). Thực tế vẽ bằng Pixi Graphics ngay lúc chạy, không có bước tạo ảnh. Ưu điểm: tô màu trực tiếp, nét sạch ở mọi mức zoom. Nhược điểm: chi tiết hình vẽ đơn giản hơn sprite vẽ tay.
- Chưa có cơ chế không vẽ khi cảnh đứng yên (demand render). Ticker luôn chạy, chỉ hạ fps khi cửa sổ mất focus hoặc tab bị ẩn.
- Lưới chặn của mèo dùng chung với người. Mèo chỉ đi dọc các hàng hành lang trống.
- Trên canvas chưa có icon provider. Danh sách bên trái vẫn có.

## Việc còn lại (ưu tiên trên xuống)

1. **Commit và đẩy code lên.** Toàn bộ office đang nằm trong working tree chưa commit, cần commit trước khi chuyển máy. Nhớ chạy `/verify` trước khi commit.
2. **Thử với thread thật:** mở `/office-3d` khi có thread đang chạy, approval, error, subagent. Kiểm tra từng hàng trong bảng chuyển trạng thái.
3. **Theme sáng:** chưa xem lần nào.
4. **Trâu trên nền tối khá chìm:** thêm một viền sáng mảnh quanh thân (`buffaloRig.ts`, phần `body`).
5. **Đo FPS thật:** đọc `app.ticker.FPS` qua một biến debug và xác nhận ổn định 60.
6. **Đánh bóng hình vẽ:** so ảnh cạnh Marvis. Chỉnh tỷ lệ trâu (hiện khoảng 70px), kiểu ghế và màn hình, bóng đổ.
7. **Thời lượng 180s:** dùng cho mọi việc lúc rảnh như Marvis. Trong Saint có thể thấy hơi lâu, cân nhắc rút ngắn toilet và coffee.
8. **Demand render:** dừng ticker khi không có gì động, nếu đo thấy tốn CPU.
9. **Icon provider trên nhãn tên** (tuỳ chọn).

## Cách thử nhanh không cần thread

Chạy một instance riêng theo skill `/verify` (server cổng 3899, web cổng 5899, `SAINT_HOME` riêng). Mở `http://localhost:5899/office-3d`, rồi chạy trong DevTools console:

```js
const mod = await import("/src/components/office/engine/officeEngine.ts");
const host = Object.assign(document.createElement("div"), {});
Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "9999" });
document.body.appendChild(host);
const engine = await mod.createOfficeEngine(host, { onSelect: console.log });
const duties = ["working", "working", "approval", "idle", "input", "working", "idle", "error"];
engine.update({
  selectedThreadId: null,
  agents: duties.map((duty, i) => ({
    threadId: "thread-" + i,
    desk: i,
    label: "Agent " + i,
    duty,
    speech: null,
    parentThreadId: null,
  })),
});
// Đổi trạng thái: gọi lại engine.update(...) với duty khác.
```

Xong thì dọn: tắt hai tiến trình, rồi chạy `git status`. Nếu `routeTree.gen.ts` chỉ bị đổi thứ tự route thì khôi phục lại.

## Kiểm tra trước khi xong

```bash
bun run fmt:check && bun run lint && bun run typecheck
cd apps/web && bun run test src/components/office
```

Kết quả lần cuối: typecheck sạch, lint không có lỗi mới, 18/18 test pass.

Cảnh báo lint `no-array-fill-with-reference-type` trỏ vào `.fill(color)` của Pixi Graphics là báo nhầm. Đó không phải `Array.fill`.

## Tài liệu tham khảo (chỉ có trên máy nhà)

`F:\WorkStation\Loco\marvis-office-extract\README.md` là bản phân tích Marvis 1.60.3400.35, kèm asset và code đã bóc. Thư mục này **không** đưa vào repo vì là tài sản Tencent. Mọi thông số cần dùng đã chép vào bảng spec ở trên.
