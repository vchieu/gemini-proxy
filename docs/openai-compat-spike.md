# Kết quả spike — endpoint OpenAI-compat của Google (Q1–Q7)

> **Nguồn dữ liệu:** các câu trả lời dưới đây thu được trong **Phase 6 live test**
> (`scripts/live-test.js`, 2026-10-04), **không phải** từ `scripts/spike-openai-compat.js`
> — script spike riêng của Phase 0 không được tạo vì không có `GEMINI_SPIKE_KEY`.
> Xem deviation tại `PLAN-openai-compat-migration.md` §Trạng thái thực hiện.
>
> Model test: `gemini-3.8-flash` (fallback sang `gemini-3.7-flash` khi 503).
> Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`.
> Ngân sách dùng: **28 request thành công** (tổng task ≤ 40 theo plan §2.3).

## Kết luận ngắn

**Phân loại = Case B** → phải có `api/signatureShim.js`. Đã tạo và xác minh live:
trước shim `L5` = **400**, sau shim `L5` = **200**.

---

## Q1 — thoughtSignature nằm ở đâu?

**Đáp án: `message.tool_calls[0].extra_content.google.thought_signature`** (532 ký tự
trong lần test đầu). Câu trả lời đúng với shape plan đã gợi ý.

- Nằm **cùng object** với tool_call (không phải part riêng như nhánh `translate`).
- `extra_content` là field **không thuộc OpenAI spec** — client OpenAI chuẩn không nhận diện.

```jsonc
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" },
        "extra_content": { "google": { "thought_signature": "<532 chars>" } }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

## Q2 — Client có làm rơi `extra_content` không → có bị 400 không?

**Đáp án: CÓ.** Test `L5` gửi lại history với `tool_calls` chỉ giữ `id/type/function`
(mô phỏng OpenAI client chuẩn) → Google trả **400**:

```
Function call is missing a thought_signature...
```

→ **Case B**: bắt buộc round-trip signature qua kênh mà client **có** echo lại, tức là
`tool_call_id`. Chi tiết xử lý: `api/signatureShim.js`.

## Q3 — Shape lỗi của Google

**Đáp án: body là MẢNG** `[{ "error": { "code", "message", "status" } }]`, không phải
object đơn. Quan sát được ở cả 400 lẫn 503:

```jsonc
[{ "error": { "code": 503, "message": "This model is currently experiencing high demand...",
              "status": "UNAVAILABLE" } }]
```

→ `buildHttpError` trong `client/geminiClient.js` đã được sửa để unwrap mảng này
(nếu không, `extractRetryDelaySeconds` sẽ không đọc được `retryDelay` của 429).

## Q4 — Endpoint có chấp nhận JSON Schema "bẩn" không?

**Đáp án: chấp nhận.** Test `L7` gửi schema chứa `$schema`, `additionalProperties`,
`examples`, `default`, `exclusiveMinimum`, `oneOf` → **200**.

*Giới hạn:* chỉ kiểm tra status, chưa xác minh model có thật sự gọi tool với schema đó
hay không. → `OPENAI_DROP_FIELDS` để rỗng, **không** cần sanitize schema khi
`upstream_mode=openai_compat`.

## Q5 — Stream có tách chunk usage-only (`choices: []`) không?

**Đáp án: KHÔNG.** Kể cả khi gửi `stream_options: { include_usage: true }`, upstream
gắn `usage` vào **chunk đang có `choices`** (`usageOnNormalChunk=2`, `usageOnlyChunk=0`).

→ Bộ lọc usage-only trong `api/openaiPassthrough.js` **không kích hoạt** với upstream này
(hiệu lực với upstream khác nếu Google đổi hành vi). Quota vẫn ghi đúng vì
`totalTokens` được đọc từ `usage.total_tokens` ở **bất kỳ** chunk nào.

## Q6 — Field nào bị endpoint từ chối (`OPENAI_DROP_FIELDS`)?

**Đáp án: chưa phát hiện field nào bị từ chối — nhưng mẫu test CÒN HẸP.**
Toàn bộ body OpenAI gửi thẳng từ agent trong các test L0–L11 được chấp nhận →
`OPENAI_DROP_FIELDS` giữ **rỗng** trong `client/geminiClient.js`.

**Giới hạn của kết luận này (đọc trước khi tin):**
- Phase 0 spike riêng (S9) **không được chạy** (thiếu `GEMINI_SPIKE_KEY`), nên chưa có
  test chủ đích từng field.
- `scripts/live-test.js` chỉ gửi các field cơ bản (`messages`, `tools`, `tool_choice`,
  `stream`, `stream_options`, `temperature`…). Chưa thử `parallel_tool_calls`, `store`,
  `reasoning_effort`, `max_completion_tokens`, `n`, `logprobs`, `response_format`…
- Quan sát gián tiếp: OpenCode thật đang chạy qua proxy này và **chưa** bị 400 do field lạ.

**Hành động nếu gặp 400 `unknown field` / `not supported`:** thêm đúng tên field vào
`OPENAI_DROP_FIELDS` (client/geminiClient.js) rồi chạy lại test — không cần đổi chỗ khác.

## Q7 — 5xx có xảy ra thật không, fallback có đúng không?

**Đáp án: CÓ, và fallback đúng.** Ghi nhận **5 lần** 503 thật:

```
Gemini error 503: This model is currently experiencing high demand.
                  Spikes in demand are usually temporary. Please try again later.
```

Hành vi quan sát được: **fallback sang cặp khác NGAY, KHÔNG set cooldown, KHÔNG tính
quota** — đúng thiết kế `isTransientUpstream` trong `router/fallbackLoop.js`.

Ngoài ra còn thấy:
- **400 propagates** về client kèm body Google, **không** set cooldown (`L8b`).
- **60s timeout** trên `gemini-3.7-flash` khi `tool_choice: "required"` → proxy trả
  **504** (`Gemini request timeout...`), fallback tiếp theo attempt. Đây là lỗi
  timeout của proxy, **không** đi nhánh `isTransientUpstream` — đúng như design.

## Quan sát thêm (ngoài plan Q1–Q7)

| # | Quan sát | Hệ quả / cách xử lý |
|---|---|---|
| 1 | Stream delta `tool_calls` **không có field `index`** | OpenAI spec bắt buộc field này; client OpenAI nghiêm ngặt từng làm hỏng nhánh `translate` vì thiếu. **Đã xử lý:** `api/signatureShim.js` → `chunkToClient` điền `index` vào mọi delta `tool_calls` khi Google không gửi (không ghi đè nếu upstream đã gửi), giữ index ổn định giữa các delta qua `indexById` / `nextIndex` / `lastIndex`. Test: `tests/openaiStreaming.test.js` (Case B stream) + `tests/signatureShim.test.js`. |
| 2 | Signature có thể đến **sau** delta đã chứa `id` | L6 chỉ pass vì sig đi cùng delta với id. Nếu id đã gửi trước, client giữ id cũ → replay 400. **Đã xử lý (phát hiện):** cờ `late` của `chunkToClient` + WARN ở `openaiPassthrough`. Chưa có giải pháp sửa gốc (muốn sửa thì phải defer chunk như nhánh `translate` — nếu gặp WARN này ngoài thực tế thì mới làm). |
| 3 | `usage` nằm trên chunk có `choices` | Xem Q5 — không ảnh hưởng quota. |
| 4 | 503 "high demand" xảy ra thường xuyên với free tier | Đã là lý do plan có nhánh 5xx fallback. |
| 5 | ~~**CHƯA XÁC MINH (M4):** sig minted bởi model/key A có được model/key B accept khi replay history không?~~ | ✅ **ĐÃ XÁC MINH LIVE 2026-10-09 (không phải vấn đề):** mint tool_call `tool_choice:required` trên `gemini-3.7-flash` (key-1) → id `callsig_…` (sig ~500+ chars), replay history `[user, assistant(tool_calls), tool(result)]` sang `gemini-3.6-flash` (key-2) — **cả model lẫn key đều khác** → **HTTP 200**, content trả về đúng ("The current weather in Paris is 21°C"). Kết luận: Google KHÔNG bind signature theo model/key (ít nhất trong cùng project) → proxy xoay cặp rồi replay `callsig_…` là an toàn. Lưu ý phụ: presence of sig KHÔNG ổn định — cùng `tool_choice:required`, run live-test `L3` không nhận sig nào (id `call_…`) mà replay vẫn 200 (L4/L5/L11), run riêng có sig. |

---

## Bảng kết quả live test

| ID | req | Kết quả | Ghi chú |
|---|---|---|---|
| L0 | 0 | PASS | `/health`, `/v1/models`, `/admin/status` → `upstream_mode` đúng |
| L1 | 1 | PASS | non-stream 200, `usage.total_tokens` > 0, model là Gemini |
| L2 | 1 | PASS | stream, đúng 1 `[DONE]`, không có usage-only chunk |
| L2b | 1 | PASS (sau khi sửa kỳ vọng) | **Q5**: usage nằm trên chunk có `choices` |
| L3 | 1 | PASS | `finish_reason=tool_calls`, **Q1/Q2** quan sát được |
| L4 | 1 | PASS | replay `[user, assistant(tool_calls), tool]` → 200 |
| L5 | 1 | **FAIL 400 → PASS 200** | **Case B**: 400 trước shim, 200 sau shim |
| L6 | 2 | **FAIL 400 → PASS 200** | stream + gom delta + replay |
| L7 | 1 | PASS | **Q4**: schema bẩn được chấp nhận |
| L8a | 0 | PASS | thiếu `messages` → 400 `invalid_request_error` (local) |
| L8b | 1 | PASS | **Q3**: 400 Google propagates, không cooldown |
| L9 | 2 | PASS | client ngắt giữa stream → không `recordSuccess`, `release()`, `reader.cancel()` |
| L10 | 6 | PASS | vượt RPM → fallback, xoay ≥ 2 model, mọi request vẫn 200 |
| L11 | 3 | PASS | tool-loop 3 vòng liên tiếp |

Chạy lại sau khi flip default (`config/upstream_mode = openai_compat`, **không** env):
`L0`, `L1`, `L2`, `L3`, `L4` → **5/5 PASS**.
