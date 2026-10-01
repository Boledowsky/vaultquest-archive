# Pagination and Filtering Reference

> **Updated for #778** — This document describes the stable cursor-based pagination
> model used across all VaultQuest list endpoints and defines how filters interact
> with hidden, deleted, and permission-restricted records.

---

## Why cursor-based pagination?

Offset-based pagination (`LIMIT n OFFSET m`) is unstable: if rows are inserted or
deleted while a user pages through a list, they will see duplicate or skipped records.

VaultQuest uses **cursor-based pagination** on all key list endpoints. The cursor is
the `id` (UUID) of the last record returned on the previous page. The query uses
Prisma's `cursor: { id } + skip: 1` pattern with a deterministic `orderBy`, so:

- Newly inserted rows always appear *after* the current page cursor.
- Deleted rows are simply absent; the page count decreases but no duplicates appear.
- Status changes do not shift existing rows relative to the cursor.

---

## Standard paginated response envelope

```json
{
  "data": [ /* array of records */ ],
  "meta": {
    "pagination": {
      "next_cursor": "uuid-of-last-record-or-null",
      "limit": 25,
      "has_more": true
    }
  }
}
```

Pass `next_cursor` back as the `cursor` query parameter to fetch the next page.
Stop paginating when `has_more` is `false`.

---

## Endpoints and their ordering keys

| Endpoint | Primary order | Secondary order | Notes |
|---|---|---|---|
| `GET /actions` | `createdAt DESC` | `id DESC` | Wallet-scoped |
| `GET /saved-pools` | `createdAt DESC` | `id DESC` | Wallet-scoped |
| `GET /admin/audit` | `sequence DESC` | — | Sequence cursor (integer) |
| `GET /admin/audit-trail` | `sequence DESC` | — | Sequence cursor |
| `GET /admin/recovery/cases` | `staleSince ASC` | — | No cursor yet; bounded by `limit` |
| `GET /admin/partial-failures` | `detectedAt DESC` | `id DESC` | Cursor-based |
| `GET /api/search` | relevance score | — | Offset-based (stable snapshot) |
| `listRecoverableActions` (internal) | `submittedAt ASC` | `id ASC` | Cursor-based (#778) |

---

## Filter behavior for hidden, deleted, and restricted records

### Soft-deleted / redacted records

`ActionLedger` rows with a non-null `redactedAt` are **excluded** from all wallet-facing
list endpoints (`/actions`). They are still accessible to maintainers via the internal
endpoints and are not removed from the audit trail.

### Status-filtered records

The `status` query parameter on `/actions` matches the `ActionStatus` enum exactly.
Records that transition status between pages are **not** re-fetched; the cursor anchors
the result to the state at the time of the first request.

### Permission-filtered records (RBAC)

- **User** (`own.data.read`): only records matching `walletAddress = req.principal.walletAddress`.
- **Maintainer** (`admin.export.any`): all records, subject to explicit filter parameters.
- **Service**: internal endpoints only; never exposed via the public API.

The search index (`/api/search`) additionally applies a `roles`/`permissions` context
to hide unlisted records from unauthenticated callers even when `include_unlisted` is
omitted.

### Recovery cases

`/admin/recovery/cases` accepts a `state` filter:

| state | Included |
|---|---|
| `retryable` | Stale, auto-retries still available |
| `failed` | Retries exhausted; awaiting maintainer |
| `manual_review` | Escalated |
| `resolved` | Terminal; excluded from default view |

### Partial failures

`/admin/partial-failures` accepts `state`, `operation_type`, `severity`, and `retryable`
query filters. The `state=ignored` and `state=resolved` filters are excluded from the
default view (no `state` filter → returns `unresolved` and `retryable` only).

---

## Stability guarantees

| Scenario | Behaviour |
|---|---|
| Row inserted before cursor | Never appears on subsequent pages |
| Row inserted after cursor | Appears on subsequent pages |
| Row deleted while paginating | Absent from all pages; no duplicates |
| Row status changes while paginating | Remains at its original cursor position |
| Concurrent writes during full export | `DataExportService` re-reads page by page; each page is stable; the export may miss records added after it started |

---

## Migration guide for callers using offset

If you are calling `listRecoverableActions(limit, offset)` directly (e.g. in a cron
or admin script), update the call site:

**Before (#778):**
```ts
const rows = await ledger.listRecoverableActions(25, offset);
offset += rows.length;
```

**After (#778):**
```ts
let cursor: string | null = null;
do {
  const { items, nextCursor } = await ledger.listRecoverableActions(25, cursor);
  cursor = nextCursor;
  // process items...
} while (cursor !== null);
```
