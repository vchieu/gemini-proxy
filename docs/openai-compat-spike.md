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

**Đáp án: chưa phát hiện field nào bị từ chối.** Toàn bộ body OpenAI gửi thẳng từ agent
được chấp nhận → `OPENAI_DROP_FIELDS` giữ **rỗng** trong `client/geminiClient.js`.

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

| # | Quan sát | Hệ quả |
|---|---|---|
| 1 | Stream delta `tool_calls` **không có field `index`** | Client OpenAI nghiêm ngặt có thể hỏng. `openai_compat` forward payload gốc nên proxy không tự thêm (khác nhánh `translate`). Nếu cần phải thêm, cần đổi chủ đích. |
| 2 | `usage` nằm trên chunk có `choices` | Xem Q5 — không ảnh hưởng quota. |
| 3 | 503 "high demand" xảy ra thường xuyên với free tier | Đã là lý do plan có nhánh 5xx fallback. |

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
