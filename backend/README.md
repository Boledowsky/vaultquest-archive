# VaultQuest Backend

Action ledger and reconciliation service for TrustQuest (issue #34).

## Stack

- Node 20 + TypeScript
- Fastify 4 (HTTP)
- Prisma 5 + Postgres 16 (storage)
- Zod (validation)
- Pino (logging)
- node-cron (orphan sweep)
- Vitest + Testcontainers (tests against real Postgres)

## Setup

```bash
cp .env.example .env
pnpm install
# Setup database (migrations and mock seed data)
pnpm run db:setup
pnpm test
pnpm dev
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | /health | Liveness probe |
| POST | /actions | Create intent (requires `Idempotency-Key: <uuid>`) |
| PATCH | /actions/:id/submitted | Attach `tx_hash` after wallet broadcasts |
| POST | /actions/:id/cancel | Mark a pending intent failed |
| GET  | /actions/:id | Read a single action |
| GET  | /actions?wallet=G...&status=&cursor=&limit= | Paginated activity history |
| GET  | /dashboard/summary?wallet=G...&stale_after_ms= | Per-wallet rollup for the dashboard (#14) |
| GET  | /saved-pools?wallet=G... | Saved-pools watchlist entries |
| POST | /saved-pools | Save or update a pool watchlist entry |
| DELETE | /saved-pools/:poolId?wallet=G... | Remove a saved pool from a wallet watchlist |
| DELETE | /actions?wallet=G... | Privacy scrub (nulls payload, sets redacted_at) |
| POST | /internal/reconcile | Event indexer → ledger (requires `X-Internal-Secret`) |

See `docs/superpowers/specs/2026-04-23-action-ledger-design.md` for the full contract, and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the service layout, schema, worker runtime, and migration strategy. For background drift detection, automated repair pipelines, and quarantine incident response, see [`docs/RECONCILIATION.md`](../docs/RECONCILIATION.md). For response envelopes, errors, and pagination, see [`docs/API_RESPONSES.md`](../docs/API_RESPONSES.md). For how the frontend should submit, poll, and **retry** these endpoints safely, see [`docs/transaction-status-api.md`](../docs/transaction-status-api.md). Indexer contributors should also follow the contract [`event schema`](../contracts/docs/EVENT_SCHEMA.md) and [`pause/recovery model`](../contracts/docs/PAUSE_RECOVERY.md). For how confirmations become quest completions and reward grants (idempotency, reorg correction, and the current payout state), see [`docs/QUEST_REWARDS.md`](../docs/QUEST_REWARDS.md).

## Environment

See `.env.example`. All values are validated at boot via Zod. Background worker settings: `WORKER_ENABLED` (default `true`) and `WORKER_POLL_INTERVAL_MS` (default `2000`); see [`docs/BACKGROUND_JOBS.md`](docs/BACKGROUND_JOBS.md).

## Errors, telemetry, jobs and the API contract

* Error codes, categories and user-safe messages: [`../docs/API.md#standard-errors`](../docs/API.md#standard-errors) (`src/errorTaxonomy.ts`).
* Metrics, structured log fields and dashboard queries: [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).
* Background worker, retry policy, dead-letter handling and local instructions: [`docs/BACKGROUND_JOBS.md`](docs/BACKGROUND_JOBS.md).
* The public API contract is checked by `tests/apiContract.spec.ts`; update `../docs/API.md` and `src/contracts/apiContract.ts` together with any response change.

## Tests

Tests use Testcontainers to spin up Postgres 16 per run. Docker must be available.

```bash
pnpm test
```
# Post-restore validation

After restoring a backup, run the backend db:validate-restore script with
DATABASE_URL set to the restored database. The command is read-only and runs
its checks in a repeatable-read, read-only transaction. It reports missing
core tables and counts for inconsistent confirmed actions, settlement
timestamps, reward grants, saved-pool registry references, chain-event
identifiers, and duplicate/orphan quest records. It never prints wallet
addresses, transaction hashes, payloads, or the database URL.

Exit code 0 means the checked invariants passed; 1 means the report needs
maintainer review; 2 means the database/schema could not be checked. A
reported count is a recovery lead, not permission to edit a financial record:
compare affected rows with chain history and use the normal reconciliation
workflow. Escalate unresolved payout, settlement, or chain-event mismatches to
the protocol maintainer before resuming user-facing operations. This is a
consistency check, not a replacement for the chain-aware disaster-recovery
drill.
