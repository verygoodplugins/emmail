import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { handleRequest } from "../../src/worker";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { signToken } from "../../src/lib/tokens";
import type { Env } from "../../src/env";

describe("Worker welcome wiring", () => {
  let env: Env;

  beforeEach(async () => {
    const db = await createSqliteD1();
    await applyMigrations(db);
    env = {
      DB: db,
      SEND_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
      ASSETS: { fetch: vi.fn(async () => new Response("asset", { status: 404 })) } as unknown as Fetcher,
      RESEND_API_KEY: "re_test",
      RESEND_WEBHOOK_SECRET: "whsec_test",
      TRACKING_SECRET: "track_secret",
      APP_BASE_URL: "https://mail.example.com",
      DEFAULT_FROM_EMAIL: "news@example.com",
      DEFAULT_FROM_NAME: "EmMail",
      EMMAIL_INGEST_SECRET: "ingest_secret",
      EMMAIL_SEND_MODE: "live",
      EMMAIL_ADMIN_TOKEN: "admin_secret",
      EMMAIL_WELCOME_ENABLED: "true"
    };
  });

  function ingest(body: Record<string, unknown>): Promise<Response> {
    return handleRequest(new Request("https://mail.example.com/api/integrations/southandozarks/contact-message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-emmail-ingest-secret": "ingest_secret" },
      body: JSON.stringify(body)
    }), env);
  }

  function queuedMessages() {
    const send = env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
    return send.mock.calls.map((call) => call[0]);
  }

  it("enqueues a welcome for a freshly ingested lead", async () => {
    const response = await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    expect(response.status).toBe(200);

    const contact = await new ContactRepository(env.DB).getContactByEmail("ada@example.com");
    expect(queuedMessages()).toEqual([{ type: "welcome", contactId: contact!.id }]);
  });

  it("does not re-enqueue once the welcome has been sent", async () => {
    await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    const contact = await new ContactRepository(env.DB).getContactByEmail("ada@example.com");
    // Simulate the consumer having delivered the welcome.
    await new CampaignRepository(env.DB).recordEvent({ contactId: contact!.id, type: "welcome_sent", providerEventId: "dry-run" });

    // A second, distinct submission from the same person (new provider id).
    await ingest({ id: 2, name: "Ada Lovelace", email: "ada@example.com" });
    expect(env.SEND_QUEUE.send).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue for a duplicate ingest (same submission id)", async () => {
    await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    // Replay of the same contact-message id → duplicate → no second welcome.
    await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    expect(env.SEND_QUEUE.send).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue when the welcome flag is off", async () => {
    env.EMMAIL_WELCOME_ENABLED = "false";
    const response = await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    expect(response.status).toBe(200);
    expect(env.SEND_QUEUE.send).not.toHaveBeenCalled();
  });

  it("captures the lead and stays recoverable if welcome enqueue throws", async () => {
    (env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("queue down"));
    const response = await ingest({ id: 1, name: "Ada Lovelace", email: "ada@example.com" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const contact = await new ContactRepository(env.DB).getContactByEmail("ada@example.com");
    expect(contact).not.toBeNull();

    // No welcome_sent marker persisted on the failed enqueue, so a later
    // submission re-enqueues instead of silently dropping the welcome.
    await ingest({ id: 2, name: "Ada Lovelace", email: "ada@example.com" });
    expect(env.SEND_QUEUE.send).toHaveBeenCalledTimes(2);
  });

  describe("contact-scoped unsubscribe", () => {
    async function seedContact(email = "lead@example.com"): Promise<string> {
      const contacts = new ContactRepository(env.DB);
      await contacts.importContacts([{ email, firstName: "Lead", lastName: "", status: "subscribed", lists: [], tags: [] }]);
      const contact = await contacts.getContactByEmail(email);
      return contact!.id;
    }

    it("suppresses the contact on a valid one-click unsubscribe", async () => {
      const contactId = await seedContact();
      const token = await signToken(env.TRACKING_SECRET, "unsubscribe-contact", [contactId]);

      const response = await handleRequest(
        new Request(`https://mail.example.com/unsubscribe/c/${contactId}/${token}`),
        env
      );

      expect(response.status).toBe(200);
      const contact = await new ContactRepository(env.DB).getContactById(contactId);
      expect(contact?.status).toBe("unsubscribed");
    });

    it("accepts a one-click POST unsubscribe (RFC 8058)", async () => {
      const contactId = await seedContact("oneclick@example.com");
      const token = await signToken(env.TRACKING_SECRET, "unsubscribe-contact", [contactId]);

      const response = await handleRequest(
        new Request(`https://mail.example.com/unsubscribe/c/${contactId}/${token}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click"
        }),
        env
      );

      expect(response.status).toBe(200);
      const contact = await new ContactRepository(env.DB).getContactById(contactId);
      expect(contact?.status).toBe("unsubscribed");
    });

    it("rejects a forged or cross-purpose token with 404", async () => {
      const contactId = await seedContact();
      // A recipient-purpose token must not unlock the contact route.
      const wrongPurpose = await signToken(env.TRACKING_SECRET, "unsubscribe", [contactId]);

      const response = await handleRequest(
        new Request(`https://mail.example.com/unsubscribe/c/${contactId}/${wrongPurpose}`),
        env
      );

      expect(response.status).toBe(404);
      const contact = await new ContactRepository(env.DB).getContactById(contactId);
      expect(contact?.status).toBe("subscribed");
    });
  });
});
