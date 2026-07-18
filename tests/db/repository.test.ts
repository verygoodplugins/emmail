import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";

describe("D1 repositories", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await createSqliteD1();
    await applyMigrations(db);
  });

  it("upserts contacts and assigns lists and tags from imports", async () => {
    const contacts = new ContactRepository(db);
    const result = await contacts.importContacts([
      {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        status: "subscribed",
        lists: ["Newsletter"],
        tags: ["donor"]
      },
      {
        email: "grace@example.com",
        firstName: "Grace",
        lastName: "Hopper",
        status: "subscribed",
        lists: ["Newsletter"],
        tags: ["vip"]
      }
    ]);

    expect(result).toEqual({ imported: 2 });
    await contacts.importContacts([
      {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Byron",
        status: "subscribed",
        lists: ["Newsletter", "Clergy"],
        tags: ["donor"]
      }
    ]);

    const rows = await contacts.listContacts({ limit: 10, offset: 0 });
    expect(rows.map((row) => row.email)).toEqual(["ada@example.com", "grace@example.com"]);
    expect(rows[0].lastName).toBe("Byron");
    expect(rows[0].lists).toEqual(["Clergy", "Newsletter"]);
    expect(rows[0].tags).toEqual(["donor"]);
  });

  it("snapshots a campaign audience from lists and tags while excluding suppressions", async () => {
    const contacts = new ContactRepository(db);
    const campaigns = new CampaignRepository(db);
    await contacts.importContacts([
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", status: "subscribed", lists: ["Newsletter"], tags: ["vip"] },
      { email: "grace@example.com", firstName: "Grace", lastName: "Hopper", status: "subscribed", lists: ["Newsletter"], tags: ["vip"] },
      { email: "skip@example.com", firstName: "Skip", lastName: "Me", status: "subscribed", lists: ["Newsletter"], tags: ["vip"] }
    ]);
    await contacts.suppressEmail("skip@example.com", "unsubscribe", "test");

    const campaign = await campaigns.createCampaign({
      name: "June update",
      subject: "June update",
      previewText: "A short note",
      markdownBody: "Hello [site](https://example.com)",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
    });

    const snapshot = await campaigns.snapshotAudience(campaign.id);
    expect(snapshot.createdRecipients).toBe(2);
    expect(snapshot.skippedSuppressed).toBe(1);

    const recipients = await campaigns.listRecipientsForSend(campaign.id, 10);
    expect(recipients.map((recipient) => recipient.email)).toEqual(["ada@example.com", "grace@example.com"]);
  });
});
