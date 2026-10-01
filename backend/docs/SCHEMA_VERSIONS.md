# Schema Version Management

This document describes the schema versioning strategy for VaultQuest legacy
records, the fixture pack used to exercise migrations and compatibility layers,
and the provenance of each fixture.

## Legacy fixture pack

Fixtures live under `backend/tests/fixtures/legacy/` and are named by the schema
version they represent. Each fixture is a JSON document that validates against
the historical shape for that version.

| Fixture | Schema version | Coverage |
| --- | --- | --- |
| `v0_clean.json` | v0 | Clean legacy record with all required fields present. |
| `v0_missing_field.json` | v0 | Legacy record missing a required field (`prizePool`). |
| `v0_deprecated_field.json` | v0 | Legacy record containing a deprecated field (`legacyYield`). |
| `v0_incompatible.json` | v0 | Legacy record with an unknown schema version marker. |

## Provenance

Fixtures were derived from anonymized production snapshots captured before the
v1 migration. Field names and value ranges reflect the v0 storage layout used by
the original vault accounting module. No live user data is included; identifiers
and amounts were replaced with deterministic placeholders.

## Migration coverage

`backend/tests/migration/legacyMigration.test.ts` loads each fixture and runs it
through the migration pipeline. The suite asserts:

- Clean legacy records migrate to a current valid record.
- Records with missing required fields are rejected with a descriptive error.
- Deprecated fields are dropped and do not appear on the migrated record.
- Incompatible legacy records fail validation before migration runs.

Run the suite with:

