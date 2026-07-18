import type { CampaignSendMessage, Env } from "../env";
import { CampaignRepository, type SendOutcome } from "../db/campaign-repository";
import { renderCampaignEmail } from "../email/render";
import { formatFromHeader } from "../lib/email";
import { signToken } from "../lib/tokens";
import { appendOpenPixel, extractLinks, rewriteLinksForRecipient } from "../lib/tracking";

export interface ResendBatchAdapter {
  sendBatch(messages: ResendBatchMessage[], options: { idempotencyKey: string }): Promise<{ data: Array<{ id: string }> | null; error: unknown | null }>;
}

export interface ResendBatchMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface CampaignSendResult {
  attempted: number;
  sent: number;
  failed: number;
  batchIndex: number;
  requeued: boolean;
}

// Each queue message is a stateless "drain the next batch" token. The batch
// index lives on the campaign row (last_completed_batch) and only advances in
// the same atomic write that records the batch's outcomes, so a redelivered
// message always re-derives the correct index and an identical Resend
// idempotency key + payload — no duplicate sends across retries.
export async function processCampaignSend(
  env: Env,
  message: CampaignSendMessage,
  resend: ResendBatchAdapter
): Promise<CampaignSendResult> {
  const campaigns = new CampaignRepository(env.DB);
  const campaign = await campaigns.getCampaign(message.campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${message.campaignId}`);
  }

  const batchIndex = (campaign.lastCompletedBatch ?? -1) + 1;
  const recipients = await campaigns.listRecipientsForSend(campaign.id, message.limit);
  if (recipients.length === 0) {
    await campaigns.updateCampaignStatus(campaign.id, "sent");
    return { attempted: 0, sent: 0, failed: 0, batchIndex, requeued: false };
  }

  let outcomes: SendOutcome[];
  if (env.EMMAIL_SEND_MODE !== "live") {
    outcomes = recipients.map((recipient) => ({ recipient, status: "dry-run" as const }));
  } else {
    const rendered = await renderCampaignEmail({
      previewText: campaign.previewText,
      markdownBody: campaign.markdownBody
    });
    const links = await campaigns.ensureLinks(campaign.id, extractLinks(rendered.html).map((link) => link.url));

    const messages: ResendBatchMessage[] = [];
    for (const recipient of recipients) {
      const unsubscribeToken = await signToken(env.TRACKING_SECRET, "unsubscribe", [recipient.id]);
      const unsubscribeUrl = `${trimSlash(env.APP_BASE_URL)}/unsubscribe/${recipient.id}/${unsubscribeToken}`;
      const linkedHtml = await rewriteLinksForRecipient(rendered.html, {
        baseUrl: env.APP_BASE_URL,
        recipientId: recipient.id,
        links,
        tokenSecret: env.TRACKING_SECRET
      });
      const trackedHtml = await appendOpenPixel(linkedHtml, {
        baseUrl: env.APP_BASE_URL,
        campaignId: campaign.id,
        recipientId: recipient.id,
        tokenSecret: env.TRACKING_SECRET
      });

      messages.push({
        from: formatFromHeader(campaign.fromName, campaign.fromEmail),
        to: [recipient.email],
        subject: campaign.subject,
        html: trackedHtml,
        text: `${rendered.text}\n\nUnsubscribe: ${unsubscribeUrl}`,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      });
    }

    const result = await resend.sendBatch(messages, {
      idempotencyKey: `batch-campaign/${campaign.id}/${batchIndex}`
    });
    if (result.error || !result.data) {
      if (isRetryableResendError(result.error)) {
        throw new Error(`Retryable Resend batch error: ${stringifyError(result.error)}`);
      }
      const error = stringifyError(result.error);
      outcomes = recipients.map((recipient) => ({ recipient, status: "failed" as const, error }));
    } else {
      const data = result.data;
      outcomes = recipients.map((recipient, index) => {
        const providerResult = data[index];
        return providerResult?.id
          ? { recipient, status: "sent" as const, resendEmailId: providerResult.id }
          : { recipient, status: "failed" as const, error: "Missing Resend batch result" };
      });
    }
  }

  await campaigns.applySendResults({ campaignId: campaign.id, batchIndex, outcomes });

  const pending = await campaigns.countRecipientsByStatus(campaign.id, "pending");
  let requeued = false;
  if (pending > 0) {
    await env.SEND_QUEUE.send({ campaignId: campaign.id, limit: message.limit });
    requeued = true;
  } else {
    await campaigns.updateCampaignStatus(campaign.id, "sent");
  }

  const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
  return {
    attempted: recipients.length,
    sent: recipients.length - failed,
    failed,
    batchIndex,
    requeued
  };
}

// Errors that a redelivery can plausibly clear; anything else is marked as a
// final per-recipient failure so the batch chain keeps advancing.
function isRetryableResendError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return (
    name === "rate_limit_exceeded" ||
    name === "internal_server_error" ||
    name === "concurrent_idempotent_requests"
  );
}

function stringifyError(error: unknown): string {
  if (!error) {
    return "Unknown Resend batch error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
