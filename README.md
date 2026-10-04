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
| POST | `/v1/chat/completions` | OpenAI-compatible chat (hỗ trợ `stream: true` SSE, tool/function-calling: `tools`, `tool_choice`, `tool_calls`) |
| POST | `/v1beta/models/:modelAction` | **Gemini-native**: truyền body thô lên Gemini, chọn cặp `(key, model)`, fallback 429/5xx. `:modelAction` là `modelName:action` (ví dụ `gemini-2.5-flash:generateContent`). Hỗ trợ `generateContent` và `streamGenerateContent`. |
| GET | `/v1beta/models` | Danh sách model dạng Google (`name`, `displayName`, `supportedGenerationMethods`) |
| GET | `/v1/models` | Danh sách model đang cấu hình |
| GET | `/admin/status` | Debug: quota đã dùng / còn lại từng cặp (key, model) |
| GET | `/health` | Health check |

### Gemini-native

- Không dịch format request/response (truyền body thô, trả response gốc Gemini).
- Forward byte SSE gốc, **không ghi `[DONE]`**.
- Chỉ hỗ trợ `generateContent` và `streamGenerateContent`.
- `respect_agent_model: true` để dùng model trên URL; mặc định `false` (proxy tự xoay model).
- Auth: bỏ qua `x-goog-api-key` và `?key=` từ client, chỉ dùng key thật từ config.

## Cấu hình

- `config/keys.json` — danh sách key (`id`, `api_key`, `enabled`). **Không nằm trong git** (đã `.gitignore`); tạo từ mẫu `config/keys.example.json`.
- `config/models.json` — danh sách model (`name`, `priority` càng nhỏ càng ưu tiên, `limits: {rpm, rpd, tpm}`).
- `config/config.json` — `port`, `strategy` (`round_robin_key_then_model` mặc định, hoặc `priority_model_first`), `state_file`, `log_level`, `request_timeout_ms`, `max_fallback_attempts`, `respect_agent_model`, `default_cooldown_seconds`.

Quota reset ngày tính theo **nửa đêm Pacific Time** (theo Gemini free-tier).

## Test

```bash
npm test
```