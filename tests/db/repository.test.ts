import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignConflictError, CampaignRepository } from "../../src/db/campaign-repository";
import {
  AutomationConflictError,
  AutomationEmptyStepsError,
  AutomationRepository,
  AutomationValidationError
} from "../../src/db/automation-repository";

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
    // Ordering ties on created_at break on the random recipient id — stable
    // across retries of the same batch, but not alphabetical.
    expect(recipients.map((recipient) => recipient.email).sort()).toEqual(["ada@example.com", "grace@example.com"]);
    expect((await campaigns.getCampaign(campaign.id))?.status).toBe("sending");

    const resumed = await campaigns.snapshotAudience(campaign.id);
    expect(resumed.createdRecipients).toBe(0);
    await expect(campaigns.updateCampaign(campaign.id, {
      name: "Too late",
      subject: "Too late",
      previewText: "",
      markdownBody: "Nope",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
    })).rejects.toThrow(CampaignConflictError);
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

  it("updates an existing campaign's copy and audience", async () => {
    const campaigns = new CampaignRepository(db);
    const campaign = await campaigns.createCampaign({
      name: "June update",
      subject: "June update",
      previewText: "A short note",
      markdownBody: "Hello",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: [] }
    });

    const updated = await campaigns.updateCampaign(campaign.id, {
      name: "July update",
      subject: "July notes",
      previewText: "Later note",
      markdownBody: "Hello again",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
    });

    expect(updated).toMatchObject({
      id: campaign.id,
      name: "July update",
      subject: "July notes",
      previewText: "Later note",
      markdownBody: "Hello again",
      audience: { listIds: ["Newsletter"], tagIds: ["vip"] },
      status: "draft"
    });
    expect(await campaigns.updateCampaign("cmp_missing", {
      name: "Nope",
      subject: "Nope",
      previewText: "",
      markdownBody: "Nope",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: [], tagIds: [] }
    })).toBeNull();

    await campaigns.updateCampaignStatus(campaign.id, "sending");
    await expect(campaigns.updateCampaign(campaign.id, {
      name: "Too late",
      subject: "Too late",
      previewText: "",
      markdownBody: "Nope",
      fromName: "EmMail",
      fromEmail: "news@example.com",
      audience: { listIds: ["Newsletter"], tagIds: [] }
    })).rejects.toThrow(CampaignConflictError);
  });
});

describe("AutomationRepository", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await createSqliteD1();
    await applyMigrations(db);
  });

  it("creates a disabled automation with a unique slug", async () => {
    const repo = new AutomationRepository(db);
    const first = await repo.createAutomation("Onboarding flow");
    const second = await repo.createAutomation("Onboarding flow");

    expect(first).toMatchObject({
      name: "Onboarding flow",
      slug: "onboarding-flow",
      triggerType: "contact_created",
      enabled: false,
      steps: []
    });
    expect(second.slug).toBe("onboarding-flow-2");
  });

  it("updates the automation name while disabled", async () => {
    const repo = new AutomationRepository(db);
    const created = await repo.createAutomation("Draft sequence");
    const updated = await repo.updateAutomationName(created.id, "Renamed sequence");

    expect(updated?.name).toBe("Renamed sequence");
  });

  it("replaces steps atomically while disabled", async () => {
    const repo = new AutomationRepository(db);
    const created = await repo.createAutomation("Draft sequence");
    const saved = await repo.replaceSteps(created.id, [
      {
        stepType: "send_email",
        config: { subject: "Hello", markdownBody: "Hi **there**" }
      },
      {
        stepType: "wait",
        config: { seconds: 60 }
      },
      {
        stepType: "add_tag",
        config: { tagName: "onboarded" }
      }
    ]);

    expect(saved?.steps).toHaveLength(3);
    expect(saved?.steps[0]).toMatchObject({
      position: 0,
      stepType: "send_email",
      config: { subject: "Hello", markdownBody: "Hi **there**" }
    });
    expect(saved?.steps[1]).toMatchObject({ position: 1, stepType: "wait", config: { seconds: 60 } });
    expect(saved?.steps[2]).toMatchObject({ position: 2, stepType: "add_tag", config: { tagName: "onboarded" } });
  });

  it("rejects writes while enabled", async () => {
    const repo = new AutomationRepository(db);
    const created = await repo.createAutomation("Live sequence");
    await repo.replaceSteps(created.id, [
      { stepType: "wait", config: { seconds: 30 } }
    ]);
    await repo.setEnabled(created.id, true);

    await expect(repo.updateAutomationName(created.id, "Blocked")).rejects.toThrow(AutomationConflictError);
    await expect(
      repo.replaceSteps(created.id, [{ stepType: "wait", config: { seconds: 60 } }])
    ).rejects.toThrow(AutomationConflictError);
  });

  it("rejects enabling an automation with no steps", async () => {
    const repo = new AutomationRepository(db);
    const created = await repo.createAutomation("Empty sequence");

    await expect(repo.setEnabled(created.id, true)).rejects.toThrow(AutomationEmptyStepsError);
  });

  it("validates step configs before replacing", async () => {
    const repo = new AutomationRepository(db);
    const created = await repo.createAutomation("Draft sequence");

    await expect(
      repo.replaceSteps(created.id, [{ stepType: "send_email", config: { subject: "", markdownBody: "" } }])
    ).rejects.toThrow(AutomationValidationError);
    await expect(
      repo.replaceSteps(created.id, [{ stepType: "wait", config: { seconds: 0 } }])
    ).rejects.toThrow(AutomationValidationError);
    await expect(
      repo.replaceSteps(created.id, [{ stepType: "add_tag", config: { tagName: "" } }])
    ).rejects.toThrow(AutomationValidationError);
    await expect(
      repo.replaceSteps(created.id, [{ stepType: "wait", config: undefined as unknown as Record<string, unknown> }])
    ).rejects.toThrow(AutomationValidationError);
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
