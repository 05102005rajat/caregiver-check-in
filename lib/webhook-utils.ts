import type { Call } from "@/types/db";

/**
 * True if this call was already fully processed. Webhook providers can redeliver the
 * same event (e.g. our response lost in transit); reprocessing a completed/failed call
 * would call Claude again and could send a duplicate concern/miss-alert SMS to family.
 */
export function isAlreadyProcessed(status: Call["status"]): boolean {
  return status === "completed" || status === "failed";
}
