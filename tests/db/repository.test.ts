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

  it("applies batch send results atomically with the batch marker", async () => {
    const campaigns = new CampaignRepository(db);
    const { campaign, recipients } = await seedRecipients(db, 3);

    await campaigns.applySendResults({
      campaignId: campaign.id,
      batchIndex: 0,
      outcomes: [
        { recipient: recipients[0], status: "sent", resendEmailId: "email_1" },
        { recipient: recipients[1], status: "dry-run" },
        { recipient: recipients[2], status: "failed", error: "boom" }
      ]
    });

    const sent = await campaigns.getRecipient(recipients[0].id);
    expect(sent).toMatchObject({ status: "sent", resendEmailId: "email_1" });
    const dryRun = await campaigns.getRecipient(recipients[1].id);
    expect(dryRun).toMatchObject({ status: "sent", resendEmailId: "dry-run" });
    const failed = await campaigns.getRecipient(recipients[2].id);
    expect(failed).toMatchObject({ status: "failed" });

    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.lastCompletedBatch).toBe(0);

    const eventTypes = await db.prepare(
      "SELECT type, contact_id FROM events WHERE campaign_id = ? ORDER BY type ASC"
    ).bind(campaign.id).all();
    expect((eventTypes.results ?? []).map((row) => (row as { type: string }).type)).toEqual([
      "send",
      "send",
      "send_failed"
    ]);
    expect((eventTypes.results ?? []).every((row) => (row as { contact_id: string | null }).contact_id)).toBe(true);
  });

  it("counts recipients by status and rolls up campaign stats", async () => {
    const campaigns = new CampaignRepository(db);
    const { campaign, recipients } = await seedRecipients(db, 3);

    expect(await campaigns.countRecipientsByStatus(campaign.id, "pending")).toBe(3);

    await campaigns.markRecipientSent(recipients[0].id, "email_1");
    await campaigns.markRecipientEvent(recipients[0].id, "opened");
    await campaigns.markRecipientSent(recipients[1].id, "email_2");
    await campaigns.markRecipientFailed(recipients[2].id, "boom");

    expect(await campaigns.countRecipientsByStatus(campaign.id, "pending")).toBe(0);
    expect(await campaigns.getCampaignStats(campaign.id)).toEqual({
      total: 3,
      sent: 2,
      delivered: 0,
      opened: 1,
      clicked: 0,
      pending: 0,
      failed: 1
    });
  });

  it("returns zeroed stats for a campaign with no recipients", async () => {
    const campaigns = new CampaignRepository(db);
    expect(await campaigns.getCampaignStats("cmp_missing")).toEqual({
      total: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      pending: 0,
      failed: 0
    });
  });
});

async function seedRecipients(db: D1Database, count: number) {
  const contacts = new ContactRepository(db);
  const campaigns = new CampaignRepository(db);
  await contacts.importContacts(
    Array.from({ length: count }, (_, index) => ({
      email: `contact${index}@example.com`,
      firstName: `Contact${index}`,
      lastName: "Test",
      status: "subscribed",
      lists: ["Newsletter"],
      tags: []
    }))
  );
  const campaign = await campaigns.createCampaign({
    name: "June update",
    subject: "June update",
    previewText: "A short note",
    markdownBody: "Hello [site](https://example.com)",
    fromName: "EmMail",
    fromEmail: "news@example.com",
    audience: { listIds: ["Newsletter"], tagIds: [] }
  });
  await campaigns.snapshotAudience(campaign.id);
  const recipients = await campaigns.listRecipientsForSend(campaign.id, count);
  return { campaign, recipients };
}
