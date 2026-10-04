# PLAN — Chuyển nhánh OpenAI-compatible sang endpoint OpenAI-compat của Google

> **Đối tượng đọc:** một AI agent nhỏ sẽ tự code, test, restart server và test live cho tới khi xong.
> **Đọc hết file này trước khi làm gì.** Làm tuần tự theo Phase. Không nhảy cóc.
> Ngôn ngữ giao tiếp với user: tiếng Việt. Identifier/code giữ tiếng Anh.

---

## 0. Luật bắt buộc (vi phạm = làm lại)

1. Đọc `AGENTS.md` trước, rồi `types.js`, rồi module liên quan. **Không suy đoán signature từ trí nhớ** — mở file nguồn kiểm chứng.
2. ⛔ **TUYỆT ĐỐI KHÔNG mở/đọc/in/grep/cat `config/keys.json`** (chứa API key thật). Muốn biết schema key thì đọc `config/keys.example.json`. Không log nguyên `api_key`, chỉ log `key.id`.
3. Codebase là **CommonJS**, Node `>=18` (dùng `fetch` global). **Không thêm dependency mới.**
4. Không đổi tên file/hàm/tham số/kiểu trả về trong contract `AGENTS.md` §3 trừ khi plan này nói rõ.
5. Không `require` vòng tròn giữa `api/` ↔ `router/` ↔ `client/`.
6. Mọi thay đổi source làm docs sai → **update docs trong cùng change** (xem Phase 7). Không "code trước, docs sau".
7. Dùng tool đọc file chuyên dụng (view/read), **không** dùng `cat`/`tail`/`ls -la` qua shell để đọc file.
8. Chạy **toàn bộ** test sau mỗi Phase: `node --test tests/*.test.js`. Baseline hiện tại: **70/70 pass**. Không được làm đỏ test cũ trừ khi plan nói rõ test đó bị thay thế.
9. **Quota free-tier rất ít** (xem §2.3). Mỗi request live là tiền thật bằng quota. Tuân thủ ngân sách ở §2.3. Hết quota → dừng và báo user, không cố gắng lách.

---

## 1. Bối cảnh (đọc kỹ để hiểu tại sao làm việc này)

### 1.1 Dự án là gì
`gemini-proxy`: proxy HTTP local (Node.js + Express) đứng giữa AI agent (OpenCode, Cline…) và Google Gemini API. Giá trị cốt lõi của proxy:

- Có **nhiều API key** × **nhiều model**. Mỗi cặp `(key, model)` có quota RPM/RPD/TPM riêng (free tier: `rpm 5, rpd 20, tpm 250000` — xem `config/models.json`).
- Khi một cặp bị 429 → proxy đặt cooldown theo `retryDelay` của Google và **tự thử cặp khác**. Khi gặp 5xx tạm thời (500/502/503/504) → thử cặp khác ngay, không cooldown. Agent không biết gì về việc xoay.
- Quota ngày reset theo nửa đêm **Pacific Time**.

### 1.2 Hiện trạng (luồng OpenAI-compatible, `POST /v1/chat/completions`)
```
agent (OpenAI format)
  → api/server.js
  → router/fallbackLoop.js  (withFallback: chọn cặp, gọi, xử lý 429/5xx)
      → api/translate.js  openAiToGemini()   ← DỊCH OpenAI → Gemini native
      → client/geminiClient.js callGemini()/callGeminiStream()  → Google :generateContent
      → api/translate.js  geminiToOpenAi() / geminiChunkToOpenAiChunk()  ← DỊCH ngược
  → agent
```
`api/translate.js` (~350 dòng) + phần stream trong `api/server.js` (~150 dòng: defer chunk chờ thoughtSignature, parse SSE multi-line, diagnostic dump) tồn tại chỉ để dịch qua lại format và vá các lỗi dịch (JSON Schema bị Google 400, thoughtSignature của Gemini 3 phải replay, v.v.).

Ngoài ra có router **Gemini-native** (`api/geminiNative.js`, mount `/v1beta`) — passthrough, **KHÔNG thuộc phạm vi thay đổi**, vẫn dùng `callGemini`.

### 1.3 Mục tiêu
Google cung cấp sẵn endpoint tương thích OpenAI:

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
Header: Authorization: Bearer <GEMINI_API_KEY>
Body: OpenAI chat-completions bình thường (model: "gemini-3.8-flash", messages, tools, stream…)
```
→ Proxy **không cần dịch format nữa**. Việc còn lại của proxy:
1. Chọn cặp `(key, model)` (giữ nguyên selector/quota/cooldown/fallback).
2. **Ghi đè field `model`** trong body bằng model của cặp được chọn, đặt header `Authorization: Bearer <key thật>`.
3. Chuyển body/stream về agent gần như nguyên bản; ghi quota (`usage.total_tokens`).

Kết quả mong muốn: xoá được phần lớn `translate.js` và logic defer-chunk trong `server.js`, nhưng **giữ nguyên toàn bộ logic xoay key/model**.

### 1.4 Những điều CHƯA được kiểm chứng (đây là lý do có Phase 0 – Spike)
Tài liệu Google nói endpoint này còn **beta** và liệt kê tính năng, nhưng **không** mô tả chi tiết các điểm dưới. Phải kiểm chứng bằng request thật, **không được đoán**:

| # | Câu hỏi | Vì sao quan trọng |
|---|---|---|
| Q1 | thoughtSignature (Gemini 3) nằm ở field nào trong response `tool_calls`? Cùng chunk với `tool_calls` khi stream không? (Gợi ý từ trí nhớ, **chưa xác minh**: `tool_calls[].extra_content.google.thought_signature`.) | Gemini 3 báo 400 `Function call is missing a thought_signature` nếu replay history thiếu signature. |
| Q2 | Client (OpenCode) có echo lại field lạ như `extra_content` khi gửi history không? Nếu client làm rơi field đó thì replay có bị 400 không? | Hiện proxy nhúng signature vào `tool_call_id` (`callsig_<name>_<rand>_<sig>`) chính vì client không echo field lạ. |
| Q3 | Body lỗi của endpoint này có dạng nào? Có thể là **mảng** `[{"error":{...}}]` thay vì object. `retryDelay` còn nằm ở `error.details[]` không? | `client/geminiClient.js::buildHttpError` hiện chỉ hiểu body là object → mất `retryDelay` → cooldown sai (rơi về 30s). |
| Q4 | JSON Schema "bẩn" của OpenCode (`additionalProperties`, `$schema`, `exclusiveMinimum`, `oneOf`, `$ref`…) có bị 400 không? | Hiện `sanitizeGeminiSchema` tồn tại vì native endpoint 400 với các field này. |
| Q5 | Stream: có chunk cuối chứa `usage` không (khi gửi `stream_options.include_usage: true`)? Chunk đó có `choices: []`? Upstream có tự gửi `data: [DONE]` không? | Cần `total_tokens` để ghi quota; cần biết ai ghi `[DONE]`. |
| Q6 | Tham số nào agent gửi mà Google từ chối (400 `Unknown name`/`invalid argument`)? | Có thể phải xoá một số field (denylist) trước khi forward. |
| Q7 | Lỗi 503 "high demand" vẫn là HTTP 503 với message chứa text lỗi? | `isTransientUpstream` dựa vào prefix `Gemini error <status>:` do `buildHttpError` tạo. |

**Quy tắc:** kết quả Phase 0 quyết định hướng của Phase 3 (xử lý signature). Ghi kết quả vào `docs/openai-compat-spike.md`.

---

## 2. Thiết kế đích (design decisions — đã chốt, không tự ý đổi)

### 2.1 Cờ chuyển đổi để rollback an toàn
Thêm setting **`upstream_mode`** vào `config/config.json`:

- `"translate"` — hành vi cũ (OpenAI → Gemini native → OpenAI). **Mặc định trong suốt Phase 1–5** để test cũ không vỡ.
- `"openai_compat"` — hành vi mới (passthrough tới endpoint `/v1beta/openai/`).

Cho phép override bằng biến môi trường **`UPSTREAM_MODE`** (ưu tiên hơn config file) để test live không phải sửa file.
Ở Phase 6 (sau khi live test xanh) mới đổi mặc định thành `"openai_compat"`. **KHÔNG xoá `api/translate.js`** trong plan này — để dành làm legacy mode; việc xoá là bước riêng user tự quyết sau.

### 2.2 Phạm vi file
| File | Thay đổi |
|---|---|
| `config/loader.js` | thêm `upstream_mode` (validate, default, env override) |
| `config/config.json` | thêm `"upstream_mode"` |
| `client/geminiClient.js` | thêm `callOpenAI`, `callOpenAIStream`; sửa `buildHttpError` hiểu body dạng mảng |
| `router/fallbackLoop.js` | `withFallback`/`handleRequest`/`openStream` rẽ nhánh theo `upstream_mode` |
| `api/openaiPassthrough.js` (**mới**) | stream passthrough ở mức event SSE |
| `api/server.js` | rẽ nhánh stream sang `openaiPassthrough` khi `openai_compat`; sửa cảnh báo thoughtSignature |
| `api/signatureShim.js` (**mới, chỉ tạo nếu spike yêu cầu — Case B**) | đổi qua lại `extra_content` ↔ `tool_call_id` |
| `tests/*` | thêm test mới (xem Phase 5), giữ test cũ |
| `scripts/spike-openai-compat.js` (**mới**) | Phase 0 |
| `scripts/live-test.js` (**mới**) | Phase 6 |
| `docs/openai-compat-spike.md` (**mới**) | kết quả Phase 0 |
| `README.md`, `AGENTS.md`, `gemini-proxy-plan.md` | Phase 7 |

**Không đụng:** `api/geminiNative.js`, `router/selector.js`, `state/*`, `client/errorParser.js` (trừ khi spike chứng minh cần), `utils/*`.

### 2.3 Ngân sách quota cho live test (QUAN TRỌNG)
Từ `config/models.json`: mỗi cặp `(key, model)` chỉ có **5 request/phút** và **20 request/ngày**. Số key xem qua `GET /admin/status` (không đọc `keys.json`).

- Trước khi bắt đầu bất kỳ đợt live nào: gọi `GET http://localhost:8787/admin/status`, cộng `rpd_remaining` của model đang dùng (ưu tiên `gemini-3.8-flash`).
- **Tổng ngân sách cả task: ≤ 40 request upstream** (Phase 0 ≤ 12, Phase 6 ≤ 28). Đếm và ghi lại.
- Nếu tổng `rpd_remaining` < 30 → **dừng, báo user**, không tiếp tục.
- Giãn request: chạy tuần tự, mỗi request cách ≥ 2 giây; nếu gặp 429 hãy chờ đúng `Retry-After`.
- Request test dùng prompt cực ngắn (`"Reply with the single word: ok"`) để tiết kiệm token.

---

## Phase 0 — Spike: kiểm chứng Q1–Q7 (không sửa code của proxy)

**Mục tiêu:** có bằng chứng thật cho Q1–Q7, ghi vào `docs/openai-compat-spike.md`.

**Chuẩn bị key:** script spike đọc key từ biến môi trường **`GEMINI_SPIKE_KEY`**.
Nếu biến này không có → **dừng và nhờ user** chạy `export GEMINI_SPIKE_KEY=...` (PowerShell: `$env:GEMINI_SPIKE_KEY="..."`). **Không** đi tìm key trong `config/keys.json`.

Tạo `scripts/spike-openai-compat.js` (Node, `fetch` global, không dependency). Script in kết quả đã **che key** và **cắt ngắn signature** (chỉ in 12 ký tự đầu + độ dài). Dùng model `gemini-3.8-flash`. Mỗi bước dưới đây = 1 request (tổng ≤ 12):

| Bước | Request | Cần ghi lại |
|---|---|---|
| S1 | Chat non-stream đơn giản | HTTP status, keys cấp 1 của body, `usage` |
| S2 | Chat stream với `stream_options:{include_usage:true}` | Danh sách `data:` event theo thứ tự (rút gọn), có `usage` chunk không, `choices` của nó, có `[DONE]` không (**Q5**) |
| S3 | Non-stream với 1 tool `get_weather` + prompt buộc gọi tool (`tool_choice:"required"`) | **Toàn bộ JSON `tool_calls[0]` (che signature)**: `id` có dạng gì, có `extra_content`/field lạ không → **Q1** |
| S4 | Replay: gửi lại history `[user, assistant(tool_calls y nguyên S3), tool(result)]` | status + có trả lời cuối không → **Q2 (client echo đầy đủ)** |
| S5 | Như S4 nhưng **xoá `extra_content`** (và mọi field lạ) khỏi `tool_calls` | status; nếu 400 ghi nguyên message → **Q2 (client làm rơi field)** |
| S6 | Stream với tool `get_weather` bắt buộc gọi | signature xuất hiện ở chunk nào, cùng chunk với `tool_calls` hay chunk sau → **Q1 stream** |
| S7 | Non-stream với tool có schema "bẩn" (copy mẫu ở `tests/translate.test.js` test "strips JSON Schema keys…": `additionalProperties`, `$schema`, `$defs`, `exclusiveMinimum`, `oneOf`) | status → **Q4** |
| S8 | Request cố tình lỗi 400 (ví dụ `model` không tồn tại) | status + **nguyên body lỗi**: object hay mảng → **Q3**, **Q7** |
| S9 | Request thừa field lạ: thêm `"parallel_tool_calls": true`, `"store": false`, `"reasoning_effort": "low"` (mỗi field 1 request riêng nếu bị 400 để tìm ra field gây lỗi; dừng khi đủ thông tin) | field nào bị từ chối → **Q6** |

**Q3 bổ sung:** nếu không tự gây được 429 (tốn quota), đánh dấu "chưa quan sát được 429 thật" — Phase 6 sẽ bắt khi tự nhiên xảy ra. Có thể suy ra shape lỗi từ S8.

**Kết quả Phase 0 → `docs/openai-compat-spike.md`** gồm: bảng Q1–Q7 (câu trả lời + bằng chứng rút gọn), và **kết luận chọn Case** cho signature:

- **Case A (passthrough thuần):** signature đi trong response ở field cố định (ví dụ `extra_content.google.thought_signature`) **cùng chunk** với tool_call, và S5 **không** gây 400 (hoặc S4 OK và bạn xác định được OpenCode echo field đó). → không cần shim.
- **Case B (shim):** S5 gây 400 `missing thought_signature`, tức client làm rơi field là hỏng → cần shim đổi `extra_content` ↔ `tool_call_id` (tái dùng ý tưởng `makeToolCallId`/`parseToolCallId` của `translate.js`).
- **Case C (không giải được):** signature đến ở chunk sau không kèm tool_call, hoặc shape không xử lý được. → **DỪNG**, giữ `upstream_mode` mặc định `translate`, báo user kết luận và bằng chứng. Không cố gắng tiếp.
- Nếu doc/response gợi ý giá trị signature "giả" để bỏ qua validate: **chỉ ghi nhận**, không áp dụng trong plan này (cần user quyết).

Cũng ghi vào kết luận: **danh sách field phải xoá** khỏi body (Q6) → sẽ thành `OPENAI_DROP_FIELDS`.

**Điều kiện qua Phase 0:** file `docs/openai-compat-spike.md` có đủ Q1–Q7 + Case được chọn. Nếu Case C → dừng toàn bộ task.

---

## Phase 1 — Config: `upstream_mode`

1. `config/loader.js`:
   - Thêm `const VALID_UPSTREAM_MODES = ['translate', 'openai_compat'];` và export.
   - Trong `settings` thêm `upstream_mode: process.env.UPSTREAM_MODE || settingsRaw.upstream_mode || 'translate'`.
   - Validate: nếu không thuộc `VALID_UPSTREAM_MODES` → `throw new Error('config.json: upstream_mode must be one of translate, openai_compat')`.
2. `config/config.json`: thêm `"upstream_mode": "translate"`.
3. Test mới (`tests/configLoader.test.js`, file mới): dùng thư mục tạm (`fs.mkdtempSync`) chứa `keys.json` **giả** (`{"keys":[{"id":"k","api_key":"x"}]}`), `models.json` giả, `config.json` giả. Kiểm tra: default `translate`; giá trị hợp lệ; giá trị sai → throw; env `UPSTREAM_MODE` override (nhớ khôi phục `process.env` trong `afterEach`).
   *(Đây là key giả trong thư mục tạm — không liên quan `config/keys.json` thật.)*
4. Chạy full test.

---

## Phase 2 — Client: `callOpenAI` & `callOpenAIStream`

Trong `client/geminiClient.js`:

```js
const OPENAI_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Điền từ kết quả Phase 0 (Q6). Mặc định rỗng nếu spike không thấy field nào bị từ chối.
const OPENAI_DROP_FIELDS = [];

function buildOpenAiBody(agentBody, model, stream) {
  const body = { ...agentBody, model: model.name };      // ghi đè model theo cặp được chọn
  for (const f of OPENAI_DROP_FIELDS) delete body[f];
  if (stream) body.stream_options = { ...(agentBody.stream_options || {}), include_usage: true };
  else delete body.stream_options;
  return body;
}
```

- `callOpenAI(key, model, openAiBody, { timeoutMs })` → trả JSON đã parse. Copy cấu trúc timeout/đọc body-1-lần của `callGemini` (AbortController, `text = await res.text()` đúng 1 lần, `!res.ok` → `throw buildHttpError(res.status, text)`). Header: `{ 'Content-Type': 'application/json', Authorization: \`Bearer ${key.api_key}\` }`.
- `callOpenAIStream(key, model, openAiBody, { timeoutMs })` → trả `{ ok, status, headers, body }` y hệt `callGeminiStream` (idle timeout, wrap `ReadableStream`, KHÔNG gán `res.body`).
- **Tránh nhân đôi code stream:** tách helper dùng chung (ví dụ `openUpstreamStream({ url, headers, body, timeoutMs })`) rồi cho `callGeminiStream` và `callOpenAIStream` cùng gọi. Sau khi tách, **`tests/geminiStream.test.js` và `tests/geminiClient.test.js` phải vẫn xanh nguyên vẹn** (không sửa các test này để cho qua).
- **Sửa `buildHttpError(status, text)`** (Q3): sau `JSON.parse`, nếu `Array.isArray(parsed)` thì dùng phần tử đầu có thuộc tính `error` làm `parsed`. Giữ nguyên: message `Gemini error ${status}: ${text}` (prefix cho `isTransientUpstream`), 429/403-quota → `Gemini429Error` có `retryDelaySeconds`, `GeminiError.body` là JSON Google (object).
  - Khi `parsed` ban đầu là mảng, `GeminiError.body` phải là **phần tử đã bóc** (object), để native router vẫn trả đúng format.
- Export thêm `callOpenAI`, `callOpenAIStream`.

Test mới (`tests/openaiClient.test.js`), mock `global.fetch` bằng **`Response` thật** (như `tests/geminiClient.test.js`; đọc body lần 2 sẽ ném TypeError — đó là bug cần chặn):
- 200 → trả JSON; kiểm tra fetch được gọi tới đúng `OPENAI_COMPAT_URL`, header `Authorization: Bearer k1`, body có `model` bằng `model.name` (dù agent gửi `model:"auto"`).
- Non-stream: body **không** có `stream_options`. Stream: body có `stream_options.include_usage === true` và vẫn giữ các `stream_options` khác agent gửi.
- 429 body object có `retryDelay` → `Gemini429Error.retryDelaySeconds` đúng.
- 429 body dạng **mảng** `[{error:{...,details:[{retryDelay:'7s'}]}}]` → `retryDelaySeconds === 7`.
- 503 body mảng → `GeminiError`, `status 503`, message bắt đầu `Gemini error 503:`, `.body` là object.
- 403 không phải quota → `GeminiError 403`. 403 quota → `Gemini429Error`.
- Stream 503 → `GeminiError` (giống test stream hiện có).
- Field trong `OPENAI_DROP_FIELDS` (nếu không rỗng) bị xoá.

Chạy full test.

---

## Phase 3 — Fallback loop rẽ nhánh theo `upstream_mode`

Sửa `router/fallbackLoop.js` (giữ nguyên **toàn bộ** logic 429/5xx/release/cooldown):

1. Đầu `withFallback`: `const mode = (config && config.upstream_mode) || 'translate';`
2. Dòng tính `geminiBody` đổi thành:
   ```js
   const geminiBody = options.geminiBody
     || (mode === 'openai_compat' ? undefined : openAiToGemini(agentRequest || {}));
   ```
   (`estimated` giữ nguyên: nó đã chấp nhận `agentRequest.messages` kiểu OpenAI.)
3. `ctx` truyền cho `call` thêm `openAiBody: agentRequest` (cạnh `geminiBody`, `estimated`, `timeoutMs`).
4. `handleRequest`: nếu `mode === 'openai_compat'` → `call` là `geminiClient.callOpenAI(p.key, p.model, ctx.openAiBody, { timeoutMs })`; `totalTokens = (value.usage && value.usage.total_tokens) || estimated`; sau đó `release` → `recordSuccess` đồng bộ như cũ; `openAiResponse = value` (không qua `geminiToOpenAi`). Nhánh `translate` giữ nguyên 100%.
5. `openStream`: nếu `openai_compat` → `call` là `geminiClient.callOpenAIStream(...)`. Contract trả về `{ upstream, pair, estimated, release }` **không đổi**.
6. `handleNativeRequest` / `openNativeStream`: **không đổi** (luôn truyền `options.geminiBody`, luôn native).
7. **Nếu Case B:** trước vòng lặp, áp `signatureShim.requestToUpstream(agentRequest)` (đổi `callsig_…` trong id của assistant tool_calls thành `extra_content` đúng shape đã quan sát ở spike); sau khi nhận response non-stream, áp `signatureShim.responseToClient(value)`. Case A: bỏ qua.

Test mới (`tests/openaiFallback.test.js`) dùng fake client có `callOpenAI`/`callOpenAIStream`, `config.upstream_mode = 'openai_compat'`:
- Thành công: client nhận nguyên JSON; `recordSuccess` gọi 1 lần với `usage.total_tokens`; `inflight_count === 0`.
- Fake client **ghi lại `model.name` nhận được** → bằng model của cặp được chọn, không phải `auto`.
- 429 trên model A → cooldown + fallback model B (`callOpenAI` được gọi 2 lần).
- 503 trên model A → fallback B, không cooldown, không tính quota A.
- Mọi cặp 429 → `Aggregated429Error` status 429.
- Timeout 504 → trả ngay, không fallback.
- Concurrency: 3 request song song, `rpm=1` → đúng 1 thành công, 2 lần 429 tổng hợp, upstream gọi 1 lần (mô phỏng `tests/concurrency.test.js`).
- `openStream` trả `release` idempotent.
- Với `upstream_mode='translate'` thì **không** gọi `callOpenAI` (hồi quy).

Chạy full test.

---

## Phase 4 — Stream passthrough (`api/openaiPassthrough.js`) + server

### 4.1 Hợp đồng
Tạo `api/openaiPassthrough.js` export:
```js
streamOpenAiPassthrough({ req, res, handle, agentRequest, deps, sendError, errorToOpenAi })
```
(`sendError`, `errorToOpenAi` truyền vào qua tham số để **tránh require vòng** với `server.js`.)

`handle` = kết quả `openStream()`: `{ upstream, pair, estimated, release }`.

### 4.2 Hành vi (xử lý ở mức EVENT SSE, không chỉ pipe byte)
1. `reader = upstream.body.getReader()` (bọc try/catch như `server.js` hiện tại: lỗi → `release()` + `sendError`).
2. `res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })`.
3. `res.on('close')`: nếu `!res.writableEnded` → `clientAborted = true; reader.cancel().catch(()=>{})`.
4. Đọc loop → gom text → tách dòng → gom các dòng `data:` thành 1 event (SSE đúng spec: nhiều dòng `data:` nối bằng `\n`, event kết thúc bằng dòng trống; xử lý `\r`). **Có thể tái dùng/copy** logic `handleLine` hiện có trong `server.js`.
5. Với mỗi event payload:
   - `[DONE]` → đặt `sawDone = true`, **forward** `data: [DONE]\n\n`.
   - JSON hợp lệ → nếu có `usage.total_tokens` thì `totalTokens = usage.total_tokens`. Nếu chunk là chunk usage-only (`Array.isArray(choices) && choices.length === 0`) **và** agent **không** yêu cầu (`agentRequest.stream_options?.include_usage !== true`) → **không forward** chunk này (client strict có thể lỗi với `choices: []`). Ngược lại → forward `data: ${payloadRaw}\n\n` (**payload gốc, không `JSON.stringify` lại**).
   - Không parse được JSON → vẫn forward nguyên (để Google lỗi đi tới client), đồng thời `logger.warn`.
6. **Case B:** trước khi forward chunk JSON, áp `signatureShim.chunkToClient(chunk)`. Nếu spike cho thấy signature đến ở chunk sau (Case C) thì plan đã dừng ở Phase 0 — không xử lý ở đây.
7. Kết thúc:
   - Stream đọc xong không lỗi, không `clientAborted` → `release()`; `stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens)`; nếu `!sawDone` thì ghi `data: [DONE]\n\n`; `res.end()`.
   - Lỗi giữa chừng (`reader.read()` throw) → `release()`, **không** `recordSuccess`, **không** `[DONE]`, ghi 1 event lỗi dạng `errorToOpenAi(...)`, `res.end()`.
   - Client ngắt → `release()`, **không** `recordSuccess`, **không** `[DONE]`.
   - **Mọi nhánh** phải `release()` đúng 1 lần (hàm `release` đã idempotent) và **luôn `res.end()`** nếu chưa kết thúc (thiếu → client treo vô hạn).
8. `totalTokens` khởi tạo bằng `handle.estimated`.

### 4.3 `api/server.js`
- Trong nhánh streaming của `POST /v1/chat/completions`: sau `handle = await openStream(...)`, nếu `config.upstream_mode === 'openai_compat'` → `return streamOpenAiPassthrough({...})`. Nhánh `translate` giữ nguyên.
- Non-stream: đoạn cảnh báo "tool_call KHÔNG kèm thoughtSignature (callsig_)" chỉ áp dụng khi `upstream_mode !== 'openai_compat'` (hoặc khi Case B); với Case A, thay bằng kiểm tra field signature đã quan sát ở spike (nếu thiếu → `logger.warn`, không throw).
- `/admin/status` đã trả `strategy`; **thêm** `upstream_mode` vào JSON trả về để test live kiểm tra nhanh mode đang chạy (đây là thay đổi hành vi user-visible → ghi docs ở Phase 7).

### 4.4 Test mới (`tests/openaiStreaming.test.js`, mô phỏng cấu trúc `tests/streaming.test.js`: dựng `createServer` với `config:{ upstream_mode:'openai_compat' }`, fake client `callOpenAIStream` trả `ReadableStream`, gọi bằng `http.request`)
- Forward chunk text + `[DONE]` do upstream gửi; `daily_count === 1`; **chỉ một** `[DONE]`.
- Upstream không gửi `[DONE]` → proxy tự ghi 1 `[DONE]` khi kết thúc sạch.
- Chunk usage-only: agent **không** xin usage → bị lọc; agent gửi `stream_options.include_usage:true` → được forward. `recordSuccess` luôn dùng `usage.total_tokens`.
- Event `data:` nhiều dòng được gộp đúng; payload forward **giống hệt byte** payload gốc (so sánh chuỗi).
- Stream lỗi giữa chừng → không `[DONE]`, `daily_count === 0`, `inflight_count === 0`.
- Client ngắt giữa chừng → không record, `inflight_count === 0`, upstream `cancel()` được gọi (mô phỏng test "client disconnects mid-stream" hiện có).
- 429 trên model A trước khi mở stream → fallback B, stream thành công (mô phỏng test hiện có).
- Hết cặp → HTTP 429 JSON.
- Lỗi upstream 400 trước khi mở stream → client nhận 400 JSON kiểu OpenAI, không cooldown.
- (Case B) chunk có tool_call mang signature được đổi sang id `callsig_…`.

Chạy full test.

---

## Phase 5 — Tổng kiểm unit trước khi live

- Chạy `node --test tests/*.test.js`: **106/106 xanh, 19 suite** (2026-10-04) — gồm 70 test cũ
  (không test nào bị xoá/làm yếu) + **36 test mới**: `tests/configLoader.test.js` (5),
  `tests/openaiClient.test.js` (9), `tests/openaiFallback.test.js` (11),
  `tests/openaiStreaming.test.js` (11).
- Số test thực tế: **106** (đã ghi vào `README.md` §Test, `AGENTS.md` §4, `gemini-proxy-plan.md` §8).
- Soát nhanh bằng mắt: không có `console.log(api_key)`; không `require` vòng (`api/openaiPassthrough.js` không require `api/server.js`).

---

## Phase 6 — Live test (tự restart server, test tới khi xong)

### 6.1 Quy trình chạy server
1. Kiểm tra cổng 8787 trống: gọi `GET http://localhost:8787/health`. **Nếu đã có proxy khác đang chạy** (có thể là bản của user) → **dừng và nhờ user tắt**; hai tiến trình dùng chung `data/state.json` sẽ ghi đè nhau.
2. Chạy proxy bằng mode mới (không sửa file config), log ra file tạm:
   - bash: `UPSTREAM_MODE=openai_compat node index.js > "$TMPDIR/gp.log" 2>&1 & echo $!`
   - PowerShell: `$env:UPSTREAM_MODE="openai_compat"; Start-Process node -ArgumentList "index.js" -RedirectStandardOutput "$env:TEMP\gp.log" -RedirectStandardError "$env:TEMP\gp.err" -PassThru`
   Ghi lại PID. Đọc log bằng **tool đọc file** (không `tail`).
3. Đợi log có `listening`, rồi `GET /health` = `{status:"ok"}` và `GET /admin/status` có `"upstream_mode":"openai_compat"`.
4. **Mỗi lần sửa code → kill đúng PID đó rồi chạy lại** (dùng SIGINT/`Stop-Process` để `flush()` state). Luôn kiểm tra `/admin/status` sau khi restart.
5. Khi xong: kill tiến trình, **không để server chạy nền**.
6. Nếu cần xem payload thô để debug: tạm đặt `LOG_LEVEL=debug`; không bao giờ in `Authorization`/`api_key`.

### 6.2 Script `scripts/live-test.js`
Node thuần (`fetch`), gọi `http://localhost:8787`, **tuần tự**, in bảng PASS/FAIL, thoát code ≠ 0 nếu có FAIL. Mỗi kịch bản dưới đây là một hàm; ghi ngân sách request ở cột cuối. Dùng prompt ngắn.

| ID | Kịch bản | PASS khi | Req |
|---|---|---|---|
| L0 | `GET /health`, `GET /v1/models`, `GET /admin/status` | 200; `upstream_mode==='openai_compat'` | 0 |
| L1 | POST chat non-stream (`model:"auto"`) | 200; `choices[0].message.content` là chuỗi không rỗng; `usage.total_tokens>0`; `model` trong response là tên model Gemini | 1 |
| L2 | POST chat stream (agent KHÔNG gửi `stream_options`) | 200; nhận ≥1 chunk có `delta.content`; **đúng 1** `[DONE]`; **không** có chunk `choices:[]`; `daily_count` của cặp tăng đúng 1 (so `/admin/status` trước/sau) | 1 |
| L2b | Như L2 nhưng agent gửi `stream_options:{include_usage:true}` | có chunk usage-only | 1 |
| L3 | Non-stream + tool `get_weather`, `tool_choice:"required"` | `finish_reason==='tool_calls'`; `tool_calls[0].function.name==='get_weather'`; `arguments` là JSON hợp lệ; **signature có mặt đúng theo Case đã chọn ở Phase 0** | 1 |
| L4 | Replay multi-turn: gửi `[user, assistant(tool_calls y nguyên L3), tool(result)]` | 200; có `content` cuối cùng | 1 |
| L5 | Replay như L4 nhưng **client mô phỏng làm rơi field lạ** (xoá mọi field ngoài `id/type/function` của tool_calls) | **Case A:** ghi nhận kết quả (200 hoặc 400) vào báo cáo; **Case B:** phải 200 (nhờ shim qua `callsig_` id — vì id vẫn được giữ) | 1 |
| L6 | Stream + tool `get_weather` bắt buộc | tool_call đầy đủ (name + arguments gom từ các delta, `index` hợp lệ); rồi replay như L4 với tool_call vừa gom → 200 | 2 |
| L7 | Non-stream với tool có schema "bẩn" (như spike S7) | 200, không 400 | 1 |
| L8a | Thiếu `messages` | 400 JSON kiểu OpenAI (`error.type==='invalid_request_error'`), không tốn upstream | 0 |
| L8b | Lỗi 400 từ Google (ví dụ role/field sai theo kết quả S9) | client nhận 400 JSON; **không cooldown** cặp, `daily_count` không tăng | 1 |
| L9 | Client ngắt giữa stream: mở stream rồi `destroy()` sau chunk đầu | sau ~1s `/admin/status` không còn inflight bất thường (gọi 1 request thường tiếp theo vẫn chạy, không bị kẹt); `daily_count` không tăng cho request bị huỷ | 2 |
| L10 | Fallback khi vượt RPM (CHỈ chạy nếu còn ngân sách): bắn 6 request non-stream liên tiếp trong <60s | tất cả 200 (RPM model 1 hết → sang key/model kế); log có dòng `Attempt` thể hiện đổi cặp hoặc `/admin/status` cho thấy phân bổ qua nhiều cặp | 6 |
| L11 | Tool-loop thực tế (nếu còn ngân sách): 3 vòng gọi tool liên tiếp bằng 1 conversation | mọi vòng 200, không 400 `thought_signature` | 3 |

Tổng ≤ 28 request. Nếu một kịch bản FAIL: **đọc log bằng tool đọc file → xác định nguyên nhân → sửa code → chạy unit test → restart server → chạy lại đúng kịch bản đó** (không chạy lại cả bộ nếu không cần, để tiết kiệm quota).

### 6.3 Bắt buộc ghi nhận khi test live
- Có xuất hiện 429 thật không; nếu có: `retryDelay` parse đúng không (xem log `cooldown Ns`), cooldown có hợp lý không (Q3).
- Có 503 thật không; nếu có: fallback không cooldown đúng không.
- Log WARN bất thường (field lạ, chunk không parse được…).

### 6.4 Điều kiện hoàn tất Phase 6
Mọi L-test PASS (L10/L11 được phép bỏ qua **chỉ khi** hết ngân sách quota — ghi rõ lý do). Sau đó:
1. Đổi mặc định `upstream_mode` thành `"openai_compat"` trong `config/loader.js` (giá trị default) và `config/config.json`.
2. Chạy lại unit test; sửa các test phụ thuộc mặc định cũ (ví dụ test dựng server với `config:{}` mà mong đợi hành vi `translate` → thêm `upstream_mode:'translate'` rõ ràng vào config của test đó). **Không xoá test nào.**
3. Restart server **không** có `UPSTREAM_MODE`, chạy lại nhanh L1, L2, L3, L4 để xác nhận mặc định mới hoạt động (≤ 5 request).
4. Tắt server.

---

## Phase 7 — Docs (bắt buộc cùng change, `AGENTS.md` §5)

Cập nhật **tất cả** mục dưới, nếu không thì phải nêu lý do "không cần" trong báo cáo:

- `README.md`: §Cấu hình thêm `upstream_mode` (`openai_compat` mặc định / `translate` legacy, env `UPSTREAM_MODE`); §Endpoint nêu rằng `/v1/chat/completions` hiện passthrough tới endpoint OpenAI-compat của Google; `/admin/status` có thêm `upstream_mode`; số test.
- `AGENTS.md`: §2 vẽ lại luồng 1 request (thêm nhánh `openai_compat`); §3 bảng contract: dòng *Gemini Client* (thêm `callOpenAI`, `callOpenAIStream`, `buildHttpError` hiểu body mảng), *Fallback* (rẽ nhánh `upstream_mode`), *API Layer* (`openaiPassthrough`), *Translate* (đánh dấu **legacy, chỉ dùng khi `upstream_mode=translate`**), *Config Loader* (`upstream_mode`, env `UPSTREAM_MODE`); thêm dòng cho `api/openaiPassthrough.js` (và `api/signatureShim.js` nếu Case B); §4 cập nhật **con số test**; §6.7 sửa mô tả streaming cho mode mới.
- `gemini-proxy-plan.md`: §2/§3/§4.3/§4.5 thêm mô tả mode mới; **ghi rõ lý do lệch spec** (dùng endpoint OpenAI-compat của Google để bỏ dịch format; nêu kết luận spike: Case A/B và các field bị xoá); §6 thêm `upstream_mode` vào mẫu config; §8 cập nhật số test và ngày.
- `docs/openai-compat-spike.md`: đã tạo ở Phase 0; bổ sung kết luận cuối.
- `.gitignore`: không cần đổi (không tạo file chứa secret). Kiểm tra bạn **không** commit log/PID/file tạm.

Checklist tự kiểm (đánh dấu từng dòng trong báo cáo):
- [x] README mô tả đúng endpoint/config/cách chạy — §Cấu hình (`upstream_mode` + env `UPSTREAM_MODE`), §Endpoint (`/v1/chat/completions`, `/admin/status`), §Test (106)
- [x] Bảng contract AGENTS §3 khớp signature thực tế — Config Loader / Fallback / Gemini Client / OpenAI Passthrough (dòng mới) / API Layer / Translate
- [x] Con số test kỳ vọng đúng — **106/106, 19 suite**
- [x] Lệch spec đã ghi lý do — `gemini-proxy-plan.md` §2/§3/§4.5/§6 + `AGENTS.md` §2
- [x] Đã chạy full test suite, kết quả có trong báo cáo

### Trạng thái thực hiện (ghi rõ deviation so với plan)

| Phase | Trạng thái | Lý do / ghi chú |
|---|---|---|
| 0 (spike) | ⏸ Chưa chạy | Cần `GEMINI_SPIKE_KEY` (plan §10 yêu cầu dừng hỏi user nếu thiếu). Hệ quả: `OPENAI_DROP_FIELDS` để **rỗng**, `api/signatureShim.js` **chưa tạo** (Case A/B/C chưa xác định) — chờ Phase 6 live. |
| 1–4 | ✅ Xong | Code + 36 unit test, default vẫn `translate`. |
| 5 | ✅ Xong | **106/106 pass**, 19 suite. |
| 6 (live) | ⏸ Chưa chạy | Cần ngân sách quota (≤ 28 request) + `UPSTREAM_MODE=openai_compat` restart server; điều kiện 6.4 (đổi default `openai_compat`) **chưa thực hiện**. |
| 7 (docs) | ✅ Xong | `README.md`, `AGENTS.md` §2/§3/§4, `gemini-proxy-plan.md` §2/§3/§6/§8, plan này. `docs/openai-compat-spike.md` chưa tạo vì Phase 0 chưa chạy. |

---

## 8. Tiêu chí chấp nhận (tổng)

1. `node --test tests/*.test.js` xanh toàn bộ; mọi test cũ còn nguyên (không bị xoá/làm yếu).
2. Live L0–L9 (và L10/L11 nếu đủ quota) PASS ở mode `openai_compat`.
3. Mặc định mới là `openai_compat`; `UPSTREAM_MODE=translate` vẫn chạy được hành vi cũ (rollback = đổi 1 giá trị, không cần revert code).
4. Native endpoint `/v1beta` hoạt động như cũ (test `geminiNative.test.js` xanh).
5. Không có API key nào trong log, trong file mới, hoặc trong báo cáo.
6. Docs đã cập nhật theo Phase 7.
7. `api/translate.js` **còn nguyên** (legacy).

## 9. Các bẫy đã biết (đọc để khỏi lặp lại lỗi cũ)

- **Body `Response` chỉ đọc được 1 lần.** Đọc `res.text()` rồi mới truyền `text` cho `buildHttpError`. Test phải dùng `Response` thật, không dùng object giả.
- **`Response.body` của undici chỉ có getter** — gán vào bị bỏ qua im lặng; luôn trả object mới `{ok,status,headers,body}`.
- **Stream response phải `res.end()`** ở mọi nhánh, nếu không client treo vô hạn.
- **`release()` mọi nhánh kết thúc**, chỉ đúng 1 lần (idempotent). `selectAndReserve` + `await` ở giữa là race (edge case #3) — không được gọi `selectPair` thuần rồi `await` trước `recordSuccess`.
- Stream bị ngắt/lỗi → **không** `recordSuccess`, **không** `[DONE]`.
- 5xx upstream được nhận diện bằng prefix message `Gemini error <status>:` — không đổi prefix này.
- Timeout/network của proxy (504/502 với message `Gemini request timeout…`/`Gemini network error…`) **trả ngay**, không fallback.
- Forward payload SSE **gốc**, đừng `JSON.parse` rồi `stringify` lại (đổi thứ tự khoá/escape, và mất field lạ không cần thiết).
- Gemini-native router dùng `GeminiError.body` để trả lỗi Google nguyên bản — khi sửa `buildHttpError` đảm bảo `.body` luôn là object.
- Không dùng `localhost:8787` song song với proxy thật của user (đụng `data/state.json`).

## 10. Khi nào PHẢI dừng và hỏi user

- Thiếu `GEMINI_SPIKE_KEY` ở Phase 0.
- Có tiến trình khác đang giữ cổng 8787.
- Quota còn lại không đủ ngân sách ở §2.3.
- Phase 0 kết luận **Case C**.
- Cần quyết định ngoài plan (dùng signature giả, xoá `translate.js`, đổi contract…).

## 11. Báo cáo cuối (bắt buộc, tiếng Việt, ngắn gọn)

1. Kết luận spike (Q1–Q7, Case đã chọn).
2. Danh sách file đã thêm/sửa.
3. Kết quả `npm test` (số pass/tổng).
4. Bảng PASS/FAIL L0–L11, số request upstream đã dùng.
5. Các WARN/lỗi đáng chú ý trong log live; 429/503 thật đã gặp (nếu có).
6. Checklist docs Phase 7.
7. Việc còn lại cho user (ví dụ: tự quyết xoá `api/translate.js` khi đã chạy ổn với OpenCode vài ngày).
