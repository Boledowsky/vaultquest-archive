import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";
import { IMPORT_FORMAT_VERSION, IMPORT_MAX_ROWS, type DataImportService } from "../services/dataImport.js";

export interface DuplicateReport {
  key: string;
  severity: "exact" | "ambiguous";
  indexes: number[];
}

const importBody = z.object({
  format_version: z.literal(IMPORT_FORMAT_VERSION),
  /** Defaults to a dry run: committing requires an explicit `dry_run: false`. */
  dry_run: z.boolean().default(true),
  records: z.array(z.unknown()).max(IMPORT_MAX_ROWS),
});

/**
 * Post /imports/saved-pools (#773): imports into the caller's own wallet only.
 * Requires `own.data.import`; the wallet is taken from the session, never the body.
 */
export const importsRoutes = (svc: DataImportService, guard: preHandlerHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.post("/imports/saved-pools", { preHandler: [guard] }, async (req) => {
      const body = importBody.parse(req.body);
      const wallet = req.principal?.walletAddress;
      if (!wallet) throw AppError.forbidden("a wallet session is required to import data");
      const result = await svc.run({ wallet, records: body.records, dryRun: body.dry_run });
      const duplicates = detectDuplicates(body.records);
      if (duplicates.length > 0) {
        const exact = duplicates.filter((d) => d.severity === "exact");
        if (exact.length > 0) {
          throw AppError.conflict("exact duplicate records detected", { duplicates: exact });
        }
        return ok({ ...result, duplicates: duplicates.map((d) => ({ ...d, reviewRequired: true })) });
      }
      return ok(result);
    });
  };

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(canonicalize).join("|");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalize(v)] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([i, v]) => `${i}:${v}`).join("|");
  }
  return String(value);
}

function duplicateKey(record: unknown): string {
  if (record === null || typeof record !== "object") return canonicalize(record);
  const r = record as Record<string, unknown>;
  const fields = [
    "vaultAddress",
    "walletAddress",
    "chainId",
    "asset",
    "amount",
    "name",
  ];
  const parts = fields.filter((f) => f in r).map((f) => `${f}:${canonicalize(r[f])}`);
  if (parts.length > 0) return parts.join("|");
  return canonicalize(r);
}

export function detectDuplicates(records: unknown[]): DuplicateReport[] {
  const byKey = new Map<string, number[]>();
  records.forEach((record, index) => {
    const key = duplicateKey(record);
    const existing = byKey.get(key);
    if (existing) existing.push(index);
    else byKey.set(key, [index]);
  });
  const reports: DuplicateReport[] = [];
  for (const [key, indexes] of byKey) {
    if (indexes.length > 1) reports.push({ key, severity: "exact", indexes });
  }
  return reports;
}
