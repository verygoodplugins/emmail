import type { Env, SendQueueMessage } from "./env";
import { Resend } from "resend";
import {
  AutomationRepository,
  AutomationConflictError,
  AutomationEmptyStepsError,
  AutomationValidationError,
  type AutomationStepType,
  type StepInput,
} from "./db/automation-repository";
import { buildAutomationPreview } from "./email/preview-sequence";
import { CampaignConflictError, CampaignRepository } from "./db/campaign-repository";
import { ContactRepository } from "./db/contact-repository";
import {
  clearSampleData,
  getSampleDataStatus,
  seedSampleData,
} from "./db/sample-data";
import {
  ingestSouthOzarksContactMessage,
  verifySharedSecret,
} from "./integrations/southandozarks";
import {
  basePathFromAppBaseUrl,
  rewriteRequestPath,
  stripBasePath,
} from "./lib/base-path";
import { previewContactsCsv } from "./lib/csv";
import { createId, nowIso } from "./lib/ids";
import { verifyToken } from "./lib/tokens";
import {
  enqueueDueAutomations,
  maybeEnrollContactCreated,
  processAutomationEnrollment,
} from "./queue/automation";
import { processCampaignSend } from "./queue/send";
import { maybeEnqueueWelcome, processWelcomeSend } from "./queue/welcome";
import { handleVerifiedResendWebhook } from "./webhooks/resend";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const basePath = basePathFromAppBaseUrl(env.APP_BASE_URL);
  const path = stripBasePath(url.pathname, basePath);
  const assetRequest =
    path === url.pathname ? request : rewriteRequestPath(request, path);

  try {
    if (path === "/login") {
      return handleAdminLogin(request, env, basePath);
    }

    if (await requiresAdminAuth(request, env, path)) {
      return path.startsWith("/api/")
        ? json({ error: "Unauthorized" }, 401)
        : adminLoginPage(basePath);
    }

    if (request.method === "POST" && path === "/api/imports/preview") {
      return json(previewContactsCsv(await request.text()));
    }

    if (request.method === "POST" && path === "/api/imports/commit") {
      const body = await request.json<{ csv: string }>();
      const preview = previewContactsCsv(body.csv);
      const contacts = new ContactRepository(env.DB);
      const imported = await contacts.importContacts(preview.accepted);
      await env.DB.prepare(
        "INSERT INTO imports (id, status, total_rows, accepted_rows, rejected_rows, created_at) VALUES (?, 'complete', ?, ?, ?, ?)",
      )
        .bind(
          createId("imp"),
          preview.summary.totalRows,
          preview.summary.acceptedRows,
          preview.summary.rejectedRows,
          nowIso(),
        )
        .run();
      return json({ ...preview, ...imported });
    }

    if (request.method === "GET" && path === "/api/sample-data/status") {
      return json(await getSampleDataStatus(env.DB));
    }

    if (request.method === "POST" && path === "/api/sample-data/seed") {
      return json(await seedSampleData(env.DB));
    }

    if (request.method === "POST" && path === "/api/sample-data/clear") {
      return json(await clearSampleData(env.DB));
    }

    if (
      request.method === "POST" &&
      path === "/api/integrations/southandozarks/contact-message"
    ) {
      const authorized = await verifySharedSecret(
        env.EMMAIL_INGEST_SECRET,
        request.headers.get("x-emmail-ingest-secret"),
      );
      if (!authorized) {
        return json({ error: "Unauthorized" }, 401);
      }
      const result = await ingestSouthOzarksContactMessage(
        env.DB,
        await request.json(),
      );
      // Gate the welcome on welcome_sent (inside maybeEnqueueWelcome), NOT on the
      // ingest `duplicate` flag: a duplicate replay is exactly how a dropped
      // enqueue self-heals, and welcome_sent already caps delivery at one per
      // contact. Best-effort so a queue failure never loses the captured lead.
      try {
        await maybeEnqueueWelcome(env, result.contact.id);
      } catch (error) {
        console.error("Welcome enqueue failed", error);
      }
      // Multi-step automations (welcome sequence, etc.) enroll independently of
      // the one-shot EMMAIL_WELCOME_ENABLED path. Keep only one of them armed
      // for a given contact stream to avoid double emails.
      try {
        await maybeEnrollContactCreated(env, result.contact.id);
      } catch (error) {
        console.error("Automation enroll failed", error);
      }
      return json({ ok: true, ...result });
    }

    if (request.method === "GET" && path === "/api/automations") {
      return json(await new AutomationRepository(env.DB).listAutomations());
    }

    if (request.method === "POST" && path === "/api/automations") {
      const body = await request.json<{ name: string }>();
      const automation = await new AutomationRepository(
        env.DB,
      ).createAutomation(body.name ?? "");
      return json(automation, 201);
    }

    if (request.method === "POST" && path === "/api/automations/preview") {
      const body = await request.json<{ firstName?: string; steps: StepInput[] }>();
      return json(await buildAutomationPreview({
        firstName: body.firstName,
        steps: body.steps ?? []
      }));
    }

    if (request.method === "POST" && path === "/api/automations/seed-welcome") {
      return json(
        await new AutomationRepository(env.DB).ensureWelcomeSequence(),
        201,
      );
    }

    const automationMatch = path.match(/^\/api\/automations\/([^/]+)$/);
    if (request.method === "PATCH" && automationMatch) {
      const body = await request.json<{ name: string }>();
      const automation = await new AutomationRepository(
        env.DB,
      ).updateAutomationName(automationMatch[1], body.name ?? "");
      return automation ? json(automation) : json({ error: "Not found" }, 404);
    }

    const automationStepsMatch = path.match(
      /^\/api\/automations\/([^/]+)\/steps$/,
    );
    if (request.method === "PUT" && automationStepsMatch) {
      const body = await request.json<{ steps: StepInput[]; name?: string }>();
      const automation = await new AutomationRepository(env.DB).replaceSteps(
        automationStepsMatch[1],
        (body.steps ?? []).map((step) => ({
          stepType: step.stepType as AutomationStepType,
          config: step.config,
        })),
        body.name === undefined ? {} : { name: body.name },
      );
      return automation ? json(automation) : json({ error: "Not found" }, 404);
    }

    const automationToggleMatch = path.match(
      /^\/api\/automations\/([^/]+)\/(enable|disable)$/,
    );
    if (request.method === "POST" && automationToggleMatch) {
      const automation = await new AutomationRepository(env.DB).setEnabled(
        automationToggleMatch[1],
        automationToggleMatch[2] === "enable",
      );
      return automation ? json(automation) : json({ error: "Not found" }, 404);
    }

    const automationEnrollmentsMatch = path.match(
      /^\/api\/automations\/([^/]+)\/enrollments$/,
    );
    if (request.method === "GET" && automationEnrollmentsMatch) {
      return json(
        await new AutomationRepository(env.DB).listEnrollments(
          automationEnrollmentsMatch[1],
        ),
      );
    }

    if (request.method === "GET" && path === "/api/contacts") {
      const contacts = new ContactRepository(env.DB);
      return json(
        await contacts.listContacts({
          limit: Number(url.searchParams.get("limit") ?? 50),
          offset: Number(url.searchParams.get("offset") ?? 0),
        }),
      );
    }

    if (request.method === "GET" && path === "/api/lists") {
      return json(await names(env.DB, "lists"));
    }

    if (request.method === "POST" && path === "/api/lists") {
      return createName(
        env.DB,
        "lists",
        "lst",
        await request.json<{ name: string }>(),
      );
    }

    if (request.method === "GET" && path === "/api/tags") {
      return json(await names(env.DB, "tags"));
    }

    if (request.method === "POST" && path === "/api/tags") {
      return createName(
        env.DB,
        "tags",
        "tag",
        await request.json<{ name: string }>(),
      );
    }

    if (request.method === "GET" && path === "/api/campaigns") {
      return json(await new CampaignRepository(env.DB).listCampaigns());
    }

    if (request.method === "POST" && path === "/api/campaigns") {
      const body = await request.json<{
        name: string;
        subject: string;
        previewText?: string;
        markdownBody: string;
        fromName?: string;
        fromEmail?: string;
        audience: { listIds?: string[]; tagIds?: string[] };
      }>();
      const campaign = await new CampaignRepository(env.DB).createCampaign({
        name: body.name,
        subject: body.subject,
        previewText: body.previewText ?? "",
        markdownBody: body.markdownBody,
        fromName: body.fromName ?? env.DEFAULT_FROM_NAME,
        fromEmail: body.fromEmail ?? env.DEFAULT_FROM_EMAIL,
        audience: {
          listIds: body.audience?.listIds ?? [],
          tagIds: body.audience?.tagIds ?? [],
        },
      });
      return json(campaign, 201);
    }

    const campaignSendMatch = path.match(/^\/api\/campaigns\/([^/]+)\/send$/);
    if (request.method === "POST" && campaignSendMatch) {
      const campaignId = campaignSendMatch[1];
      const campaigns = new CampaignRepository(env.DB);
      const snapshot = await campaigns.snapshotAudience(campaignId);
      // Enqueue whenever recipients are pending, not just when the snapshot
      // created new ones — re-posting /send resumes a campaign whose queue
      // message was lost.
      const pendingRecipients = await campaigns.countRecipientsByStatus(
        campaignId,
        "pending",
      );
      const queuedJobs = pendingRecipients > 0 ? 1 : 0;
      if (queuedJobs) {
        await env.SEND_QUEUE.send({ campaignId, limit: 100 });
      }
      return json({ ...snapshot, pendingRecipients, queuedJobs });
    }

    const campaignStatsMatch = path.match(/^\/api\/campaigns\/([^/]+)\/stats$/);
    if (request.method === "GET" && campaignStatsMatch) {
      return json(
        await new CampaignRepository(env.DB).getCampaignStats(
          campaignStatsMatch[1],
        ),
      );
    }

    const campaignEventsMatch = path.match(
      /^\/api\/campaigns\/([^/]+)\/events$/,
    );
    if (request.method === "GET" && campaignEventsMatch) {
      return json(await campaignEvents(env.DB, campaignEventsMatch[1]));
    }

    const campaignGetMatch = path.match(/^\/api\/campaigns\/([^/]+)$/);
    if (request.method === "GET" && campaignGetMatch) {
      const campaign = await new CampaignRepository(env.DB).getCampaign(
        campaignGetMatch[1],
      );
      return campaign ? json(campaign) : json({ error: "Not found" }, 404);
    }
    if (request.method === "PATCH" && campaignGetMatch) {
      const body = await request.json<{
        name: string;
        subject: string;
        previewText?: string;
        markdownBody: string;
        audience: { listIds?: string[]; tagIds?: string[] };
      }>();
      const campaign = await new CampaignRepository(env.DB).updateCampaign(
        campaignGetMatch[1],
        {
          name: body.name,
          subject: body.subject,
          previewText: body.previewText ?? "",
          markdownBody: body.markdownBody,
          fromName: env.DEFAULT_FROM_NAME,
          fromEmail: env.DEFAULT_FROM_EMAIL,
          audience: {
            listIds: body.audience?.listIds ?? [],
            tagIds: body.audience?.tagIds ?? []
          }
        }
      );
      return campaign ? json(campaign) : json({ error: "Not found" }, 404);
    }

    const openMatch = path.match(/^\/t\/open\/([^/]+)\/([^/]+)\/([^/]+)\.gif$/);
    if (request.method === "GET" && openMatch) {
      return handleOpen(env, openMatch[1], openMatch[2], openMatch[3]);
    }

    const clickMatch = path.match(/^\/t\/click\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (request.method === "GET" && clickMatch) {
      return handleClick(env, clickMatch[1], clickMatch[2], clickMatch[3]);
    }

    const contactUnsubscribeMatch = path.match(
      /^\/unsubscribe\/c\/([^/]+)\/([^/]+)$/,
    );
    if (
      (request.method === "GET" || request.method === "POST") &&
      contactUnsubscribeMatch
    ) {
      // POST supports RFC 8058 one-click unsubscribe (the List-Unsubscribe-Post
      // header advertised on welcome mail); GET supports a human clicking it.
      return handleContactUnsubscribe(
        env,
        contactUnsubscribeMatch[1],
        contactUnsubscribeMatch[2],
      );
    }

    const unsubscribeMatch = path.match(/^\/unsubscribe\/([^/]+)\/([^/]+)$/);
    if (request.method === "GET" && unsubscribeMatch) {
      return handleUnsubscribe(env, unsubscribeMatch[1], unsubscribeMatch[2]);
    }

    if (request.method === "POST" && path === "/webhooks/resend") {
      return handleResendWebhook(request, env);
    }

    if (request.method === "GET") {
      return env.ASSETS.fetch(assetRequest);
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (
      error instanceof AutomationConflictError ||
      error instanceof AutomationEmptyStepsError ||
      error instanceof CampaignConflictError
    ) {
      return json({ error: error.message }, 409);
    }
    if (error instanceof AutomationValidationError) {
      return json({ error: error.message }, 400);
    }
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
}

export default {
  fetch: handleRequest,
  async queue(batch: MessageBatch<SendQueueMessage>, env: Env): Promise<void> {
    const resend = new Resend(env.RESEND_API_KEY);
    const emailAdapter = {
      sendEmail: async (
        payload: {
          from: string;
          to: string[];
          subject: string;
          html: string;
          text: string;
          headers: Record<string, string>;
        },
        options: { idempotencyKey: string },
      ) => {
        const response = await resend.emails.send(payload, {
          idempotencyKey: options.idempotencyKey,
        });
        return { data: response.data, error: response.error };
      },
    };
    for (const message of batch.messages) {
      const body = message.body;
      try {
        if (body.type === "welcome") {
          await processWelcomeSend(env, body, emailAdapter);
        } else if (body.type === "automation") {
          await processAutomationEnrollment(env, body, emailAdapter);
        } else {
          await processCampaignSend(env, body, {
            sendBatch: async (messages, options) => {
              const response = await resend.batch.send(messages, {
                idempotencyKey: options.idempotencyKey,
              });
              return {
                data: response.data?.data ?? null,
                error: response.error,
              };
            },
          });
        }
        message.ack();
      } catch (error) {
        console.error("Send message failed", error);
        message.retry();
      }
    }
  },
  // Sweep due automation waits (and stuck active enrollments) every minute.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const queued = await enqueueDueAutomations(env);
      if (queued > 0) {
        console.log(`Automation sweeper enqueued ${queued} enrollment(s)`);
      }
    } catch (error) {
      console.error("Automation sweeper failed", error);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function requiresAdminAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<boolean> {
  if (isPublicPath(request.method, path)) {
    return false;
  }
  const token = env.EMMAIL_ADMIN_TOKEN;
  if (!token) {
    // Fail closed: an unset admin token means no admin access, not open access.
    return true;
  }
  return !(await hasAdminAccess(request, token));
}

function isPublicPath(method: string, path: string): boolean {
  return (
    path === "/login" ||
    (method === "POST" &&
      path === "/api/integrations/southandozarks/contact-message") ||
    (method === "POST" && path === "/webhooks/resend") ||
    /^\/t\/open\/[^/]+\/[^/]+\/[^/]+\.gif$/.test(path) ||
    /^\/t\/click\/[^/]+\/[^/]+\/[^/]+$/.test(path) ||
    /^\/unsubscribe\/c\/[^/]+\/[^/]+$/.test(path) ||
    /^\/unsubscribe\/[^/]+\/[^/]+$/.test(path)
  );
}

async function hasAdminAccess(
  request: Request,
  token: string,
): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return verifySharedSecret(
      token,
      authorization.slice("bearer ".length).trim(),
    );
  }

  const cookieValue = readCookie(
    request.headers.get("cookie") ?? "",
    "emmail_admin",
  );
  if (!cookieValue) {
    return false;
  }

  return verifySharedSecret(await adminSessionValue(token), cookieValue);
}

async function handleAdminLogin(
  request: Request,
  env: Env,
  basePath: string,
): Promise<Response> {
  if (!env.EMMAIL_ADMIN_TOKEN) {
    return adminLoginPage(
      basePath,
      "Admin access is disabled: EMMAIL_ADMIN_TOKEN is not configured.",
    );
  }

  if (request.method === "GET") {
    return adminLoginPage(basePath);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const ok = await verifySharedSecret(env.EMMAIL_ADMIN_TOKEN, token);
  if (!ok) {
    return adminLoginPage(basePath, "Invalid admin token.");
  }

  const cookiePath = basePath || "/";
  const cookieParts = [
    `emmail_admin=${await adminSessionValue(env.EMMAIL_ADMIN_TOKEN)}`,
    `Path=${cookiePath}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=604800",
  ];
  if (env.APP_BASE_URL.startsWith("https://")) {
    cookieParts.push("Secure");
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: loginRedirectTarget(basePath),
      "set-cookie": cookieParts.join("; "),
      "cache-control": "no-store",
    },
  });
}

function adminLoginPage(basePath: string, message = ""): Response {
  const action = `${basePath}/login`.replace(/^\/\//, "/");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EmMail Admin</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f6f2ea; color: #1d2a2e; }
    main { width: min(360px, calc(100vw - 32px)); }
    h1 { font-size: 1.4rem; margin: 0 0 1rem; }
    form { display: grid; gap: .75rem; }
    input, button { font: inherit; border-radius: 8px; padding: .75rem .85rem; }
    input { border: 1px solid #c9c0b2; background: white; }
    button { border: 0; background: #1f6f68; color: white; font-weight: 700; cursor: pointer; }
    p { color: #9c3d35; min-height: 1.4rem; margin: 0 0 .5rem; }
  </style>
</head>
<body>
  <main>
    <h1>EmMail Admin</h1>
    <p>${escapeHtml(message)}</p>
    <form method="post" action="${escapeHtml(action)}">
      <input name="token" type="password" autocomplete="current-password" placeholder="Admin token" autofocus>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function adminSessionValue(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`emmail-admin:${token}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return "";
}

function loginRedirectTarget(basePath: string): string {
  return basePath || "/";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function names(
  db: D1Database,
  table: "lists" | "tags",
): Promise<Array<{ id: string; name: string }>> {
  const result = await db
    .prepare(`SELECT id, name FROM ${table} ORDER BY name ASC`)
    .all();
  return (result.results ?? []) as Array<{ id: string; name: string }>;
}

async function createName(
  db: D1Database,
  table: "lists" | "tags",
  prefix: string,
  body: { name: string },
): Promise<Response> {
  const existing = await db
    .prepare(`SELECT id, name FROM ${table} WHERE name = ?`)
    .bind(body.name)
    .first<{ id: string; name: string }>();
  if (existing) {
    return json(existing);
  }
  const record = { id: createId(prefix), name: body.name };
  await db
    .prepare(`INSERT INTO ${table} (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(record.id, record.name, nowIso())
    .run();
  return json(record, 201);
}

async function campaignEvents(
  db: D1Database,
  campaignId: string,
): Promise<unknown[]> {
  const result = await db
    .prepare(
      "SELECT id, type, recipient_id, link_id, url, created_at FROM events WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 200",
    )
    .bind(campaignId)
    .all();
  return result.results ?? [];
}

async function handleOpen(
  env: Env,
  recipientId: string,
  campaignId: string,
  token: string,
): Promise<Response> {
  const ok = await verifyToken(
    env.TRACKING_SECRET,
    "open",
    [recipientId, campaignId],
    token,
  );
  if (!ok) {
    return new Response(null, { status: 404 });
  }
  await new CampaignRepository(env.DB).markRecipientEvent(
    recipientId,
    "opened",
  );
  const gif = transparentGif();
  return new Response(
    new Blob([gif as unknown as BlobPart], { type: "image/gif" }),
    {
      headers: {
        "content-type": "image/gif",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    },
  );
}

async function handleClick(
  env: Env,
  recipientId: string,
  linkId: string,
  token: string,
): Promise<Response> {
  const ok = await verifyToken(
    env.TRACKING_SECRET,
    "click",
    [recipientId, linkId],
    token,
  );
  if (!ok) {
    return new Response(null, { status: 404 });
  }
  const campaigns = new CampaignRepository(env.DB);
  const link = await campaigns.getLink(linkId);
  if (!link) {
    return new Response(null, { status: 404 });
  }
  await campaigns.markRecipientEvent(recipientId, "clicked");
  return Response.redirect(link.url, 302);
}

async function handleUnsubscribe(
  env: Env,
  recipientId: string,
  token: string,
): Promise<Response> {
  const ok = await verifyToken(
    env.TRACKING_SECRET,
    "unsubscribe",
    [recipientId],
    token,
  );
  if (!ok) {
    return new Response(null, { status: 404 });
  }
  const campaigns = new CampaignRepository(env.DB);
  const recipient = await campaigns.getRecipient(recipientId);
  if (!recipient) {
    return new Response(null, { status: 404 });
  }
  await new ContactRepository(env.DB).suppressEmail(
    recipient.email,
    "unsubscribe",
    "one-click",
  );
  await campaigns.recordEvent({ recipientId, type: "unsubscribe" });
  return unsubscribedPage();
}

// Contact-scoped unsubscribe for transactional mail (e.g. the welcome email)
// that has no campaign_recipients row. Token purpose is distinct from the
// recipient unsubscribe so the two can never be cross-replayed.
async function handleContactUnsubscribe(
  env: Env,
  contactId: string,
  token: string,
): Promise<Response> {
  const ok = await verifyToken(
    env.TRACKING_SECRET,
    "unsubscribe-contact",
    [contactId],
    token,
  );
  if (!ok) {
    return new Response(null, { status: 404 });
  }
  const contacts = new ContactRepository(env.DB);
  const contact = await contacts.getContactById(contactId);
  if (!contact) {
    return new Response(null, { status: 404 });
  }
  await contacts.suppressEmail(contact.email, "unsubscribe", "one-click");
  await new CampaignRepository(env.DB).recordEvent({
    contactId,
    type: "unsubscribe",
  });
  return unsubscribedPage();
}

function unsubscribedPage(): Response {
  return new Response(
    "<!doctype html><title>Unsubscribed</title><p>You have been unsubscribed.</p>",
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function handleResendWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (
    !request.headers.get("svix-id") ||
    !request.headers.get("svix-timestamp") ||
    !request.headers.get("svix-signature")
  ) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  const payload = await request.text();
  const resend = new Resend(env.RESEND_API_KEY);
  try {
    await handleVerifiedResendWebhook(
      env.DB,
      payload,
      request.headers,
      env.RESEND_WEBHOOK_SECRET,
      (rawPayload, headers, secret) =>
        resend.webhooks.verify({
          payload: rawPayload,
          headers: {
            id: headers.get("svix-id") ?? "",
            timestamp: headers.get("svix-timestamp") ?? "",
            signature: headers.get("svix-signature") ?? "",
          },
          webhookSecret: secret,
        }),
    );
    return json({ ok: true });
  } catch {
    return json({ error: "Invalid webhook signature" }, 401);
  }
}

function transparentGif(): Uint8Array {
  return Uint8Array.from(
    atob("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="),
    (char) => char.charCodeAt(0),
  );
}
