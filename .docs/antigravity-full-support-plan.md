# Kế hoạch hỗ trợ Antigravity toàn diện

Mục tiêu: thread Antigravity trong Saint hoạt động giống như chạy `agy` trực tiếp. Người thực hiện:
tuân thủ [AGENTS.md](../AGENTS.md). Các mục đánh dấu **[UI]** thay đổi text, control hoặc tương tác
hiển thị, cần người dùng cho phép rõ ràng trước khi làm. Mọi mục khác làm đúng như mô tả.

Đã khảo sát ngày 2026-11-16 với `agy` 1.5.9 (`~/.local/bin/agy`). Máy **đã đăng nhập** (lần khảo
sát đầu báo chưa đăng nhập chỉ vì chạy trong sandbox chỉ-đọc, không đọc được `~/.gemini`). Chạy `agy`
ngoài sandbox. Phase 0 ghi nhận các dữ kiện session còn thiếu.

`agy models` thật có `gemini-4-hydrogen-xhigh` (Gemini 4 Hydrogen XHigh), nhưng Saint discovery chỉ
hiện low/medium/high cho Hydrogen → thêm vào P1: discovery phải lộ đủ mức effort agy có (gồm
`xhigh`).

## agy 1.5.9 cung cấp gì (đã kiểm chứng)

- Flag CLI: `--mode accept-edits|auto|plan`, `--effort low|medium|high|xhigh|max`, `--model`,
  `--conversation <id>`, `-c/--continue`, `--add-dir`, `--dangerously-skip-permissions`,
  `--sandbox`, `-p --output-format json|stream-json`, `--json-schema`, `--agent`.
- Subcommand: `acp`, `models`, `agents`, `mcp`, `plugin`, `changelog`, `update`. `agy acp --login`
  chạy đăng nhập tương tác. **Không có** `agy auth login`.
- Phản hồi `initialize` của `agy acp`: `loadSession: true`,
  `promptCapabilities {image: true, audio: false, embeddedContext: true}`,
  `sessionCapabilities {resume, close, load, list, additionalDirectories}`, `auth.logout`,
  `_meta.antigravity {tier: true, systemPrompt.append: true}`. Phương thức auth: `oauth-personal`,
  `oauth-business`, `gemini-api-key`, `agent-platform`. **Không** khai báo `session/fork` hay
  `mcpCapabilities.http`.
- Changelog: ACP Auto mode từ 1.5.4. ACP `usage_update` (context window) từ 1.5.8, gửi khi bắt đầu
  và reload session, sau mỗi lần gọi model, và sau khi đổi model hoặc thinking level. Swarm preview
  từ 1.5.5.
- Thư mục skill native tìm thấy trong binary: `.agents/skills/`, `_agents/skills/`, và
  `.agents/skills.json`. Cấu hình MCP của user nằm ở `~/.gemini/config/mcp_config.json`, agy tự load.
- `agy models` khi chưa đăng nhập in `You are not logged into Antigravity.` ra stderr, stdout rỗng.

## Bảng thiếu hụt

| Tính năng                                | agy có?                                | Saint hiện tại                                                                                     | Hành động                                                                 |
| ---------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Transport                                | ACP (`agy acp`)                        | Mặc định ACP; print adapter là fallback qua `SAINT_ANTIGRAVITY_TRANSPORT=print`                    | Giữ nguyên                                                                |
| Resume                                   | `session/resume` và `load`             | Resume cursor qua `AcpSessionRuntime`                                                              | Giữ; kiểm chứng thật (P0)                                                 |
| Fork                                     | không có `session/fork`                | `forkViaAcpRuntime`, rồi fallback sang transcript đã lưu                                           | Giữ (không có fork native)                                                |
| Rollback                                 | không có rewind                        | `restart-session`                                                                                  | Giữ                                                                       |
| Cancel                                   | `session/cancel`                       | `cancelTurnAndWait` với grace 5 s                                                                  | Giữ                                                                       |
| **Chế độ cần duyệt (approval-required)** | mode `default` + `request_permission`  | **Bị từ chối**: `startSession` yêu cầu `full-access` (AntigravityAcpAdapter.ts:612)                | **P2**: map runtime mode sang mode của agy; hạ tầng duyệt quyền đã có sẵn |
| **Auto mode**                            | ACP `auto` (≥1.5.4, tuỳ tài khoản)     | Chưa có (`AUTO_RUNTIME_MODE_PROVIDERS` chỉ có codex và claudeAgent)                                | **P3**                                                                    |
| Full access                              | `default` + duyệt tất cả               | Ưu tiên agy `auto`, nên lệnh chạy trong terminal sandbox của agy                                   | P2: full-access → `default`, Saint tự duyệt (quyết định D1)               |
| Plan mode                                | ACP `plan`                             | Đặt mode và thêm prefix vào prompt; **không có `turn.proposed.completed`**, nên không có plan card | **P4**                                                                    |
| Model + effort                           | config option `model`, `thought_level` | Discovery qua một ACP session dùng tạm                                                             | Lỗi P1: binary path, không `session/close`, thiếu nhãn `xhigh`/`max`      |
| Context window                           | `usage_update {size, used}`            | `UsageUpdated` bị bỏ khi ngoài turn; kết quả prompt dùng bảng max-token cố định                    | **P1**                                                                    |
| Slash command                            | `available_commands_update`            | `listCommands` rỗng cho tới khi có session                                                         | P1: cache từ discovery session                                            |
| Skill                                    | native `.agents/skills`                | Luôn chèn mọi skill vào prompt (trùng với cái agy tự load)                                         | **P5**                                                                    |
| Ảnh                                      | có                                     | `loadProviderPromptImageBlocks`                                                                    | Giữ                                                                       |
| File đính kèm                            | `embeddedContext`                      | Block đường dẫn dạng text                                                                          | Giữ (đang chạy; resource block là suy đoán)                               |
| Project nhiều thư mục                    | `additionalDirectories`                | Bị chặn (`MULTI_FOLDER_PROVIDERS` chỉ có codex và claudeAgent)                                     | **P6**                                                                    |
| Import thread                            | `session/list` + `load`                | `supportsThreadImport: false`                                                                      | **P7**                                                                    |
| MCP: Saint gateway                       | stdio                                  | Chèn qua `buildAcpSaintMcpServers`                                                                 | Giữ                                                                       |
| MCP: connector                           | không có HTTP MCP qua ACP              | Không gửi (cố ý)                                                                                   | Không: `mcp_config.json` của agy đã áp dụng                               |
| Subagent                                 | `invoke_subagent`, swarm               | `task.started`/`task.completed` cho `invoke_subagent`                                              | Giữ; kiểm tra tool title của swarm ở P0                                   |
| Hiển thị tool                            | ACP kind, nội dung diff                | Mapping ACP chung                                                                                  | Giữ; kiểm tra title ở P0                                                  |
| Trạng thái auth                          | `agy models` / ACP auth                | `unknown` khi chưa đăng nhập                                                                       | P1: báo `unauthenticated`                                                 |
| Gợi ý lỗi auth                           | `agy acp --login` / `agy`              | Ghi `agy auth login` (sai)                                                                         | P1 [UI]                                                                   |
| Usage / rate limit                       | quota Cloud Code                       | `providerUsage/providers/antigravity.ts`                                                           | Giữ                                                                       |
| Terminal profile + đăng nhập             | `agy`                                  | `providerTerminalProfiles.ts`, `providerAuthentication.ts`                                         | Giữ                                                                       |
| Sinh text cho Git                        | `-p --json-schema`                     | Cố ý loại trừ (comment `GIT_TEXT_GENERATION_PROVIDERS`)                                            | Quyết định D2, chưa lên lịch                                              |
| Steering giữa turn                       | không                                  | Không                                                                                              | Không                                                                     |
| Compact thread                           | Chỉ khi agy có lệnh `/compact`         | Không                                                                                              | Không (slash command native đã được truyền qua)                           |

## Quyết định của người dùng (đã chốt 2026-11-16)

- **UI**: cho phép mọi mục [UI] trong P1–P7. Thẻ duyệt quyền: tái dùng thẻ duyệt quyền có sẵn (có
  mục task) nếu dùng được; chỉ tạo mới khi thật sự không dùng được, và ghi lý do.
- **D1**: bỏ sandbox. full-access → agy `default`, Saint tự duyệt mọi thứ.
- **D2**: bỏ qua. Không làm sinh text Git qua `agy -p`.
- **P0**: agy đã đăng nhập → chạy P0 thật; P7 làm nếu P0 xác nhận `session/list`.

## Phase 0: ghi nhận thực tế (cần `agy` đã đăng nhập; chỉ đọc đối với repo)

Chạy một Saint instance tách biệt (home và port riêng, theo AGENTS.md) với
`SAINT_ANTIGRAVITY_ACP_DEBUG=1` và bật native event log. Trong một thread, ghi lại:

1. Phản hồi `session/new`: `modes.availableModes[].id`, id và giá trị của `configOptions`
   (`model`, `thought_level`, `mode`), và `available_commands_update` đầu tiên.
2. Payload `usage_update`: khi nào tới, và `size` có được đặt không.
3. Một turn plan mode: agy phát plan update, tool call, hay chỉ text assistant cho plan cuối?
4. Tool-call title và kind cho: sửa file, lệnh shell, web fetch, `invoke_subagent`, và `/swarm`.
5. `~/.agents/skills` (thư mục home) có được load native không, hay chỉ `<workspace>/.agents/skills`.
6. `session/list` có trả về các hội thoại tạo bởi CLI `agy` thường không.

Bỏ id, đường dẫn và nội dung prompt khỏi dữ liệu ghi nhận, rồi lưu thành fixture trong
`apps/server/src/provider/acp/AntigravityAcpSupport.test.ts` (hằng số inline, không tạo thư mục
fixture mới). Các phase sau dùng các mode id này thay vì đoán.

## Phase 1: sửa lỗi đúng đắn (server)

File: `apps/server/src/provider/acp/AntigravityAcpSupport.ts`,
`apps/server/src/provider/Layers/AntigravityAcpAdapter.ts`,
`apps/server/src/provider/Layers/ProviderHealth.ts`.

1. **Binary path khi discovery.** `listModels` truyền `binaryPath: input.binaryPath?.trim() || "agy"`.
   Cách này bỏ qua các fallback của `resolveAntigravityCliBinaryPath`
   (`~/.gemini/antigravity-cli/bin/agy`, `~/.local/bin/agy`). Truyền nguyên `input.binaryPath`
   (undefined khi rỗng), và tạo cache key từ đường dẫn đã resolve.
2. **Discovery rò hội thoại.** Discovery runtime gọi `session/new` mỗi lần cache miss. Trước khi
   scope kết thúc, gọi `closeSession` (đã có trên runtime ở `AcpSessionRuntime.ts:922`) khi
   `sessionCapabilities.close` được khai báo. Bỏ qua lỗi.
3. **Slash command trước turn đầu tiên.** Trong cùng discovery session, đọc
   `runtime.getAvailableCommands` (có timeout, rỗng nếu lỗi) và lưu vào entry discovery cache hiện
   có. `listCommands` trả về command đã cache khi chưa có session sống.
4. **Context window.**
   - Trong handler `UsageUpdated`, lưu `ctx.lastContextWindowSize = event.usage.maxTokens` và phát
     event cả khi `activeTurnId` là undefined (`makeAcpTokenUsageEvent` đã chấp nhận `turnId`
     undefined).
   - Cho `buildAntigravityPromptUsageSnapshot` một tham số tuỳ chọn `maxTokens` và ưu tiên nó trước
     `resolveAntigravityModelMaxTokens`.
   - Kiểm tra orchestration ingestion có nhận `thread.token-usage.updated` không có turn id không.
     Nếu không, giữ guard theo turn và chỉ ghi lại size.
5. **Nhãn effort.** Thêm `xhigh: "XHigh"` và `max: "Max"` vào `THOUGHT_LEVEL_LABELS`. **[UI]** (text
   nhãn trong picker). Thêm `xhigh` và `max` vào `ANTIGRAVITY_REASONING_EFFORT_SET` trong
   `apps/web/src/composerDraftModels.ts` để parse được slug cũ dạng `"Model (XHigh)"`. Phần này
   không thay đổi hiển thị.
6. **Gợi ý auth.** Trong `resolveAntigravityAcpAuthMethodId`, thay "Run `agy auth login`" bằng "Run
   `agy` (or `agy acp --login`) to sign in, or set GEMINI_API_KEY". **[UI]** (text lỗi)
7. **Trạng thái auth trong health.** Trong `checkAntigravityProviderStatus`, khi stderr hoặc stdout
   của `agy models` chứa `not logged into Antigravity`, trả về `authStatus: "unauthenticated"` với
   mẫu thông báo đăng nhập như các provider khác. **[UI]** (badge và text trạng thái trong Settings)

Test: `AntigravityAcpSupport.test.ts` (nhãn, usage snapshot ưu tiên size được khai báo, text gợi ý
auth), `AntigravityAcpAdapter.test.ts` dùng `acp/testing/fakeAcpSessionRuntime.ts` (discovery gọi
close, `listCommands` trả command đã cache, usage ngoài turn được phát, discovery resolve binary qua
fallback), `ProviderHealth.test.ts` (stderr chưa đăng nhập → `unauthenticated`).

## Phase 2: approval-required và full-access (server)

File: `AntigravityAcpSupport.ts`, `AntigravityAcpAdapter.ts`.

1. Xoá đoạn từ chối `input.runtimeMode !== "full-access"` trong `startSession` (khoảng dòng 612).
2. Thay phần chọn mode của `applyAntigravityAcpInteractionMode` bằng hàm thuần
   `resolveAntigravityAcpModeId({ runtimeMode, interactionMode, availableModeIds })`:
   - interaction `plan` → `plan`
   - `approval-required` → `default`
   - `auto` → `auto`
   - `full-access` → `default` (D1)

   Dùng các id ghi nhận ở P0. Nếu thiếu mode đích cho `plan`, `approval-required`, hoặc `auto`, fail
   closed bằng `ProviderAdapterValidationError` liệt kê các mode có sẵn. Làm theo
   `resolveRequestedModeId` trong `DevinAdapter.ts:798` (tái dùng câu chữ và cấu trúc; không tự chế
   matcher mới). Với `full-access`, thiếu mode thì không sao.

3. Truyền `runtimeMode` (từ `ctx.session.runtimeMode`) vào bước áp mode trong
   `startAntigravityTurn`.
4. Phần quyền không cần code mới. `resolveAcpPermissionPolicy` trả `undefined` cho mode không phải
   full-access, và luồng `pendingApprovals` cùng `makeAcpRequestOpenedEvent` trong
   `handleRequestPermission` đã tạo approval của Saint. Thêm một test chứng minh điều này.
5. Đổi runtime mode đã tự restart session (`ProviderCommandReactor.ts:2777`). Không cần sửa.

Ảnh hưởng hiển thị: thread Antigravity ở chế độ "Ask for approval" giờ chạy được và hiện các thẻ
duyệt quyền có sẵn thay vì báo lỗi. **[UI]** (hành vi tương tác; component không đổi)

Test: `AntigravityAcpSupport.test.ts` (bảng map mode, các trường hợp fail closed),
`AntigravityAcpAdapter.test.ts` (session approval-required khởi động được; `request_permission` phát
`request.opened`; `respondToRequest` chọn đúng option; full-access tự chọn `allow_once`).

## Phase 3: Auto mode

File: `packages/shared/src/runtimeMode.ts`, `apps/server/src/provider/Layers/ProviderHealth.ts`,
`apps/web/src/lib/runtimeMode.ts`.

1. Thêm `"antigravity"` vào `AUTO_RUNTIME_MODE_PROVIDERS`. Cập nhật câu chữ
   `unsupportedAutoRuntimeModeMessage` để liệt kê Antigravity. **[UI]** (text)
2. Trong `checkAntigravityProviderStatus`, đặt `supportsAutoRuntimeMode` bằng
   `compareSemverVersions(version, "1.5.4") >= 0` trên mọi status trả về có version. Việc tài khoản
   có Auto hay không vẫn do kiểm tra fail closed ở P2 đảm bảo.
3. Thêm entry `antigravity` vào `PROVIDER_RUNTIME_MODE_DESCRIPTIONS` mô tả đúng hành vi của agy
   (Auto: sửa file trong workspace, chạy lệnh trong terminal sandbox của agy, hỏi trước khi ra
   ngoài). **[UI]**
4. "Approve for me" xuất hiện trong picker quyền truy cập cho Antigravity. Việc này điều khiển bằng
   dữ liệu qua `providerModelSupportsAutoRuntimeMode`; không sửa component. **[UI]**

Test: `packages/shared/src/runtimeMode.test.ts`, `apps/web/src/lib/runtimeMode.test.ts`,
`ProviderHealth.test.ts` (chặn theo version).

## Phase 4: plan đề xuất trong plan mode [UI]

File: `apps/server/src/provider/planMode.ts`, `apps/server/src/provider/Layers/GrokAdapter.ts`,
`AntigravityAcpAdapter.ts`.

1. Chuyển `extractGrokTerminalPlanMarkdown` (`GrokAdapter.ts:267`) vào `planMode.ts` với tên
   `extractTerminalPlanMarkdown`. Grok import từ đó; hành vi giữ nguyên.
2. Trong Antigravity adapter, thêm `activePlanResponseText` và gom text delta của assistant khi
   `activeInteractionMode === "plan"`. Khi prompt thành công, trước `turn.completed`, phát
   `turn.proposed.completed` với `{ planMarkdown }` theo `GrokAdapter.ts:2063`, và đặt
   `lastPlanFingerprint`. Nếu P0 cho thấy agy phát artifact hoặc tool call riêng cho plan, đọc từ đó
   (như `DroidAdapter.ts:1191`) và giữ fallback bằng text.

Ảnh hưởng hiển thị: thẻ proposed-plan có sẵn và bước tiếp "Implement" xuất hiện cho turn plan của
Antigravity.

Test: chuyển test helper Grok hiện có theo (chỉ tạo `planMode.test.ts` nếu chưa có test Grok nào bao
phủ), cùng `AntigravityAcpAdapter.test.ts` (turn plan phát đúng một proposed plan; turn không phải
plan không phát).

## Phase 5: skill native

File: `apps/server/src/provider/skillPromptInjection.ts`.

- `case "antigravity"`: trả về `!(segments.has(".agents") || segments.has("_agents"))` để agy tự load
  các skill đó và Saint chỉ chèn các thư mục khác. Nếu P0 cho thấy thư mục home
  (`~/.agents/skills`) không được load native, giới hạn kiểm tra cho đường dẫn workspace. Cập nhật
  comment `default:` đã lỗi thời nói rằng Antigravity không có skill native.
- Test: `apps/server/src/provider/skillPromptInjection.test.ts` (`.agents` → không chèn; `.claude`
  → chèn).

## Phase 6: project nhiều thư mục

File: `packages/shared/src/projectFolders.ts`, `apps/server/src/provider/acp/AcpSessionRuntime.ts`,
`AntigravityAcpAdapter.ts`.

1. Thêm option `additionalDirectories?: ReadonlyArray<string>` vào `AcpSessionRuntimeOptions`. Gửi
   nó trong `session/new`, `session/load`, và `session/resume` chỉ khi
   `initializeResult.agentCapabilities.sessionCapabilities.additionalDirectories` có mặt. Nếu không,
   cho start thất bại với lỗi rõ ràng, không bao giờ âm thầm bỏ qua. ACP SDK (1.2.1) đã có field này.
2. Adapter truyền `input.additionalDirectories` từ `startSession`.
3. Thêm `"antigravity"` vào `MULTI_FOLDER_PROVIDERS`. Cập nhật doc comment trong
   `packages/contracts/src/provider.ts:70` ("Only providers that can grant them natively…").
   **[UI]** (project nhiều thư mục không còn hiện lỗi "Use Codex or Claude" cho Antigravity)

Test: `AcpSessionRuntime.test.ts` (field chỉ gửi khi được khai báo),
`packages/shared/src/projectFolders.test.ts`, `AntigravityAcpAdapter.test.ts`.

## Phase 7: import hội thoại agy [UI]

Chỉ làm nếu mục 6 của P0 xác nhận `session/list` thấy được hội thoại từ CLI.

1. `AntigravityAcpAdapter.ts`: implement `readExternalThread` với runtime có scope và
   `resumeSessionId = externalThreadId`. Dùng `session/load`, gom các turn được replay
   (`AcpLoadReplayGate` đã chặn replay), và trả về `ProviderThreadSnapshot`. Làm theo
   `DroidAdapter.ts:1869` cho dạng lỗi. Đặt `supportsThreadImport: true` trong
   `getComposerCapabilities`.
2. `apps/web/src/lib/threadImport.ts`: thêm `"antigravity"` vào `ThreadImportProviderKind` và
   `supportsThreadImportProvider`. **[UI]** (Antigravity xuất hiện trong picker import)

Test: `AntigravityAcpAdapter.test.ts` (`readExternalThread` qua replay của fake runtime),
`apps/web/src/lib/threadImport.test.ts`.

## Tài liệu cần đồng bộ (cùng commit với code)

- `docs/providers.md`: runtime mode của Antigravity, plan card, skill, hỗ trợ nhiều thư mục, và
  import.
- `.docs/runtime-modes.md:21`: danh sách provider có Auto.
- `docs/mcp-connectors.md:43`: giữ "No" và thêm "agy loads its own `mcp_config.json`".
- `apps/web/src/whatsNew/entries.ts`: chỉ khi người dùng cho phép thêm mục What's New. **[UI]**

## Ngoài phạm vi (agy không hỗ trợ, hoặc là suy đoán)

Fork native, rewind, steering, HTTP MCP connector, audio, gửi harness policy qua
`systemPrompt.append` (chưa rõ cấu trúc meta; xem lại sau P0), xoá print adapter, và UI riêng cho
swarm.

## Kiểm chứng

- Khi đang làm: `bun run test <file>` cho từng file test đã sửa. Mỗi suite chạy một lần và ghi output
  ra file.
- Lượt cuối: `bun run fmt:check`, `bun run lint`, `bun run typecheck`, và các file Vitest bị ảnh
  hưởng. P6 sửa `AcpSessionRuntime`, thứ mọi ACP provider dùng chung, nên chạy thêm toàn bộ test
  provider của server. Không bao giờ dùng `bun test`.
- Nghiệm thu thật (cần agy đã đăng nhập, instance tách biệt, skill `/verify`):

| Kiểm tra                         | Kỳ vọng                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Ask for approval → sửa một file  | Hiện thẻ duyệt; Approve áp dụng thay đổi; Decline giữ file nguyên              |
| Auto mode trên tài khoản có Auto | Session khởi động và mode là `auto`; tài khoản không có thì bị từ chối rõ ràng |
| Full access                      | Không hỏi; lệnh chạy ngoài sandbox của agy (D1)                                |
| Plan mode                        | Có thẻ proposed-plan; "Implement" chạy ở mode mặc định                         |
| Thread mới, trước lần gửi đầu    | Context meter và menu `/` đã có dữ liệu                                        |
| Effort `xhigh`                   | Được áp dụng (`thought_level` = `xhigh`)                                       |
| Chưa đăng nhập                   | Settings hiện unauthenticated với gợi ý đăng nhập đúng                         |
| Project nhiều thư mục            | agy đọc được file trong thư mục phụ                                            |
| Import id hội thoại từ agy CLI   | Hiện lịch sử; turn tiếp theo resume native                                     |

Không kiểm chứng được nếu chưa đăng nhập: mọi mục của P0, mode id của agy, Auto có hay không theo
tài khoản, tần suất `usage_update`, dạng output của plan, việc load skill từ thư mục home, phạm vi
`session/list`, và hành vi Windows bản đóng gói.
