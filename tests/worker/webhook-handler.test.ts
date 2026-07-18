import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { handleVerifiedResendWebhook } from "../../src/webhooks/resend";

describe("Resend webhook handler", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await createSqliteD1();
    await applyMigrations(db);
  });

  it("uses the raw payload verifier and records bounce suppressions", async () => {
    const contacts = new ContactRepository(db);
    const campaigns = new CampaignRepository(db);
    await contacts.importContacts([
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", status: "subscribed", lists: ["Newsletter"], tags: [] }
    ]);
    const campaign = await campaigns.createCampaign({
      name: "June update",
      subject: "June update",
      previewText: "A short note",
      markdownBody: "Hello",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: [] }
    });
    await campaigns.snapshotAudience(campaign.id);
    const [recipient] = await campaigns.listRecipientsForSend(campaign.id, 10);
    await campaigns.markRecipientSent(recipient.id, "email_1");

    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "email_1", to: ["ada@example.com"] }
    });
    const verify = vi.fn(() => JSON.parse(payload));

    await handleVerifiedResendWebhook(db, payload, new Headers({ "svix-id": "msg_1" }), "secret", verify);

    expect(verify).toHaveBeenCalledWith(payload, expect.any(Headers), "secret");
    expect(await db.prepare("SELECT type FROM suppressions WHERE email = ?").bind("ada@example.com").first("type")).toBe("bounce");
    expect(await db.prepare("SELECT type FROM events WHERE recipient_id = ? AND type = 'bounced'").bind(recipient.id).first("type")).toBe("bounced");
  });
});
