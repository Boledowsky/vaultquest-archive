import type { PrismaClient } from "@prisma/client";
import { SCHEMA_VERSIONS, getVersionMismatch } from "../constants.js";

/**
 * Versioned API response contract for schema version endpoints.
 *
 * Versioning rules:
 * - The `version` field is a monotonically increasing integer per response type.
 * - Adding optional fields is a non-breaking change and does not bump the version.
 * - Removing fields, changing field types, or making optional fields required is a
 *   breaking change and MUST bump the version and update the schema below.
 * - Deprecated fields are retained for at least one major version and marked with
 *   `deprecated: true` in the schema before removal.
 */
export const SCHEMA_VERSION_RESPONSE_VERSION = 1;

/**
 * JSON schema for the schema version validation response.
 * Used by contract tests to detect breaking changes early.
 */
export const schemaVersionResponseSchema = {
  $id: "https://vaultquest.dev/schemas/schema-version-response.json",
  type: "object",
  required: ["version", "valid", "databaseVersion", "indexerVersion", "issues"],
  additionalProperties: false,
  properties: {
    version: { type: "integer", const: SCHEMA_VERSION_RESPONSE_VERSION },
    valid: { type: "boolean" },
    databaseVersion: { type: "string" },
    indexerVersion: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * JSON schema for the schema version info response.
 */
export const schemaVersionInfoResponseSchema = {
  $id: "https://vaultquest.dev/schemas/schema-version-info-response.json",
  type: "object",
  required: ["version", "database", "indexer"],
  additionalProperties: false,
  properties: {
    version: { type: "integer", const: SCHEMA_VERSION_RESPONSE_VERSION },
    database: {
      type: "object",
      required: ["current", "expected", "supported"],
      additionalProperties: false,
      properties: {
        current: { type: "string" },
        expected: { type: "string" },
        supported: { type: "array", items: { type: "string" } },
      },
    },
    indexer: {
      type: "object",
      required: ["current", "expected", "supported"],
      additionalProperties: false,
      properties: {
        current: { type: "string" },
        expected: { type: "string" },
        supported: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

/**
 * Service for validating database and indexer schema versions
 * Prevents deployment with incompatible schemas
 */
export class SchemaVersionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Get current database schema version from migrations
   */
  async getDatabaseVersion(): Promise<string> {
    try {
      // Query the _prisma_migrations table to get the latest applied migration
      const result = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name 
        FROM _prisma_migrations 
        ORDER BY finished_at DESC 
        LIMIT 1
      `;
      
      if (result && result.length > 0) {
        // Extract version from migration name (e.g., "20260725000002_add_wallet_auth")
        const migrationName = result[0].migration_name;
        const versionMatch = migrationName.match(/^(\d{14})/);
        return versionMatch ? versionMatch[1] : "unknown";
      }
      
      return "unknown";
    } catch (error) {
      console.error("Failed to get database version:", error);
      return "unknown";
    }
  }

  /**
   * Get current indexer schema version
   * Reads from the indexer_version field populated by the indexer on startup.
   */
  async getIndexerVersion(): Promise<string> {
    try {
      const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
        where: { id: "singleton" },
      });
      
      // Reads the real version from the checkpoint table
      return checkpoint?.indexerVersion || "unknown";
    } catch (error) {
      console.error("Failed to get indexer version:", error);
      return "unknown";
    }
  }

  /**
   * Perform preflight validation check
   * Throws error if schemas are incompatible
   */
  async validateSchemaVersions(): Promise<{
    version: number;
    valid: boolean;
    databaseVersion: string;
    indexerVersion: string;
    issues: string[];
  }> {
    const dbVersion = await this.getDatabaseVersion();
    const indexerVersion = await this.getIndexerVersion();
    
    const { compatible, issues } = getVersionMismatch(dbVersion, indexerVersion);
    
    return {
      version: SCHEMA_VERSION_RESPONSE_VERSION,
      valid: compatible,
      databaseVersion: dbVersion,
      indexerVersion: indexerVersion,
      issues,
    };
  }

  /**
   * Get version information for monitoring
   */
  async getVersionInfo() {
    const dbVersion = await this.getDatabaseVersion();
    const indexerVersion = await this.getIndexerVersion();
    
    return {
      version: SCHEMA_VERSION_RESPONSE_VERSION,
      database: {
        current: dbVersion,
        expected: SCHEMA_VERSIONS.DATABASE,
        supported: SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS,
      },
      indexer: {
        current: indexerVersion,
        expected: SCHEMA_VERSIONS.INDEXER,
        supported: SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS,
      },
    };
  }
}
