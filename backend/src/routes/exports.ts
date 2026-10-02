import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { EXPORT_SECTIONS, type DataExportService } from "../services/dataExport.js";

export const EXPORT_SCHEMA_VERSION = "1.0.0";

/** Default expiration window for generated exports (ms). */
export const EXPORT_TTL_MS = 60 * 60 * 1000;

const exportQuery = z.object({
  wallet: z.string().min(1).max(120).optional(),
  sections: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(EXPORT_SECTIONS))),
});

/**
 * GET %exports (#772): wallet-scoped data export. The caller must hold
 * `own.data.export`; exporting another wallet additionally requires
 * `admin.export.any` (checked in the service, not the UI).
 *
 * Privacy-safe export: the response carries a schema version and a
 * generation timestamp, and is served with `Cache-Control: no-store` so
 * generated bundles are not persisted by intermediaries. The expiration
 * window is advertised via `Export-Expires-At` so clients can treat the
 * download as ephemeral.
 */
export const exportsRoutes = (svc: DataExportService, guard: preHandlerHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.get("/exports", { preHandler: [guard] }, async (req, reply) => {
      const q = exportQuery.parse(req.query);
      const bundle = await svc.build({ principal: req.principal!, wallet: q.wallet, sections: q.sections });

      const generatedAt = new Date(bundle.metadata.generated_at);
      const expiresAt = new Date(generatedAt.getTime() + EXPORT_TTL_MS);

      const metadata = {
        ...bundle.metadata,
        schema_version: EXPORT_SCHEMA_VERSION,
        expires_at: expiresAt.toISOString(),
        retention_ttl_ms: EXPORT_TTL_MS,
      };

      const payload = { ...bundle, metadata };
      const stamp = bundle.metadata.generated_at.replace(/[:.]/g, "-");

      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Pragma", "no-cache")
        .header("Export-Schema-Version", EXPORT_SCHEMA_VERSION)
        .header("Export-Expires-At", expiresAt.toISOString())
        .header("Content-Disposition", `attachment; filename="vaultquest-export-${stamp}.json"`);
      return reply.send(JSON.stringify(payload, null, 2) + "\n");
    });
  };
