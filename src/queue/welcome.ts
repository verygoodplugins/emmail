import type { Env, WelcomeSendMessage } from "../env";
import { CampaignRepository } from "../db/campaign-repository";
import { ContactRepository } from "../db/contact-repository";
import { renderCampaignEmail } from "../email/render";
import { WELCOME_PREVIEW, WELCOME_SUBJECT, welcomeMarkdown } from "../email/welcome";
import { formatFromHeader } from "../lib/email";
import { isIdempotencyConflict, isRetryableResendError, stringifyResendError } from "../lib/resend-errors";
import { signToken } from "../lib/tokens";

export interface ResendEmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface ResendEmailAdapter {
  sendEmail(
    message: ResendEmailMessage,
    options: { idempotencyKey: string }
  ): Promise<{ data: { id: string } | null; error: unknown | null }>;
}

export interface WelcomeSendResult {
  status: "sent" | "dry-run" | "skipped" | "conflict" | "failed";
  contactId: string;
  reason?: string;
  resendEmailId?: string;
}

export function isWelcomeEnabled(env: Env): boolean {
  return env.EMMAIL_WELCOME_ENABLED === "true";
}

// Called from the ingest route after a contact-form submission. Enqueues a
// one-shot welcome job unless this contact was already sent one. The gate is
// `welcome_sent` (recorded only after a successful send/dry-run), NOT a
// pre-enqueue marker — so a failed enqueue leaves no trace and the next ingest
// re-tries (self-healing). At-most-once *delivery* is enforced downstream: the
// consumer re-checks welcome_sent and the Resend key welcome/{contactId}
// dedupes, so duplicate messages from rapid resubmits are harmless.
// Best-effort: the caller must not let a failure here fail ingest.
export async function maybeEnqueueWelcome(env: Env, contactId: string): Promise<boolean> {
  if (!isWelcomeEnabled(env)) {
    return false;
  }
  const campaigns = new CampaignRepository(env.DB);
  if (await campaigns.hasContactEvent(contactId, ["welcome_sent"])) {
    return false;
  }
  await env.SEND_QUEUE.send({ type: "welcome", contactId });
  return true;
}

// Queue consumer for welcome messages. Terminal conditions (missing contact,
// not subscribed, already sent, non-retryable send error) resolve normally so
// the message is acked; only genuinely retryable Resend errors throw so the
// queue redelivers. Mirrors processCampaignSend's retry discipline.
export async function processWelcomeSend(
  env: Env,
  message: WelcomeSendMessage,
  resend: ResendEmailAdapter
): Promise<WelcomeSendResult> {
  const { contactId } = message;
  const campaigns = new CampaignRepository(env.DB);
  const contacts = new ContactRepository(env.DB);

  const contact = await contacts.getContactById(contactId);
  if (!contact) {
    return { status: "skipped", contactId, reason: "contact-not-found" };
  }
  // status already reflects suppression: suppressEmail() sets unsubscribed /
  // bounced for unsubscribe / bounce / complaint.
  if (contact.status !== "subscribed") {
    await campaigns.recordEvent({ contactId, type: "welcome_skipped", metadata: { reason: `status:${contact.status}` } });
    return { status: "skipped", contactId, reason: `status:${contact.status}` };
  }
  // Redelivery after a successful send.
  if (await campaigns.hasContactEvent(contactId, ["welcome_sent"])) {
    return { status: "skipped", contactId, reason: "already-sent" };
  }

  const { html, text } = await renderCampaignEmail({
    previewText: WELCOME_PREVIEW,
    markdownBody: welcomeMarkdown(contact.first_name)
  });

  if (env.EMMAIL_SEND_MODE !== "live") {
    await campaigns.recordEvent({ contactId, type: "welcome_sent", providerEventId: "dry-run", metadata: { mode: "dry-run" } });
    return { status: "dry-run", contactId };
  }

  const unsubscribeUrl = await contactUnsubscribeUrl(env, contactId);
  const result = await resend.sendEmail(
    {
      from: formatFromHeader(env.DEFAULT_FROM_NAME, env.DEFAULT_FROM_EMAIL),
      to: [contact.email],
      subject: WELCOME_SUBJECT,
      html,
      text: `${text}\n\nUnsubscribe: ${unsubscribeUrl}`,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    },
    { idempotencyKey: `welcome/${contactId}` }
  );

  if (result.error || !result.data) {
    if (isRetryableResendError(result.error)) {
      throw new Error(`Retryable Resend welcome error: ${stringifyResendError(result.error)}`);
    }
    if (isIdempotencyConflict(result.error)) {
      // The welcome already went out under this key; record and move on.
      await campaigns.recordEvent({ contactId, type: "welcome_sent", providerEventId: "conflict", metadata: { mode: "conflict" } });
      return { status: "conflict", contactId };
    }
    const error = stringifyResendError(result.error);
    await campaigns.recordEvent({ contactId, type: "welcome_failed", metadata: { error } });
    return { status: "failed", contactId, reason: error };
  }

  await campaigns.recordEvent({ contactId, type: "welcome_sent", providerEventId: result.data.id, metadata: { mode: "live" } });
  return { status: "sent", contactId, resendEmailId: result.data.id };
}

async function contactUnsubscribeUrl(env: Env, contactId: string): Promise<string> {
  const token = await signToken(env.TRACKING_SECRET, "unsubscribe-contact", [contactId]);
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/unsubscribe/c/${contactId}/${token}`;
}
