import { createId, nowIso } from "../lib/ids";

export interface CampaignInput {
  name: string;
  subject: string;
  previewText: string;
  markdownBody: string;
  fromName: string;
  fromEmail: string;
  audience: { listIds: string[]; tagIds: string[] };
}

export class CampaignConflictError extends Error {
  constructor(message = "Campaign can only be edited while draft") {
    super(message);
    this.name = "CampaignConflictError";
  }
}

export class CampaignRepository {
  constructor(private readonly db: D1Database) {}

  async createCampaign(input: CampaignInput): Promise<CampaignRecord> {
    const now = nowIso();
    const id = createId("cmp");
    await this.db.prepare(
      `INSERT INTO campaigns
       (id, name, subject, preview_text, markdown_body, from_name, from_email, audience_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).bind(
      id,
      input.name,
      input.subject,
      input.previewText,
      input.markdownBody,
      input.fromName,
      input.fromEmail,
      JSON.stringify(input.audience),
      now,
      now
    ).run();

    const campaign = await this.getCampaign(id);
    if (!campaign) {
      throw new Error("Campaign insert failed");
    }
    return campaign;
  }

  async updateCampaign(
    campaignId: string,
    input: CampaignInput
  ): Promise<CampaignRecord | null> {
    const existing = await this.getCampaign(campaignId);
    if (!existing) {
      return null;
    }
    if (existing.status !== "draft") {
      throw new CampaignConflictError();
    }
    const now = nowIso();
    await this.db.prepare(
      `UPDATE campaigns
       SET name = ?, subject = ?, preview_text = ?, markdown_body = ?,
           audience_json = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      input.name,
      input.subject,
      input.previewText,
      input.markdownBody,
      JSON.stringify(input.audience),
      now,
      campaignId
    ).run();
    return this.getCampaign(campaignId);
  }

  async getCampaign(campaignId: string): Promise<CampaignRecord | null> {
    const row = await this.db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first<CampaignRow>();
    return row ? mapCampaign(row) : null;
  }

  async listCampaigns(): Promise<CampaignRecord[]> {
    const result = await this.db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
    return ((result.results ?? []) as unknown as CampaignRow[]).map(mapCampaign);
  }

  async snapshotAudience(campaignId: string): Promise<{ createdRecipients: number; skippedSuppressed: number }> {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const audience = campaign.audience;
    const contacts = await this.selectAudience(audience);
    let createdRecipients = 0;
    let skippedSuppressed = 0;
    const now = nowIso();

    for (const contact of contacts) {
      const suppressed = await this.db.prepare("SELECT id FROM suppressions WHERE email = ? LIMIT 1").bind(contact.email).first();
      if (suppressed) {
        skippedSuppressed += 1;
        continue;
      }
      if (contact.status !== "subscribed") {
        continue;
      }

      const recipientId = createId("rcp");
      const result = await this.db.prepare(
        `INSERT OR IGNORE INTO campaign_recipients
         (id, campaign_id, contact_id, email, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(recipientId, campaignId, contact.id, contact.email, now, now).run();
      createdRecipients += Number(result.meta?.changes ?? 0);
    }

    if (createdRecipients > 0) {
      await this.updateCampaignStatus(campaignId, "sending");
    }

    return { createdRecipients, skippedSuppressed };
  }

  async listRecipientsForSend(
    campaignId: string,
    limit: number,
    statuses: string[] = ["pending"]
  ): Promise<CampaignRecipient[]> {
    const placeholders = statuses.map(() => "?").join(", ");
    const result = await this.db.prepare(
      `SELECT * FROM campaign_recipients
       WHERE campaign_id = ? AND status IN (${placeholders})
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    ).bind(campaignId, ...statuses, limit).all();

    return ((result.results ?? []) as unknown as RecipientRow[]).map(mapRecipient);
  }

  async countRecipientsByStatus(campaignId: string, status: string): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? AND status = ?"
    ).bind(campaignId, status).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async getCampaignStats(campaignId: string): Promise<CampaignStats> {
    const row = await this.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaign_recipients WHERE campaign_id = ?`
    ).bind(campaignId).first<Record<string, number | null>>();

    return {
      total: Number(row?.total ?? 0),
      sent: Number(row?.sent ?? 0),
      delivered: Number(row?.delivered ?? 0),
      opened: Number(row?.opened ?? 0),
      clicked: Number(row?.clicked ?? 0),
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0)
    };
  }

  async applySendResults(input: {
    campaignId: string;
    batchIndex: number;
    outcomes: SendOutcome[];
  }): Promise<void> {
    const now = nowIso();
    const statements: D1PreparedStatement[] = [];

    for (const outcome of input.outcomes) {
      const recipient = outcome.recipient;
      if (outcome.status === "sent" || outcome.status === "dry-run") {
        const providerId = outcome.status === "sent" ? outcome.resendEmailId : "dry-run";
        statements.push(
          this.db.prepare(
            "UPDATE campaign_recipients SET status = 'sent', resend_email_id = ?, sent_at = ?, updated_at = ? WHERE id = ?"
          ).bind(providerId, now, now, recipient.id)
        );
        statements.push(this.eventStatement({
          campaignId: recipient.campaignId,
          contactId: recipient.contactId,
          recipientId: recipient.id,
          type: "send",
          providerEventId: providerId,
          metadata: outcome.status === "dry-run" ? { mode: "dry-run" } : {},
          now
        }));
      } else {
        statements.push(
          this.db.prepare(
            "UPDATE campaign_recipients SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
          ).bind(outcome.error, now, recipient.id)
        );
        statements.push(this.eventStatement({
          campaignId: recipient.campaignId,
          contactId: recipient.contactId,
          recipientId: recipient.id,
          type: "send_failed",
          providerEventId: null,
          metadata: { error: outcome.error },
          now
        }));
      }
    }

    statements.push(
      this.db.prepare("UPDATE campaigns SET last_completed_batch = ?, updated_at = ? WHERE id = ?")
        .bind(input.batchIndex, now, input.campaignId)
    );

    await this.db.batch(statements);
  }

  private eventStatement(input: {
    campaignId: string;
    contactId: string;
    recipientId: string;
    type: string;
    providerEventId: string | null;
    metadata: Record<string, unknown>;
    now: string;
  }): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO events
       (id, campaign_id, contact_id, recipient_id, type, provider_event_id, link_id, url, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).bind(
      createId("evt"),
      input.campaignId,
      input.contactId,
      input.recipientId,
      input.type,
      input.providerEventId,
      JSON.stringify(input.metadata),
      input.now
    );
  }

  async getRecipient(recipientId: string): Promise<CampaignRecipient | null> {
    const row = await this.db.prepare("SELECT * FROM campaign_recipients WHERE id = ?")
      .bind(recipientId)
      .first<RecipientRow>();
    return row ? mapRecipient(row) : null;
  }

  async findRecipientByProviderId(providerId: string): Promise<CampaignRecipient | null> {
    const row = await this.db.prepare("SELECT * FROM campaign_recipients WHERE resend_email_id = ?")
      .bind(providerId)
      .first<RecipientRow>();
    return row ? mapRecipient(row) : null;
  }

  async markRecipientSent(recipientId: string, resendEmailId: string): Promise<void> {
    const now = nowIso();
    await this.db.prepare(
      "UPDATE campaign_recipients SET status = 'sent', resend_email_id = ?, sent_at = ?, updated_at = ? WHERE id = ?"
    ).bind(resendEmailId, now, now, recipientId).run();
    await this.recordEvent({ recipientId, type: "send", providerEventId: resendEmailId });
  }

  async markRecipientDryRun(recipientId: string): Promise<void> {
    const now = nowIso();
    await this.db.prepare(
      "UPDATE campaign_recipients SET status = 'sent', resend_email_id = 'dry-run', sent_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now, now, recipientId).run();
    await this.recordEvent({ recipientId, type: "send", providerEventId: "dry-run", metadata: { mode: "dry-run" } });
  }

  async markRecipientFailed(recipientId: string, error: string): Promise<void> {
    const now = nowIso();
    await this.db.prepare(
      "UPDATE campaign_recipients SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    ).bind(error, now, recipientId).run();
    await this.recordEvent({ recipientId, type: "send_failed", metadata: { error } });
  }

  async markRecipientEvent(recipientId: string, type: string, providerEventId?: string): Promise<void> {
    const now = nowIso();
    const statusPatch = eventStatusPatch(type);
    if (statusPatch) {
      await this.db.prepare(statusPatch.sql).bind(...statusPatch.bindings(now, providerEventId), recipientId).run();
    }
    await this.recordEvent({ recipientId, type, providerEventId });
  }

  async recordEvent(input: {
    recipientId?: string;
    campaignId?: string | null;
    contactId?: string | null;
    type: string;
    providerEventId?: string | null;
    linkId?: string | null;
    url?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    let campaignId = input.campaignId ?? null;
    let contactId = input.contactId ?? null;
    if (input.recipientId && (!campaignId || !contactId)) {
      const recipient = await this.db.prepare("SELECT campaign_id, contact_id FROM campaign_recipients WHERE id = ?")
        .bind(input.recipientId)
        .first<{ campaign_id: string; contact_id: string }>();
      campaignId = campaignId ?? recipient?.campaign_id ?? null;
      contactId = contactId ?? recipient?.contact_id ?? null;
    }

    await this.db.prepare(
      `INSERT INTO events
       (id, campaign_id, contact_id, recipient_id, type, provider_event_id, link_id, url, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      createId("evt"),
      campaignId,
      contactId,
      input.recipientId ?? null,
      input.type,
      input.providerEventId ?? null,
      input.linkId ?? null,
      input.url ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso()
    ).run();
  }

  // Resolve a transactional send (welcome or automation email) back to its
  // contact by the Resend provider id stored on the send event. These emails
  // have no campaign_recipients row, so bounce/complaint webhooks use this to
  // find who to suppress.
  async findWelcomeContactByProviderId(providerId: string): Promise<{ contactId: string; email: string } | null> {
    const row = await this.db.prepare(
      `SELECT c.id AS contactId, c.email AS email
       FROM events e JOIN contacts c ON c.id = e.contact_id
       WHERE e.type IN ('welcome_sent', 'automation_email_sent') AND e.provider_event_id = ?
       LIMIT 1`
    ).bind(providerId).first<{ contactId: string; email: string }>();
    return row ?? null;
  }

  // True when the contact already has any event of the given types — used to
  // gate the once-per-contact welcome email (welcome_sent).
  async hasContactEvent(contactId: string, types: string[]): Promise<boolean> {
    if (types.length === 0) {
      return false;
    }
    const placeholders = types.map(() => "?").join(", ");
    const row = await this.db.prepare(
      `SELECT id FROM events WHERE contact_id = ? AND type IN (${placeholders}) LIMIT 1`
    ).bind(contactId, ...types).first<{ id: string }>();
    return Boolean(row);
  }

  async ensureLinks(campaignId: string, urls: string[]): Promise<Array<{ id: string; url: string; position: number }>> {
    const now = nowIso();
    for (let position = 0; position < urls.length; position += 1) {
      await this.db.prepare(
        `INSERT OR IGNORE INTO campaign_links (id, campaign_id, url, position, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(createId("lnk"), campaignId, urls[position], position, now).run();
    }
    return this.listLinks(campaignId);
  }

  async listLinks(campaignId: string): Promise<Array<{ id: string; url: string; position: number }>> {
    const result = await this.db.prepare(
      "SELECT id, url, position FROM campaign_links WHERE campaign_id = ? ORDER BY position ASC"
    ).bind(campaignId).all();
    return (result.results ?? []) as Array<{ id: string; url: string; position: number }>;
  }

  async getLink(linkId: string): Promise<{ id: string; campaignId: string; url: string } | null> {
    const row = await this.db.prepare("SELECT id, campaign_id, url FROM campaign_links WHERE id = ?")
      .bind(linkId)
      .first<{ id: string; campaign_id: string; url: string }>();
    return row ? { id: row.id, campaignId: row.campaign_id, url: row.url } : null;
  }

  async updateCampaignStatus(campaignId: string, status: string): Promise<void> {
    await this.db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, nowIso(), campaignId)
      .run();
  }

  private async selectAudience(audience: { listIds: string[]; tagIds: string[] }): Promise<Array<{ id: string; email: string; status: string }>> {
    const predicates = ["1 = 1"];
    const params: string[] = [];

    if (audience.listIds.length > 0) {
      const placeholders = audience.listIds.map(() => "?").join(", ");
      predicates.push(
        `EXISTS (
          SELECT 1 FROM contact_lists cl
          JOIN lists l ON l.id = cl.list_id
          WHERE cl.contact_id = c.id AND (l.id IN (${placeholders}) OR l.name IN (${placeholders}))
        )`
      );
      params.push(...audience.listIds, ...audience.listIds);
    }

    if (audience.tagIds.length > 0) {
      const placeholders = audience.tagIds.map(() => "?").join(", ");
      predicates.push(
        `EXISTS (
          SELECT 1 FROM contact_tags ct
          JOIN tags t ON t.id = ct.tag_id
          WHERE ct.contact_id = c.id AND (t.id IN (${placeholders}) OR t.name IN (${placeholders}))
        )`
      );
      params.push(...audience.tagIds, ...audience.tagIds);
    }

    const result = await this.db.prepare(
      `SELECT c.id, c.email, c.status FROM contacts c WHERE ${predicates.join(" AND ")} ORDER BY c.email ASC`
    ).bind(...params).all();
    return (result.results ?? []) as Array<{ id: string; email: string; status: string }>;
  }
}

export interface CampaignRecord {
  id: string;
  name: string;
  subject: string;
  previewText: string;
  markdownBody: string;
  fromName: string;
  fromEmail: string;
  audience: { listIds: string[]; tagIds: string[] };
  status: string;
  lastCompletedBatch: number | null;
}

export interface CampaignStats {
  total: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  pending: number;
  failed: number;
}

export type SendOutcome =
  | { recipient: CampaignRecipient; status: "sent"; resendEmailId: string }
  | { recipient: CampaignRecipient; status: "dry-run" }
  | { recipient: CampaignRecipient; status: "failed"; error: string };

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  contactId: string;
  email: string;
  status: string;
  resendEmailId: string | null;
}

interface CampaignRow {
  id: string;
  name: string;
  subject: string;
  preview_text: string;
  markdown_body: string;
  from_name: string;
  from_email: string;
  audience_json: string;
  status: string;
  last_completed_batch: number | null;
}

interface RecipientRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  email: string;
  status: string;
  resend_email_id: string | null;
}

function mapCampaign(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    previewText: row.preview_text,
    markdownBody: row.markdown_body,
    fromName: row.from_name,
    fromEmail: row.from_email,
    audience: JSON.parse(row.audience_json),
    status: row.status,
    lastCompletedBatch: row.last_completed_batch === null || row.last_completed_batch === undefined
      ? null
      : Number(row.last_completed_batch)
  };
}

function mapRecipient(row: RecipientRow): CampaignRecipient {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    email: row.email,
    status: row.status,
    resendEmailId: row.resend_email_id
  };
}

function eventStatusPatch(type: string): { sql: string; bindings: (now: string, providerEventId?: string) => unknown[] } | null {
  if (type === "delivered") {
    return {
      sql: "UPDATE campaign_recipients SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?",
      bindings: (now) => [now, now]
    };
  }
  if (type === "bounced") {
    return {
      sql: "UPDATE campaign_recipients SET status = 'bounced', error = ?, updated_at = ? WHERE id = ?",
      bindings: (now, providerEventId) => [providerEventId ?? "bounced", now]
    };
  }
  if (type === "complained") {
    return {
      sql: "UPDATE campaign_recipients SET status = 'complained', error = ?, updated_at = ? WHERE id = ?",
      bindings: (now, providerEventId) => [providerEventId ?? "complained", now]
    };
  }
  if (type === "opened") {
    return {
      sql: "UPDATE campaign_recipients SET status = 'opened', opened_at = ?, updated_at = ? WHERE id = ?",
      bindings: (now) => [now, now]
    };
  }
  if (type === "clicked") {
    return {
      sql: "UPDATE campaign_recipients SET status = 'clicked', clicked_at = ?, updated_at = ? WHERE id = ?",
      bindings: (now) => [now, now]
    };
  }
  return null;
}
