import { createId, nowIso } from "../lib/ids";
import {
  FOLLOWUP_PREVIEW,
  FOLLOWUP_SUBJECT,
  followupMarkdown,
  WELCOME_PREVIEW,
  WELCOME_SUBJECT,
  welcomeMarkdown,
} from "../email/welcome";

export type AutomationTrigger = "contact_created";
export type AutomationStepType = "send_email" | "wait" | "add_tag";
export type EnrollmentStatus =
  | "active"
  | "waiting"
  | "completed"
  | "cancelled"
  | "failed";

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

export interface StepInput {
  stepType: AutomationStepType;
  config: Record<string, unknown>;
}

export class AutomationConflictError extends Error {
  constructor(message = "Automation must be disabled before editing") {
    super(message);
    this.name = "AutomationConflictError";
  }
}

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationValidationError";
  }
}

export class AutomationEmptyStepsError extends Error {
  constructor(
    message = "Automation must have at least one step before enabling",
  ) {
    super(message);
    this.name = "AutomationEmptyStepsError";
  }
}

const WELCOME_SEQUENCE_SLUG = "welcome-sequence";

export class AutomationRepository {
  constructor(private readonly db: D1Database) {}

  async listAutomations(): Promise<AutomationSummary[]> {
    const result = await this.db
      .prepare("SELECT * FROM automations ORDER BY created_at ASC")
      .all();
    const rows = (result.results ?? []) as unknown as AutomationRow[];
    return Promise.all(
      rows.map(async (row) => {
        const automation = mapAutomation(row);
        const steps = await this.listSteps(automation.id);
        const enrollmentCounts = await this.enrollmentCounts(automation.id);
        return { ...automation, steps, enrollmentCounts };
      }),
    );
  }

  async getAutomation(id: string): Promise<Automation | null> {
    const row = await this.db
      .prepare("SELECT * FROM automations WHERE id = ?")
      .bind(id)
      .first<AutomationRow>();
    return row ? mapAutomation(row) : null;
  }

  async getAutomationBySlug(slug: string): Promise<Automation | null> {
    const row = await this.db
      .prepare("SELECT * FROM automations WHERE slug = ?")
      .bind(slug)
      .first<AutomationRow>();
    return row ? mapAutomation(row) : null;
  }

  async listSteps(automationId: string): Promise<AutomationStep[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM automation_steps WHERE automation_id = ? ORDER BY position ASC",
      )
      .bind(automationId)
      .all();
    return ((result.results ?? []) as unknown as AutomationStepRow[]).map(
      mapStep,
    );
  }

  async getStepAt(
    automationId: string,
    position: number,
  ): Promise<AutomationStep | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM automation_steps WHERE automation_id = ? AND position = ?",
      )
      .bind(automationId, position)
      .first<AutomationStepRow>();
    return row ? mapStep(row) : null;
  }

  async listEnabledByTrigger(
    triggerType: AutomationTrigger,
  ): Promise<Automation[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM automations WHERE trigger_type = ? AND enabled = 1 ORDER BY created_at ASC",
      )
      .bind(triggerType)
      .all();
    return ((result.results ?? []) as unknown as AutomationRow[]).map(
      mapAutomation,
    );
  }

  async createAutomation(name: string): Promise<AutomationSummary> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new AutomationValidationError("Automation name is required");
    }
    const now = nowIso();
    const automationId = createId("aut");
    const slug = await this.uniqueSlug(trimmed);
    await this.db
      .prepare(
        `INSERT INTO automations (id, name, slug, trigger_type, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'contact_created', 0, ?, ?)`,
      )
      .bind(automationId, trimmed, slug, now, now)
      .run();
    return this.getAutomationSummary(automationId);
  }

  async updateAutomationName(
    id: string,
    name: string,
  ): Promise<AutomationSummary | null> {
    const automation = await this.getAutomation(id);
    if (!automation) {
      return null;
    }
    this.assertEditable(automation);
    const trimmed = name.trim();
    if (!trimmed) {
      throw new AutomationValidationError("Automation name is required");
    }
    await this.db
      .prepare("UPDATE automations SET name = ?, updated_at = ? WHERE id = ?")
      .bind(trimmed, nowIso(), id)
      .run();
    return this.getAutomationSummary(id);
  }

  async replaceSteps(
    id: string,
    steps: StepInput[],
    options: { name?: string } = {},
  ): Promise<AutomationSummary | null> {
    const automation = await this.getAutomation(id);
    if (!automation) {
      return null;
    }
    this.assertEditable(automation);
    for (const step of steps) {
      validateStepInput(step);
    }
    assertConsecutiveNonWaitWithinGuard(steps);

    const trimmedName =
      options.name === undefined ? null : options.name.trim();
    if (options.name !== undefined && !trimmedName) {
      throw new AutomationValidationError("Automation name is required");
    }

    const now = nowIso();
    // Conditional mutations so a concurrent enable cannot leave the sequence
    // enabled with half-replaced (or empty) steps mid-batch.
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `DELETE FROM automation_steps
           WHERE automation_id = ?
             AND (SELECT enabled FROM automations WHERE id = ?) = 0`,
        )
        .bind(id, id),
    ];
    for (let position = 0; position < steps.length; position += 1) {
      const step = steps[position];
      statements.push(
        this.db
          .prepare(
            `INSERT INTO automation_steps (id, automation_id, position, step_type, config_json, created_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE (SELECT enabled FROM automations WHERE id = ?) = 0`,
          )
          .bind(
            createId("stp"),
            id,
            position,
            step.stepType,
            JSON.stringify(step.config),
            now,
            id,
          ),
      );
    }
    statements.push(
      trimmedName
        ? this.db
            .prepare(
              "UPDATE automations SET name = ?, updated_at = ? WHERE id = ? AND enabled = 0",
            )
            .bind(trimmedName, now, id)
        : this.db
            .prepare(
              "UPDATE automations SET updated_at = ? WHERE id = ? AND enabled = 0",
            )
            .bind(now, id),
    );
    const results = await this.db.batch(statements);
    const touched = results[results.length - 1]?.meta?.changes ?? 0;
    if (touched !== 1) {
      throw new AutomationConflictError();
    }
    return this.getAutomationSummary(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<Automation | null> {
    const automation = await this.getAutomation(id);
    if (!automation) {
      return null;
    }
    if (enabled) {
      const steps = await this.listSteps(id);
      if (steps.length === 0) {
        throw new AutomationEmptyStepsError();
      }
      assertConsecutiveNonWaitWithinGuard(steps);
      const now = nowIso();
      const result = await this.db
        .prepare(
          `UPDATE automations SET enabled = 1, updated_at = ?
           WHERE id = ? AND enabled = 0
             AND (SELECT COUNT(*) FROM automation_steps WHERE automation_id = ?) > 0`,
        )
        .bind(now, id, id)
        .run();
      if ((result.meta?.changes ?? 0) !== 1) {
        const current = await this.getAutomation(id);
        if (!current) {
          return null;
        }
        if (current.enabled) {
          return current;
        }
        throw new AutomationEmptyStepsError();
      }
      return this.getAutomation(id);
    }
    const now = nowIso();
    await this.db
      .prepare(
        "UPDATE automations SET enabled = 0, updated_at = ? WHERE id = ?",
      )
      .bind(now, id)
      .run();
    return this.getAutomation(id);
  }

  async getEnrollment(id: string): Promise<AutomationEnrollment | null> {
    const row = await this.db
      .prepare("SELECT * FROM automation_enrollments WHERE id = ?")
      .bind(id)
      .first<EnrollmentRow>();
    return row ? mapEnrollment(row) : null;
  }

  async getEnrollmentForContact(
    automationId: string,
    contactId: string,
  ): Promise<AutomationEnrollment | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?",
      )
      .bind(automationId, contactId)
      .first<EnrollmentRow>();
    return row ? mapEnrollment(row) : null;
  }

  async listEnrollments(
    automationId: string,
    limit = 50,
  ): Promise<AutomationEnrollment[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_enrollments
       WHERE automation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      )
      .bind(automationId, limit)
      .all();
    return ((result.results ?? []) as unknown as EnrollmentRow[]).map(
      mapEnrollment,
    );
  }

  // Enrollments the cron sweeper should re-queue:
  // - waiting rows whose next_run_at has elapsed (covers >12h waits and lost delay)
  // - active rows stuck for >5 minutes (lost the immediate wake message)
  async listDueEnrollments(
    limit = 50,
    stuckAfterMs = 5 * 60 * 1000,
  ): Promise<AutomationEnrollment[]> {
    const now = nowIso();
    const stuckBefore = new Date(Date.now() - stuckAfterMs).toISOString();
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_enrollments
       WHERE (status = 'waiting' AND next_run_at IS NOT NULL AND next_run_at <= ?)
          OR (status = 'active' AND updated_at <= ?)
       ORDER BY COALESCE(next_run_at, updated_at) ASC
       LIMIT ?`,
      )
      .bind(now, stuckBefore, limit)
      .all();
    return ((result.results ?? []) as unknown as EnrollmentRow[]).map(
      mapEnrollment,
    );
  }

  async enrollContact(
    automationId: string,
    contactId: string,
  ): Promise<{ enrollment: AutomationEnrollment; created: boolean }> {
    const existing = await this.getEnrollmentForContact(
      automationId,
      contactId,
    );
    if (existing) {
      // Never re-enroll completed/cancelled/active/waiting — at most once.
      // Only a failed enrollment may be restarted (self-heal after a hard error).
      if (existing.status !== "failed") {
        return { enrollment: existing, created: false };
      }
      const now = nowIso();
      await this.db
        .prepare(
          `UPDATE automation_enrollments
         SET current_position = 0, status = 'active', next_run_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`,
        )
        .bind(now, existing.id)
        .run();
      const restarted = await this.getEnrollment(existing.id);
      return { enrollment: restarted!, created: true };
    }

    const now = nowIso();
    const id = createId("enr");
    await this.db
      .prepare(
        `INSERT INTO automation_enrollments
       (id, automation_id, contact_id, current_position, status, next_run_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'active', NULL, NULL, ?, ?)`,
      )
      .bind(id, automationId, contactId, now, now)
      .run();
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
    },
  ): Promise<void> {
    const existing = await this.getEnrollment(id);
    if (!existing) {
      return;
    }
    await this.db
      .prepare(
        `UPDATE automation_enrollments
       SET current_position = ?, status = ?, next_run_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      )
      .bind(
        patch.currentPosition ?? existing.currentPosition,
        patch.status ?? existing.status,
        patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
        patch.lastError === undefined ? existing.lastError : patch.lastError,
        nowIso(),
        id,
      )
      .run();
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
    await this.db
      .prepare(
        `INSERT INTO automations (id, name, slug, trigger_type, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'contact_created', 0, ?, ?)`,
      )
      .bind(automationId, "Welcome sequence", WELCOME_SEQUENCE_SLUG, now, now)
      .run();

    const steps: Array<{
      type: AutomationStepType;
      config: Record<string, unknown>;
    }> = [
      {
        type: "send_email",
        config: {
          subject: WELCOME_SUBJECT,
          previewText: WELCOME_PREVIEW,
          // {{first_name}} is filled at send time from the contact record.
          markdownBody: welcomeMarkdown("{{first_name}}"),
        },
      },
      {
        type: "wait",
        // Two minutes for local demos; operators can lengthen via SQL/API later.
        config: { seconds: 120 },
      },
      {
        type: "send_email",
        config: {
          subject: FOLLOWUP_SUBJECT,
          previewText: FOLLOWUP_PREVIEW,
          markdownBody: followupMarkdown("{{first_name}}"),
        },
      },
      {
        type: "add_tag",
        config: { tagName: "welcome-sequence-complete" },
      },
    ];

    for (let position = 0; position < steps.length; position += 1) {
      const step = steps[position];
      await this.db
        .prepare(
          `INSERT INTO automation_steps (id, automation_id, position, step_type, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          createId("stp"),
          automationId,
          position,
          step.type,
          JSON.stringify(step.config),
          now,
        )
        .run();
    }

    const automation = (await this.getAutomation(automationId))!;
    const seededSteps = await this.listSteps(automationId);
    return {
      ...automation,
      steps: seededSteps,
      enrollmentCounts: {
        active: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    };
  }

  private async enrollmentCounts(
    automationId: string,
  ): Promise<AutomationSummary["enrollmentCounts"]> {
    const result = await this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
       FROM automation_enrollments
       WHERE automation_id = ?
       GROUP BY status`,
      )
      .bind(automationId)
      .all();
    const counts = {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of (result.results ?? []) as Array<{
      status: EnrollmentStatus;
      count: number;
    }>) {
      if (row.status in counts) {
        counts[row.status] = Number(row.count);
      }
    }
    return counts;
  }

  private async getAutomationSummary(id: string): Promise<AutomationSummary> {
    const automation = (await this.getAutomation(id))!;
    const steps = await this.listSteps(id);
    const enrollmentCounts = await this.enrollmentCounts(id);
    return { ...automation, steps, enrollmentCounts };
  }

  private assertEditable(automation: Automation): void {
    if (automation.enabled) {
      throw new AutomationConflictError();
    }
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    let candidate = base;
    let suffix = 2;
    while (await this.getAutomationBySlug(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
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
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
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
    updatedAt: row.updated_at,
  };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "sequence";
}

/**
 * Matches processAutomationEnrollment `guard < 32`.
 * A wake that advances a due wait spends one iteration first, so a post-wait
 * run of 31 non-wait steps cannot complete before the guard trips. Cap all
 * consecutive non-wait runs at 30.
 */
const MAX_CONSECUTIVE_NON_WAIT_STEPS = 30;

function assertConsecutiveNonWaitWithinGuard(
  steps: Array<{ stepType: string }>,
): void {
  let run = 0;
  for (const step of steps) {
    if (step.stepType === "wait") {
      run = 0;
      continue;
    }
    run += 1;
    if (run > MAX_CONSECUTIVE_NON_WAIT_STEPS) {
      throw new AutomationValidationError(
        `Sequences cannot have more than ${MAX_CONSECUTIVE_NON_WAIT_STEPS} consecutive non-wait steps`,
      );
    }
  }
}

function validateStepInput(step: StepInput): void {
  if (!step || typeof step !== "object") {
    throw new AutomationValidationError("Each step must be an object");
  }
  if (
    !step.config ||
    typeof step.config !== "object" ||
    Array.isArray(step.config)
  ) {
    throw new AutomationValidationError("Each step requires a config object");
  }
  if (step.stepType === "send_email") {
    const subject = String(step.config.subject ?? "").trim();
    const markdownBody = String(step.config.markdownBody ?? "").trim();
    if (!subject || !markdownBody) {
      throw new AutomationValidationError(
        "send_email steps require subject and markdownBody",
      );
    }
    return;
  }
  if (step.stepType === "wait") {
    const seconds = Number(step.config.seconds ?? 0);
    // Cap so Date.now() + seconds*1000 stays representable for toISOString().
    const maxWaitSeconds = 60 * 60 * 24 * 365 * 10;
    if (
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > maxWaitSeconds
    ) {
      throw new AutomationValidationError(
        `wait steps require seconds between 1 and ${maxWaitSeconds}`,
      );
    }
    return;
  }
  if (step.stepType === "add_tag") {
    const tagName = String(step.config.tagName ?? "").trim();
    if (!tagName) {
      throw new AutomationValidationError("add_tag steps require tagName");
    }
    return;
  }
  throw new AutomationValidationError(
    `Unknown step type: ${String(step.stepType)}`,
  );
}

export { validateStepInput };

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
