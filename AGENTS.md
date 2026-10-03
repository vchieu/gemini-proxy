# AGENTS.md — Hướng dẫn bắt buộc cho AI agent làm việc trong repo này

> **Mọi AI agent (và cả contributor người) PHẢI đọc file này trước khi sửa code.**
> File này là source-of-truth về kiến trúc, contract module và quy trình làm việc.
> Spec sản phẩm gốc: `gemini-proxy-plan.md`.
>
> ⛔ **RULE ĐỌC FILE NGAY TẠI ĐÂY:** AI **KHÔNG ĐƯỢC** mở/đọc `config/keys.json`
> (file chứa API key thật, **không nằm trong git** — xem §7). Muốn biết cấu trúc
> schema keys thì đọc `config/keys.example.json`.

## 1. Thứ tự đọc bắt buộc (reference order)

Trước khi nhận task, đọc theo thứ tự:

1. `AGENTS.md` (file này) — nắm luật và kiến trúc.
2. `gemini-proxy-plan.md` — spec đầy đủ (§3 contract module, §4 thuật toán, §5 edge cases).
3. `types.js` — các typedef dùng chung (`ApiKeyConfig`, `ModelConfig`, `ModelLimits`, `PairState`, `SelectedPair`).
4. Module liên quan trực tiếp tới task (xem bảng §3).
5. `config/models.json`, `config/config.json` — nếu task đụng tới config/quota.
   ⛔ KHÔNG đọc `config/keys.json` (file secret, đã bị ignore khỏi git); dùng
   `config/keys.example.json` nếu cần xem cấu trúc field key.
6. `tests/` — test tương ứng để biết hành vi kỳ vọng đã được khóa (lock) ở đâu.

Không được suy đoán signature từ trí nhớ — luôn mở file nguồn để kiểm chứng.

## 2. Tổng quan kiến trúc

Proxy HTTP local (Node.js + Express, CommonJS), đứng giữa agent (Cline/OpenCode)
và Google Gemini API. Nhận request OpenAI-compatible, tự xoay cặp `(key, model)`
khi gặp 429 — agent không biết phía sau có fallback.

Luồng 1 request (`POST /v1/chat/completions`, non-stream):

```
agent → api/server.js → router/fallbackLoop.js → router/selector.js
  → state/cooldown.js (isAvailable) + state/store.js (StateStore)
  → client/geminiClient.js → Google API
  → 429? client/errorParser.js → store.setCooldown → chọn cặp khác (loop)
  → 5xx upstream (500/502/503/504)? → chọn cặp khác NGAY (KHÔNG cooldown, KHÔNG tính quota)
  → thành công? store.recordSuccess → api/translate.js → trả OpenAI format
```

Bản dịch format nằm ở `api/translate.js` (`openAiToGemini`, `geminiToOpenAi`,
`geminiChunkToOpenAiChunk`). Quota ngày reset theo **nửa đêm Pacific Time**
(`utils/time.js` → `nextMidnightPacific`), KHÔNG dùng giờ server.

## 3. Contract module (không được tự ý đổi)

| Module | File | Export chính / signature |
|---|---|---|
| Bootstrap | `index.js` | `main()` — load config → `StateStore` → `createServer` → `listen` |
| Config Loader | `config/loader.js` | `loadConfig(configDir) → { keys, models, settings }` |
| State Store | `state/store.js` | `class StateStore`: `get(k,m)`, `recordSuccess(k,m,tokens)`, `setCooldown(k,m,ts)`, `pruneOldEntries(st,now)`, `persist()` (atomic write qua .tmp + rename; lược bỏ inflight — transient), `reserve(k,m,est)`, `release(k,m,est)`, `resetDailyIfNeeded(k,m,now)`, `minCooldownRemaining(now)`, `snapshot()`, `flush()` (huỷ debounce + persist, dùng khi SIGINT/SIGTERM) |
| Cooldown | `state/cooldown.js` | `isAvailable(pairState, limits, nowMs, estimatedTokens) → boolean` (THUẦN, không mutate pairState; cộng `inflight_count`/`inflight_tokens` vào RPD/RPM/TPM — edge case #3). Reset daily_count gọi riêng qua `StateStore.resetDailyIfNeeded(k,m,now)` |
| Selector | `router/selector.js` | `selectPair(..., strategy?)` (thuần, không side-effect; `strategy: 'round_robin_key_then_model' \| 'priority_model_first'`) + `selectAndReserve(..., strategy?)` (select + `reserve` nguyên tử, caller BẮT BUỘC `release` mọi nhánh kết thúc) → `SelectedPair \| null` (+ `_resetRoundRobin()` chỉ dùng cho test) |
| Fallback | `router/fallbackLoop.js` | `handleRequest(agentRequest, { models, keys, stateStore, geminiClient, config }) → Promise<{ openAiResponse, usedKeyId, usedModel, attempts }>`; `openStream(agentRequest, deps) → Promise<{ upstream, pair, estimated, release }>` (fallback 429/5xx ở giai đoạn mở stream, caller phải `release()`); `class Aggregated429Error`; chính sách fallback: **429** → set cooldown theo retryDelay, **HTTP 5xx upstream (500/502/503/504)** → fallback ngay không cooldown (xem §6.5), lỗi khác trả ngay |
| Gemini Client | `client/geminiClient.js` | `callGemini(key, model, geminiBody, {timeoutMs?})`, `callGeminiStream(...)` trả **object mới** `{ ok, status, headers, body }` (không phải `Response` gốc, vì `Response.body` không gán được); idle timeout cover cả stream body; `class Gemini429Error` (có `.rawMessage`, `.details`, `.retryDelaySeconds`), `class GeminiError` |
| Error Parser | `client/errorParser.js` | `extractRetryDelaySeconds(body) → number` (giây; fallback `DEFAULT_COOLDOWN_SECONDS = 30`) |
| API Layer | `api/server.js` | `createServer({ models, keys, stateStore, config, geminiClient? }) → Express app`; streaming: **defer chunk** khi `tool_calls` chưa có thoughtSignature — giữ chunk tới khi sig về (part/chunk sau) mới ghi ra client, xả trễ nhất ở cuối stream (kèm WARN nếu sig không bao giờ đến — xem plan §4.5) |
| Translate | `api/translate.js` | `openAiToGemini(oaiBody)`, `geminiToOpenAi(gemBody, modelName?)`, `geminiChunkToOpenAiChunk(chunk, model, streamId, created, toolCallIndexOffset?)`; hỗ trợ tool/function-calling: `tools` → `functionDeclarations`, `tool_choice` → `toolConfig`, `tool_calls` → `functionCall`, `role: "tool"` → `functionResponse`; **sanitize** `parameters` bằng whitelist Gemini `Schema` (bỏ `additionalProperties`, `exclusiveMinimum`, `$schema`, `$defs`, `$ref`... ; `oneOf` → `anyOf`; giữ nguyên giá trị `example`/`default` — xem plan §4.5); **thoughtSignature roundtrip**: `functionCall` có `thoughtSignature` (bắt buộc replay với Gemini 3) được nhúng vào `tool_call_id` dạng `callsig_<name>_<rand>_<sig>` khi trả response và gắn lại thành field sibling của `functionCall` part khi build history; sig có thể nằm ở **part RIÊNG** (không cùng part với functionCall) → `extractToolCalls` gom pool rồi gán theo thứ tự; export thêm `attachThoughtSignature(id, sig)` để gán sig muộn cho id đã phát ra (dùng khi streaming cross-chunk — xem plan §4.5); `tool_call_id` nhúng tên function (FIFO fallback — đúng với parallel tool_calls); streaming `tool_calls` có `index` tăng dần giữa các chunk |
| Token estimate | `utils/tokenEstimate.js` | `estimateTokens(messages) → number` (heuristic chars/4 + 4 token overhead/message) |
| Time | `utils/time.js` | `nextMidnightPacific(nowMs) → ms` |
| Logger | `utils/logger.js` | `logger.{debug,info,warn,error}`, `createLogger(level)` |

Quy tắc:

- **Không đổi tên file, tên hàm, tham số, kiểu trả về** nếu không có yêu cầu rõ ràng và không cập nhật toàn bộ caller + test + docs (xem §5).
- Codebase dùng **CommonJS** (`require`/`module.exports`), Node `>= 18` (dùng `fetch` global). Không thêm dependency mới nếu stdlib giải quyết được.
- `state/store.js` là single-process in-memory + persist JSON. Mọi mutation quota/cooldown phải đi qua `StateStore` để được `persist()`.
- Không bao giờ commit API key thật. `config/keys.json` chứa key thật của user
  và **đã bị bỏ khỏi git** (`.gitignore`, chỉ còn `config/keys.example.json`
  với placeholder được track) — không được `git add` lại file này.
- ⛔ Không đọc/ mở/ in ra `config/keys.json` — file chứa secret; schema xem ở
  `config/keys.example.json`.

## 4. Quy trình làm việc chuẩn

1. Đọc AGENTS.md + file liên quan (xem §1).
2. Chạy test baseline trước khi sửa: `node --test tests/*.test.js` (hoặc `npm test`, tương đương).
3. Sửa code theo đúng contract §3 và thuật toán `gemini-proxy-plan.md` §4.
4. Chạy lại **toàn bộ** test suite sau khi sửa. Mọi test phải pass (`51/51` tại thời điểm fix thoughtSignature đến muộn ở chunk/part riêng (bug 400 `Function call is missing a thought_signature` với Gemini 3) ; gồm `tests/concurrency.test.js` khóa bail-out khi overshoot RPM, `tests/streaming.test.js` khóa fallback 429 + client disconnect + defer chunk chờ sig, `tests/geminiStream.test.js` khóa real Response body, `tests/translate.test.js` khóa tool/function-calling — kể cả parallel, streaming index, strip schema keys, thoughtSignature id roundtrip và orphan-part sig, `tests/selectorFallback.test.js` khóa fallback 429 + 5xx transient + timeout trả ngay).
5. Smoke-test server nếu đụng tới `api/`, `index.js`, `config/`: `node index.js` rồi kiểm tra
   `GET /health`, `GET /v1/models`, `GET /admin/status`, `POST /v1/chat/completions` (case thiếu `messages` phải 400).
6. Cập nhật tài liệu theo §5 **trong cùng một change** — PR/change thiếu doc update được coi là chưa xong.

## 5. ⛔ RULE NGHIÊM NGẶT: update documents khi update source

> **Bất kỳ thay đổi source nào làm tài liệu hiện tại trở nên sai/lạc hậu thì BẮT BUỘC
> phải cập nhật tài liệu trong cùng một lần thay đổi. Không được tách "code trước,
> docs sau".**

### 5.1 Khi nào phải update docs

| Thay đổi source | Docs phải update |
|---|---|
| Thêm/đổi/xóa endpoint, field request/response, status code | `README.md` (§Endpoint) + `AGENTS.md` §3 nếu đổi contract |
| Thêm/đổi/xóa field config (`keys.json`/`models.json`/`config.json`), đổi default, đổi validation | `README.md` (§Cấu hình) + `AGENTS.md` §3 |
| Đổi signature/hành vi hàm trong contract §3, đổi thuật toán chọn cặp/cooldown/fallback | `AGENTS.md` §3 (+ `gemini-proxy-plan.md` nếu đổi thiết kế gốc — ghi rõ lý do lệch spec) |
| Đổi thuật toán quota (RPM/RPD/TPM), timezone reset, công thức estimate token | `AGENTS.md` §2–§3 + `README.md` nếu user-visible |
| Thêm dependency, đổi yêu cầu Node, đổi script `npm` | `README.md` + `AGENTS.md` §3–§4 |
| Thêm/xóa test làm thay đổi số lượng test kỳ vọng | Cập nhật con số trong `AGENTS.md` §4 |

### 5.2 Checklist trước khi kết thúc task (bắt buộc tự kiểm)

- [ ] `README.md` còn mô tả đúng endpoint/config/cách chạy không?
- [ ] Bảng contract `AGENTS.md` §3 còn khớp signature thực tế không?
- [ ] Con số test kỳ vọng (§4) còn đúng không?
- [ ] Nếu cố tình lệch khỏi `gemini-proxy-plan.md`, đã ghi lý do ở đâu?
- [ ] Đã chạy full test suite và ghi kết quả vào báo cáo chưa?

Nếu câu trả lời cho bất kỳ thay đổi user-visible/contract nào là "docs chưa cần update",
phải nêu rõ lý do trong báo cáo thay vì im lặng bỏ qua.

## 6. Edge cases không được quên (§5 của plan)

1. Tất cả cặp cooldown → 429 tổng hợp + header `Retry-After` = cooldown ngắn nhất.
2. Request ước lượng vượt TPM mọi model → lỗi rõ ràng, không loop vô hạn.
3. Single-process: mutation state qua `StateStore` (đồng bộ); không cache `PairState` ra biến ngoài rồi ghi đè. Chống race đồng thời bằng **inflight reservation**: `selectAndReserve()` giữ chỗ ngay khi chọn (đồng bộ, không `await` ở giữa), `isAvailable()` cộng inflight vào RPD/RPM/TPM, caller (`fallbackLoop`, streaming trong `server.js`) BẮT BUỘC `release()` mọi nhánh kết thúc; inflight không persist và reset về 0 khi load. Không được gọi `selectPair()` thuần rồi `await` trước khi `recordSuccess` trong flow mới.
4. Reset ngày theo PT (`utils/time.js`), không dùng giờ local.
5. Lỗi non-429 **khác 5xx** (4xx, timeout/network của proxy) → trả lỗi ngay, không tính quota, không set cooldown.
   **Ngoại lệ (lệch plan §5.5 — lý do ở `gemini-proxy-plan.md` §5.5):** upstream trả
   **HTTP 500/502/503/504** (503 "high demand" xảy ra thường xuyên với free tier) thì
   `withFallback` fallback sang cặp khác **ngay**, bỏ qua toàn bộ key của model đó trong
   request hiện tại, **không** set cooldown, **không** tính quota; hết cặp còn 5xx thì trả
   lỗi 5xx gốc (không phải 429). Phân biệt bằng prefix message `Gemini error <status>:`
   (chỉ sinh ra khi Google trả `!res.ok`) — timeout/network của `geminiClient` có message
   `Gemini request timeout...` / `Gemini network error...` nên VẪN trả ngay như cũ.
6. `respect_agent_model=true` mới tôn trọng model agent gửi; mặc định `false` (proxy tự chọn, `model: "auto"`).
7. Streaming: kiểm tra limit **trước** khi mở stream; fallback 429 được thực hiện trước khi gửi byte đầu; 429 giữa stream thì đóng stream kèm lỗi (không retry ngầm). Stream bị interrupt (lỗi network, client disconnect) thì KHÔNG recordSuccess và KHÔNG ghi `[DONE]` — chỉ record khi stream hoàn tất nguyên vẹn. Timeout cover cả stream body (idle timeout), không chỉ lúc kết nối ban đầu.

## 7. Cấm kỵ

- ⛔ **KHÔNG đọc file `config/keys.json`** (dùng `read`/`grep`/`cat`/shell đều không).
  File này chứa API key thật, nằm ngoài git. Mọi thao tác với schema key phải
  dựa vào `config/keys.example.json` (placeholder). Không `git add` để đưa nó
  quay lại index.
- Không hardcode API key, không log nguyên `api_key` (chỉ log `key.id`).
- Không `require` vòng tròn giữa `api/` ↔ `router/` ↔ `client/` (luồng phụ thuộc một chiều như §2).
- Không sửa `config/*.json` mẫu thành key thật để "test cho tiện".
- Không dùng `tail`, `ls -la`, `cat` qua shell khi đã có tool đọc file chuyên dụng.
