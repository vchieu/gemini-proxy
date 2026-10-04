# Local Gemini Multi-Key/Model Rotating Proxy

Proxy HTTP chạy local, đứng giữa AI agent (Cline, OpenCode, ...) và Gemini API.
Tự xoay tua cặp `(API key, model)` khi gặp 429, agent không cần biết.

> **Dành cho AI agent / contributor:** đọc `AGENTS.md` trước khi sửa code.
> Mọi thay đổi source làm docs lạc hậu thì **bắt buộc update docs trong cùng change**
> (rule chi tiết tại `AGENTS.md` §5).

## Chạy

1. Tạo file key từ mẫu rồi điền API key thật vào (file này nằm ngoài git, không bị commit):

```bash
cp config/keys.example.json config/keys.json   # Windows PowerShell: Copy-Item config/keys.example.json config/keys.json
```

2. Cài đặt & chạy:

```bash
npm install
npm start
```

3. Trỏ agent tới OpenAI-compatible endpoint:

- Base URL: `http://localhost:8787/v1`
- API key: bất kỳ (proxy bỏ qua, dùng key thật phía sau)
- Model: `auto` (proxy tự chọn model theo priority + quota), hoặc tên model cụ thể trong `config/models.json`.

## Endpoint

| Method | Path | Mô tả |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat (hỗ trợ `stream: true` SSE, tool/function-calling: `tools`, `tool_choice`, `tool_calls`). Khi `upstream_mode=openai_compat`: body được forward nguyên bản (chỉ đổi `model`) tới endpoint OpenAI-compat của Google, không qua `api/translate.js` |
| POST | `/v1beta/models/:modelAction` | **Gemini-native**: truyền body thô lên Gemini, chọn cặp `(key, model)`, fallback 429/5xx. `:modelAction` là `modelName:action` (ví dụ `gemini-2.5-flash:generateContent`). Hỗ trợ `generateContent` và `streamGenerateContent`. |
| GET | `/v1beta/models` | Danh sách model dạng Google (`name`, `displayName`, `supportedGenerationMethods`) |
| GET | `/v1/models` | Danh sách model đang cấu hình |
| GET | `/admin/status` | Debug: quota đã dùng / còn lại từng cặp (key, model) + `upstream_mode` đang chạy |
| GET | `/health` | Health check |

### Gemini-native

- Không dịch format request/response (truyền body thô, trả response gốc Gemini).
- Forward byte SSE gốc, **không ghi `[DONE]`**.
- Chỉ hỗ trợ `generateContent` và `streamGenerateContent`.
- `respect_agent_model: true` để dùng model trên URL; mặc định `false` (proxy tự xoay model).
- Auth: bỏ qua `x-goog-api-key` và `?key=` từ client, chỉ dùng key thật từ config.

### openai_compat (`upstream_mode` mặc định)

- Body OpenAI của agent được forward **nguyên bản** (chỉ đổi `model` theo cặp proxy đã chọn)
  tới `POST /v1beta/openai/chat/completions` của Google, auth `Authorization: Bearer <key>`.
- **thoughtSignature roundtrip:** Google trả signature tại
  `tool_calls[].extra_content.google.thought_signature`. Agent OpenAI chuẩn KHÔNG echo field
  lạ này → khi replay history sẽ bị 400. Proxy nhúng sig vào `tool_call_id` dạng
  `callsig_<name>_<rand>_<sig>` khi trả client và dựng lại `extra_content` khi nhận history
  (`api/signatureShim.js`). Agent không cần biết điều này.
- Stream: gom event SSE ở mức event, forward payload gốc, tự ghi `[DONE]` nếu upstream thiếu.
- Chi tiết bằng chứng live test: [`docs/openai-compat-spike.md`](docs/openai-compat-spike.md).

### Legacy (`upstream_mode=translate`)

- Dịch format OpenAI ↔ Gemini native qua `api/translate.js` rồi gọi `generateContent`.
- Streaming do `api/server.js` xử lý, có **defer chunk** khi `tool_calls` thiếu thoughtSignature.

## Cấu hình

- `config/keys.json` — danh sách key (`id`, `api_key`, `enabled`). **Không nằm trong git** (đã `.gitignore`); tạo từ mẫu `config/keys.example.json`.
- `config/models.json` — danh sách model (`name`, `priority` càng nhỏ càng ưu tiên, `limits: {rpm, rpd, tpm}`).
- `config/config.json` — `port`, `strategy` (`round_robin_key_then_model` mặc định, hoặc `priority_model_first`), `state_file`, `log_level`, `request_timeout_ms`, `max_fallback_attempts`, `respect_agent_model`, `default_cooldown_seconds`, `upstream_mode` (**`openai_compat` mặc định** — passthrough body OpenAI gốc tới endpoint OpenAI-compat của Google `/v1beta/openai/chat/completions`, bỏ qua `api/translate.js`; `translate` — legacy, dịch format OpenAI ↔ Gemini native). Override bằng biến môi trường `UPSTREAM_MODE` (ưu tiên hơn config file).

Quota reset ngày tính theo **nửa đêm Pacific Time** (theo Gemini free-tier).

## Test

```bash
npm test
```

**124/124 test pass** (20 suite) — gồm 36 test cho nhánh `upstream_mode=openai_compat`
(`tests/configLoader.test.js`, `tests/openaiClient.test.js`, `tests/openaiFallback.test.js`,
`tests/openaiStreaming.test.js`) và 12 test `tests/signatureShim.test.js`.

## Tài liệu khác

- [`AGENTS.md`](AGENTS.md) — contract module, quy trình làm việc bắt buộc cho contributor/agent.
- [`gemini-proxy-plan.md`](gemini-proxy-plan.md) — spec gốc (thuật toán chọn cặp, cooldown, edge cases).
- [`PLAN-openai-compat-migration.md`](PLAN-openai-compat-migration.md) — kế hoạch chuyển sang endpoint OpenAI-compat + trạng thái thực hiện.
- [`docs/openai-compat-spike.md`](docs/openai-compat-spike.md) — bằng chứng live test Q1–Q7 (thoughtSignature, error shape, 5xx).