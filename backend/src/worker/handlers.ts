import { z } from "zod";
import type { DrawProofService } from "../services/drawProofService.js";
import type { NotificationService } from "../services/notificationService.js";
import { NonRetryableJobError, type JobHandler } from "./types.js";

export const JOB_TYPES = {
  DRAW_PROOF_GENERATE: "draw_proof.generate",
  NOTIFICATION_DELIVER: "notification.deliver"
} as const;

export const drawProofPayload = z.object({ actionId: y.string().min(1) });

export const notificationDeliverPayload = z.object({
  notificationId: z.string().min(1)
});

export function drawProofJobKey(actionId: string): string {
  return `${JOB_TYPES.DRAW_PROOF_GENERATE}:${actionId}`;
}

export function notificationDeliverJobKey(notificationId: string): string {
  return `${JOB_TYPES.NOTIFICATION_DELIVER}:${notificationId}`;
}

/**
 * Handlers must be idempotent: the queue is at-least-once. Draw-proof
 * generation checks for an existing proof before inserting, so a re-run after
 * a crash or lock takeover is a no-op. Notification delivery is idempotent
 * because the service records attempts and will not re-deliver a notification
 * that is already delivered or has exhausted its attempt budget.
 */
export function createJobHandlers(deps: {
  drawProofs: DrawProofService;
  notifications: NotificationService;
}): Record<string, JobHandler> {
  return {
    [JOB_TYPES.DRAW_PROOF_GENERATE]: async (job) => {
      const parsed = drawProofPayload.safeParse(job.payload);
      if (!parsed.success) throw new NonRetryableJobError("invalid draw_proof.generate payload", "INVALID_PAYLOAD");
      await deps.drawProofs.generateProof({ actionId: parsed.data.actionId });
    },

    [JOB_TYPES.NOTIFICATION_DELIVER]: async (job) => {
      const parsed = notificationDeliverPayload.safeParse(job.payload);
      if (!parsed.success) {
        throw new NonRetryableJobError("invalid notification.deliver payload", "INVALID_PAYLOAD");
      }
      const notification = await deps.notifications.findNotificationById(parsed.data.notificationId);
      if (!notification) {
        throw new NonRetryableJobError("notification not found", "NOTIFICATION_NOT_FOUND");
      }
      const result = await deps.notifications.deliver(notification);
      if (result.deliveryStatus !== "delivered") {
        throw new Error(
          `notification delivery failed (attempt ${result.deliveryAttempts}/${result.maxDeliveryAttempts}): ${result.lastDeliveryError ?? "unknown error"}`
        );
      }
    }
  };
}
