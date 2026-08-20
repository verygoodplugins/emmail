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
    // No campaign recipient — this may be a welcome email, which stores its
    // provider id on a welcome_sent event instead of a recipient row.
    await handleWelcomeWebhookEvent(campaigns, contacts, event, providerId);
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

// Suppress/record for a welcome email (no campaign_recipients row) resolved via
// its welcome_sent event, so bounces and complaints still opt the contact out.
async function handleWelcomeWebhookEvent(
  campaigns: CampaignRepository,
  contacts: ContactRepository,
  event: ResendWebhookEvent,
  providerId: string
): Promise<void> {
  const welcome = await campaigns.findWelcomeContactByProviderId(providerId);
  if (!welcome) {
    return;
  }

  if (event.type === "email.delivered") {
    await campaigns.recordEvent({
      contactId: welcome.contactId,
      type: "welcome_delivered",
      providerEventId: providerId,
    });
    return;
  }

  if (event.type === "email.bounced") {
    await contacts.suppressEmail(welcome.email, "bounce", "resend-webhook", providerId);
    await campaigns.recordEvent({
      contactId: welcome.contactId,
      type: "welcome_bounced",
      providerEventId: providerId,
    });
    return;
  }

  if (event.type === "email.complained") {
    await contacts.suppressEmail(welcome.email, "complaint", "resend-webhook", providerId);
    await campaigns.recordEvent({
      contactId: welcome.contactId,
      type: "welcome_complained",
      providerEventId: providerId,
    });
  }
}
