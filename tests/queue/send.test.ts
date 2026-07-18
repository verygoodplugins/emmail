import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { processCampaignSend } from "../../src/queue/send";
import type { Env } from "../../src/env";

describe("campaign send queue", () => {
  let env: Env;

  beforeEach(async () => {
    const db = await createSqliteD1();
    await applyMigrations(db);
    env = {
      DB: db,
      SEND_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
      ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
      RESEND_API_KEY: "re_test",
      RESEND_WEBHOOK_SECRET: "whsec_test",
      TRACKING_SECRET: "track_secret",
      APP_BASE_URL: "https://mail.example.com",
      DEFAULT_FROM_EMAIL: "news@example.com",
      DEFAULT_FROM_NAME: "EmMail",
      EMMAIL_INGEST_SECRET: "ingest_secret",
      EMMAIL_SEND_MODE: "live"
    };
  });

  it("sends pending recipients in Resend batches and records provider ids", async () => {
    const contacts = new ContactRepository(env.DB);
    const campaigns = new CampaignRepository(env.DB);
    await contacts.importContacts([
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", status: "subscribed", lists: ["Newsletter"], tags: [] }
    ]);
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

    const sendBatch = vi.fn(async () => ({
      data: [{ id: "email_1" }],
      error: null
    }));

    const result = await processCampaignSend(env, { campaignId: campaign.id, limit: 100 }, { sendBatch });

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0 });
    const recipients = await campaigns.listRecipientsForSend(campaign.id, 10, ["sent"]);
    expect(recipients[0].resendEmailId).toBe("email_1");
    const calls = sendBatch.mock.calls as unknown as Array<[Array<Record<string, unknown>>, { idempotencyKey: string }]>;
    const firstCall = calls[0]!;
    const firstMessage = firstCall[0][0]!;
    expect(firstMessage).toMatchObject({
      from: "EmMail <news@example.com>",
      to: ["ada@example.com"],
      subject: "June update"
    });
    expect(firstCall[1]).toMatchObject({ idempotencyKey: `batch-campaign/${campaign.id}/0` });
  });

  it("dry-runs pending recipients without calling Resend", async () => {
    env.EMMAIL_SEND_MODE = "dry-run";
    const contacts = new ContactRepository(env.DB);
    const campaigns = new CampaignRepository(env.DB);
    await contacts.importContacts([
      { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", status: "subscribed", lists: ["Newsletter"], tags: [] }
    ]);
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
    const sendBatch = vi.fn(async () => ({ data: [{ id: "email_1" }], error: null }));

    const result = await processCampaignSend(env, { campaignId: campaign.id, limit: 100 }, { sendBatch });

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
    const recipients = await campaigns.listRecipientsForSend(campaign.id, 10, ["sent"]);
    expect(recipients[0].resendEmailId).toBe("dry-run");
    const event = await env.DB.prepare(
      "SELECT type, provider_event_id, metadata_json FROM events WHERE recipient_id = ?"
    ).bind(recipients[0].id).first<{ type: string; provider_event_id: string; metadata_json: string }>();
    expect(event).toMatchObject({ type: "send", provider_event_id: "dry-run" });
    expect(JSON.parse(event!.metadata_json)).toMatchObject({ mode: "dry-run" });
  });
});
