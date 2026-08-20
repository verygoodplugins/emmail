import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { ContactRepository } from "../../src/db/contact-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import {
  isWelcomeEnabled,
  maybeEnqueueWelcome,
  processWelcomeSend,
  type ResendEmailAdapter,
  type ResendEmailMessage,
} from "../../src/queue/welcome";
import { sanitizeName, welcomeMarkdown } from "../../src/email/welcome";
import type { Env } from "../../src/env";

describe("welcome automation", () => {
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
      EMMAIL_SEND_MODE: "live",
      EMMAIL_WELCOME_ENABLED: "true",
    };
  });

  async function createContact(
    overrides: Partial<{
      email: string;
      firstName: string;
      status: "subscribed" | "unsubscribed" | "bounced";
    }> = {}
  ): Promise<string> {
    const email = overrides.email ?? "lead@example.com";
    const contacts = new ContactRepository(env.DB);
    await contacts.importContacts([
      {
        email,
        firstName: overrides.firstName ?? "Dana",
        lastName: "Lead",
        status: overrides.status ?? "subscribed",
        lists: ["South & Ozarks"],
        tags: ["contact-form"],
      },
    ]);
    const contact = await contacts.getContactByEmail(email);
    return contact!.id;
  }

  function successAdapter(): { adapter: ResendEmailAdapter; sendEmail: ReturnType<typeof vi.fn> } {
    const sendEmail = vi.fn(async (_message: ResendEmailMessage) => ({
      data: { id: "email_welcome_0" },
      error: null,
    }));
    return { adapter: { sendEmail }, sendEmail };
  }

  function queuedMessages() {
    const send = env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
    return send.mock.calls.map((call) => call[0]);
  }

  describe("sanitizeName", () => {
    it("strips markdown/HTML metacharacters and caps length", () => {
      expect(sanitizeName("<b>Ada</b>")).toBe("bAdab");
      expect(sanitizeName("[Ada](http://evil)")).toBe("Adahttpevil");
      expect(sanitizeName("Ada*_`# ")).toBe("Ada");
      expect(sanitizeName("")).toBe("");
      expect(sanitizeName("a".repeat(80))).toHaveLength(40);
    });

    it("keeps ordinary names and greets by first name", () => {
      expect(sanitizeName("María O'Neil-Smith")).toBe("María O'Neil-Smith");
      expect(welcomeMarkdown("Ada")).toContain("Hi Ada,");
      expect(welcomeMarkdown("")).toContain("Hi there,");
    });

    it("never lets an injected name reach rendered markup as a tag", () => {
      expect(welcomeMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
    });
  });

  describe("maybeEnqueueWelcome", () => {
    it("enqueues a welcome for a contact with no prior welcome", async () => {
      const contactId = await createContact();

      expect(await maybeEnqueueWelcome(env, contactId)).toBe(true);
      expect(queuedMessages()).toEqual([{ type: "welcome", contactId }]);
    });

    it("does not enqueue once a welcome has already been sent", async () => {
      const contactId = await createContact();
      await new CampaignRepository(env.DB).recordEvent({
        contactId,
        type: "welcome_sent",
        providerEventId: "dry-run",
      });

      expect(await maybeEnqueueWelcome(env, contactId)).toBe(false);
      expect(env.SEND_QUEUE.send).not.toHaveBeenCalled();
    });

    it("self-heals: a failed enqueue leaves no marker, so the next ingest re-tries", async () => {
      const contactId = await createContact();
      (env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("queue down")
      );

      await expect(maybeEnqueueWelcome(env, contactId)).rejects.toThrow("queue down");
      // No welcome_sent recorded on failure → a retry enqueues successfully.
      expect(await maybeEnqueueWelcome(env, contactId)).toBe(true);
      expect(env.SEND_QUEUE.send).toHaveBeenCalledTimes(2);
    });

    it("does nothing when the flag is off", async () => {
      env.EMMAIL_WELCOME_ENABLED = "false";
      const contactId = await createContact();
      expect(isWelcomeEnabled(env)).toBe(false);
      expect(await maybeEnqueueWelcome(env, contactId)).toBe(false);
      expect(env.SEND_QUEUE.send).not.toHaveBeenCalled();
    });
  });

  describe("processWelcomeSend", () => {
    it("sends a single welcome email with a per-contact idempotency key", async () => {
      const contactId = await createContact({ email: "lead@example.com" });
      const { adapter, sendEmail } = successAdapter();

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "sent", contactId, resendEmailId: "email_welcome_0" });
      const [message, options] = sendEmail.mock.calls[0] as [
        ResendEmailMessage,
        { idempotencyKey: string },
      ];
      expect(message).toMatchObject({
        from: "EmMail <news@example.com>",
        to: ["lead@example.com"],
      });
      expect(message.headers["List-Unsubscribe"]).toContain(`/unsubscribe/c/${contactId}/`);
      expect(options.idempotencyKey).toBe(`welcome/${contactId}`);

      const campaigns = new CampaignRepository(env.DB);
      expect(await campaigns.hasContactEvent(contactId, ["welcome_sent"])).toBe(true);
    });

    it("dry-runs without calling Resend and still records welcome_sent", async () => {
      env.EMMAIL_SEND_MODE = "dry-run";
      const contactId = await createContact();
      const { adapter, sendEmail } = successAdapter();

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "dry-run", contactId });
      expect(sendEmail).not.toHaveBeenCalled();
      const event = await env.DB.prepare(
        "SELECT provider_event_id, metadata_json FROM events WHERE contact_id = ? AND type = 'welcome_sent'"
      )
        .bind(contactId)
        .first<{ provider_event_id: string; metadata_json: string }>();
      expect(event?.provider_event_id).toBe("dry-run");
    });

    it("skips a redelivered message once the welcome already sent", async () => {
      const contactId = await createContact();
      const { adapter, sendEmail } = successAdapter();

      await processWelcomeSend(env, { type: "welcome", contactId }, adapter);
      const redelivered = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(redelivered).toMatchObject({ status: "skipped", reason: "already-sent" });
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("skips unsubscribed/bounced contacts without sending", async () => {
      const contactId = await createContact({ status: "unsubscribed" });
      const { adapter, sendEmail } = successAdapter();

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "skipped", reason: "status:unsubscribed" });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("skips when the flag was disabled after the message was queued (kill switch)", async () => {
      const contactId = await createContact();
      env.EMMAIL_WELCOME_ENABLED = "false";
      const { adapter, sendEmail } = successAdapter();

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "skipped", reason: "welcome-disabled" });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("skips a suppressed contact even if ingest re-marked it subscribed", async () => {
      const contactId = await createContact({ email: "optout@example.com" });
      const contacts = new ContactRepository(env.DB);
      // Opt out (adds a suppression row + flips status), then simulate a later
      // contact-form ingest re-upserting the same email as subscribed.
      await contacts.suppressEmail("optout@example.com", "unsubscribe", "prior-optout");
      await contacts.importContacts([
        {
          email: "optout@example.com",
          firstName: "Dana",
          lastName: "Lead",
          status: "subscribed",
          lists: [],
          tags: [],
        },
      ]);
      const refreshed = await contacts.getContactById(contactId);
      expect(refreshed?.status).toBe("subscribed");
      const { adapter, sendEmail } = successAdapter();

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "skipped", reason: "suppressed" });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("skips a vanished contact as a terminal no-op", async () => {
      const { adapter, sendEmail } = successAdapter();
      const result = await processWelcomeSend(
        env,
        { type: "welcome", contactId: "con_missing" },
        adapter
      );
      expect(result).toMatchObject({ status: "skipped", reason: "contact-not-found" });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("rethrows retryable Resend errors so the queue redelivers", async () => {
      const contactId = await createContact();
      const adapter: ResendEmailAdapter = {
        sendEmail: vi.fn(async () => ({
          data: null,
          error: { name: "rate_limit_exceeded", message: "slow down" },
        })),
      };

      await expect(
        processWelcomeSend(env, { type: "welcome", contactId }, adapter)
      ).rejects.toThrow("slow down");
      const campaigns = new CampaignRepository(env.DB);
      expect(await campaigns.hasContactEvent(contactId, ["welcome_sent"])).toBe(false);
    });

    it("rethrows an application_error (Resend 500) so the queue redelivers", async () => {
      const contactId = await createContact();
      const adapter: ResendEmailAdapter = {
        sendEmail: vi.fn(async () => ({
          data: null,
          error: { name: "application_error", message: "try again" },
        })),
      };

      await expect(
        processWelcomeSend(env, { type: "welcome", contactId }, adapter)
      ).rejects.toThrow("try again");
      const campaigns = new CampaignRepository(env.DB);
      expect(await campaigns.hasContactEvent(contactId, ["welcome_sent"])).toBe(false);
    });

    it("acks a terminal Resend error by recording welcome_failed (no retry storm)", async () => {
      const contactId = await createContact();
      const adapter: ResendEmailAdapter = {
        sendEmail: vi.fn(async () => ({
          data: null,
          error: { name: "validation_error", message: "bad address" },
        })),
      };

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "failed", reason: "bad address" });
      const failed = await env.DB.prepare(
        "SELECT metadata_json FROM events WHERE contact_id = ? AND type = 'welcome_failed'"
      )
        .bind(contactId)
        .first<{ metadata_json: string }>();
      expect(JSON.parse(failed!.metadata_json)).toMatchObject({ error: "bad address" });
    });

    it("treats a 409 idempotency conflict as already-sent", async () => {
      const contactId = await createContact();
      const adapter: ResendEmailAdapter = {
        sendEmail: vi.fn(async () => ({
          data: null,
          error: { statusCode: 409, message: "conflict" },
        })),
      };

      const result = await processWelcomeSend(env, { type: "welcome", contactId }, adapter);

      expect(result).toMatchObject({ status: "conflict", contactId });
      const campaigns = new CampaignRepository(env.DB);
      expect(await campaigns.hasContactEvent(contactId, ["welcome_sent"])).toBe(true);
    });
  });
});
