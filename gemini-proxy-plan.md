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
| Fallback | `router/fallbackLoop.js` | `handleRequest(agentRequest, { models, keys, stateStore, geminiClient, config }) → Promise<{ openAiResponse, usedKeyId, usedModel, attempts }>`; `openStream(agentRequest, deps) → Promise<{ upstream, pair, estimated, release }>` (fallback 429 ở giai đoạn mở stream, caller phải `release()`); `class Aggregated429Error` |
| Gemini Client | `client/geminiClient.js` | `callGemini(key, model, geminiBody, {timeoutMs?})`, `callGeminiStream(...)` trả **object mới** `{ ok, status, headers, body }` (không phải `Response` gốc, vì `Response.body` không gán được); idle timeout cover cả stream body; `class Gemini429Error` (có `.rawMessage`, `.details`, `.retryDelaySeconds`), `class GeminiError` |
| Error Parser | `client/errorParser.js` | `extractRetryDelaySeconds(body) → number` (giây; fallback `DEFAULT_COOLDOWN_SECONDS = 30`) |
| API Layer | `api/server.js` | `createServer({ models, keys, stateStore, config, geminiClient? }) → Express app` |
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
| GET | `/v1/models` | Danh sách model đang cấu hình |
| GET | `/admin/status` | Debug: quota đã dùng / còn lại từng cặp (key, model) |
| GET | `/health` | Health check |

## 8. Test

```bash
npm test
```

Kỳ vọng: **43/43 pass** (2026-10-02, gồm tool/function-calling tests — bổ sung parallel tool_calls + streaming tool_calls index).
