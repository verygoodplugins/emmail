import type { CampaignSendMessage, Env } from "../env";
import { CampaignRepository } from "../db/campaign-repository";
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

export async function processCampaignSend(
  env: Env,
  message: CampaignSendMessage,
  resend: ResendBatchAdapter
): Promise<{ attempted: number; sent: number; failed: number }> {
  const campaigns = new CampaignRepository(env.DB);
  const campaign = await campaigns.getCampaign(message.campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${message.campaignId}`);
  }

  const recipients = await campaigns.listRecipientsForSend(campaign.id, message.limit);
  if (recipients.length === 0) {
    await campaigns.updateCampaignStatus(campaign.id, "sent");
    return { attempted: 0, sent: 0, failed: 0 };
  }

  if (env.EMMAIL_SEND_MODE !== "live") {
    await Promise.all(recipients.map((recipient) => campaigns.markRecipientDryRun(recipient.id)));
    return { attempted: recipients.length, sent: recipients.length, failed: 0 };
  }

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

  const result = await resend.sendBatch(messages, { idempotencyKey: `batch-campaign/${campaign.id}/0` });
  if (result.error || !result.data) {
    const error = stringifyError(result.error);
    await Promise.all(recipients.map((recipient) => campaigns.markRecipientFailed(recipient.id, error)));
    return { attempted: recipients.length, sent: 0, failed: recipients.length };
  }

  let sent = 0;
  let failed = 0;
  for (let index = 0; index < recipients.length; index += 1) {
    const providerResult = result.data[index];
    if (providerResult?.id) {
      sent += 1;
      await campaigns.markRecipientSent(recipients[index].id, providerResult.id);
    } else {
      failed += 1;
      await campaigns.markRecipientFailed(recipients[index].id, "Missing Resend batch result");
    }
  }

  return { attempted: recipients.length, sent, failed };
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
