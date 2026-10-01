# API response standard

Backend HTTP responses use one envelope so frontend code can parse success,
validation, and recovery states without route-specific branching.

## Success

Single-object responses:

```json
{
  "data": {
    "id": "act_123",
    "status": "pending"
  }
}
```

List responses:

```json
{
  "data": [{ "id": "act_123" }],
  "meta": {
    "pagination": {
      "next_cursor": "4f2b9a1d-...",
      "limit": 25,
      "has_more": true
    }
  }
}
```

`next_cursor: null` and `has_more: false` mean the client has reached the end.
Clients should pass the returned cursor back as `?cursor=` unchanged.

## Errors

All errors use one envelope. The full field reference, the complete code
table (category, retryability, HTTP status) and worked examples live in
[`docs/API.md`(________docs/API.md#standard-errors); they are enforced by
`tests/apiContract.spec.ts`.

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "category": "validation",
    "message": "validation failed",
    "retryable": false,
    "recovery": "Correct the highlighted fields and submit again.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 400,
    "issues": []
  }
}
```

Codes, categories, retryability and user-facing text come from the catalog in
`src/errorTaxonomy.ts`. Internal messages never reach clients on server errors;
`error_id` is the request's correlation id (also the `Correlation-Id` header)
and is what users should quote to support.

Validation responses include Zod `issues`; frontend code should prefer`
error.message` for general copy and field-specific `issues` when rendering
forms.

## Network and upstream failures

Backend routes that cannot reach Stellar RPC, Horizon, Prisma, or another
upstream should return `NETWORK_ERROR` when the failure is expected/recoverable.
Unknown exceptions fall back to `INTERNAL`. Frontends should retry only when
`error.retryable` is `true` (with backoff, honouring `Retry-After`); never
auto-retry validation, auth, or conflict errors.

## Data exports (`GET /exports`)

Wallet-scoped exports are the one documented exception to the `data`/`meta`
envelope above. They are generated on demand and never stored, so the response
is a downloadable JSON bundle with its own contract:

```json
{
  "metadata": {
    "schema_version": "1.0.0",
    "generated_at": "2026-03-01T12:00:00.000Z",
    "expires_at": "2026-03-02T12:00:00.000Z",
    "retention_hours": 24,
    "wallet": "GALICE",
    "generated_by_role": "user",
    "sections": ["actions", "saved_pools"],
    "record_counts": { "actions": 1, "saved_pools": 1 },
    "truncated": false,
    "max_records_per_section": 10000,
    "checksum": "<key sha256 of `data`>"
  },
  "data": {
    "actions": [],
    "saved_pools": []
  }
}
```

- `Get /exports` is authenticated and requires the `own.data.export` permission.
- `?wallet=` defaults to the caller's own wallet. Exporting another wallet
  requires `admin.export.any` and is enforced in the service layer.
- `?sections=` is a comma-separated subset of `actions` and `saved_pools`.
- Responses are sent with `Cache-Control: no-store` and a `Content-Disposition`
  attachment filename derived from `generated_at`.
- Exports are not persisted; consumers must discard the bundle after
  `expires_at` (`retention_hours` from generation).
- `truncated` is `true` when a section hit `max_records_per_section`; the
  corresponding `record_counts` entry then reflects the capped count.
- `checksum` is the SHA-256 of the serialized `data` object for tamper
  detection by downstream consumers.
