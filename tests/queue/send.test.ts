import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository, type CampaignRecord } from "../../src/db/campaign-repository";
import { processCampaignSend, type ResendBatchAdapter, type ResendBatchMessage } from "../../src/queue/send";
import type { CampaignSendMessage, Env } from "../../src/env";

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

  async function seedCampaign(contactCount: number): Promise<{ campaign: CampaignRecord; campaigns: CampaignRepository }> {
    const contacts = new ContactRepository(env.DB);
    const campaigns = new CampaignRepository(env.DB);
    await contacts.importContacts(
      Array.from({ length: contactCount }, (_, index) => ({
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
    return { campaign, campaigns };
  }

  function queuedMessages(): CampaignSendMessage[] {
    const send = env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
    return send.mock.calls.map((call) => call[0] as CampaignSendMessage);
  }

  // Simulates the queue consumer loop: process the first message, then every
  // continuation message the consumer enqueues, until the chain stops.
  async function drainQueue(first: CampaignSendMessage, adapter: ResendBatchAdapter) {
    const results = [];
    let message: CampaignSendMessage | undefined = first;
    for (let round = 0; message && round < 20; round += 1) {
      const result = await processCampaignSend(env, message, adapter);
      results.push(result);
      message = result.requeued ? queuedMessages().at(-1) : undefined;
    }
    return results;
  }

  function successAdapter(): { adapter: ResendBatchAdapter; sendBatch: ReturnType<typeof vi.fn> } {
    let counter = 0;
    const sendBatch = vi.fn(async (messages: ResendBatchMessage[]) => ({
      data: messages.map(() => ({ id: `email_${counter++}` })),
      error: null
    }));
    return { adapter: { sendBatch }, sendBatch };
  }

  it("sends pending recipients in Resend batches and records provider ids", async () => {
    const { campaign, campaigns } = await seedCampaign(1);
    const { adapter, sendBatch } = successAdapter();

    const result = await processCampaignSend(env, { campaignId: campaign.id, limit: 100 }, adapter);

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0, batchIndex: 0, requeued: false });
    const recipients = await campaigns.listRecipientsForSend(campaign.id, 10, ["sent"]);
    expect(recipients[0].resendEmailId).toBe("email_0");
    const calls = sendBatch.mock.calls as unknown as Array<[ResendBatchMessage[], { idempotencyKey: string }]>;
    const firstCall = calls[0]!;
    expect(firstCall[0][0]).toMatchObject({
      from: "EmMail <news@example.com>",
      to: ["contact0@example.com"],
      subject: "June update"
    });
    expect(firstCall[1]).toMatchObject({ idempotencyKey: `batch-campaign/${campaign.id}/0` });
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.status).toBe("sent");
    expect(after?.lastCompletedBatch).toBe(0);
    expect(env.SEND_QUEUE.send).not.toHaveBeenCalled();
  });

  it("drains audiences larger than one batch through continuation messages", async () => {
    const { campaign, campaigns } = await seedCampaign(5);
    const { adapter, sendBatch } = successAdapter();

    const results = await drainQueue({ campaignId: campaign.id, limit: 2 }, adapter);

    expect(results.map((result) => result.attempted)).toEqual([2, 2, 1]);
    expect(results.map((result) => result.batchIndex)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.requeued)).toEqual([true, true, false]);
    const keys = sendBatch.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([0, 1, 2].map((index) => `batch-campaign/${campaign.id}/${index}`));
    const sentEmails = sendBatch.mock.calls.flatMap((call) => (call[0] as ResendBatchMessage[]).map((message) => message.to[0]));
    expect(new Set(sentEmails).size).toBe(5);
    expect(queuedMessages()).toEqual([
      { campaignId: campaign.id, limit: 2 },
      { campaignId: campaign.id, limit: 2 }
    ]);
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.status).toBe("sent");
    expect(await campaigns.countRecipientsByStatus(campaign.id, "pending")).toBe(0);
  });

  it("processes the next batch when a committed message is redelivered", async () => {
    const { campaign } = await seedCampaign(4);
    const { adapter, sendBatch } = successAdapter();
    const message = { campaignId: campaign.id, limit: 2 };

    await processCampaignSend(env, message, adapter);
    // Redelivery of the same message after its batch committed: the derived
    // index moves forward, so the next pending recipients are sent instead of
    // duplicating batch 0.
    const redelivered = await processCampaignSend(env, message, adapter);

    expect(redelivered.batchIndex).toBe(1);
    const perCallEmails = sendBatch.mock.calls.map((call) => (call[0] as ResendBatchMessage[]).map((m) => m.to[0]));
    expect(perCallEmails[0]).not.toEqual(expect.arrayContaining(perCallEmails[1]));
    expect(new Set(perCallEmails.flat()).size).toBe(4);
  });

  it("repeats the identical batch and idempotency key when the send throws before committing", async () => {
    const { campaign } = await seedCampaign(2);
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      processCampaignSend(env, { campaignId: campaign.id, limit: 2 }, { sendBatch: failing })
    ).rejects.toThrow("network down");

    const { adapter, sendBatch } = successAdapter();
    const retry = await processCampaignSend(env, { campaignId: campaign.id, limit: 2 }, adapter);

    expect(retry.batchIndex).toBe(0);
    const failedCall = failing.mock.calls[0] as unknown as [ResendBatchMessage[], { idempotencyKey: string }];
    const retryCall = sendBatch.mock.calls[0] as unknown as [ResendBatchMessage[], { idempotencyKey: string }];
    expect(retryCall[1].idempotencyKey).toBe(failedCall[1].idempotencyKey);
    expect(retryCall[0].map((m) => m.to)).toEqual(failedCall[0].map((m) => m.to));
  });

  it("rethrows retryable Resend errors so the queue redelivers", async () => {
    const { campaign, campaigns } = await seedCampaign(1);
    const sendBatch = vi.fn(async () => ({
      data: null,
      error: { name: "rate_limit_exceeded", message: "slow down" }
    }));

    await expect(
      processCampaignSend(env, { campaignId: campaign.id, limit: 100 }, { sendBatch })
    ).rejects.toThrow("slow down");
    expect(await campaigns.countRecipientsByStatus(campaign.id, "pending")).toBe(1);
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.lastCompletedBatch).toBeNull();
  });

  it("marks the batch failed on a final Resend error and keeps the chain advancing", async () => {
    const { campaign, campaigns } = await seedCampaign(3);
    let calls = 0;
    const sendBatch = vi.fn(async (messages: ResendBatchMessage[]) => {
      calls += 1;
      if (calls === 1) {
        return { data: null, error: { name: "validation_error", message: "bad payload" } };
      }
      return { data: messages.map((_, index) => ({ id: `email_${index}` })), error: null };
    });

    const results = await drainQueue({ campaignId: campaign.id, limit: 2 }, { sendBatch });

    expect(results.map((result) => ({ sent: result.sent, failed: result.failed }))).toEqual([
      { sent: 0, failed: 2 },
      { sent: 1, failed: 0 }
    ]);
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.status).toBe("sent");
    expect(after?.lastCompletedBatch).toBe(1);
    expect(await campaigns.countRecipientsByStatus(campaign.id, "failed")).toBe(2);
    const failedEvent = await env.DB.prepare(
      "SELECT metadata_json FROM events WHERE type = 'send_failed' LIMIT 1"
    ).first<{ metadata_json: string }>();
    expect(JSON.parse(failedEvent!.metadata_json)).toMatchObject({ error: "bad payload" });
  });

  it("dry-runs pending recipients without calling Resend", async () => {
    env.EMMAIL_SEND_MODE = "dry-run";
    const { campaign, campaigns } = await seedCampaign(1);
    const { adapter, sendBatch } = successAdapter();

    const result = await processCampaignSend(env, { campaignId: campaign.id, limit: 100 }, adapter);

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0, batchIndex: 0, requeued: false });
    expect(sendBatch).not.toHaveBeenCalled();
    const recipients = await campaigns.listRecipientsForSend(campaign.id, 10, ["sent"]);
    expect(recipients[0].resendEmailId).toBe("dry-run");
    const event = await env.DB.prepare(
      "SELECT type, provider_event_id, metadata_json FROM events WHERE recipient_id = ?"
    ).bind(recipients[0].id).first<{ type: string; provider_event_id: string; metadata_json: string }>();
    expect(event).toMatchObject({ type: "send", provider_event_id: "dry-run" });
    expect(JSON.parse(event!.metadata_json)).toMatchObject({ mode: "dry-run" });
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.status).toBe("sent");
  });

  it("drains a multi-batch dry-run to a sent campaign", async () => {
    env.EMMAIL_SEND_MODE = "dry-run";
    const { campaign, campaigns } = await seedCampaign(5);
    const { adapter, sendBatch } = successAdapter();

    const results = await drainQueue({ campaignId: campaign.id, limit: 2 }, adapter);

    expect(results).toHaveLength(3);
    expect(sendBatch).not.toHaveBeenCalled();
    const after = await campaigns.getCampaign(campaign.id);
    expect(after?.status).toBe("sent");
    expect(await campaigns.countRecipientsByStatus(campaign.id, "pending")).toBe(0);
  });

  it("treats a message for a fully drained campaign as a no-op", async () => {
    const { campaign } = await seedCampaign(1);
    const { adapter, sendBatch } = successAdapter();
    const message = { campaignId: campaign.id, limit: 100 };

    await processCampaignSend(env, message, adapter);
    const stale = await processCampaignSend(env, message, adapter);

    expect(stale).toMatchObject({ attempted: 0, sent: 0, failed: 0, requeued: false });
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });
});
