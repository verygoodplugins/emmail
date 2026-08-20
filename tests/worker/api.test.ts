import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";
import { handleRequest } from "../../src/worker";
import type { Env } from "../../src/env";
import { CampaignRepository } from "../../src/db/campaign-repository";
import { ContactRepository } from "../../src/db/contact-repository";
import { signToken } from "../../src/lib/tokens";

describe("Worker API", () => {
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
      EMMAIL_ADMIN_TOKEN: "admin_secret"
    };
  });

  const adminAuth = { authorization: "Bearer admin_secret" };

  it("previews CSV imports through the admin API", async () => {
    const response = await handleRequest(
      new Request("https://mail.example.com/api/imports/preview", {
        method: "POST",
        headers: adminAuth,
        body: "email,name\nada@example.com,Ada Lovelace"
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: { totalRows: 1, acceptedRows: 1, rejectedRows: 0 }
    });
  });

  it("snapshots and enqueues a campaign send", async () => {
    await handleRequest(new Request("https://mail.example.com/api/imports/commit", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ csv: "email,name,lists,tags\nada@example.com,Ada Lovelace,Newsletter,vip" })
    }), env);

    const createResponse = await handleRequest(new Request("https://mail.example.com/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "June update",
        subject: "June update",
        previewText: "A short note",
        markdownBody: "Hello [site](https://example.com)",
        audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
      })
    }), env);
    const campaign = await createResponse.json() as { id: string };

    const sendResponse = await handleRequest(new Request(`https://mail.example.com/api/campaigns/${campaign.id}/send`, {
      method: "POST",
      headers: adminAuth
    }), env);

    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toMatchObject({ createdRecipients: 1, pendingRecipients: 1, queuedJobs: 1 });
    expect(env.SEND_QUEUE.send).toHaveBeenCalledWith({ campaignId: campaign.id, limit: 100 });
  });

  it("re-enqueues a resumed send while recipients are still pending", async () => {
    const { campaign } = await seedRecipient(env);

    const first = await handleRequest(new Request(`https://mail.example.com/api/campaigns/${campaign.id}/send`, {
      method: "POST",
      headers: adminAuth
    }), env);
    await expect(first.json()).resolves.toMatchObject({ pendingRecipients: 1, queuedJobs: 1 });

    // No new recipients this time, but the pending one still gets a message —
    // this is the recovery path for a lost queue message.
    const resume = await handleRequest(new Request(`https://mail.example.com/api/campaigns/${campaign.id}/send`, {
      method: "POST",
      headers: adminAuth
    }), env);
    await expect(resume.json()).resolves.toMatchObject({ createdRecipients: 0, pendingRecipients: 1, queuedJobs: 1 });
    expect(env.SEND_QUEUE.send).toHaveBeenCalledTimes(2);
  });

  it("returns recipient rollup stats for a campaign", async () => {
    const { campaign, recipient } = await seedRecipient(env);
    const campaigns = new CampaignRepository(env.DB);
    await campaigns.markRecipientSent(recipient.id, "email_1");
    await campaigns.markRecipientEvent(recipient.id, "opened");

    const response = await handleRequest(
      new Request(`https://mail.example.com/api/campaigns/${campaign.id}/stats`, { headers: adminAuth }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      total: 1,
      sent: 1,
      delivered: 0,
      opened: 1,
      clicked: 0,
      pending: 0,
      failed: 0
    });
  });

  it("patches an existing campaign through the admin API", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "June update",
        subject: "June update",
        previewText: "A short note",
        markdownBody: "Hello",
        audience: { listIds: ["Newsletter"], tagIds: [] }
      })
    }), env);
    const campaign = await createResponse.json() as { id: string };

    const patchResponse = await handleRequest(new Request(`https://mail.example.com/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "July update",
        subject: "July notes",
        previewText: "Later note",
        markdownBody: "Hello again",
        audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
      })
    }), env);

    expect(patchResponse.status).toBe(200);
    await expect(patchResponse.json()).resolves.toMatchObject({
      id: campaign.id,
      name: "July update",
      subject: "July notes",
      markdownBody: "Hello again",
      audience: { listIds: ["Newsletter"], tagIds: ["vip"] }
    });

    const missing = await handleRequest(new Request("https://mail.example.com/api/campaigns/cmp_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "Nope",
        subject: "Nope",
        markdownBody: "Nope",
        audience: { listIds: [], tagIds: [] }
      })
    }), env);
    expect(missing.status).toBe(404);

    await new CampaignRepository(env.DB).updateCampaignStatus(campaign.id, "sending");
    const sending = await handleRequest(new Request(`https://mail.example.com/api/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "Too late",
        subject: "Too late",
        markdownBody: "Nope",
        audience: { listIds: ["Newsletter"], tagIds: [] }
      })
    }), env);
    expect(sending.status).toBe(409);
    await expect(sending.json()).resolves.toMatchObject({
      error: expect.stringMatching(/draft/i)
    });
  });

  it("serves admin assets and APIs under the configured sidecar base path", async () => {
    env.APP_BASE_URL = "https://southandozarks.autojack.ai/_emmail";

    const assetResponse = await handleRequest(new Request("https://southandozarks.autojack.ai/_emmail/", { headers: adminAuth }), env);
    expect(assetResponse.status).toBe(404);
    const assetFetch = env.ASSETS.fetch as ReturnType<typeof vi.fn>;
    const assetRequest = assetFetch.mock.calls[0][0] as Request;
    expect(assetRequest.url).toBe("https://southandozarks.autojack.ai/");

    const response = await handleRequest(
      new Request("https://southandozarks.autojack.ai/_emmail/api/contacts?limit=10&offset=0", { headers: adminAuth }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("protects admin assets and APIs when an admin token is configured", async () => {
    env.EMMAIL_ADMIN_TOKEN = "admin_secret";

    const deniedApi = await handleRequest(new Request("https://mail.example.com/api/contacts"), env);
    expect(deniedApi.status).toBe(401);

    const deniedAsset = await handleRequest(new Request("https://mail.example.com/"), env);
    expect(deniedAsset.status).toBe(200);
    expect(await deniedAsset.text()).toContain("EmMail Admin");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();

    const bearerResponse = await handleRequest(new Request("https://mail.example.com/api/contacts", {
      headers: { authorization: "Bearer admin_secret" }
    }), env);
    expect(bearerResponse.status).toBe(200);

    const loginResponse = await handleRequest(new Request("https://mail.example.com/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=admin_secret"
    }), env);
    expect(loginResponse.status).toBe(302);
    const cookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("emmail_admin=");

    const cookieResponse = await handleRequest(new Request("https://mail.example.com/api/contacts", {
      headers: { cookie }
    }), env);
    expect(cookieResponse.status).toBe(200);
  });

  it("denies admin access when no admin token is configured", async () => {
    env.EMMAIL_ADMIN_TOKEN = "";

    const deniedApi = await handleRequest(new Request("https://mail.example.com/api/contacts"), env);
    expect(deniedApi.status).toBe(401);

    const deniedAsset = await handleRequest(new Request("https://mail.example.com/"), env);
    expect(deniedAsset.status).toBe(200);
    expect(await deniedAsset.text()).toContain("EmMail Admin");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();

    const loginPage = await handleRequest(new Request("https://mail.example.com/login"), env);
    expect(await loginPage.text()).toContain("EMMAIL_ADMIN_TOKEN is not configured");

    // Public endpoints keep their own auth and stay reachable.
    const ingest = await handleRequest(new Request("https://mail.example.com/api/integrations/southandozarks/contact-message", {
      method: "POST",
      headers: { "content-type": "application/json", "x-emmail-ingest-secret": "ingest_secret" },
      body: JSON.stringify({ id: 1, name: "Ada Lovelace", email: "ada@example.com" })
    }), env);
    expect(ingest.status).toBe(200);
  });

  it("seeds the welcome automation sequence through the admin API", async () => {
    const seeded = await handleRequest(new Request("https://mail.example.com/api/automations/seed-welcome", {
      method: "POST",
      headers: adminAuth
    }), env);
    expect(seeded.status).toBe(201);
    const body = await seeded.json() as { name: string; slug: string; enabled: boolean; steps: unknown[] };
    expect(body).toMatchObject({
      name: "Welcome sequence",
      slug: "welcome-sequence",
      enabled: false
    });
    expect(body.steps).toHaveLength(4);

    const listed = await handleRequest(new Request("https://mail.example.com/api/automations", { headers: adminAuth }), env);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual([expect.objectContaining({ slug: "welcome-sequence", steps: expect.any(Array) })]);

    const again = await handleRequest(new Request("https://mail.example.com/api/automations/seed-welcome", {
      method: "POST",
      headers: adminAuth
    }), env);
    expect(again.status).toBe(201);
    await expect(again.json()).resolves.toMatchObject({ slug: "welcome-sequence" });
  });

  it("returns a 500 when automations tables are missing", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS automation_enrollments");
    await env.DB.exec("DROP TABLE IF EXISTS automation_steps");
    await env.DB.exec("DROP TABLE IF EXISTS automations");

    const response = await handleRequest(new Request("https://mail.example.com/api/automations/seed-welcome", {
      method: "POST",
      headers: adminAuth
    }), env);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/automations/i);
  });

  it("creates, edits, and protects automations through the admin API", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Draft sequence" })
    }), env);
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { id: string; name: string; enabled: boolean; steps: unknown[] };
    expect(created).toMatchObject({ name: "Draft sequence", enabled: false, steps: [] });

    const saveSteps = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        steps: [
          { stepType: "send_email", config: { subject: "Hello", markdownBody: "Welcome" } },
          { stepType: "wait", config: { seconds: 60 } }
        ]
      })
    }), env);
    expect(saveSteps.status).toBe(200);
    await expect(saveSteps.json()).resolves.toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ stepType: "wait" })]) });

    const rename = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Renamed sequence" })
    }), env);
    expect(rename.status).toBe(200);
    await expect(rename.json()).resolves.toMatchObject({ name: "Renamed sequence" });

    const enable = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/enable`, {
      method: "POST",
      headers: adminAuth
    }), env);
    expect(enable.status).toBe(200);

    const blocked = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ steps: [{ stepType: "wait", config: { seconds: 30 } }] })
    }), env);
    expect(blocked.status).toBe(409);
  });

  it("rejects invalid automation step configs and empty enable", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Empty sequence" })
    }), env);
    const created = await createResponse.json() as { id: string };

    const invalid = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ steps: [{ stepType: "wait", config: { seconds: 0 } }] })
    }), env);
    expect(invalid.status).toBe(400);

    const missingConfig = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ steps: [{ stepType: "wait" }] })
    }), env);
    expect(missingConfig.status).toBe(400);

    const enableEmpty = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/enable`, {
      method: "POST",
      headers: adminAuth
    }), env);
    expect(enableEmpty.status).toBe(409);
  });

  it("rejects sequences with too many consecutive non-wait steps", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Guard overflow" })
    }), env);
    const created = await createResponse.json() as { id: string };
    const steps = Array.from({ length: 32 }, () => ({
      stepType: "add_tag",
      config: { tagName: "overflow" }
    }));

    const tooMany = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ steps })
    }), env);
    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toMatchObject({
      error: expect.stringMatching(/30 consecutive non-wait/i)
    });
  });

  it("rejects wait steps that cannot be scheduled", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Huge wait" })
    }), env);
    const created = await createResponse.json() as { id: string };

    const hugeWait = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        steps: [{ stepType: "wait", config: { seconds: 1e20 } }]
      })
    }), env);
    expect(hugeWait.status).toBe(400);
    await expect(hugeWait.json()).resolves.toMatchObject({
      error: expect.stringMatching(/seconds between/i)
    });
  });

  it("saves automation name and steps in one request", async () => {
    const createResponse = await handleRequest(new Request("https://mail.example.com/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ name: "Draft rename" })
    }), env);
    const created = await createResponse.json() as { id: string };

    const saved = await handleRequest(new Request(`https://mail.example.com/api/automations/${created.id}/steps`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        name: "Atomic rename",
        steps: [{ stepType: "wait", config: { seconds: 30 } }]
      })
    }), env);
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      name: "Atomic rename",
      steps: [expect.objectContaining({ stepType: "wait" })]
    });
  });

  it("previews an unsaved automation draft with merge tags and timing", async () => {
    const response = await handleRequest(new Request("https://mail.example.com/api/automations/preview", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        firstName: "Ada",
        steps: [
          {
            stepType: "send_email",
            config: {
              subject: "Hello {{first_name}}",
              previewText: "Preview {{first_name}}",
              markdownBody: "Hi {{first_name}},\n\nWelcome."
            }
          },
          { stepType: "wait", config: { seconds: 60 } },
          { stepType: "add_tag", config: { tagName: "previewed" } }
        ]
      })
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      sample: { firstName: string };
      timeline: Array<{ kind: string; timingLabel: string; subject?: string; html?: string }>;
    };
    expect(body.sample.firstName).toBe("Ada");
    expect(body.timeline).toHaveLength(3);
    expect(body.timeline[0]).toMatchObject({
      kind: "send_email",
      timingLabel: "Immediately",
      subject: "Hello Ada"
    });
    expect(body.timeline[0].html).toContain("Ada");
    expect(body.timeline[1]).toMatchObject({ kind: "wait", timingLabel: "Immediately" });
    expect(body.timeline[2]).toMatchObject({ kind: "add_tag", timingLabel: "After 1 minute" });
  });

  it("returns 400 for invalid automation preview drafts", async () => {
    const response = await handleRequest(new Request("https://mail.example.com/api/automations/preview", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({
        firstName: "Ada",
        steps: [{ stepType: "send_email", config: { subject: "", markdownBody: "" } }]
      })
    }), env);
    expect(response.status).toBe(400);
  });

  it("ingests South & Ozarks contact messages with list tags and idempotent events", async () => {
    env.APP_BASE_URL = "https://southandozarks.autojack.ai/_emmail";
    env.EMMAIL_ADMIN_TOKEN = "admin_secret";

    const payload = {
      id: 42,
      name: "Ada Lovelace",
      email: "Ada@Example.COM",
      phone: "555-0100",
      message: "I would like to hear more.",
      source: "contact-form",
      createdAt: "2026-06-17T12:00:00.000Z"
    };

    const missingSecret = await handleRequest(new Request("https://southandozarks.autojack.ai/_emmail/api/integrations/southandozarks/contact-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }), env);
    expect(missingSecret.status).toBe(401);

    for (let index = 0; index < 2; index += 1) {
      const response = await handleRequest(new Request("https://southandozarks.autojack.ai/_emmail/api/integrations/southandozarks/contact-message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-emmail-ingest-secret": "ingest_secret"
        },
        body: JSON.stringify(payload)
      }), env);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        contact: { email: "ada@example.com" },
        duplicate: index === 1
      });
    }

    const contacts = await new ContactRepository(env.DB).listContacts({ limit: 10, offset: 0 });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      lists: ["South & Ozarks"],
      tags: ["contact-form", "website-inquiry"]
    });

    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE provider_event_id = ? AND type = 'contact_ingested'"
    ).bind("contact_messages:42").first("count");
    expect(Number(eventCount)).toBe(1);
  });

  it("records signed open events and returns a transparent gif", async () => {
    const { campaign, recipient } = await seedRecipient(env);
    const token = await signToken(env.TRACKING_SECRET, "open", [recipient.id, campaign.id]);

    const response = await handleRequest(
      new Request(`https://mail.example.com/t/open/${recipient.id}/${campaign.id}/${token}.gif`),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    const eventType = await env.DB.prepare("SELECT type FROM events WHERE recipient_id = ?").bind(recipient.id).first("type");
    expect(eventType).toBe("opened");
  });

  it("records signed click events and redirects to the stored campaign link", async () => {
    const { campaign, recipient } = await seedRecipient(env);
    const campaigns = new CampaignRepository(env.DB);
    const [link] = await campaigns.ensureLinks(campaign.id, ["https://example.com/path?a=1"]);
    const token = await signToken(env.TRACKING_SECRET, "click", [recipient.id, link.id]);

    const response = await handleRequest(
      new Request(`https://mail.example.com/t/click/${recipient.id}/${link.id}/${token}`),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/path?a=1");
    const eventType = await env.DB.prepare("SELECT type FROM events WHERE recipient_id = ?").bind(recipient.id).first("type");
    expect(eventType).toBe("clicked");
  });

  it("handles signed unsubscribe links by creating a suppression", async () => {
    const { recipient } = await seedRecipient(env);
    const token = await signToken(env.TRACKING_SECRET, "unsubscribe", [recipient.id]);

    const response = await handleRequest(
      new Request(`https://mail.example.com/unsubscribe/${recipient.id}/${token}`),
      env
    );

    expect(response.status).toBe(200);
    const suppression = await env.DB.prepare("SELECT type FROM suppressions WHERE email = ?").bind(recipient.email).first("type");
    expect(suppression).toBe("unsubscribe");
  });

  it("rejects unsigned Resend webhooks", async () => {
    const response = await handleRequest(
      new Request("https://mail.example.com/webhooks/resend", {
        method: "POST",
        body: JSON.stringify({ type: "email.bounced" })
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("seeds and clears sample data without removing real contacts", async () => {
    await handleRequest(new Request("https://mail.example.com/api/imports/commit", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminAuth },
      body: JSON.stringify({ csv: "email,name,lists,tags\nreal@example.com,Real Contact,Customers,real" })
    }), env);

    const seedResponse = await handleRequest(new Request("https://mail.example.com/api/sample-data/seed", {
      method: "POST",
      headers: adminAuth
    }), env);

    expect(seedResponse.status).toBe(200);
    await expect(seedResponse.json()).resolves.toMatchObject({
      contacts: 8,
      lists: 3,
      tags: 4,
      campaigns: 2,
      recipients: 6,
      events: 17,
      suppressions: 2
    });

    const contactsAfterSeed = await new ContactRepository(env.DB).listContacts({ limit: 20, offset: 0 });
    expect(contactsAfterSeed.map((contact) => contact.email)).toEqual([
      "ava.reed@example.com",
      "casey.rivera@example.com",
      "ellie.morgan@example.com",
      "jordan.lee@example.com",
      "miles.chen@example.com",
      "noah.brooks@example.com",
      "real@example.com",
      "sofia.patel@example.com",
      "taylor.quinn@example.com"
    ]);

    const statusResponse = await handleRequest(new Request("https://mail.example.com/api/sample-data/status", { headers: adminAuth }), env);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({ contacts: 8, campaigns: 2, events: 17 });

    const sampleEvents = await handleRequest(
      new Request("https://mail.example.com/api/campaigns/sample_campaign_june/events", { headers: adminAuth }),
      env
    );
    expect(sampleEvents.status).toBe(200);
    await expect(sampleEvents.json()).resolves.toHaveLength(17);

    const clearResponse = await handleRequest(new Request("https://mail.example.com/api/sample-data/clear", {
      method: "POST",
      headers: adminAuth
    }), env);

    expect(clearResponse.status).toBe(200);
    await expect(clearResponse.json()).resolves.toMatchObject({ contacts: 8, campaigns: 2, events: 17 });

    const contactsAfterClear = await new ContactRepository(env.DB).listContacts({ limit: 20, offset: 0 });
    expect(contactsAfterClear.map((contact) => contact.email)).toEqual(["real@example.com"]);
    const campaigns = await new CampaignRepository(env.DB).listCampaigns();
    expect(campaigns).toEqual([]);
  });

  it("can seed sample data more than once without duplicating records", async () => {
    await handleRequest(new Request("https://mail.example.com/api/sample-data/seed", { method: "POST", headers: adminAuth }), env);
    await handleRequest(new Request("https://mail.example.com/api/sample-data/seed", { method: "POST", headers: adminAuth }), env);

    const statusResponse = await handleRequest(new Request("https://mail.example.com/api/sample-data/status", { headers: adminAuth }), env);

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      contacts: 8,
      lists: 3,
      tags: 4,
      campaigns: 2,
      recipients: 6,
      events: 17,
      suppressions: 2
    });
  });
});

async function seedRecipient(env: Env) {
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
  const [recipient] = await campaigns.listRecipientsForSend(campaign.id, 10);
  return { campaign, recipient };
}
