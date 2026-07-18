import { CampaignRepository } from "../db/campaign-repository";
import { ContactRepository } from "../db/contact-repository";
import { normalizeEmail, parseNameParts } from "../lib/email";

export interface SouthOzarksContactMessage {
  id: number | string;
  name: string;
  email: string;
  phone?: string;
  message?: string;
  source?: string;
  createdAt?: string;
}

export async function ingestSouthOzarksContactMessage(
  db: D1Database,
  input: SouthOzarksContactMessage
): Promise<{ contact: { id: string; email: string }; duplicate: boolean }> {
  const email = normalizeEmail(String(input.email ?? ""));
  if (!email) {
    throw new Error("Invalid contact email");
  }

  const providerEventId = `contact_messages:${String(input.id)}`;
  const existingEvent = await db.prepare(
    "SELECT id FROM events WHERE provider_event_id = ? AND type = 'contact_ingested' LIMIT 1"
  ).bind(providerEventId).first<{ id: string }>();

  const nameParts = parseNameParts(String(input.name ?? ""));
  const contacts = new ContactRepository(db);
  await contacts.importContacts([{
    email,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    status: "subscribed",
    lists: ["South & Ozarks"],
    tags: ["contact-form", "website-inquiry"]
  }]);

  const contact = await contacts.getContactByEmail(email);
  if (!contact) {
    throw new Error("Contact ingest failed");
  }

  if (!existingEvent) {
    await new CampaignRepository(db).recordEvent({
      contactId: contact.id,
      type: "contact_ingested",
      providerEventId,
      metadata: {
        source: input.source ?? "contact-form",
        phone: input.phone ?? "",
        message: input.message ?? "",
        createdAt: input.createdAt ?? ""
      }
    });
  }

  return { contact: { id: contact.id, email: contact.email }, duplicate: Boolean(existingEvent) };
}

export async function verifySharedSecret(expected: string, actual: string | null): Promise<boolean> {
  if (!expected || !actual) {
    return false;
  }

  const encoder = new TextEncoder();
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual))
  ]);
  const expectedBytes = new Uint8Array(expectedHash);
  const actualBytes = new Uint8Array(actualHash);
  let diff = expectedBytes.length ^ actualBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= expectedBytes[index] ^ (actualBytes[index] ?? 0);
  }
  return diff === 0;
}
