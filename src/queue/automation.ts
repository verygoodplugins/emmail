import type { AutomationSendMessage, Env } from "../env";
import {
  AutomationRepository,
  type AddTagConfig,
  type AutomationEnrollment,
  type AutomationStep,
  type SendEmailConfig,
  type WaitConfig
} from "../db/automation-repository";
import { CampaignRepository } from "../db/campaign-repository";
import { ContactRepository } from "../db/contact-repository";
import { sanitizeName } from "../email/welcome";
import { renderCampaignEmail } from "../email/render";
import { formatFromHeader } from "../lib/email";
import { isIdempotencyConflict, isRetryableResendError, stringifyResendError } from "../lib/resend-errors";
import { signToken } from "../lib/tokens";
import type { ResendEmailAdapter } from "./welcome";

// Cloudflare Queues cap delaySeconds at 12 hours. Longer waits rely on the
// scheduled sweeper reading next_run_at from D1.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

export interface AutomationRunResult {
  status: "completed" | "waiting" | "skipped" | "failed";
  enrollmentId: string;
  stepsRun: number;
  reason?: string;
}

// Enroll a contact into every enabled contact_created automation. Best-effort:
// callers must not fail the ingest path if this throws. At-most-once enrollment
// per (automation, contact) is enforced in the repository.
export async function maybeEnrollContactCreated(env: Env, contactId: string): Promise<number> {
  const automations = new AutomationRepository(env.DB);
  const enabled = await automations.listEnabledByTrigger("contact_created");
  let enrolled = 0;
  for (const automation of enabled) {
    const { enrollment, created } = await automations.enrollContact(automation.id, contactId);
    if (!created) {
      continue;
    }
    await new CampaignRepository(env.DB).recordEvent({
      contactId,
      type: "automation_enrolled",
      metadata: { automationId: automation.id, enrollmentId: enrollment.id, slug: automation.slug }
    });
    await env.SEND_QUEUE.send({ type: "automation", enrollmentId: enrollment.id });
    enrolled += 1;
  }
  return enrolled;
}

// Cron / recovery: re-queue enrollments that are due (waits elapsed, or active
// rows whose immediate queue message was lost).
export async function enqueueDueAutomations(env: Env, limit = 50): Promise<number> {
  const automations = new AutomationRepository(env.DB);
  const due = await automations.listDueEnrollments(limit);
  for (const enrollment of due) {
    await env.SEND_QUEUE.send({ type: "automation", enrollmentId: enrollment.id });
  }
  return due.length;
}

// Drain one enrollment as far as it can go until a wait, terminal state, or
// retryable provider error. Mirrors processWelcomeSend's terminal-vs-retry
// discipline: only throw for retryable Resend failures.
export async function processAutomationEnrollment(
  env: Env,
  message: AutomationSendMessage,
  resend: ResendEmailAdapter
): Promise<AutomationRunResult> {
  const automations = new AutomationRepository(env.DB);
  const campaigns = new CampaignRepository(env.DB);
  const contacts = new ContactRepository(env.DB);

  const enrollment = await automations.getEnrollment(message.enrollmentId);
  if (!enrollment) {
    return { status: "skipped", enrollmentId: message.enrollmentId, stepsRun: 0, reason: "enrollment-not-found" };
  }
  if (enrollment.status === "completed" || enrollment.status === "cancelled") {
    return { status: "skipped", enrollmentId: enrollment.id, stepsRun: 0, reason: `status:${enrollment.status}` };
  }

  const automation = await automations.getAutomation(enrollment.automationId);
  if (!automation) {
    await automations.updateEnrollment(enrollment.id, { status: "failed", lastError: "automation-missing" });
    return { status: "failed", enrollmentId: enrollment.id, stepsRun: 0, reason: "automation-missing" };
  }
  // Kill switch: disabling the automation freezes in-flight enrollments.
  if (!automation.enabled) {
    return { status: "skipped", enrollmentId: enrollment.id, stepsRun: 0, reason: "automation-disabled" };
  }

  const contact = await contacts.getContactById(enrollment.contactId);
  if (!contact) {
    await automations.updateEnrollment(enrollment.id, { status: "cancelled", lastError: "contact-not-found" });
    return { status: "skipped", enrollmentId: enrollment.id, stepsRun: 0, reason: "contact-not-found" };
  }

  let current = enrollment;
  let stepsRun = 0;
  // Bound the loop so a misconfigured zero-wait chain can't spin forever.
  for (let guard = 0; guard < 32; guard += 1) {
    if (current.status === "waiting") {
      if (current.nextRunAt && current.nextRunAt > new Date().toISOString()) {
        await scheduleWake(env, current);
        return { status: "waiting", enrollmentId: current.id, stepsRun, reason: "not-due" };
      }
      // Wait elapsed: advance past the wait step and continue.
      await automations.updateEnrollment(current.id, {
        currentPosition: current.currentPosition + 1,
        status: "active",
        nextRunAt: null,
        lastError: null
      });
      current = (await automations.getEnrollment(current.id))!;
      stepsRun += 1;
      continue;
    }

    if (current.status !== "active" && current.status !== "failed") {
      return { status: "skipped", enrollmentId: current.id, stepsRun, reason: `status:${current.status}` };
    }

    const step = await automations.getStepAt(current.automationId, current.currentPosition);
    if (!step) {
      // Concurrent wakes can both reach "no more steps"; only the first transition
      // to completed should emit automation_completed.
      const beforeComplete = await automations.getEnrollment(current.id);
      if (beforeComplete?.status === "completed") {
        return { status: "completed", enrollmentId: current.id, stepsRun };
      }
      await automations.updateEnrollment(current.id, { status: "completed", nextRunAt: null, lastError: null });
      await campaigns.recordEvent({
        contactId: contact.id,
        type: "automation_completed",
        metadata: { automationId: automation.id, enrollmentId: current.id }
      });
      return { status: "completed", enrollmentId: current.id, stepsRun };
    }

    if (step.stepType === "wait") {
      const waitConfig = step.config as unknown as WaitConfig;
      const seconds = Math.max(0, Number(waitConfig.seconds ?? 0));
      const nextRunAt = new Date(Date.now() + seconds * 1000).toISOString();
      await automations.updateEnrollment(current.id, {
        status: "waiting",
        nextRunAt,
        lastError: null
      });
      current = (await automations.getEnrollment(current.id))!;
      await scheduleWake(env, current, seconds);
      return { status: "waiting", enrollmentId: current.id, stepsRun };
    }

    if (step.stepType === "add_tag") {
      const tagConfig = step.config as unknown as AddTagConfig;
      const tagName = String(tagConfig.tagName ?? "").trim();
      if (tagName) {
        await contacts.addTagByName(contact.id, tagName);
      }
      await campaigns.recordEvent({
        contactId: contact.id,
        type: "automation_tag_added",
        metadata: { automationId: automation.id, enrollmentId: current.id, stepId: step.id, tagName }
      });
      await automations.updateEnrollment(current.id, {
        currentPosition: current.currentPosition + 1,
        status: "active",
        nextRunAt: null
      });
      current = (await automations.getEnrollment(current.id))!;
      stepsRun += 1;
      continue;
    }

    if (step.stepType === "send_email") {
      const outcome = await runSendEmailStep(env, {
        enrollment: current,
        step,
        contact: { id: contact.id, email: contact.email, firstName: contact.first_name, status: contact.status },
        resend,
        campaigns,
        contacts
      });
      if (outcome === "retry") {
        throw new Error(`Retryable Resend automation error for enrollment ${current.id}`);
      }
      if (outcome === "failed") {
        await automations.updateEnrollment(current.id, {
          status: "failed",
          lastError: "send-failed"
        });
        return { status: "failed", enrollmentId: current.id, stepsRun, reason: "send-failed" };
      }
      // sent | dry-run | skipped | conflict — advance either way so one bad
      // suppression check doesn't pin the contact forever on this step.
      await automations.updateEnrollment(current.id, {
        currentPosition: current.currentPosition + 1,
        status: "active",
        nextRunAt: null,
        lastError: null
      });
      current = (await automations.getEnrollment(current.id))!;
      stepsRun += 1;
      continue;
    }

    // Unknown step type: skip forward so a future step type doesn't brick the run.
    await automations.updateEnrollment(current.id, {
      currentPosition: current.currentPosition + 1,
      lastError: `unknown-step:${step.stepType}`
    });
    current = (await automations.getEnrollment(current.id))!;
    stepsRun += 1;
  }

  await automations.updateEnrollment(current.id, { status: "failed", lastError: "step-guard-exceeded" });
  return { status: "failed", enrollmentId: current.id, stepsRun, reason: "step-guard-exceeded" };
}

async function runSendEmailStep(
  env: Env,
  input: {
    enrollment: AutomationEnrollment;
    step: AutomationStep;
    contact: { id: string; email: string; firstName: string; status: string };
    resend: ResendEmailAdapter;
    campaigns: CampaignRepository;
    contacts: ContactRepository;
  }
): Promise<"sent" | "dry-run" | "skipped" | "conflict" | "failed" | "retry"> {
  const { enrollment, step, contact, resend, campaigns, contacts } = input;
  const config = step.config as unknown as SendEmailConfig;

  if (contact.status !== "subscribed") {
    await campaigns.recordEvent({
      contactId: contact.id,
      type: "automation_email_skipped",
      metadata: { enrollmentId: enrollment.id, stepId: step.id, reason: `status:${contact.status}` }
    });
    return "skipped";
  }
  if (await contacts.isSuppressed(contact.email)) {
    await campaigns.recordEvent({
      contactId: contact.id,
      type: "automation_email_skipped",
      metadata: { enrollmentId: enrollment.id, stepId: step.id, reason: "suppressed" }
    });
    return "skipped";
  }

  const firstName = sanitizeName(contact.firstName);
  const subject = applyTemplate(String(config.subject ?? ""), firstName);
  const previewText = applyTemplate(String(config.previewText ?? ""), firstName);
  const markdownBody = applyTemplate(String(config.markdownBody ?? ""), firstName);
  const { html, text } = await renderCampaignEmail({ previewText, markdownBody });

  if (env.EMMAIL_SEND_MODE !== "live") {
    await campaigns.recordEvent({
      contactId: contact.id,
      type: "automation_email_sent",
      providerEventId: "dry-run",
      metadata: {
        mode: "dry-run",
        enrollmentId: enrollment.id,
        stepId: step.id,
        subject
      }
    });
    return "dry-run";
  }

  const unsubscribeUrl = await contactUnsubscribeUrl(env, contact.id);
  const result = await resend.sendEmail(
    {
      from: formatFromHeader(env.DEFAULT_FROM_NAME, env.DEFAULT_FROM_EMAIL),
      to: [contact.email],
      subject,
      html,
      text: `${text}\n\nUnsubscribe: ${unsubscribeUrl}`,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    },
    { idempotencyKey: `automation/${enrollment.id}/${step.id}` }
  );

  if (result.error || !result.data) {
    if (isRetryableResendError(result.error)) {
      return "retry";
    }
    if (isIdempotencyConflict(result.error)) {
      await campaigns.recordEvent({
        contactId: contact.id,
        type: "automation_email_sent",
        providerEventId: "conflict",
        metadata: { mode: "conflict", enrollmentId: enrollment.id, stepId: step.id, subject }
      });
      return "conflict";
    }
    const error = stringifyResendError(result.error);
    await campaigns.recordEvent({
      contactId: contact.id,
      type: "automation_email_failed",
      metadata: { enrollmentId: enrollment.id, stepId: step.id, error }
    });
    return "failed";
  }

  await campaigns.recordEvent({
    contactId: contact.id,
    type: "automation_email_sent",
    providerEventId: result.data.id,
    metadata: { mode: "live", enrollmentId: enrollment.id, stepId: step.id, subject }
  });
  return "sent";
}

function applyTemplate(template: string, firstName: string): string {
  if (!firstName) {
    return template
      .replaceAll("Hi {{first_name}},", "Hi there,")
      .replaceAll("{{first_name}}", "");
  }
  return template.replaceAll("{{first_name}}", firstName);
}

async function scheduleWake(env: Env, enrollment: AutomationEnrollment, secondsHint?: number): Promise<void> {
  if (!enrollment.nextRunAt) {
    return;
  }
  const remainingMs = Math.max(0, Date.parse(enrollment.nextRunAt) - Date.now());
  const remainingSeconds = secondsHint ?? Math.ceil(remainingMs / 1000);
  if (remainingSeconds <= 0) {
    await env.SEND_QUEUE.send({ type: "automation", enrollmentId: enrollment.id });
    return;
  }
  if (remainingSeconds <= MAX_QUEUE_DELAY_SECONDS) {
    await env.SEND_QUEUE.send(
      { type: "automation", enrollmentId: enrollment.id },
      { delaySeconds: remainingSeconds }
    );
    return;
  }
  // Longer waits: the scheduled sweeper will pick this up when next_run_at is due.
}

async function contactUnsubscribeUrl(env: Env, contactId: string): Promise<string> {
  const token = await signToken(env.TRACKING_SECRET, "unsubscribe-contact", [contactId]);
  return `${env.APP_BASE_URL.replace(/\/+$/, "")}/unsubscribe/c/${contactId}/${token}`;
}
