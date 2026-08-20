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
      {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        status: "subscribed",
        lists: ["Newsletter"],
        tags: [],
      },
    ]);
    const campaign = await campaigns.createCampaign({
      name: "June update",
      subject: "June update",
      previewText: "A short note",
      markdownBody: "Hello",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: [] },
    });
    await campaigns.snapshotAudience(campaign.id);
    const [recipient] = await campaigns.listRecipientsForSend(campaign.id, 10);
    await campaigns.markRecipientSent(recipient.id, "email_1");

    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "email_1", to: ["ada@example.com"] },
    });
    const verify = vi.fn(() => JSON.parse(payload));

    await handleVerifiedResendWebhook(
      db,
      payload,
      new Headers({ "svix-id": "msg_1" }),
      "secret",
      verify
    );

    expect(verify).toHaveBeenCalledWith(payload, expect.any(Headers), "secret");
    expect(
      await db
        .prepare("SELECT type FROM suppressions WHERE email = ?")
        .bind("ada@example.com")
        .first("type")
    ).toBe("bounce");
    expect(
      await db
        .prepare("SELECT type FROM events WHERE recipient_id = ? AND type = 'bounced'")
        .bind(recipient.id)
        .first("type")
    ).toBe("bounced");
  });

  it("suppresses a welcome-email contact on bounce via its welcome_sent event", async () => {
    const contacts = new ContactRepository(db);
    const campaigns = new CampaignRepository(db);
    await contacts.importContacts([
      {
        email: "wel@example.com",
        firstName: "Wel",
        lastName: "Come",
        status: "subscribed",
        lists: [],
        tags: [],
      },
    ]);
    const contact = await contacts.getContactByEmail("wel@example.com");
    // A live welcome send records its Resend id on a welcome_sent event (no recipient row).
    await campaigns.recordEvent({
      contactId: contact!.id,
      type: "welcome_sent",
      providerEventId: "email_welcome_9",
      metadata: { mode: "live" },
    });

    const payload = JSON.stringify({
      type: "email.bounced",
      data: { email_id: "email_welcome_9", to: ["wel@example.com"] },
    });
    const verify = vi.fn(() => JSON.parse(payload));

    await handleVerifiedResendWebhook(
      db,
      payload,
      new Headers({ "svix-id": "msg_2" }),
      "secret",
      verify
    );

    expect(
      await db
        .prepare("SELECT type FROM suppressions WHERE email = ?")
        .bind("wel@example.com")
        .first("type")
    ).toBe("bounce");
    expect(
      await db
        .prepare("SELECT type FROM events WHERE contact_id = ? AND type = 'welcome_bounced'")
        .bind(contact!.id)
        .first("type")
    ).toBe("welcome_bounced");
  });
});
