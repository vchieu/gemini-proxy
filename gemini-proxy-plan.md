# gemini-proxy-plan.md — Spec sản phẩm

> File này là spec gốc của gemini-proxy. AGENTS.md §1 tham chiếu tới file này.
> Spec này được viết lại từ code hiện tại (2026-10-02) để đảm bảo khớp implementation.

## 1. Tổng quan

Proxy HTTP local (Node.js + Express, CommonJS), đứng giữa AI agent (Cline/OpenCode)
và Google Gemini API. Nhận request OpenAI-compatible, tự xoay cặp `(API key, model)`
khi gặp 429 — agent không cần biết phía sau có fallback.

**Mục tiêu:**
- Agent chỉ cần trỏ tới 1 endpoint OpenAI-compatible, không cần biến logic retry/rotate.
- Tận dụng nhiều API key + nhiều model để tăng throughput và tránh rate limit.
- Quota reset theo **nửa đêm Pacific Time** (theo Gemini free-tier).

## 2. Kiến trúc

```
agent → api/server.js → router/fallbackLoop.js → router/selector.js
  → state/cooldown.js (isAvailable) + state/store.js (StateStore)
  → client/geminiClient.js → Google API
  → 429? client/errorParser.js → store.setCooldown → chọn cặp khác (loop)
  → thành công? store.recordSuccess → api/translate.js → trả OpenAI format
```

**Luồng streaming:**
```
agent → POST /v1/chat/completions (stream: true)
  → openStream() → withFallback() → callGeminiStream()
  → 429? fallback sang cặp khác (trước khi gửi byte đầu)
  → thành công? ghi SSE chunks → client
  → client disconnect? cancel upstream, KHÔNG recordSuccess
```

**Bản dịch format:** `api/translate.js` (`openAiToGemini`, `geminiToOpenAi`, `geminiChunkToOpenAiChunk`).

## 3. Module contract

| Module | File | Export chính / signature |
|---|---|---|
| Bootstrap | `index.js` | `main()` — load config → `StateStore` → `createServer` → `listen` + shutdown handler |
| Config Loader | `config/loader.js` | `loadConfig(configDir) → { keys, models, settings }` |
| State Store | `state/store.js` | `class StateStore`: `get(k,m)`, `recordSuccess(k,m,tokens)`, `setCooldown(k,m,ts)`, `pruneOldEntries(st,now)`, `persist()` (atomic write qua .tmp + rename; lược bỏ inflight — transient), `reserve(k,m,est)`, `release(k,m,est)`, `resetDailyIfNeeded(k,m,now)`, `minCooldownRemaining(now)`, `snapshot()`, `flush()` (huỷ debounce + persist, dùng khi SIGINT/SIGTERM) |
| Cooldown | `state/cooldown.js` | `isAvailable(pairState, limits, nowMs, estimatedTokens) → boolean` (THUẦN, không mutate pairState; cộng `inflight_count`/`inflight_tokens` vào RPD/RPM/TPM — edge case #3). Reset daily_count gọi riêng qua `StateStore.resetDailyIfNeeded(k,m,now)` |
| Selector | `router/selector.js` | `selectPair(..., strategy?)` (thuần, không side-effect; `strategy: 'round_robin_key_then_model' \| 'priority_model_first'`) + `selectAndReserve(..., strategy?)` (select + `reserve` nguyên tử, caller BẮT BUỘC `release` mọi nhánh kết thúc) → `SelectedPair \| null` (+ `_resetRoundRobin()` chỉ dùng cho test) |
| Fallback | `router/fallbackLoop.js` | `handleRequest(agentRequest, { models, keys, stateStore, geminiClient, config }) → Promise<{ openAiResponse, usedKeyId, usedModel, attempts }>`; `openStream(agentRequest, deps) → Promise<{ upstream, pair, estimated, release }>` (fallback 429/5xx ở giai đoạn mở stream, caller phải `release()`); `handleNativeRequest(requestedModel, geminiBody, deps)` / `openNativeStream(requestedModel, geminiBody, deps)` — bản native cho Gemini passthrough (body Gemini gốc truyền qua `options.geminiBody`, không qua `openAiToGemini`); `class Aggregated429Error`; chính sách fallback: **429** → set cooldown theo retryDelay, **HTTP 5xx upstream (500/502/503/504)** → fallback ngay không cooldown (xem §5), lỗi khác trả ngay |
| Gemini Native | `api/geminiNative.js` | `createGeminiNativeRouter(deps) → express.Router`; mount tại `/v1beta` (xem `api/server.js`); `POST /models/:modelAction` (generateContent / streamGenerateContent), `GET /models`; **passthrough**: không dịch format, stream forward byte SSE nguyên bản + **`res.end()` bắt buộc khi stream xong** (thiếu → client treo vô hạn), không ghi `[DONE]`; lỗi trả theo format Google `{ error: { code, message, status } }` (giữ nguyên body Google nếu có) |
| Gemini Client | `client/geminiClient.js` | `callGemini(key, model, geminiBody, {timeoutMs?})`, `callGeminiStream(...)` trả **object mới** `{ ok, status, headers, body }` (không phải `Response` gốc, vì `Response.body` không gán được); idle timeout cover cả stream body; `class Gemini429Error` (có `.rawMessage`, `.details`, `.retryDelaySeconds`), `class GeminiError`; lỗi HTTP dựng qua helper `buildHttpError(status, text)` — **body đọc đúng 1 lần ở caller** rồi truyền `text`; 429 hoặc 403 có message quota/rate/limit/retry → `Gemini429Error` (kèm `retryDelaySeconds`), còn lại → `GeminiError("Gemini error <status>: ...")`; **`GeminiError.body` là JSON Google đã parse** (hoặc `undefined` nếu không phải JSON object — không bọc giả `{ error: { message } }`) |
| Error Parser | `client/errorParser.js` | `extractRetryDelaySeconds(body) → number` (giây; fallback `DEFAULT_COOLDOWN_SECONDS = 30`) |
| API Layer | `api/server.js` | `createServer({ models, keys, stateStore, config, geminiClient? }) → Express app`; mount router Gemini-native tại `/v1beta` — route `POST /v1beta/models/:modelAction`, `GET /v1beta/models`; che `key=` trong access log |
| Translate | `api/translate.js` | `openAiToGemini(oaiBody)`, `geminiToOpenAi(gemBody, modelName?)`, `geminiChunkToOpenAiChunk(chunk, modelName, streamId, created, toolCallIndexOffset?)`; tool/function-calling: `tools` → `functionDeclarations`, `tool_choice` → `toolConfig`, `tool_calls` → `functionCall`, `role: "tool"` → `functionResponse` |
| Token estimate | `utils/tokenEstimate.js` | `estimateTokens(messages) → number` (heuristic chars/4 + 4 token overhead/message) |
| Time | `utils/time.js` | `nextMidnightPacific(nowMs) → ms` |
| Logger | `utils/logger.js` | `logger.{debug,info,warn,error}`, `createLogger(level)` |

## 4. Thuật toán

### 4.1 Chọn cặp (key, model)

1. Lọc model theo `respect_agent_model` (nếu `true` và agent gửi model cụ thể).
2. Ưu tiên theo `priority` (số càng nhỏ càng ưu tiên).
3. Kiểm tra `isAvailable()` — thuần, không mutate state.
4. `selectAndReserve()` — select + reserve đồng bộ (không `await` ở giữa) để tránh race.
5. Nếu hết cặp → trả về `null`, caller tính `Retry-After` từ `minCooldownRemaining()`.

### 4.2 Fallback loop

```
while (attempts < maxAttempts):
  pair = selectAndReserve(...)
  if (!pair) throw Aggregated429Error(retryAfter)
  try:
    result = await call(pair)
    return result  // caller phải release()
  catch 429:
    release(pair)
    setCooldown(pair, retrySeconds)
    triedPairs.push(pair)
    attempts++
  catch non-429:
    release(pair)
    if là HTTP 500/502/503/504 từ upstream (message "Gemini error <status>:"):
      triedPairs += mọi cặp của model này   // fallback request này, KHÔNG cooldown
      lastTransient = e; attempts++; continue
    throw
throw Aggregated429Error("Đã thử hết số lần fallback")
```

### 4.3 Streaming

1. `openStream()` — fallback 429 ở giai đoạn mở stream (trước byte đầu).
2. Kiểm tra limit **trước** khi gửi byte đầu.
3. `res.writeHead(200)` sau khi stream mở thành công.
4. Loop `reader.read()` → parse SSE → forward chunks.
5. Client disconnect → `reader.cancel()`, KHÔNG recordSuccess, KHÔNG ghi `[DONE]`.
6. Stream hoàn tất → `recordSuccess()` + ghi `[DONE]`.

### 4.4 Quota tracking

- **RPM** (requests/minute): đếm `request_timestamps` trong 60s.
- **RPD** (requests/day): đếm `daily_count`, reset theo nửa đêm PT.
- **TPM** (tokens/minute): đếm `token_timestamps` trong 60s.
- **Inflight**: `inflight_count` + `inflight_tokens` — transient, không persist, reset khi load.

### 4.5 Tool/function-calling

- **Request:** `tools` → `functionDeclarations`, `tool_choice` → `toolConfig`.
- **Schema tool (sanitize):** `parameters` đi qua whitelist Gemini `Schema`
  (`type, format, title, description, nullable, enum, maxItems, minItems, properties,
  required, minProperties, maxProperties, minLength, maxLength, pattern, example,
  anyOf, propertyOrdering, default, items, minimum, maximum`) — đệ quy qua
  `properties`/`items`. Mọi field khác bị bỏ (`additionalProperties`,
  `exclusiveMinimum`, `$schema`, `$defs`, `$ref`, `const`...), `oneOf` → `anyOf`,
  giá trị `example`/`default`/`enum` giữ nguyên. **Lý do:** test live với OpenCode
  bị Gemini 400 `Unknown name "additionalProperties" at 'tools[0]...parameters'`
  (agent gửi JSON Schema draft-07 đầy đủ, Gemini chỉ nhận subset OpenAPI 3.0).
- **thoughtSignature (Gemini 3):** `thoughtSignature` là field của **Part** — xác nhận
  từ response thật — **không phải lúc nào cũng cùng part với `functionCall`**: có thể
  nằm ở part RIÊNG trong cùng response, hoặc đến Ở CHUNK SAU trong streaming (test live
  thấy 1/22 call bị lỡ → id cũ không sig → replay 400 `Function call is missing a
  thought_signature`). Gemini 3 **bắt buộc** gửi lại signature này khi replay history
  functionCall. OpenAI format không có chỗ chứa nó và client không echo field lạ →
  **nhúng vào `tool_call_id`** dạng `callsig_<encName>_<rand>_<sig>` (`encName` không
  còn `_` để parse chắc chắn; sig ở đuôi nên chứa gì cũng không phá parse). Khi build
  history, decode từ id và gắn lại thành field sibling của `functionCall` part.
  **Bắt sig không phụ thuộc vị trí:**
  - Non-stream / cùng chunk: `extractToolCalls` gom pool sig từ các part chỉ có
    `thoughtSignature` (không kèm `functionCall`) rồi gán vào call thiếu sig theo thứ tự.
  - Streaming cross-chunk: `server.js` **defer chunk** — chunk chứa `tool_calls` chưa
    có sig được giữ lại (không ghi byte ra client), sig từ chunk sau được gán vào bằng
    `attachThoughtSignature(id, sig)` rồi xả cả hàng đợi theo đúng thứ tự; trễ nhất
    xả ở cuối stream TRƯỚC `[DONE]`. **SSE parsing đúng spec**: 1 event = nhiều dòng
    `data:` (gộp với `\n`), kết thúc tại dòng trống — chunk chứa sig bị tách dòng
    sẽ không bị bỏ sót thầm lặng.
  - **Diagnostic (điều tra khi sig "mất tích"):** cuối stream vẫn còn call thiếu
    sig → WARN kèm counters (events/fcParts/sigParts/orphanSigs/unparseableEvents/
    leftoverSigs) + **dump raw payload** (cắt ngắn 1500 ký tự, tối đa 10 chunk) của
    các chunk chứa functionCall chưa có sig và chunk chứa sig; WARN ngay khi gặp
    field chứa `thought`/`sign` bất thường, `thoughtSignature` không phải string,
    hoặc chunk SSE không parse được. Non-stream path cũng WARN kèm ids/model/key.
    Heuristic: sig cùng chunk ưu tiên gán cho call cùng chunk trước (thứ tự lồng
    nhau hiếm khi sai).
  Id không mang signature (model 2.5 / client tự tạo id / sig không đến) → format cũ
  `call_<name>_<rand>`, parse/FIFO không đổi. Nhúng vào id thay vì cache trong proxy vì
  id được client echo nguyên vẹn → sống sót qua restart, không cần state (đã xác minh
  OpenCode lưu/echo nguyên id `callsig_...`). **Lưu ý:** phiên hội thoại có call bị lỡ
  sig (tạo trước khi có fix này) thì signature đã mất vĩnh viễn (không khôi phục được)
  — phải mở session mới; text part signature (final part) không truyền được qua OpenAI
  format (chỉ ảnh hưởng chất lượng, không 400).
- **Assistant response:** `tool_calls` → `functionCall` parts.
- **Tool result:** `role: "tool"` → `functionResponse` parts. `extractToolName` ưu tiên parse tên
  từ `tool_call_id` (id do `makeToolCallId` tạo, nhúng tên function đã encode); fallback FIFO
  (functionCall chưa respond gần nhất theo document) — cần cho parallel tool_calls, nếu không
  mọi tool result sẽ map về tên ĐẦU TIÊN.
- **Response:** `functionCall` → `tool_calls`, `finish_reason: "tool_calls"`. Streaming:
  `delta.tool_calls[i]` kèm `index` tăng dần giữa các chunk (tham số `toolCallIndexOffset`,
  `server.js` giữ counter) — OpenAI spec bắt buộc `index`, client gom delta theo index.

## 5. Edge cases

1. **Tất cả cặp cooldown** → 429 tổng hợp + header `Retry-After` = cooldown ngắn nhất.
2. **Request vượt TPM mọi model** → lỗi rõ ràng, không loop vô hạn.
3. **Race đồng thời** — inflight reservation: `selectAndReserve()` giữ chỗ ngay khi chọn, `isAvailable()` cộng inflight vào RPD/RPM/TPM.
4. **Reset ngày theo PT** — `utils/time.js`, không dùng giờ local.
5. **Lỗi non-429** → trả lỗi ngay, không tính quota, không set cooldown.
   **Lệch spec (đã sửa sau khi test live, lý do ghi tại đây):** upstream trả
   **HTTP 500/502/503/504** được coi là lỗi tạm thời (overload/spikes — test live thấy
   `gemini-3.8-flash` trả 503 "high demand" lặp lại dù 3 model khác vẫn chạy được) nên
   `withFallback` fallback sang cặp khác **ngay** (loại hết key của model 5xx trong
   request đó), không tính quota, không set cooldown; hết cặp còn 5xx thì trả lỗi 5xx gốc.
   Timeout/network của proxy và mọi lỗi 4xx vẫn trả ngay như spec. (Xem `AGENTS.md` §6.5.)
6. **`respect_agent_model=true`** mới tôn trọng model agent gửi; mặc định `false`.
7. **Streaming:**
   - Kiểm tra limit **trước** khi mở stream.
   - Fallback 429 trước khi gửi byte đầu.
   - 429 giữa stream → đóng stream kèm lỗi (không retry ngầm).
   - Client disconnect → KHÔNG recordSuccess, KHÔNG ghi `[DONE]`.
   - Timeout cover cả stream body (idle timeout).
8. **Shutdown** — SIGINT/SIGTERM → `flush()` (huỷ debounce + persist) trước khi exit.

## 6. Cấu hình

### `config/keys.json`
```json
{
  "keys": [
    { "id": "key-1", "api_key": "...", "enabled": true }
  ]
}
```

### `config/models.json`
```json
{
  "models": [
    {
      "name": "gemini-2.5-flash",
      "priority": 1,
      "limits": { "rpm": 5, "rpd": 20, "tpm": 250000 }
    }
  ]
}
```

### `config/config.json`
```json
{
  "port": 8787,
  "strategy": "round_robin_key_then_model",
  "state_file": "./data/state.json",
  "log_level": "info",
  "request_timeout_ms": 60000,
  "max_fallback_attempts": 12,
  "respect_agent_model": false,
  "default_cooldown_seconds": 30
}
```

## 7. API endpoints

| Method | Path | Mô tả |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat (hỗ trợ `stream: true` SSE, tool/function-calling) |
| POST | `/v1beta/models/:modelAction` | **Gemini-native**: passthrough body/response format Google (không dịch), chọn cặp `(key, model)`, fallback 429/5xx. `:modelAction` = `modelName:action` (`generateContent` / `streamGenerateContent`) |
| GET | `/v1beta/models` | Danh sách model (`name`, `displayName`, `supportedGenerationMethods`) |
| GET | `/v1/models` | Danh sách model đang cấu hình |
| GET | `/admin/status` | Debug: quota đã dùng / còn lại từng cặp (key, model) |
| GET | `/health` | Health check |

## 8. Test

```bash
npm test
```

Kỳ vọng: **70/70 pass** (2026-10-04; 2026-10-02 gồm tool/function-calling tests, 2026-10-03 thêm 6 test native router, 2026-10-04 thêm 12 test `geminiClient` error handling với `Response` thật).
