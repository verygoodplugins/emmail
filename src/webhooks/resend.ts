import { CampaignRepository } from "../db/campaign-repository";
import { ContactRepository } from "../db/contact-repository";

export type ResendWebhookVerifier = (payload: string, headers: Headers, secret: string) => unknown;

interface ResendWebhookEvent {
  type: string;
  data?: {
    email_id?: string;
    to?: string[];
  };
}

export async function handleVerifiedResendWebhook(
  db: D1Database,
  payload: string,
  headers: Headers,
  secret: string,
  verify: ResendWebhookVerifier
): Promise<void> {
  const event = verify(payload, headers, secret) as ResendWebhookEvent;
  const providerId = event.data?.email_id;
  if (!providerId) {
    return;
  }

  const campaigns = new CampaignRepository(db);
  const contacts = new ContactRepository(db);
  const recipient = await campaigns.findRecipientByProviderId(providerId);
  if (!recipient) {
    return;
  }

  if (event.type === "email.delivered") {
    await campaigns.markRecipientEvent(recipient.id, "delivered", providerId);
    return;
  }

  if (event.type === "email.bounced") {
    await contacts.suppressEmail(recipient.email, "bounce", "resend-webhook", providerId);
    await campaigns.markRecipientEvent(recipient.id, "bounced", providerId);
    return;
  }

  if (event.type === "email.complained") {
    await contacts.suppressEmail(recipient.email, "complaint", "resend-webhook", providerId);
    await campaigns.markRecipientEvent(recipient.id, "complained", providerId);
  }
}
