import { vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "./sqlite-d1";
import { AutomationRepository } from "../../src/db/automation-repository";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { ContactRepository } from "../../src/db/contact-repository";
import { handleRequest } from "../../src/worker";
import { processAutomationEnrollment } from "../../src/queue/automation";
import type {
  ResendEmailAdapter,
  ResendEmailMessage,
} from "../../src/queue/welcome";
import type { Env } from "../../src/env";

export interface CapturedEmail {
  message: ResendEmailMessage;
  idempotencyKey: string;
}

export interface MailHarness {
  env: Env;
  automations: AutomationRepository;
  contacts: ContactRepository;
  campaigns: CampaignRepository;
  emails: CapturedEmail[];
  adapter: ResendEmailAdapter;
  ingest: (body: Record<string, unknown>) => Promise<Response>;
  queuedMessages: () => Array<{
    body: Record<string, unknown>;
    options?: unknown;
  }>;
  drainAutomation: (
    enrollmentId: string,
  ) => ReturnType<typeof processAutomationEnrollment>;
  forceWaitDue: (enrollmentId: string) => Promise<void>;
  contactEventTypes: (contactId: string) => Promise<string[]>;
  contactEvents: (
    contactId: string,
  ) => Promise<
    Array<{
      type: string;
      metadata: Record<string, unknown> | null;
      providerEventId: string | null;
    }>
  >;
}

export async function createMailHarness(
  overrides: Partial<Env> = {},
): Promise<MailHarness> {
  const db = await createSqliteD1();
  await applyMigrations(db);

  const emails: CapturedEmail[] = [];
  let emailSeq = 0;
  const adapter: ResendEmailAdapter = {
    sendEmail: async (message, options) => {
      emails.push({ message, idempotencyKey: options.idempotencyKey });
      emailSeq += 1;
      return { data: { id: `email_test_${emailSeq}` }, error: null };
    },
  };

  const env: Env = {
    DB: db,
    SEND_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    ASSETS: {
      fetch: vi.fn(async () => new Response("asset", { status: 404 })),
    } as unknown as Fetcher,
    RESEND_API_KEY: "re_test",
    RESEND_WEBHOOK_SECRET: "whsec_test",
    TRACKING_SECRET: "track_secret",
    APP_BASE_URL: "https://mail.example.com",
    DEFAULT_FROM_EMAIL: "news@example.com",
    DEFAULT_FROM_NAME: "EmMail",
    EMMAIL_INGEST_SECRET: "ingest_secret",
    EMMAIL_SEND_MODE: "live",
    EMMAIL_ADMIN_TOKEN: "admin_secret",
    // Prefer the multi-step sequence over the one-shot welcome in builder tests.
    EMMAIL_WELCOME_ENABLED: "false",
    ...overrides,
  };

  return {
    env,
    automations: new AutomationRepository(db),
    contacts: new ContactRepository(db),
    campaigns: new CampaignRepository(db),
    emails,
    adapter,
    ingest(body) {
      return handleRequest(
        new Request(
          "https://mail.example.com/api/integrations/southandozarks/contact-message",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-emmail-ingest-secret": env.EMMAIL_INGEST_SECRET,
            },
            body: JSON.stringify(body),
          },
        ),
        env,
      );
    },
    queuedMessages() {
      const send = env.SEND_QUEUE.send as unknown as ReturnType<typeof vi.fn>;
      return send.mock.calls.map((call) => ({
        body: call[0] as Record<string, unknown>,
        options: call[1],
      }));
    },
    drainAutomation(enrollmentId) {
      return processAutomationEnrollment(
        env,
        { type: "automation", enrollmentId },
        adapter,
      );
    },
    async forceWaitDue(enrollmentId) {
      await new AutomationRepository(db).updateEnrollment(enrollmentId, {
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      });
    },
    async contactEvents(contactId) {
      const result = await db
        .prepare(
          `SELECT type, metadata_json, provider_event_id
         FROM events
         WHERE contact_id = ?
         ORDER BY created_at ASC, id ASC`,
        )
        .bind(contactId)
        .all();
      return (
        (result.results ?? []) as Array<{
          type: string;
          metadata_json: string | null;
          provider_event_id: string | null;
        }>
      ).map((row) => ({
        type: row.type,
        providerEventId: row.provider_event_id,
        metadata: row.metadata_json
          ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
          : null,
      }));
    },
    async contactEventTypes(contactId) {
      const result = await db
        .prepare(
          `SELECT type
         FROM events
         WHERE contact_id = ?
         ORDER BY created_at ASC, id ASC`,
        )
        .bind(contactId)
        .all();
      return ((result.results ?? []) as Array<{ type: string }>).map((row) => row.type);
    },
  };
}

export async function seedEnabledWelcomeSequence(harness: MailHarness) {
  const seeded = await harness.automations.ensureWelcomeSequence();
  await harness.automations.setEnabled(seeded.id, true);
  return (await harness.automations.listAutomations())[0];
}
