# Local Gemini Multi-Key/Model Rotating Proxy

Proxy HTTP chạy local, đứng giữa AI agent (Cline, OpenCode, ...) và Gemini API.
Tự xoay tua cặp `(API key, model)` khi gặp 429, agent không cần biết.

> **Dành cho AI agent / contributor:** đọc `AGENTS.md` trước khi sửa code.
> Mọi thay đổi source làm docs lạc hậu thì **bắt buộc update docs trong cùng change**
> (rule chi tiết tại `AGENTS.md` §5).

## Chạy

1. Điền API key thật vào `config/keys.json`.
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
| POST | `/v1/chat/completions` | OpenAI-compatible chat (hỗ trợ `stream: true` SSE) |
| GET | `/v1/models` | Danh sách model đang cấu hình |
| GET | `/admin/status` | Debug: quota đã dùng / còn lại từng cặp (key, model) |
| GET | `/health` | Health check |

## Cấu hình

- `config/keys.json` — danh sách key (`id`, `api_key`, `enabled`).
- `config/models.json` — danh sách model (`name`, `priority` càng nhỏ càng ưu tiên, `limits: {rpm, rpd, tpm}`).
- `config/config.json` — `port`, `strategy` (`round_robin_key_then_model` mặc định, hoặc `priority_model_first`), `state_file`, `log_level`, `request_timeout_ms`, `max_fallback_attempts`, `respect_agent_model`, `default_cooldown_seconds`.

Quota reset ngày tính theo **nửa đêm Pacific Time** (theo Gemini free-tier).

## Test

```bash
npm test
```
