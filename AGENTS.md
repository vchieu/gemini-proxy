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
  → [upstream_mode=translate]     client/geminiClient.js → Google generateContent
  → [upstream_mode=openai_compat] client/geminiClient.js → Google /v1beta/openai/chat/completions
  → 429? client/errorParser.js → store.setCooldown → chọn cặp khác (loop)
  → 5xx upstream (500/502/503/504) hoặc timeout của proxy (504 "...timeout...")? → chọn cặp khác NGAY (KHÔNG cooldown, KHÔNG tính quota; phạt model 45s — xem §6.5)
  → thành công? store.recordSuccess → [translate] api/translate.js → trả OpenAI format
                                 ↘ [openai_compat] trả nguyên payload Google
```

Bản dịch format nằm ở `api/translate.js` (`openAiToGemini`, `geminiToOpenAi`,
`geminiChunkToOpenAiChunk`) — **chỉ dùng khi `upstream_mode=translate`**; chế độ
`openai_compat` forward body OpenAI gốc tới endpoint OpenAI-compat của Google
(`client/geminiClient.js` → `callOpenAI`/`callOpenAIStream`, stream qua
`api/openaiPassthrough.js`). Quota ngày reset theo **nửa đêm Pacific Time**
(`utils/time.js` → `nextMidnightPacific`), KHÔNG dùng giờ server.

## 3. Contract module (không được tự ý đổi)

| Module | File | Export chính / signature |
|---|---|---|
| Bootstrap | `index.js` | `main()` — load config → `StateStore` → `createServer` → `listen(settings.port, settings.host)` với **`host` mặc định `127.0.0.1`** (H2: proxy local không auth, không bind 0.0.0.0 để LAN không đốt được quota; muốn expose phải set `host` chủ động) (+ `server.on('error')`: port bị chiếm → log rõ + `exit(1)`, tránh instance 2 sống trùng gây EPERM khi 2 process cùng ghi state) |
| Config Loader | `config/loader.js` | `loadConfig(configDir) → { keys, models, settings }` with `settings.upstream_mode` ('translate' \| 'openai_compat'; **mặc định `openai_compat`**), `settings.host` (**mặc định `'127.0.0.1'`**, validate non-empty string), `settings.first_byte_timeout_ms` (**mặc định `20000`** — timeout đợi connect + header + chunk SSE đầu, validate `> 0`; lúc dùng bị kẹp bởi `request_timeout_ms`); validate against `VALID_UPSTREAM_MODES` (**được export**), `default_cooldown_seconds >= 0`; env `UPSTREAM_MODE` override |
| State Store | `state/store.js` | `class StateStore`: `get(k,m)`, `recordSuccess(k,m,tokens)`, `setCooldown(k,m,ts)`, `pruneOldEntries(st,now)`, `persist()` (atomic write tmp theo pid `state.json.<pid>.tmp` + rename; **retry đồng bộ 3 lần (sleep 50/150ms) khi Windows lock/EPERM + tối đa 1 retry an toàn sau 1s**; lược bỏ inflight — transient; constructor dọn tmp cũ lúc load), `reserve(k,m,est)`, `release(k,m,est)`, `resetDailyIfNeeded(k,m,now)`, `minCooldownRemaining(now)`, `snapshot()`, `flush()` (huỷ debounce + persist, dùng khi SIGINT/SIGTERM — nhờ retry trong `persist()` nên flush cũng bền khi file bị lock), **circuit breaker theo model — CHỈ RAM, KHÔNG persist**: `penalizeModel(model, ms, now?)` (đặt hạn phạt), `isModelPenalized(model, now?) → boolean` (entry hết hạn tự xoá), `clearModelPenalty(model)` (gọi khi model chạy tốt) |
| Cooldown | `state/cooldown.js` | `isAvailable(pairState, limits, nowMs, estimatedTokens) → boolean` (THUẦN, không mutate pairState; cộng `inflight_count`/`inflight_tokens` vào RPD/RPM/TPM — edge case #3). Reset daily_count gọi riêng qua `StateStore.resetDailyIfNeeded(k,m,now)` |
| Selector | `router/selector.js` | `selectPair(..., strategy?)` (thuần, không side-effect; `strategy: 'round_robin_key_then_model' \| 'priority_model_first'`) + `selectAndReserve(..., strategy?)` (select + `reserve` nguyên tử, caller BẮT BUỘC `release` mọi nhánh kết thúc) → `SelectedPair \| null` (+ `_resetRoundRobin()` chỉ dùng cho test) |
| Fallback | `router/fallbackLoop.js` | `handleRequest(agentRequest, deps, options?)` với `options.signal` optional (client ngắt → huỷ upstream, ném lỗi 499) → `Promise<{ openAiResponse, usedKeyId, usedModel, attempts }>`; `openStream(agentRequest, deps) → Promise<{ upstream, pair, estimated, release }>` (fallback 429/5xx ở giai đoạn mở stream, caller phải `release()`); `handleNativeRequest(requestedModel, geminiBody, deps, options?)` / `openNativeStream(requestedModel, geminiBody, deps)` — bản native cho Gemini passthrough (body Gemini gốc truyền qua `options.geminiBody`, không qua `openAiToGemini`); `class Aggregated429Error`; chính sách fallback: **429** → set cooldown qua `cooldownUntilFor429` (retryDelay tường minh; **quota theo NGÀY không retryDelay → cooldown tới `daily_reset_at` nửa đêm PT** — M3), **HTTP 5xx upstream (500/502/503/504)** → fallback ngay không cooldown (xem §6.5), **timeout của proxy (504 có chữ "timeout" — connect/first-byte/idle)** → fallback ngay không cooldown + **phạt model `MODEL_PENALTY_MS = 45000`** (xem §6.5), **499 (client aborted)** → log info + trả ngay (không fallback, không cooldown, không quota), lỗi khác (4xx, network 502) trả ngay; **circuit breaker theo model**: đầu request lọc các model đang bị phạt qua `stateStore.isModelPenalized` (loại cặp của nó khỏi `triedPairs` — **trừ khi MỌI model đều phạt** thì không loại model nào, tránh tự khóa), nhánh transient gọi `stateStore.penalizeModel`, thành công gọi `stateStore.clearModelPenalty`; khi `selectAndReserve` trả `null` mà còn cặp bị loại do phạt → gỡ các cặp đó ra và **thử lại đúng 1 lần**; `ctx` mang thêm `firstByteMs = min(config.first_byte_timeout_ms || 20000, request_timeout_ms)` truyền cho các hàm stream; **rẽ nhánh theo `config.upstream_mode`**: `translate` dùng `callGemini` + `openAiToGemini`/`geminiToOpenAi`, `openai_compat` dùng `callOpenAI`/`callOpenAIStream` passthrough tới Google endpoint `/v1beta/openai/` **(trước khi gửi: `signatureShim.requestToUpstream` dựng lại `extra_content` từ id `callsig_…`; sau khi nhận non-stream: `signatureShim.responseToClient`)** |
| Gemini Native | `api/geminiNative.js` | `createGeminiNativeRouter(deps) → express.Router`; mount tại `/v1beta` (xem `api/server.js`); `POST /models/:modelAction` (generateContent / streamGenerateContent), `GET /models` — **trả shape GOOGLE `{ models: [{ name: 'models/<id>', displayName, supportedGenerationMethods }] }`** (không phải `{object,data}` của OpenAI); **passthrough**: không dịch format, stream forward byte SSE nguyên bản + **`res.end()` bắt buộc khi stream xong** (thiếu → client treo vô hạn), không ghi `[DONE]`; lỗi trả theo format Google `{ error: { code, message, status } }` (giữ nguyên body Google nếu có); non-stream abort upstream khi client ngắt (signal qua `handleNativeRequest`) |
| Gemini Client | `client/geminiClient.js` | `callGemini(key, model, geminiBody, {timeoutMs?, signal?})`, `callGeminiStream(...)` trả **object mới** `{ ok, status, headers, body }` (không phải `Response` gốc, vì `Response.body` không gán được); idle timeout cover cả stream body; `signal` (optional) → client ngắt → abort fetch → `GeminiError` status **499** (phân biệt với timeout nhờ `options.signal.aborted`); `class Gemini429Error` (có `.rawMessage`, `.details`, `.retryDelaySeconds`), `class GeminiError`; lỗi HTTP dựng qua helper `buildHttpError(status, text)` — **body đọc đúng 1 lần ở caller** rồi truyền `text` (đọc lần 2 trên `Response` thật sẽ ném `TypeError`); 429 hoặc 403 có message khớp `QUOTA_RE = /quota|\brate[- _]?limit|resource[_ ]exhausted|retry in/i` (**M1: KHÔNG match裸 "rate"/"limit" — "generateContent" chứa "rate", 403 thật từng bị nhầm 429**) → `Gemini429Error` (kèm `retryDelaySeconds`), còn lại → `GeminiError("Gemini error <status>: ...")` (prefix để `isTransientUpstream` nhận diện 5xx); **`GeminiError.body` là JSON Google đã parse** (hoặc `undefined` nếu không phải JSON object — không bọc giả `{ error: { message } }`), nên `sendGeminiError` ở native router trả đúng format Google; **thêm `callOpenAI(key, model, openAiBody, {timeoutMs?, signal?})` và `callOpenAIStream(key, model, openAiBody, {timeoutMs?, firstByteMs?})` để gọi endpoint OpenAI-compat `/v1beta/openai/`**; sửa `buildHttpError` hiểu body JSON mảng `[{error:{...}}]` → bóc phần tử đầu làm parsed; **2 hàm stream dùng chung helper nội bộ `fetchSse(doFetch, timeoutMs, firstByteMs?)`** (`firstByteMs` mặc định `= timeoutMs`: timer phủ connect + header + **chunk SSE đầu**; **đọc sẵn chunk đầu TRƯỚC khi trả về** → upstream treo trước byte đầu ném `GeminiError 504 "Gemini stream first-byte timeout after Xms"` ngay khi `openStream` chưa trả pair (còn kịp fallback); sau chunk đầu chuyển sang idle timeout `timeoutMs` reset mỗi chunk; đọc body lỗi nằm dưới timer first-byte; **bắt lỗi in-band ở CHUNK ĐẦU** — helper nội bộ `inbandErrorFromChunk(value)` bóc event `data:` đầu tiên của chunk vừa đọc sẵn, nếu là JSON `{error:{code}}` hoặc `[{error:{...}}]` thì ném `buildHttpError(status, text)` ngay TRƯỚC khi trả stream (`openStream` chưa trả pair → 503/5xx fallback, 429 cooldown; trước đây bị forward mid-stream → client nhận lỗi giữa chừng, không ai fallback); status lấy `error.code` nếu là số trong dải 4xx–5xx, không thì suy từ message khớp `QUOTA_RE` (→ 429), còn lại mặc định 503; lỗi ở chunk SAU chunk đầu vẫn forward nguyên (mid-stream — xử lý ở router); wrap `ReadableStream` mới vì `Response.body` của undici chỉ có getter; **mọi timeout 504 đều chứa chữ "timeout"** → `fallbackLoop.isTransientUpstream` coi là tạm thời) — URL là hằng `OPENAI_COMPAT_URL` (cùng 1 endpoint cho stream/non-stream, phân biệt qua field `stream` trong body), `OPENAI_DROP_FIELDS` (mặc định rỗng) |
| Error Parser | `client/errorParser.js` | `extractRetryDelaySeconds(body) → number` (giây; fallback `DEFAULT_COOLDOWN_SECONDS = 30`); `findExplicitRetryDelaySeconds(body) → number\|null` (chỉ trả khi Google gửi tường minh, KHÔNG fallback); `mentionsDailyQuota(bodyLike) → boolean` (message/details nhắc "per day"/"PerDay"); `cooldownUntilFor429(bodyLike, { defaultCooldownSeconds?, dailyResetAt?, nowMs?, retryDelaySecondsHint? }) → epoch ms` — **helper dùng chung cho mọi nhánh set cooldown 429 (fallbackLoop + in-band mid-stream), thực thi M3** |
| OpenAI Passthrough | `api/openaiPassthrough.js` (mới) | `streamOpenAiPassthrough({ req, res, handle, agentRequest, deps, sendError, errorToOpenAi })` — stream SSE ở mức event cho `upstream_mode=openai_compat`: gom event `data:` đúng spec, forward payload **gốc** (không parse→stringify lại), lọc chunk usage-only `choices:[]` khi agent không xin `stream_options.include_usage`, tự ghi `[DONE]` nếu upstream thiếu; **decode UTF-8 bằng 1 `TextDecoder` dùng chung cho cả stream (`.decode(value, {stream:true})` + flush cuối loop — H1: decode từng chunk network riêng lẻ sẽ hỏng ký tự đa-byte bị cắt giữa chunk)**; **in-band 429 mid-stream → `stateStore.setCooldown` qua `cooldownUntilFor429` (M2/M3)**; mọi nhánh `release()` đúng 1 lần + **`reader.cancel()` trong finally** (M6: nhánh in-band error từng break mà không cancel → kết nối upstream treo tới idle timeout) + luôn `res.end()` (thiếu → client treo); client ngắt → `reader.cancel()`, không `recordSuccess`, không `[DONE]`; không `require` `api/server.js` (tránh vòng — `sendError`/`errorToOpenAi` truyền qua tham số) |
| API Layer | `api/server.js` | `createServer({ models, keys, stateStore, config, geminiClient? }) → Express app`; streaming (translate): **defer chunk** khi `tool_calls` chưa có thoughtSignature — giữ chunk tới khi sig về (part/chunk sau) mới ghi ra client, xả trễ nhất ở cuối stream (kèm WARN chi tiết + dump raw payload các chunk liên quan nếu sig không bao giờ đến — xem plan §4.5); SSE parsing đúng spec (gộp multi-line `data:`, event kết thúc tại dòng trống); **decode UTF-8 bằng `TextDecoder` stream (H1)**; **in-band 429 mid-stream → set cooldown (M2)**; **`reader.cancel()` trong finally (M6)**; **mount router Gemini-native tại `/v1beta`**, route `POST /v1beta/models/:modelAction`, `GET /v1beta/models`; che `key=` trong access log; **non-stream: `AbortController` + `res.on('close')` → abort upstream khi client ngắt (lỗi 499 không gửi client)**; **rẽ nhánh `upstream_mode`**: `translate` dùng `handleRequest` + `openAiToGemini`/`geminiToOpenAi`, `openai_compat` dùng `streamOpenAiPassthrough` gửi body nguyên bản tới `/v1beta/openai/` endpoint (stream) + `handleRequest` trả `signatureShim.responseToClient` (non-stream); `/admin/status` trả `upstream_mode` (default `openai_compat`) |
| OpenAI Signature Shim | `api/signatureShim.js` | `responseToClient(openAiResponse)`, `requestToUpstream(agentRequest)`, `chunkToClient(chunk, state) → { chunk, changed, unshimmed, late }`, `readThoughtSignature(tc)`; **CHỈ dùng cho `upstream_mode=openai_compat` (Case B)** — round-trip thoughtSignature giữa `tool_calls[].extra_content.google.thought_signature` (shape Google) và `tool_calls[].id` dạng `callsig_…` (shape OpenAI sạch, client không echo field lạ); dùng `makeToolCallId`/`parseToolCallId` của **`utils/toolCallId.js`** (KHÔNG `require` `api/translate.js` — tránh phụ thuộc vòng trong `api/`); mutate tại chỗ rồi trả về; `chunkToClient` chỉ trả `changed:true` khi thật sự đổi gì đó (caller giữ payload gốc nếu không); trả `unshimmed:true` khi không gắn được sig và `late:true` khi sig đến **sau** khi id đã gửi cho client → caller WARN cả 2; **điền `index` vào delta `tool_calls` khi Google không gửi** (L6 `sawIndex=false`; OpenAI spec bắt buộc, client nghiêm ngặt đã từng làm hỏng nhánh `translate` vì thiếu field này); `state` do caller giữ theo từng request gồm `names`, `indexById`, `emitted`, `emittedWithSig`, `nextIndex`, `lastIndex` (caller truyền `{}` cũng được, khởi tạo tại chỗ) |
| Translate | `api/translate.js` | `openAiToGemini(oaiBody)`, `geminiToOpenAi(gemBody, modelName?)`, `geminiChunkToOpenAiChunk(chunk, model, streamId, created, toolCallIndexOffset?)`; hỗ trợ tool/function-calling: `tools` → `functionDeclarations`, `tool_choice` → `toolConfig`, `tool_calls` → `functionCall`, `role: "tool"` → `functionResponse`; **sanitize** `parameters` bằng whitelist Gemini `Schema` (bỏ `additionalProperties`, `exclusiveMinimum`, `$schema`, `$defs`, `$ref`... ; `oneOf` → `anyOf`; giữ nguyên giá trị `example`/`default` — xem plan §4.5); **thoughtSignature roundtrip**: `functionCall` có `thoughtSignature` (bắt buộc replay với Gemini 3) được nhúng vào `tool_call_id` dạng `callsig_<name>_<rand>_<sig>` khi trả response và gắn lại thành field sibling của `functionCall` part khi build history; sig có thể nằm ở **part RIÊNG** (không cùng part với functionCall) → `extractToolCalls` gom pool rồi gán theo thứ tự; export thêm `attachThoughtSignature(id, sig)` để gán sig muộn cho id đã phát ra (dùng khi streaming cross-chunk — xem plan §4.5); **re-export** `makeToolCallId(name, sig)` và `parseToolCallId(id)` (định nghĩa gốc ở `utils/toolCallId.js`) để giữ contract cũ của module; `tool_call_id` nhúng tên function (FIFO fallback — đúng với parallel tool_calls); streaming `tool_calls` có `index` tăng dần giữa các chunk; **chế độ legacy (`upstream_mode=translate`) chuyển OpenAI format sang Gemini native và ngược lại; khi `upstream_mode=openai_compat` bộ dịch này được bỏ qua, request forwarded trực tiếp đến Google endpoint `/v1beta/openai/`** |
| Tool Call Id | `utils/toolCallId.js` | `makeToolCallId(name, thoughtSignature?)`, `parseToolCallId(id) → { name?, thoughtSignature?, rand? }` — **nơi định nghĩa DUY NHẤT format id** `callsig_<encName>_<rand>_<sig>` / `call_<encName>_<rand>`; `encName` encode để không còn `_` (parse tách từ trái chắc chắn); dùng chung bởi `api/translate.js` (re-export) và `api/signatureShim.js`; đứng riêng ở `utils/` để shim không phải `require` `api/translate.js` |
| Token estimate | `utils/tokenEstimate.js` | `estimateTokens(messages) → number` (heuristic chars/4 + 4 token overhead/message; body OpenAI `{messages, tools}` tính thêm JSON `tools`, mảng messages tính thêm JSON `tool_calls` từng message — L2) |
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
4. Chạy lại **toàn bộ** test suite sau khi sửa. Mọi test phải pass (`170/170` tại thời điểm test xong — gồm 70 test gốc + 36 test cho `upstream_mode=openai_compat` + 12 test `signatureShim` + 6 test bổ sung sau review + 7 test regression cho H1, H2, M2, M3, L3 + 2 test regression cho L2 (tools/tool_calls được tính vào estimate) + 4 test regression cho persist EPERM (retry, self-heal, dọn tmp, safety-net) + 17 test cho review round 2: 3 test `QUOTA_RE` M1 (403 GenerateContent không nhầm 429), 2 test H1 UTF-8 split (passthrough/translate), 1 test H1 native usage parse, 2 test M3 daily-quota cooldown, 4 test `host`/export loader (H2), 3 test abort-on-disconnect (Low), 1 test native models shape + 10 test cho timeout byte đầu & circuit breaker: 1 test timeout 504 giờ fallback (thay test cũ khóa "trả ngay"), 1 test mọi model timeout trả 504 gốc, 3 test circuit breaker trong `selectorFallback` (request sau bỏ qua model phạt / phạt tất cả model không tự khóa / hết hạn phạt), 2 test `geminiStream` (first-byte timeout, idle timeout sau chunk đầu), 1 test `openaiClient` truyền `firstByteMs`, 3 test `configLoader` `first_byte_timeout_ms` + 6 test cho in-band error ở chunk đầu: 4 test `geminiStream` (503/429/mảng `[{error}]` ném lỗi trước khi trả stream, error SAU chunk đầu vẫn forward) và 2 test `selectorFallback` integration (503 in-band → fallback + phạt model, 429 in-band → cooldown cặp)) ...
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
5. Lỗi non-429 **khác 5xx và timeout** (4xx, network của proxy) → trả lỗi ngay, không tính quota, không set cooldown.
   **Ngoại lệ (lệch plan §5.5 — lý do ở `gemini-proxy-plan.md` §5.5):** upstream trả
   **HTTP 500/502/503/504** (503 "high demand" xảy ra thường xuyên với free tier) thì
   `withFallback` fallback sang cặp khác **ngay**, bỏ qua toàn bộ key của model đó trong
   request hiện tại, **không** set cooldown, **không** tính quota; hết cặp còn 5xx thì trả
   lỗi 5xx gốc (không phải 429). Phân biệt bằng prefix message `Gemini error <status>:`
   (chỉ sinh ra khi Google trả `!res.ok`).
   **Ngoại lệ 2 (timeout cũng là tạm thời — "model treo", sửa sau khi xem log):** mọi
   `GeminiError` **504 có chữ "timeout"** (`Gemini request timeout...`,
   `Gemini stream first-byte timeout...`, `Gemini stream idle timeout...`) cũng fallback
   ngay như 5xx. Trước đây timeout bị "trả ngay" → request chết sau `request_timeout_ms`
   rồi agent retry và lại chọn đúng model đang treo (mỗi request mới đều bắt đầu từ model
   ưu tiên cao nhất, không có trí nhớ). Kèm **circuit breaker theo model** (RAM-only):
   model vừa 5xx/timeout bị `stateStore.penalizeModel(model, 45000)` → các request kế
   tiếp bỏ qua nó, call thành công thì `clearModelPenalty`. Chỉ `Gemini network error...`
   (502) và 4xx VẪN trả ngay như cũ.
   **Ngoại lệ 3 (Low — abort khi client ngắt):** non-stream có `options.signal` nối từ
   `res.on('close')` → client ngắt giữa chừng → abort fetch → `GeminiError` **499** →
   trả ngay, log INFO (không log error), không fallback, không cooldown, không quota.
6. `respect_agent_model=true` mới tôn trọng model agent gửi; mặc định `false` (proxy tự chọn, `model: "auto"`).
7. Streaming: kiểm tra limit **trước** khi mở stream; fallback 429 được thực hiện trước khi gửi byte đầu; 429 giữa stream thì đóng stream kèm lỗi + **set cooldown cho cặp (M2 — helper `cooldownUntilFor429`, quota theo ngày → `daily_reset_at` — M3)**, không retry ngầm. Stream bị interrupt (lỗi network, client disconnect) thì KHÔNG recordSuccess và KHÔNG ghi `[DONE]` — chỉ record khi stream hoàn tất nguyên vẹn. Timeout cover cả stream body (idle timeout), không chỉ lúc kết nối ban đầu. **Không thấy chunk SSE đầu trong `first_byte_timeout_ms` (mặc định 20000ms, kẹp bởi `request_timeout_ms`) → `fetchSse` ném 504 ngay TRƯỚC khi `openStream` trả pair → vẫn kịp fallback sang model khác (xem mục 5).** **Chunk đầu là JSON lỗi in-band (upstream mở 200 rồi gửi `data: {"error":{"code":503/429,...}}` ngay — "high demand" xảy ra thật trong log) → `fetchSse` ném `buildHttpError` ngay TRƯỚC khi trả stream: 503 vào nhánh transient (fallback + phạt model 45s), 429 vào nhánh cooldown; lỗi ở chunk SAU chunk đầu vẫn forward nguyên (mid-stream — xử lý ở router như cũ).** **Decode UTF-8 bắt buộc qua 1 `TextDecoder` dùng chung cho cả stream (H1 — decode từng chunk network sẽ hỏng ký tự đa-byte bị cắt giữa chunk); mọi nhánh kết thúc `reader.cancel()` (M6 — kể cả sau in-band error).**
   **Theo `upstream_mode`:** `translate` → `api/server.js` tự ghi `[DONE]` và **defer chunk** khi `tool_calls` thiếu thoughtSignature; `openai_compat` → `api/openaiPassthrough.js` gom event SSE, forward payload gốc, lọc chunk usage-only, tự ghi `[DONE]` nếu upstream thiếu, và mọi nhánh đều `release()` đúng 1 lần + `res.end()` (thiếu → client treo). KHÔNG defer thoughtSignature ở chế độ này.

## 7. Cấm kỵ

- ⛔ **KHÔNG đọc file `config/keys.json`** (dùng `read`/`grep`/`cat`/shell đều không).
  File này chứa API key thật, nằm ngoài git. Mọi thao tác với schema key phải
  dựa vào `config/keys.example.json` (placeholder). Không `git add` để đưa nó
  quay lại index.
- Không hardcode API key, không log nguyên `api_key` (chỉ log `key.id`).
- Không `require` vòng tròn giữa `api/` ↔ `router/` ↔ `client/` (luồng phụ thuộc một chiều như §2).
- Không sửa `config/*.json` mẫu thành key thật để "test cho tiện".
- Không dùng `tail`, `ls -la`, `cat` qua shell khi đã có tool đọc file chuyên dụng.
