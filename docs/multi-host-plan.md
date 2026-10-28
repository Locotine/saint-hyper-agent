# Plan B: multi-backend Saint — định danh theo host có kiểu (host-qualified identity), store mỗi host

> User đã duyệt hướng **B** (kể cả tốn thời gian nhất). Plan này thay hướng A (tiền tố ID).
> Không đổi UI nhìn thấy được khi chưa có duyệt riêng (AGENTS.md): các phase P0–P4 **không có thay đổi UI**; UI nằm ở P5 và cần xác nhận lại.
> Nguồn: code `main` @ `21c3d7732`, REMOTE.md, docs/core-concepts.md, Orca (đọc, không chạy).

## TL;DR

| Mục | Quyết định |
| --- | --- |
| Định danh | `HostId` + brand `ScopedThreadId`/`ScopedProjectId` (khác `ThreadId`/`ProjectId` thô). Biên giữa "slice của một host" và "phần còn lại của app" là chỗ compiler bắt buộc dùng scoped ID. |
| Store | Factory `createHostStore(hostId)`: mỗi host một slice orchestration, **bên trong vẫn khoá ID thô** ⇒ reducer (`storeEventReducer`, `storeProjection`) gần như không đổi. Selector gộp cho sidebar. |
| Transport/API | `HostConnectionRegistry` giữ `WsTransport` + `HostApi` mỗi host. `readNativeApi()` đổi thành `readLocalNativeApi()` tường minh; call site khác dùng `useHostApi(hostId)`/`apiFor(ref)`. Dây (wire) với server **không đổi** (ID thô). |
| Local | Chạy qua đúng code path đó với `hostId="local"` từ P2 ⇒ không có nhánh cũ để bảo trì. |
| Desktop | Tunnel supervisor + `epoch` + `hostKey`; IPC nhận `host` tường minh; bỏ switch-reload ở cuối. |
| Ước lượng | **~22–27 tuần-kỹ sư** (P0 2, P1 1.5, P2 3–4, P3 5–6, P4 4–5, P5 4–5, P6 2–3). Mỗi phase ship độc lập. |
| Rủi ro | Diff cực lớn (337 file dùng `ThreadId`, 217 file gọi `readNativeApi`, ~80 store persist) và hồi quy local. Giảm bằng characterization trước + compiler dẫn đường + commit nhỏ theo khu vực. |

## 1. Hiện trạng đã xác minh

| Sự kiện | Chỗ |
| --- | --- |
| Một `instance={api,transport}` singleton; `readNativeApi()` trả một API | `wsNativeApi.ts:77`, `nativeApi.ts:15` |
| 648 lần gọi `readNativeApi/ensureNativeApi`, 217 file | grep |
| Listener push là registry module-level (welcome, config, terminal, git progress, orchestration…) | `wsNativeApi.ts:143-184` |
| Một `useStore`; `syncServerShellSnapshot` thay toàn bộ projects/threads, prune detail, cursor, remembered UI state; một `shellSnapshotSequence` | `storeProjection.ts:1297-1380`, `storeState.ts:24` |
| `EventRouter` ~1700 dòng, fence là biến closure; sau snapshot gọi `removeOrphanedTerminalStates(activeThreadIds)` | `__root.tsx:1213`, `:1740-1755`, `:1917` |
| `ThreadId`: 337 file / 5 640 ref; 80 file chạm localStorage; `browserManager.ts` 571 ref `threadId`; 62 file chạm route/URL thread | grep |
| Persist project theo `cwd` chuẩn hoá, key `saint:renderer-state:v8` | `storePersistence.ts:11,44` |
| `remoteWindowHost` hằng module ở ~14 chỗ; `betaFeatures.ts:33` cache `remoteWindow.providers` | grep |
| Main: `mainWindowHost` (`main.ts:581`), `remoteWindowForSender` (`:5988`), `activateMainWindowHost` = reload (`:6009`); IPC per-window `wsUrl` sync (`:5154`), `openInEditor` (`:5182`), `downloadFiles` (`:5202`), `pickFolder` (`:5238`); preload `getRemoteWindowBridge` (`preload.ts:87`) | đọc |
| Hook catalog hiện tại: 1 `WsTransport`/host poll 15 s, giữ WS mở ⇒ đã chặn idle-exit server khi sidebar mở (`idleExit.ts:64`) | `useRemoteHostCatalog.ts` |
| Tunnel exit khi connected ⇒ phase `error`, **không tự nối lại**; token mới mỗi `runConnect`, port giữ ổn định; `WsTransport` nhận URL cố định trong constructor | `remoteSshManager.ts:181,400,464-474`, `wsTransport.ts:1038` |
| Server: `totalPerClient 20`, `threadPerClient 8` stream mỗi client; negotiation có `serverInstanceId` | `wsCompatibility.ts:21,30` |
| `BETA_ONLY_FEATURES=[]`; remote-ssh bật cả Stable | `betaFeatures.ts:62`, `main.ts:582` |
| Orca: một renderer, `ExecutionHostId`, hàng gắn `hostId`, fence generation (`claimHostCatalogFence`, `captureHostIdentityFence`), `callHostRoute` kiểm fence sau call (`HostRouteUnverifiableError`), cùng ID 2 host = 2 hàng, badge host | scratchpad `orca-src` |

## 2. Thiết kế

### 2.1 Kiểu và định danh
- `packages/shared/src/hostId.ts` (subpath export riêng, không barrel): `HostId = "local" | \`ssh:${hostKey}\``, `LOCAL_HOST_ID`, `parseHostId`, `hostKey` = 8 hex sinh một lần, lưu trong saved-host (đổi alias ssh không mồ côi dữ liệu).
- `ScopedThreadId`, `ScopedProjectId`: brand chuỗi, **chỉ tạo qua** `scopeThread(hostId, threadId)` / `unscopeThread(scoped) → {hostId, threadId}` (tương tự project). Dạng chuỗi `"<hostId>~<rawId>"` dùng cho khoá map/route/persist; không được dựng tay (test + lint cấm ghép chuỗi). `ThreadRef = {hostId, threadId}` cho tham số hàm.
- Route `/$threadId` chứa `ScopedThreadId`. Parser tương thích ngược: param không có tiền tố host ⇒ coi là local (URL, deep link, state cũ vẫn mở được).
- Wire contracts (`packages/contracts`) **không đổi**: server luôn thấy ID thô.
- Danh tính host kiểm bằng `serverInstanceId` đã có trong negotiate; **không cần đổi server**.

### 2.2 Store theo host
- `createHostStore(hostId)` bọc state hiện có (`AppState`) + reducer hiện có; ID bên trong slice là ID thô. Fence (`shellSnapshotSequence`, cursor, tombstone) tự nhiên theo host.
- `HostStoreRegistry` giữ `Map<HostId, HostStore>`; `local` dựng ở boot. Hook công khai: `useThread(scopedId)`, `useProject(scopedId)`, `useAllProjects()`, `useAllThreadSummaries()` (selector gộp, memo ổn định, tái dùng `EMPTY_*`).
- `syncServerShellSnapshot` & GC chỉ tác động slice của host đó. GC ("không còn trong snapshot ⇒ xoá") **chỉ chạy cho host có snapshot authoritative của epoch hiện tại**; host offline/đang nối lại ⇒ giữ nguyên, đánh dấu stale. Chỗ phải gate: `removeOrphanedTerminalStates`, `deletedThreadClientReconciliation`, `threadVisitedPersistence`, `pinnedThreadsStore`, `openThreadTabsStore`, `retainThreadDetailResumeCursors`, `resetStaleRememberedProjectState`, `releaseOrphanedThreadDetail`.
- `EventRouter` → `createHostEventPump({hostId, store, api})`; mỗi host một pump, `visibleThreadIds` lọc theo host. Local chạy qua cùng factory.

### 2.3 Transport & API
- `apps/web/src/hosts/hostConnectionRegistry.ts`: `Map<HostId, HostConnection{transport, api, epoch, generation, status, capabilities}>`. `local` bọc `instance` hiện có.
- Tách `createWsNativeApi` thành `createHostNativeApi({transport, hostId, listeners})`. Local dùng registry listener cũ; remote dùng registry riêng. Welcome/config/settings/provider-status của host remote vào `hostRuntimeStore[hostId]`, không vào registry chung.
- Kênh remote chỉ subscribe cái nằm trong ma trận năng lực (chat, terminal, files, git); automation/todo/device/computer/projectAgent chỉ local.
- `HostFence = {hostId, epoch, generation}` chụp trước async call, so sau; lệch ⇒ bỏ kết quả; lệnh ghi lệch ⇒ *unverifiable* (với `thread.turn.start` dùng `settleTurnDispatch`, `wsTransport.ts:1304`).
- Transport mới mỗi epoch (token mới). Dispose cái cũ trước khi tạo.
- Đổi tên `readNativeApi/ensureNativeApi` → `readLocalNativeApi/ensureLocalNativeApi`; API mới `apiFor(hostId)`, `apiForRef(ref)`, `useHostApi(hostId)`. Codemod theo khu vực; call site thread/project dùng ref, call site cài đặt/hệ thống dùng local tường minh.
- Giới hạn: `MAX_LIVE_HOSTS` (đề xuất 8); lease thread-detail toàn cục giữ `MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS=32`, chia theo host, host đang xem ưu tiên; host nền chỉ shell stream + gộp ghi store (~4 Hz, cần đo).

### 2.4 Desktop / preload / contracts
| File | Thay đổi |
| --- | --- |
| `packages/contracts/src/ipc.ts` | `DesktopRemoteSshHostState` + `hostKey`, `epoch`; `DesktopRemoteSshPhase` + `reconnecting` (soát switch exhaustive); `remoteSsh.openInEditor(host,…)`, `downloadFiles(host,…)`, `hostInfo(host)`; `remoteWindow`/`activate` legacy tới P6; `DesktopRemoteSshSavedHost` + `hostKey` |
| `remoteSshManager.ts` | Supervisor tunnel: exit khi connected ⇒ `reconnecting`, nối lại cùng port/token backoff 1/2/5/15/30 s có trần; `/health` hỏng ⇒ `runConnect` đầy đủ; `epoch` tăng mỗi tunnel+token mới; spawn qua `spawnProcess` dùng chung |
| `remoteSshIpc.ts` | handler nhận `host`, kiểm `parseHost` + connected, giữ `isControlRenderer` |
| `main.ts` | `wsUrl` sync = local; IPC editor/download theo `host`; P6 xoá `mainWindowHost`/`activateMainWindowHost`/title host/reload; `browserManager` từ chối ID scoped remote |
| `preload.ts` | bridge theo host; `getPathForFile` luôn có |
| saved-hosts file | thêm `hostKey` (đọc được file cũ) |

Token không vào state persist; `wsUrl(host)` gọi mới mỗi epoch.

### 2.5 Persist & migration (P3)
> Trạng thái từng store (đã làm / hoãn có lý do): [multi-host-p0-inventory.md § P3 status](multi-host-p0-inventory.md#p3-status). `storePersistence` v9 và react-query key được hoãn có lý do ở đó.
- Migration có phiên bản v8→v9 cho các store persist: khoá thread/project thô → `local~<raw>`; đọc được bản cũ (fallback), ghi bản mới; test migration từng store (fixture trước/sau).
- `saint:renderer-state:v8` (project theo cwd) → khoá `hostId + cwd`; `cwd` remote là POSIX, so sánh phân biệt hoa/thường.
- Dọn khi `forget host`: xoá draft/tab/ghim/terminal state mang host đó + GC khi khởi động.
- Downgrade: bản cũ không đọc được khoá v9 ⇒ ghi rõ trong BETA.md; giữ bản sao v8 một release để rollback.
- Không có migration DB server.

### 2.6 Định tuyến theo bề mặt
| Bề mặt | Cơ chế |
| --- | --- |
| Chat (dispatch, snapshot, subscribe, interrupt, approvals, user-input) | `apiForRef(ref)`; slice của host |
| Terminal | `ThreadRef` ⇒ api host; event vào pump host; khoá terminal state scoped |
| Explorer/files/upload/download | `useHostApi(hostId)`, react-query key có `hostId`; `resolveWsHttpUrl(path, hostId)`; tải về: main nhận `host` |
| Git panel/branch/worktree | `useHostApi`; `git.handoffThread` chéo host không hỗ trợ |
| Folder picker / Add project | local: native; remote: `RemoteFolderPickerDialog`+`remoteFolderPickerStore` nhận `hostId` qua `filesystem.browse` |
| Open in editor | remote: `remoteSsh.openInEditor(host,…)` |
| Provider/model/skills | theo host; `isProviderOn` → `isProviderOnHost(hostId,p)` |
| PR / GitHub inbox, Settings/server.*, Browser, Computer, AppSnap, Device | local-only |

`remoteWindowHost` (~14 chỗ) thay bằng `hostIdOf(ref)`; xoá hằng module.

## 3. Phân phase (mỗi phase ship độc lập, có rollback)

| Phase | Nội dung | UI đổi? | Rollback | Ước lượng |
| --- | --- | --- | --- | --- |
| **P0** Khoá hành vi + nền | characterization test local (`EventRouter.browser.tsx`, `wsNativeApi.test.ts`, `storeProjection/EventReducer`, persist); kiểu `HostId`/Scoped + test; harness host loopback (dev-only, bỏ ssh); kiểm kê call site chỉ-`cwd` và store persist | Không | Không cần | 2 tuần |
| **P1** Supervisor + registry + catalog live | tunnel supervisor, `epoch`, `hostKey`, phase `reconnecting`; registry tạo transport/host; thay poll 15 s bằng shell stream | Không (chấm trạng thái chính xác hơn) | cờ `multi-host-live-catalog` ⇒ hook poll cũ (giữ 1 release) | 1.5 tuần |
| **P2** Store theo host + pump theo host | `createHostStore`, `HostStoreRegistry`, `createHostEventPump`; local chạy qua đó với `hostId=local`; GC gate theo host tươi; selector gộp | Không | cờ nội bộ ⇒ store/pump đơn cũ (giữ 1 release) | 3–4 tuần |
| **P3** Scoped ID cho consumer + migration persist | đổi kiểu theo khu vực (compiler dẫn đường): store UI (drafts, tabs, split, pinned, terminal, recent, selection…), route, react-query key, `storePersistence` v9; test migration | Không (URL local có thể hiện tiền tố, vẫn tương thích) | giữ bản sao v8 + đọc fallback | 5–6 tuần |
| **P4** `HostApi` bắt buộc | đổi tên `readLocalNativeApi`; codemod 217 file; `useHostApi/apiForRef`; lint rule cấm API trần trong code thread/project; `remoteWindowHost` → ref; `betaFeatures` theo host | Không | từng khu vực một PR, revert độc lập | 4–5 tuần |
| **P5** UI + chat remote + bề mặt | **cần duyệt UI**: U1–U10 (dưới); remote chat trước, rồi terminal, explorer/upload/download, folder picker + Add project, editor SSH, git, catalog provider; mỗi bề mặt một PR + cờ | **Có** | cờ `multi-host` Beta-only; tắt ⇒ sidebar về mục Remote cũ, `activate` còn | 4–5 tuần |
| **P6** Chéo host + dọn | palette search fan-out, Activity/Priority, thông báo, quit coordinator, split chéo host (nếu duyệt); xoá `activate`/reload/`mainWindowHost`/`PendingRemoteThreadOpener`/legacy; promote cờ; docs | Có (U8, U9) | giữ legacy tới khi bake xong | 2–3 tuần |

**Tổng ~22–27 tuần-kỹ sư.**

Trạng thái thực hiện từng phase: [multi-host-p0-inventory.md](multi-host-p0-inventory.md) (mục "P3 status", "P4–P5 status", "P6 status"). P6 xong: cờ `multi-host` đã promote (user duyệt 2026-10-29), đường chuyển cửa sổ legacy đã gỡ.

## 4. UI (P5–P6) — cần user duyệt trước khi làm

| # | Thay đổi | Phase |
| --- | --- | --- |
| U1 | Project/thread remote hiện trong danh sách Projects chính cùng local | P5 |
| U2 | Nhãn host: `Local` hoặc tên host (icon `ServerIcon`/`MonitorIcon`, chữ `text-ui-xs`); `Local` chỉ hiện khi có ≥1 host kết nối | P5 |
| U3 | Chấm trạng thái host (connected/connecting/reconnecting/error/offline); hàng host offline mờ, snapshot cũ chỉ đọc | P5 |
| U4 | Hover card: thêm dòng `host:/path` | P5 |
| U5 | Bỏ mục "Remote hosts"/"This computer"; tuỳ chọn bộ lọc host | P5 |
| U6 | Trạng thái vô hiệu cho bề mặt chưa hỗ trợ + "Open on <host>" (đường `activate` cũ) | P5 |
| U7 | Add project / New thread: chọn host; `ProjectPicker` hiện nhãn host | P5 |
| U8 | Title bar bỏ `— host` | P6 |
| U9 | Chữ hộp thoại thoát cho chat remote đang chạy | P6 |
| U10 | Settings → Remote hosts: nút "Open" đổi nghĩa/bỏ | P5 |

Quy tắc: font `text-ui*`; tái dùng `RemoteHostsSidebarSection` (StatusDot, `SIDEBAR_*`), `DisclosureChevron`/`disclosureMotion.ts`, `Tooltip`, `MenuSub`/`contextMenuGroup.ts`; không `has-*` chồng `*:`; test `hasSelectorVariants.test.ts`, `uiFontSize.test.ts` xanh.
Quyết định còn mở (hỏi user trước P5): D1 phẳng+badge (khuyến nghị) vs nhóm theo host; D2 host offline mờ (khuyến nghị) vs ẩn; D3 Space: remote hiện ở mọi Space như Chats (cần xác minh) vs chỉ Void; D5 split chéo host.

## 5. Gating Beta/Stable
- `MULTI_HOST_BETA_FEATURE="multi-host"` trong `packages/shared/src/betaFeatures.ts`, thêm vào `BETA_ONLY_FEATURES` từ P5 tới hết P6 bake.
- Ranh giới authoritative = desktop main (tunnel, token, IPC): Stable từ chối IPC mới, giữ `activate`; web ẩn U1–U7; state remote persist inert trên Stable.
- Thành thật: server không phân biệt client đa host ⇒ không có "server refuse" có nghĩa. P0–P4 là refactor nội bộ không đổi hành vi nên ship cả Stable.
- Diagnostics: không thêm trường; nếu thêm thì qua allowlist + `diagnosticsRedaction.ts`, không gửi tên host/path.
- Docs cùng PR: REMOTE.md (§3 bước 4, bảng Disconnect/Close, "While the app window is on a host", "Remote windows share…"), BETA.md, docs/README.md, CHANGELOG.md.

## 6. Kiểm thử
| Lớp | Việc |
| --- | --- |
| Unit | kiểu/scope (không dựng tay chuỗi), `HostFence`, supervisor (spawn giả), migration v8→v9 từng store |
| Store | host A snapshot không đụng B; 2 host cùng raw ID = 2 hàng; host offline không mất draft/terminal/tab |
| Transport | `wsTransport.test.ts` + `effectRpcWebSocketMock.ts`: 2 transport song song; transport mới mỗi epoch |
| Characterization | khoá local trước mỗi phase refactor |
| Browser | `RemoteHostsSidebarSection.browser.tsx`, `ChatView.browser.tsx`, `EventRouter.browser.tsx` với 2 transport giả |
| Chuẩn repo | `bun run fmt:check`, `lint`, `typecheck`, `bun run test` (không `bun test`); `windows-runtime:check` khi đụng supervisor/ranh giới process; `migrations:check` chỉ khi đụng DB |
| Thật | skill `verify`, instance cô lập (home riêng, port trống). Kịch bản: 1–2 host SSH thật + local; turn dài đồng thời; kill tunnel giữa stream; dừng server host rồi Connect; interrupt khi stream; sleep/resume; thoát app khi remote đang chạy |

## 7. Rủi ro
1. Hồi quy local ở P2–P4 (refactor lớn). Giảm: characterization, local qua cùng path, PR theo khu vực.
2. GC xoá state host offline. Giảm: gate "snapshot tươi của epoch".
3. Migration persist hỏng state người dùng. Giảm: đọc fallback, giữ bản sao v8, test fixture.
4. Tunnel chết âm thầm. Giảm: supervisor + fence epoch + `reconnecting`.
5. Render khi nhiều host stream. Giảm: host nền chỉ shell stream + gộp ghi; cần đo.
6. Diff review quá lớn. Giảm: commit/PR nhỏ theo khu vực, compiler làm checklist.

## 8. Chưa xác minh
- Không chạy code/test; không SSH host thật; chưa đo hiệu năng N host.
- Mức "gần như không đổi" của `storeEventReducer`/`storeProjection` khi bọc theo host (đọc `syncServerShellSnapshot`, chưa đọc hết reducer).
- `normalizeWorkspaceRootForComparison` với path POSIX trên Windows.
- Cách Space lọc project chưa gán; Sidebar.tsx 8 410 dòng chỉ đọc theo điểm.
- Số call site `resolveWsHttpUrl`/`getWsUrl`.
- Hành vi gói Windows (ssh không ControlMaster) chỉ suy từ REMOTE.md.
- Orca chỉ đọc; kiến trúc khác Saint, ánh xạ ở mức khái niệm.
