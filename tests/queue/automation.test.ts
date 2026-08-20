import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { AutomationRepository } from "../../src/db/automation-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { ContactRepository } from "../../src/db/contact-repository";
import {
  enqueueDueAutomations,
  maybeEnrollContactCreated,
  processAutomationEnrollment,
} from "../../src/queue/automation";
import type { ResendEmailAdapter, ResendEmailMessage } from "../../src/queue/welcome";
import type { Env } from "../../src/env";

describe("multi-step automations", () => {
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
    };
  });

  async function createContact(email = "lead@example.com"): Promise<string> {
    const contacts = new ContactRepository(env.DB);
    await contacts.importContacts([
      {
        email,
        firstName: "Dana",
        lastName: "Lead",
        status: "subscribed",
        lists: ["South & Ozarks"],
        tags: ["contact-form"],
      },
    ]);
    return (await contacts.getContactByEmail(email))!.id;
  }

  function successAdapter(idPrefix = "email_auto"): {
    adapter: ResendEmailAdapter;
    sendEmail: ReturnType<typeof vi.fn>;
  } {
    let n = 0;
    const sendEmail = vi.fn(async (_message: ResendEmailMessage) => {
      n += 1;
      return { data: { id: `${idPrefix}_${n}` }, error: null };
    });
    return { adapter: { sendEmail }, sendEmail };
  }

  function queuedMessages() {
    const send = env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
    return send.mock.calls.map((call) => ({ body: call[0], options: call[1] }));
  }

  it("seeds the welcome sequence with four steps, disabled by default", async () => {
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    expect(seeded.slug).toBe("welcome-sequence");
    expect(seeded.enabled).toBe(false);
    expect(seeded.steps.map((step) => step.stepType)).toEqual([
      "send_email",
      "wait",
      "send_email",
      "add_tag",
    ]);
    // Idempotent.
    const again = await repo.ensureWelcomeSequence();
    expect(again.id).toBe(seeded.id);
    expect((await repo.listAutomations()).length).toBe(1);
  });

  it("does not enroll when no automation is enabled", async () => {
    const contactId = await createContact();
    await new AutomationRepository(env.DB).ensureWelcomeSequence();

    expect(await maybeEnrollContactCreated(env, contactId)).toBe(0);
    expect(env.SEND_QUEUE.send).not.toHaveBeenCalled();
  });

  it("enrolls once per automation and runs welcome → wait → follow-up → tag", async () => {
    const contactId = await createContact();
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);

    expect(await maybeEnrollContactCreated(env, contactId)).toBe(1);
    expect(await maybeEnrollContactCreated(env, contactId)).toBe(0);

    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;
    const { adapter, sendEmail } = successAdapter();

    // First drain: send welcome, then park on the wait step.
    const first = await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      adapter
    );
    expect(first.status).toBe("waiting");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toContain("Thanks for reaching out");
    expect(sendEmail.mock.calls[0][0].html).toContain("Dana");

    let enrollment = await repo.getEnrollment(enrollmentId);
    expect(enrollment?.status).toBe("waiting");
    expect(enrollment?.currentPosition).toBe(1);

    // Force the wait due and resume: follow-up email + tag + complete.
    await repo.updateEnrollment(enrollmentId, {
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const second = await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      adapter
    );
    expect(second.status).toBe("completed");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].subject).toContain("Anything else");

    enrollment = await repo.getEnrollment(enrollmentId);
    expect(enrollment?.status).toBe("completed");

    const contact = (await new ContactRepository(env.DB).listContacts({ limit: 10, offset: 0 }))[0];
    expect(contact.tags).toContain("welcome-sequence-complete");

    const campaigns = new CampaignRepository(env.DB);
    expect(await campaigns.hasContactEvent(contactId, ["automation_email_sent"])).toBe(true);
    expect(await campaigns.hasContactEvent(contactId, ["automation_completed"])).toBe(true);
  });

  it("respects suppression and still advances past the send step", async () => {
    const contactId = await createContact("suppressed@example.com");
    const contacts = new ContactRepository(env.DB);
    await contacts.suppressEmail("suppressed@example.com", "unsubscribe", "test");

    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);
    await maybeEnrollContactCreated(env, contactId);
    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;

    const { adapter, sendEmail } = successAdapter();
    const result = await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      adapter
    );
    expect(result.status).toBe("waiting");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      await new CampaignRepository(env.DB).hasContactEvent(contactId, ["automation_email_skipped"])
    ).toBe(true);
  });

  it("kill-switches when the automation is disabled mid-flight", async () => {
    const contactId = await createContact();
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);
    await maybeEnrollContactCreated(env, contactId);
    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;
    await repo.setEnabled(seeded.id, false);

    const { adapter, sendEmail } = successAdapter();
    const result = await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      adapter
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("automation-disabled");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("dry-run records automation_email_sent without calling Resend", async () => {
    env.EMMAIL_SEND_MODE = "dry-run";
    const contactId = await createContact();
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);
    await maybeEnrollContactCreated(env, contactId);
    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;

    const { adapter, sendEmail } = successAdapter();
    await processAutomationEnrollment(env, { type: "automation", enrollmentId }, adapter);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      await new CampaignRepository(env.DB).hasContactEvent(contactId, ["automation_email_sent"])
    ).toBe(true);
  });

  it("cron sweeper re-queues due waiting enrollments", async () => {
    const contactId = await createContact();
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);
    await maybeEnrollContactCreated(env, contactId);
    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;

    await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      successAdapter().adapter
    );
    (env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mockClear();

    await repo.updateEnrollment(enrollmentId, {
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await enqueueDueAutomations(env)).toBe(1);
    expect(queuedMessages()[0].body).toEqual({ type: "automation", enrollmentId });
  });

  it("schedules a delayed queue wake for short waits", async () => {
    const contactId = await createContact();
    const repo = new AutomationRepository(env.DB);
    const seeded = await repo.ensureWelcomeSequence();
    await repo.setEnabled(seeded.id, true);
    await maybeEnrollContactCreated(env, contactId);
    const enrollmentId = queuedMessages()[0].body.enrollmentId as string;
    (env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>).mockClear();

    await processAutomationEnrollment(
      env,
      { type: "automation", enrollmentId },
      successAdapter().adapter
    );
    const wake = queuedMessages().find((entry) => entry.body.type === "automation");
    expect(wake?.options).toMatchObject({ delaySeconds: 120 });
  });
});
