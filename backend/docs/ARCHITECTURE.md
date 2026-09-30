# Backend Service Architecture (#24)

This document is the foundation called out in issue #24: a documented
backend scaffold with explicit boundaries between the public API,
event-ingestion path, and worker runtime, plus the schema/migration story
that supports issues #13 and #14 without inventing a new platform later.

## Service boundaries

```
                    ┌──────────────────────────┐
  Stellar / Soroban │  pool, vault, claim …    │
        events      └─────────────┬────────────┘
                                  │   (off-chain indexer — issue #13)
                                  ▼
                    ┌──────────────────────────┐
                    │  POST /internal/reconcile │   (X-Internal-Secret)
                    └─────────────┬────────────┘
                                  │
            ┌─────────────────────┴──────────────────────┐
            ▼                                            ▼
   ┌─────────────────┐                          ┌──────────────────┐
   │  ActionLedger   │ ◄──── Prisma 5 ─────►    │   PendingEvent    │
   │  (intents)      │                          │  (event-first)    │
   └────────┬────────┘                          └──────────────────┘
            │
            ▼
   ┌──────────────────────────────────────┐
   │ Public Fastify routes (this service) │
   │   POST /actions                      │
   │   PATCH /actions/:id/submitted       │
   │   POST  /actions/:id/cancel          │
   │   GET   /actions/:id                 │
   │   GET   /actions?wallet=…            │
   │   GET   /dashboard/summary?wallet=…  │
   └──────────────────────────────────────┘
            ▲
            │
            ▼
   ┌──────────────────────────────────────┐
   │  Worker runtime (src/cron.ts)         │
   │   - reconciler sweep                 │
   │   - orphan TTL eviction              │
   └──────────────────────────────────────┘
```

The three concerns are intentionally co-located in one repo but kept
in distinct modules so they can be split into separate processes (or
horizontally scaled independently) later without rewriting the data model:

- **API surface** — `src/routes/*` + `src/app.ts`. Pure Fastify handlers.
  Validates with Zod (`src/schemas/*`), delegates to `LedgerService`,
  serializes through a single `serialize()` helper for stable response
  shapes.
- **Canonical serialization** — `src/canonical.ts` provides the single
  canonicalization primitive used by every hashed, signed, compared, or
  verified payload (see *Canonical serialization* below).
- **Indexing inbound** — `POST /internal/reconcile` is the *only* write
  path the event indexer (issue #13) touches. Authenticated by
  `X-Internal-Secret` (`AppDeps.internalSecret`). The handler delegates
  straight into `LedgerService.reconcileEvent`, which is replay-safe
  (event-first writes go to `PendingEvent` and are claimed when the
  intent eventually attaches its `tx_hash`).
- **Processed-event checkpointing** — the indexer also persists the last
  processed paging token alongside the ledger checkpoint, so a restart can
  resume from the next unread event instead of replaying an entire batch.
- **Worker runtime** — `src/cron.ts` schedules the reconciler sweep and
  the orphan TTL eviction. Worker concerns never reach into route
  handlers; they call `LedgerService` directly so they share the same
  invariants as the API.

## Domain model

| Table | Purpose | Key columns |
|---|---|---|
| `action_ledger` | Intent record. Created the moment a user clicks a button, before any tx is signed. | `idempotency_key` (unique), `wallet_address`, `action_type`, `status`, `tx_hash`, `correlation_id`, `error_code`, `redacted_at` |
| `pending_events` | Indexer-first events that arrived before the matching intent attached its `tx_hash`. Drained on attach. | `tx_hash` (PK), `soroban_event_id`, `event_payload`, `status_hint`, `consumed_at` |
| `indexer_checkpoints` | Singleton indexer cursor and health checkpoint. | `latest_ledger`, `last_processed_event_id`, `last_sync_time`, `last_success_sync_time`, `last_error` |

Status machine (enforced in `src/constants.ts`):

```
pending  ──┬──► submitted ──┬──► confirmed
           │                ├──► reverted
           │                └──► orphaned   (TTL sweep — worker)
           └──► failed
```

The ledger never deletes rows. Privacy scrub (`DELETE /actions?wallet=…`)
nulls `action_payload` and sets `redacted_at`, preserving the audit
trail for the indexer.

### Why an intent-first ledger

An intent is durably recorded *before* the wallet signs anything, so:

- A wallet timeout / browser refresh can recover by replaying the
  `Idempotency-Key` rather than producing a duplicate on-chain tx.
- The indexer can publish events asynchronously without coordinating
  with the API process.
- The `correlation_id` is carried through every log line and structured
  error response so the frontend can quote it in support tickets.

## Canonical serialization

Any payload that is hashed, signed, compared, or verified must be
serialized through `src/canonical.ts` before it leaves the process. This
guarantees that equivalent payloads produce byte-identical output
regardless of key insertion order, whitespace, casing, or numeric
formatting, and that non-canonical inputs are normalized or rejected
consistently.

### Payloads in scope

| Payload | Where it is produced | Why canonical |
|---|---|---|
| `action_payload` on `action_ledger` | `POST /actions` | Hashed into the `idempotency_key`; must be stable across retries. |
| `event_payload` on `pending_events` | `POST /internal/reconcile` | Compared against replayed indexer deliveries; must dedupe deterministically. |
| Dashboard summary digest | `GET /dashboard/summary` | Signed into the `is_stale` ETag; must match across nodes. |
| Wallet-flow intent envelope | `PATCH /actions/:id/submitted` | Verified against the wallet signature; must match the client's canonical form. |

### Canonicalization rules

1. **Ordering** — object keys are sorted lexicographically by UTF-16
   code unit (JavaScript default `Array.prototype.sort`). Arrays keep
   their original order; callers that need set semantics must sort
   before canonicalizing.
2. **Whitespace** — no insignificant whitespace is emitted. Strings are
   preserved verbatim except for Unicode NFC normalization; leading and
   trailing whitespace inside string *values* is significant and is not
   trimmed.
3. **Casing** — keys are case-sensitive and preserved. Enum-like string
   values (e.g. `action_type`, `status`) are lowercased during
   normalization so `"Submitted"` and `"submitted"` collapse to the same
   canonical form.
4. **Numeric precision** — numbers are serialized as decimal strings
   with no exponent, no leading `+`, no leading zeros, and no trailing
   fractional zeros. Integers are emitted without a decimal point.
   `NaN`, `Infinity`, and `-Infinity` are rejected with a structured
   `CanonicalError`.
5. **Unsupported values** — `undefined`, functions, symbols, and
   `BigInt` are rejected. `null` is preserved. `Date` is normalized to
   its ISO-8601 UTC string.

### Compatibility path for legacy records

Rows written before canonicalization landed may contain unsorted keys,
mixed-case enum values, or numbers serialized with exponent notation.
`canonicalizeLegacy()` accepts these records, applies the same rules
above, and returns a canonical form plus a `legacy: true` marker so
callers can log or migrate them. New writes always go through
`canonicalize()`; the legacy path exists only to read historical rows
without rewriting them in place.

### Validation

`pnpm test -- canonical.spec.ts` covers ordering, whitespace, casing,
numeric precision, and legacy payloads. Fixtures live in
`tests/fixtures/canonical/` and are checked into the repo so the
expected canonical bytes are reviewable in diffs.

## Migration strategy

Schema lives in `backend/prisma/schema.prisma`. Migrations live in
`backend/prisma/migrations/` and are applied with the standard Prisma
flow — `prisma migrate dev` locally, `prisma migrate deploy` in CI and
production. Rollback is purposely *not* automated: every migration is
expected to be additive (new tables, new columns, new enum values).
Destructive changes require a paired migration that keeps the previous
schema readable until traffic has cut over.

## Local-development bootstrap

```bash
cp .env.example .env                  # set DATABASE_URL, INTERNAL_SECRET
pnpm install
pnpm exec prisma migrate deploy       # applies migrations to your local DB
pnpm dev                              # starts Fastify on $PORT, default 3000
pnpm test                             # vitest + testcontainers (needs Docker)
```

The default `.env.example` points at a local Postgres at
`localhost:5432`. Tests spin up an ephemeral Postgres 16 container per
run (`tests/helpers/db.ts`), so contributors don't need to manage a
test database manually.

## Configuration

All env vars are validated at boot in `src/env.ts` via Zod. Boot fails
loudly with a structured Zod error if anything is missing or malformed.
Required values:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `INTERNAL_SECRET` | Shared secret for `X-Internal-Secret` on `/internal/reconcile`. |
| `PORT` | HTTP port (optional, default 3000). |
| `LOG_LEVEL` | Pino log level (`info`, `debug`, …). |

## Replay safety

`LedgerService.reconcileEvent` is the only path that writes a
confirmed/reverted status. It is wrapped in a Prisma transaction and
falls back to the `PendingEvent` table when the matching intent's
`tx_hash` has not yet been attached. The same transaction is invoked
from both the worker sweep and `POST /internal/reconcile`, so duplicate
deliveries from the indexer are idempotent.

Replay comparisons use the canonical form of `event_payload` (see
*Canonical serialization*), so a re-delivered event with reordered keys
or reformatted numbers is recognized as a duplicate rather than a new row.

## Smoke check

The repo ships a synchronous boot smoke test
(`tests/smoke.spec.ts`) that:

1. Boots the Fastify app with a Testcontainers Postgres instance
2. Applies the latest migrations via `prisma migrate deploy`
3. Asserts `/health` responds `200 { ok: true }`

Run it with `pnpm test -- smoke.spec.ts`. If this passes locally, the
backend stack is healthy enough for issues #13 and #14 to land work
against it.

The smoke test also asserts that `canonicalize()` is deterministic for a
known fixture, so a regression in serialization fails the boot check.

## Relationship to the rest of the system

- **Frontend (#7, #14)** consumes only the public Fastify routes.
  Stale-data handling is driven by the `is_stale` flag returned from
  `GET /dashboard/summary`.
- **Soroban contracts (#10, #11, #12)** never call this service
  directly. Their events flow through the off-chain indexer (issue #13)
  and arrive here via `POST /internal/reconcile`.
- **Indexer (#13)** is the only producer of `PendingEvent` rows and the
  only authenticated caller of `/internal/reconcile`.
