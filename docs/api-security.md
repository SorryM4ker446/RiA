# API contracts and local security

The application targets one local Next.js service process with SQLite and private media files. These controls are shared by browser and Electron requests. They are not a public, multi-instance deployment design.

## Errors and request processing

Business handlers return errors as JSON with `Cache-Control: no-store`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": {}
  }
}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Malformed JSON, invalid fields, unsupported model or invalid media reference |
| `UNAUTHORIZED` | 401 | Missing/expired application session or incorrect login credentials |
| `FORBIDDEN` | 403 | Host, desktop Cookie or browser origin check failed |
| `NOT_FOUND` | 404 | Missing resource, including resources owned by another user |
| `CONFLICT` | 409 | Duplicate account/identifier, stale tool approval, concurrent edit or referenced media |
| `PAYLOAD_TOO_LARGE` | 413 | Request bytes, extracted document or conversation export limits exceeded |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | A JSON or multipart endpoint received the wrong Content-Type |
| `RANGE_NOT_SATISFIABLE` | 416 | Invalid media byte range; includes Content-Range |
| `RATE_LIMITED` | 429 | Local quota exhausted; includes Retry-After and details.retryAfterSeconds |
| `INTERNAL_ERROR` | 500 | Unexpected application/storage failure, without internal diagnostics |
| `UPSTREAM_FAILED` | 502 | Model or external service failure |
| `CONFIGURATION_ERROR` | 503 | Required service configuration is missing or invalid |
| `SERVICE_UNAVAILABLE` | 503 | SQLite query/connection wait timed out or document parsers are busy |
| `TIMEOUT` | 504 | Upstream operation or document parsing timed out |

The order is Host/Origin/desktop boundary, user authentication, applicable quota, limited body reading and schema validation, resource/configuration checks, then business work. Login and registration use the same flow without a pre-existing user session. Logout is idempotent and accepts an absent/expired session after the origin check. Health requires a valid desktop Host but no desktop Cookie.

JSON operations require `application/json`. Unknown request fields and unknown model IDs are rejected instead of silently selecting a default model; omitting the model still selects its default. Chat accepts user/assistant history, bounded message parts, uploaded image references and the supported tool/approval states. Client system history is never promoted to the server system prompt. Only a final persisted pending approval can continue execution. Media generation accepts private uploaded references, never arbitrary remote or data URLs.

Successful API payloads are documented in [Local integration API](local-api.md); conversation exports return attachment bodies instead of a JSON data envelope. AI SDK streams already started with HTTP 200 cannot switch their HTTP status later. Their error chunks carry the same serialized error object; the shared browser parser displays its message and retry/reload guidance. Persistence failures, including regeneration conflicts, are surfaced through that stream. HEAD errors intentionally have no response body. Framework-level routing errors (for example an unknown endpoint or an unsupported HTTP method) are outside the business error contract.

Raw ORM/provider diagnostics are not logged or returned because they can contain query values or upstream request details. Route logs retain the endpoint and normalized error code. Chat and knowledge layouts evaluate authentication at request time, even if the artifact was built with demo authentication enabled.

## Byte and input limits

The common reader counts actual bytes, including requests without Content-Length, and cancels oversized streams. JSON bodies are limited to 2 MiB, authentication bodies to 16 KiB, and JSON nesting to 32 levels. Logout, cleanup and DELETE accept no body or an empty JSON object (at most 16 KiB).

Existing media limits remain: four attachments per message, PNG/JPEG/WebP/GIF only, at most 8 MiB each and 20 MiB combined, with a 21 MiB multipart envelope. Signatures, ownership and stored sizes are checked before use. Next.js Proxy buffering is capped at 22 MiB so valid uploads over its default 10 MiB buffer are not truncated and handlers have room to detect overflow before truncation; the accepted multipart limit remains 21 MiB. Actual chunked HTTP overflow is covered by a browser-suite regression. Generated image/video storage limits remain 20/100 MiB. See [Media storage](media-storage.md).

## Single-process quotas

| Operation | Scope | Fixed window |
| --- | --- | --- |
| Login | Entire local service | 20 attempts / 15 minutes |
| Registration | Entire local service | 5 attempts / hour |
| Chat | User | 30 requests / minute |
| Tool execution | User, shared by manual and automatic calls | 30 attempts / minute |
| Image generation | User | 6 requests / minute |
| Video generation | User | 3 requests / minute |
| Media library regeneration attempts | User; valid recipes also consume the image/video quota above | 6 attempts / minute |
| Attachment upload | User | 20 requests / minute |
| Document import/reindex | User, shared between both operations | 6 attempts / minute |
| Desktop task reminder claims | User | 10 checks / minute; at most 10 due tasks per check |
| Conversation text search | User | 30 requests / minute |
| Conversation export | User | 6 requests / minute |
| Confirmed bulk conversation deletion | User | 10 requests / minute |
| Backup create/restore/delete, import begin/finish | User, shared | 6 attempts / minute |
| Backup import chunks | User | 120 chunks / minute, each at most 8 MiB |
| Model preference updates | User | 20 attempts / minute |

Document-only search shares the tool request quota. Document uploads reuse the limited stream reader with a narrower 9 MiB body/8 MiB file allowance. Extraction has worker, timeout, expanded-size and per-user document limits; see [Document knowledge](document-knowledge.md). The existing attachment/Proxy limits are not increased.

Bulk conversation deletion accepts at most 50 unique owned IDs and explicit confirmation within 16 KiB. Exports have message/source/output caps, preserve private media authorization, and omit raw tool arguments/settings. See [Conversation management](conversation-management.md). Archive state never replaces ownership checks.

Media library regeneration requires strict `{ "confirm": true }` JSON within 16 KiB, then checks the owned recipe and shared image/video quota before generation. Callers cannot override recorded parameters. Its list/detail APIs omit filesystem paths and retain owner-only access; message and generation-input references both prevent deletion. See [Media library](media-library.md).

Invalid requests and configuration failures consume the applicable quota. Rejected requests do not extend its window. Unauthenticated protected requests never use a user's quota. Login and registration deliberately do not trust `X-Forwarded-For` or `X-Real-IP`: changing an address or email cannot bypass the service budget. The in-memory store holds at most 2,000 active keys and refuses new keys while full instead of evicting existing quotas. Expired entries are reclaimed.

Restarting the service resets quotas. Fixed windows can allow a burst around their boundary. These are bounded local abuse/cost controls, not distributed rate limits, concurrency controls, or provider spending caps. Heavy legitimate authentication activity shares one budget; wait for Retry-After rather than repeatedly retrying. Public deployment needs a separate reviewed authentication, proxy and shared-state design.

## Sessions and origins

Account backup operations coordinate with business requests through a single-process maintenance gate. In-flight work rejects a maintenance request with 409; active maintenance rejects business requests with 503. Disconnecting a chat HTTP reader does not release its background persistence guard early. Backup files have owner-only access, bounded ordered uploads, schema/checksum validation and server-generated paths; restore requires explicit confirmation and creates a safety backup. See [Account backups](account-backups.md). Model settings use strict 64 KiB JSON and reuse the same session/Origin checks; [usage estimates](model-usage.md) exclude prompt/key/error-body storage.

Opaque application-session tokens are stored only as hashes, expire after 30 days and use HttpOnly, SameSite=Lax cookies. Web production cookies retain Secure; desktop loopback HTTP cookies do not require HTTPS. Creating/resolving sessions opportunistically deletes expired rows no more than once per 15 minutes, coalesces concurrent maintenance, and deletes an individually encountered expired session immediately. An idle, stopped application performs no maintenance; expiry remains enforced on the next request. Cleanup failures are propagated, not silently retried.

Without `APP_ORIGIN`, API Host values are restricted to localhost, 127.0.0.1 and ::1. A non-loopback Web host requires an exact HTTP(S) origin such as `https://assistant.example.invalid` with no path or trailing slash. The reverse proxy must preserve that Host and strip client-supplied forwarding headers; the application does not use forwarded host/IP values as authorization. Keep `AUTH_DISABLED=0` and HTTPS for an authenticated network service. Setting APP_ORIGIN alone does not make public deployment supported.

Browser writes must be same-origin. Foreign/null Origin and cross-site or same-site Fetch Metadata are rejected, including login, logout, uploads and cleanup. Native scripts without Origin/Fetch Metadata remain supported but still need normal authentication. This intentionally retains local service probes and Electron main-process fetches. There is no permissive CORS allowlist, wildcard origin or cross-origin cookie flow.

Desktop always uses its generated Host and random desktop Cookie, independently of APP_ORIGIN and AUTH_DISABLED. It binds to loopback and still applies origin checks. Changing the local service port refreshes that Cookie; renderer, proxy settings, health probes and media access continue through the existing desktop lifecycle.

Task reminder claims are desktop-only and persist before native display to prevent replay. They cannot accept a caller-supplied user ID or arbitrary notification content. Recurring-task completion and successor creation are transactional. See [Task reminders](task-reminders.md) for delivery limits and the read-only scheduling state.
