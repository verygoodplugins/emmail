import { createId, nowIso } from "../lib/ids";
import { FOLLOWUP_PREVIEW, FOLLOWUP_SUBJECT, followupMarkdown, WELCOME_PREVIEW, WELCOME_SUBJECT, welcomeMarkdown } from "../email/welcome";

export type AutomationTrigger = "contact_created";
export type AutomationStepType = "send_email" | "wait" | "add_tag";
export type EnrollmentStatus = "active" | "waiting" | "completed" | "cancelled" | "failed";

export interface Automation {
  id: string;
  name: string;
  slug: string;
  triggerType: AutomationTrigger;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationStep {
  id: string;
  automationId: string;
  position: number;
  stepType: AutomationStepType;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface AutomationEnrollment {
  id: string;
  automationId: string;
  contactId: string;
  currentPosition: number;
  status: EnrollmentStatus;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationSummary extends Automation {
  steps: AutomationStep[];
  enrollmentCounts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
}

export interface SendEmailConfig {
  subject: string;
  previewText?: string;
  markdownBody: string;
}

export interface WaitConfig {
  seconds: number;
}

export interface AddTagConfig {
  tagName: string;
}

const WELCOME_SEQUENCE_SLUG = "welcome-sequence";

export class AutomationRepository {
  constructor(private readonly db: D1Database) {}

  async listAutomations(): Promise<AutomationSummary[]> {
    const result = await this.db.prepare(
      "SELECT * FROM automations ORDER BY created_at ASC"
    ).all();
    const rows = (result.results ?? []) as unknown as AutomationRow[];
    return Promise.all(rows.map(async (row) => {
      const automation = mapAutomation(row);
      const steps = await this.listSteps(automation.id);
      const enrollmentCounts = await this.enrollmentCounts(automation.id);
      return { ...automation, steps, enrollmentCounts };
    }));
  }

  async getAutomation(id: string): Promise<Automation | null> {
    const row = await this.db.prepare("SELECT * FROM automations WHERE id = ?")
      .bind(id)
      .first<AutomationRow>();
    return row ? mapAutomation(row) : null;
  }

  async getAutomationBySlug(slug: string): Promise<Automation | null> {
    const row = await this.db.prepare("SELECT * FROM automations WHERE slug = ?")
      .bind(slug)
      .first<AutomationRow>();
    return row ? mapAutomation(row) : null;
  }

  async listSteps(automationId: string): Promise<AutomationStep[]> {
    const result = await this.db.prepare(
      "SELECT * FROM automation_steps WHERE automation_id = ? ORDER BY position ASC"
    ).bind(automationId).all();
    return ((result.results ?? []) as unknown as AutomationStepRow[]).map(mapStep);
  }

  async getStepAt(automationId: string, position: number): Promise<AutomationStep | null> {
    const row = await this.db.prepare(
      "SELECT * FROM automation_steps WHERE automation_id = ? AND position = ?"
    ).bind(automationId, position).first<AutomationStepRow>();
    return row ? mapStep(row) : null;
  }

  async listEnabledByTrigger(triggerType: AutomationTrigger): Promise<Automation[]> {
    const result = await this.db.prepare(
      "SELECT * FROM automations WHERE trigger_type = ? AND enabled = 1 ORDER BY created_at ASC"
    ).bind(triggerType).all();
    return ((result.results ?? []) as unknown as AutomationRow[]).map(mapAutomation);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation | null> {
    const now = nowIso();
    await this.db.prepare(
      "UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?"
    ).bind(enabled ? 1 : 0, now, id).run();
    return this.getAutomation(id);
  }

  async getEnrollment(id: string): Promise<AutomationEnrollment | null> {
    const row = await this.db.prepare("SELECT * FROM automation_enrollments WHERE id = ?")
      .bind(id)
      .first<EnrollmentRow>();
    return row ? mapEnrollment(row) : null;
  }

  async getEnrollmentForContact(automationId: string, contactId: string): Promise<AutomationEnrollment | null> {
    const row = await this.db.prepare(
      "SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?"
    ).bind(automationId, contactId).first<EnrollmentRow>();
    return row ? mapEnrollment(row) : null;
  }

  async listEnrollments(automationId: string, limit = 50): Promise<AutomationEnrollment[]> {
    const result = await this.db.prepare(
      `SELECT * FROM automation_enrollments
       WHERE automation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(automationId, limit).all();
    return ((result.results ?? []) as unknown as EnrollmentRow[]).map(mapEnrollment);
  }

  // Enrollments the cron sweeper should re-queue:
  // - waiting rows whose next_run_at has elapsed (covers >12h waits and lost delay)
  // - active rows stuck for >5 minutes (lost the immediate wake message)
  async listDueEnrollments(limit = 50, stuckAfterMs = 5 * 60 * 1000): Promise<AutomationEnrollment[]> {
    const now = nowIso();
    const stuckBefore = new Date(Date.now() - stuckAfterMs).toISOString();
    const result = await this.db.prepare(
      `SELECT * FROM automation_enrollments
       WHERE (status = 'waiting' AND next_run_at IS NOT NULL AND next_run_at <= ?)
          OR (status = 'active' AND updated_at <= ?)
       ORDER BY COALESCE(next_run_at, updated_at) ASC
       LIMIT ?`
    ).bind(now, stuckBefore, limit).all();
    return ((result.results ?? []) as unknown as EnrollmentRow[]).map(mapEnrollment);
  }

  async enrollContact(automationId: string, contactId: string): Promise<{ enrollment: AutomationEnrollment; created: boolean }> {
    const existing = await this.getEnrollmentForContact(automationId, contactId);
    if (existing) {
      // Never re-enroll completed/cancelled/active/waiting — at most once.
      // Only a failed enrollment may be restarted (self-heal after a hard error).
      if (existing.status !== "failed") {
        return { enrollment: existing, created: false };
      }
      const now = nowIso();
      await this.db.prepare(
        `UPDATE automation_enrollments
         SET current_position = 0, status = 'active', next_run_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(now, existing.id).run();
      const restarted = await this.getEnrollment(existing.id);
      return { enrollment: restarted!, created: true };
    }

    const now = nowIso();
    const id = createId("enr");
    await this.db.prepare(
      `INSERT INTO automation_enrollments
       (id, automation_id, contact_id, current_position, status, next_run_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', NULL, NULL, ?, ?)`
    ).bind(id, automationId, contactId, now, now).run();
    const enrollment = await this.getEnrollment(id);
    return { enrollment: enrollment!, created: true };
  }

  async updateEnrollment(
    id: string,
    patch: {
      currentPosition?: number;
      status?: EnrollmentStatus;
      nextRunAt?: string | null;
      lastError?: string | null;
    }
  ): Promise<void> {
    const existing = await this.getEnrollment(id);
    if (!existing) {
      return;
    }
    await this.db.prepare(
      `UPDATE automation_enrollments
       SET current_position = ?, status = ?, next_run_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      patch.currentPosition ?? existing.currentPosition,
      patch.status ?? existing.status,
      patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
      patch.lastError === undefined ? existing.lastError : patch.lastError,
      nowIso(),
      id
    ).run();
  }

  // Idempotent seed of the demo welcome sequence. Does not flip enabled.
  async ensureWelcomeSequence(): Promise<AutomationSummary> {
    const existing = await this.getAutomationBySlug(WELCOME_SEQUENCE_SLUG);
    if (existing) {
      const steps = await this.listSteps(existing.id);
      const enrollmentCounts = await this.enrollmentCounts(existing.id);
      return { ...existing, steps, enrollmentCounts };
    }

    const now = nowIso();
    const automationId = createId("aut");
    await this.db.prepare(
      `INSERT INTO automations (id, name, slug, trigger_type, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'contact_created', 0, ?, ?)`
    ).bind(automationId, "Welcome sequence", WELCOME_SEQUENCE_SLUG, now, now).run();

    const steps: Array<{ type: AutomationStepType; config: Record<string, unknown> }> = [
      {
        type: "send_email",
        config: {
          subject: WELCOME_SUBJECT,
          previewText: WELCOME_PREVIEW,
          // {{first_name}} is filled at send time from the contact record.
          markdownBody: welcomeMarkdown("{{first_name}}")
        }
      },
      {
        type: "wait",
        // Two minutes for local demos; operators can lengthen via SQL/API later.
        config: { seconds: 120 }
      },
      {
        type: "send_email",
        config: {
          subject: FOLLOWUP_SUBJECT,
          previewText: FOLLOWUP_PREVIEW,
          markdownBody: followupMarkdown("{{first_name}}")
        }
      },
      {
        type: "add_tag",
        config: { tagName: "welcome-sequence-complete" }
      }
    ];

    for (let position = 0; position < steps.length; position += 1) {
      const step = steps[position];
      await this.db.prepare(
        `INSERT INTO automation_steps (id, automation_id, position, step_type, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(createId("stp"), automationId, position, step.type, JSON.stringify(step.config), now).run();
    }

    const automation = (await this.getAutomation(automationId))!;
    const seededSteps = await this.listSteps(automationId);
    return {
      ...automation,
      steps: seededSteps,
      enrollmentCounts: { active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 }
    };
  }

  private async enrollmentCounts(automationId: string): Promise<AutomationSummary["enrollmentCounts"]> {
    const result = await this.db.prepare(
      `SELECT status, COUNT(*) AS count
       FROM automation_enrollments
       WHERE automation_id = ?
       GROUP BY status`
    ).bind(automationId).all();
    const counts = { active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of (result.results ?? []) as Array<{ status: EnrollmentStatus; count: number }>) {
      if (row.status in counts) {
        counts[row.status] = Number(row.count);
      }
    }
    return counts;
  }
}

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    triggerType: row.trigger_type as AutomationTrigger,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapStep(row: AutomationStepRow): AutomationStep {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config_json || "{}") as Record<string, unknown>;
  } catch {
    config = {};
  }
  return {
    id: row.id,
    automationId: row.automation_id,
    position: row.position,
    stepType: row.step_type as AutomationStepType,
    config,
    createdAt: row.created_at
  };
}

function mapEnrollment(row: EnrollmentRow): AutomationEnrollment {
  return {
    id: row.id,
    automationId: row.automation_id,
    contactId: row.contact_id,
    currentPosition: row.current_position,
    status: row.status as EnrollmentStatus,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface AutomationRow {
  id: string;
  name: string;
  slug: string;
  trigger_type: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface AutomationStepRow {
  id: string;
  automation_id: string;
  position: number;
  step_type: string;
  config_json: string;
  created_at: string;
}

interface EnrollmentRow {
  id: string;
  automation_id: string;
  contact_id: string;
  current_position: number;
  status: string;
  next_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
