import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaVersionService } from "../src/services/schemaVersionService.js";
import { SCHEMA_VERSIONS } from "../src/constants.js";

/**
 * Legacy VAULTQUEST fixture pack.
 *
 * Provenance:
* These records mirror the historical shapes emitted by the VaultQuest
 * indexer and prize vault accounting layers before the current schema
 * version. They are used to exercise the compatibility layer and
 * migration path that normalizes old records into the current shape.
 *
 * Coverage:
 * - clean legacy record (valid old shape)
 * - missing field (old shape lacking a required field)
 * - deprecated field (old shape carrying a field no longer used)
 * - incompatible legacy record (shape that cannot be migrated)
 */

export interface LegacyVaultRecord {
  vaultId: string;
  ownerAddress: string;
  prizePoolId?: string;
  depositTotal?: string;
  // Deprecated in current schema; kept only for legacy records.
  legacyPrizePoolId?: string;
  schemaVersion?: string;
}

export interface CurrentVaultRecord {
  vaultId: string;
  ownerAddress: string;
  prizePoolId: string;
  depositTotal: bigint;
  schemaVersion: string;
}

export const LEGACY_FIXTURES: Record<string, LegacyVaultRecord> = {
  clean: {
    vaultId: "vault-legacy-001",
    ownerAddress: "0x111111111111111111111111111111111111111",
    prizePoolId: "pool-legacy-001",
    depositTotal: "10000000000000000000",
    schemaVersion: SCHEM_VERSIONS.DATABASE.replace(/^(\d+)\.(\d+)\.(\d+)$/, "$1.$2.0"),
  },
  missingField: {
    vaultId: "vault-legacy-002",
    ownerAddress: "0x222222222222222222222222222222222222222",
    // prizePoolId intentionally omitted
    depositTotal: "5000000000000000000",
    schemaVersion: SCHEMA_VERSIONS.DATABASE.replace(/^(\d+)\.(\d+)\.(\d+)$/, "$1.$2.0"),
  },
  deprecatedField: {
    vaultId: "vault-legacy-003",
    ownerAddress: "0x333333333333333333333333333333333333333",
    prizePoolId: "pool-legacy-003",
    depositTotal: "7500000000000000000",
    legacyPrizePoolId: "pool-legacy-003",
    schemaVersion: SCHEMA_VERSIONS.DATABASE.replace(/^(\d+)\.(\d+)\.(\d+)$/, "$1.$2.0"),
  },
  incompatible: {
    vaultId: "",
    ownerAddress: "",
    prizePoolId: "",
    depositTotal: "not-a-number",
    schemaVersion: "unknown",
  },
};

export function migrateLegacyVaultRecord(
  record: LegacyVaultRecord,
): { ok: true; value: CurrentVaultRecord } | { ok: false; error: string } {
  if (!record.vaultId || typeof record.vaultId !== "string") {
    return { ok: false, error: "missing or invalid vaultId" };
  }
  if (!record.ownerAddress || typeof record.ownerAddress !== "string") {
    return { ok: false, error: "missing or invalid ownerAddress" };
  }
  const prizePoolId = record.prizePoolId ?? record.legacyPrizePoolId;
  if (!prizePoolId) {
    return { ok: false, error: "missing prizePoolId" };
  }
  if (typeof record.depositTotal !== "string" || !/^\d+$/.test(record.depositTotal)) {
    return { ok: false, error: "invalid depositTotal" };
  }
  return {
    ok: true,
    value: {
      vaultId: record.vaultId,
      ownerAddress: record.ownerAddress,
      prizePoolId,
      depositTotal: BigInt(record.depositTotal),
      schemaVersion: SCHEMA_VERSIONS.DATABASE.replace(/^(\d+)\.(\d+)\.(\d+)$/, "$1.$2.0"),
    },
  };
}

describe("SchemaVersionService", () => {
  let mockPrisma: any;
  let service: SchemaVersionService;

  beforeEach(() => {
    mockPrisma = {
      $queryRaw: vi.fn(),
      indexerCheckpoint: {
        findUnique: vi.fn(),
      },
    };
    service = new SchemaVersionService(mockPrisma);
  });

  describe("getIndexerVersion", () => {
    it("returns real indexer version from metadata instead of hardcoded literal", async () => {
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: "2.5.0",
      });

      const version = await service.getIndexerVersion();
      expect(version).toBe("2.5.0");
    });
  });

  describe("validateSchemaVersions", () => {
    it("detects a mismatch between old indexer and new expected schema", async () => {
      // Force database version to match expected
      mockPrisma.$queryRaw.mockResolvedValue([
        { migration_name: `${SCHEMA_VERSIONS.DATABASE}some_migration` },
      ]);
      // Force old indexer version
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: "0.9.0", // An old version
      });

      const result = await service.validateSchemaVersions();
      expect(result.valid).toBe(false);
      expect(result.indexerVersion).toBe("0.9.0");
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Indexer schema version 0.9.0 is not supported")
        ])
      );
    });
  });

  describe("legacy fixture pack", () => {
    it("validates the clean legacy record against the expected old shape", () => {
      const record = LEGGACY_FIXTURES.clean;
      expect(record.vaultId).toBe("vault-legacy-001");
      expect(record.ownerAddress).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(record.prizePoolId).toBeDefined();
      expect(record.depositTotal).toMatch(/^\d+$/);
    });

    it("migrates a clean legacy record into a current valid record", () => {
      const result = migrateLegacyVaultRecord(LEGACY_FIXTURES.clean);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.vaultId).toBe(LEGACY_FIXTURES.clean.vaultId);
        expect(typeof result.value.depositTotal).toBe("bigint");
        expect(result.value.schemaVersion).toBe(
          SCHEMA_VERSIONS.DATABASE.replace(/^(\d+)\.(\d+)\.(\d+)$/, "$1.$2.0"),
        );
      }
    });

    // Acceptance criteria: missing field
    it("fails to migrate a legacy record missing a required field", () => {
      const result = migrateLegacyVaultRecord(LEGACY_FIXTURES.missingField);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("prizePoolId");
      }
    });

    // Acceptance criteria: deprecated field
    it("migrates a legacy record that carries a deprecated field", () => {
      const record = LEGACY_FIXTURES.deprecatedField;
      expect(record.legacyPrizePoolId).toBeDefined();
      const result = migrateLegacyVaultRecord(record);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.prizePoolId).toBe(record.prizePoolId);
        expect("deprecated" in result.value).toBe(false);
      }
    });

    // Acceptance criteria: incompatible legacy record
    it("rejects an incompatible legacy record", () => {
      const result = migrateLegacyVaultRecord(LEGGACY_FIXTURES.incompatible);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/vaultId|ownerAddress|depositTotal/);
      }
    });
  });
});
