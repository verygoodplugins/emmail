import type { ImportedContact } from "../lib/csv";
import { createId, nowIso } from "../lib/ids";

export class ContactRepository {
  constructor(private readonly db: D1Database) {}

  async importContacts(contacts: ImportedContact[]): Promise<{ imported: number }> {
    for (const contact of contacts) {
      await this.upsertContact(contact);
    }
    return { imported: contacts.length };
  }

  async listContacts(options: { limit: number; offset: number }): Promise<Array<{ id: string; email: string; firstName: string; lastName: string; status: string; lists: string[]; tags: string[] }>> {
    const result = await this.db.prepare(
      "SELECT id, email, first_name, last_name, status FROM contacts ORDER BY email ASC LIMIT ? OFFSET ?"
    ).bind(options.limit, options.offset).all();

    const rows = (result.results ?? []) as unknown as ContactRow[];
    return Promise.all(rows.map(async (row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      status: row.status,
      lists: await this.namesFor(row.id, "lists"),
      tags: await this.namesFor(row.id, "tags")
    })));
  }

  async suppressEmail(email: string, type: string, source: string, reason = ""): Promise<void> {
    const now = nowIso();
    await this.db.prepare(
      `INSERT INTO suppressions (id, email, type, source, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email, type) DO UPDATE SET source = excluded.source, reason = excluded.reason, created_at = excluded.created_at`
    ).bind(createId("sup"), email.toLowerCase(), type, source, reason, now).run();

    if (type === "unsubscribe") {
      await this.db.prepare("UPDATE contacts SET status = 'unsubscribed', updated_at = ? WHERE email = ?")
        .bind(now, email.toLowerCase())
        .run();
    }
    if (type === "bounce" || type === "complaint") {
      await this.db.prepare("UPDATE contacts SET status = 'bounced', updated_at = ? WHERE email = ?")
        .bind(now, email.toLowerCase())
        .run();
    }
  }

  async listSuppressedEmails(): Promise<string[]> {
    const result = await this.db.prepare("SELECT DISTINCT email FROM suppressions").all();
    return ((result.results ?? []) as Array<{ email: string }>).map((row) => row.email);
  }

  async getContactByEmail(email: string): Promise<ContactRow | null> {
    return await this.db.prepare("SELECT * FROM contacts WHERE email = ?").bind(email.toLowerCase()).first<ContactRow>();
  }

  async getContactById(id: string): Promise<ContactRow | null> {
    return await this.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
  }

  // Targeted single-email suppression check (not the whole table). `status`
  // alone is not enough: contact-form ingest re-upserts an existing email as
  // `subscribed`, so a previously unsubscribed/bounced address can look
  // subscribed again while its suppression row persists.
  async isSuppressed(email: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 AS hit FROM suppressions WHERE email = ? LIMIT 1")
      .bind(email.toLowerCase()).first<{ hit: number }>();
    return Boolean(row);
  }

  private async upsertContact(contact: ImportedContact): Promise<void> {
    const now = nowIso();
    const existing = await this.getContactByEmail(contact.email);
    const contactId = existing?.id ?? createId("con");

    await this.db.prepare(
      `INSERT INTO contacts (id, email, first_name, last_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).bind(contactId, contact.email, contact.firstName, contact.lastName, contact.status, now, now).run();

    for (const listName of contact.lists) {
      const listId = await this.ensureNamedRecord("lists", "lst", listName);
      await this.db.prepare(
        "INSERT OR IGNORE INTO contact_lists (contact_id, list_id, created_at) VALUES (?, ?, ?)"
      ).bind(contactId, listId, now).run();
    }

    for (const tagName of contact.tags) {
      const tagId = await this.ensureNamedRecord("tags", "tag", tagName);
      await this.db.prepare(
        "INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, created_at) VALUES (?, ?, ?)"
      ).bind(contactId, tagId, now).run();
    }
  }

  private async ensureNamedRecord(table: "lists" | "tags", prefix: string, name: string): Promise<string> {
    const trimmedName = name.trim();
    const existing = await this.db.prepare(`SELECT id FROM ${table} WHERE name = ?`).bind(trimmedName).first<{ id: string }>();
    if (existing) {
      return existing.id;
    }
    const id = createId(prefix);
    await this.db.prepare(`INSERT INTO ${table} (id, name, created_at) VALUES (?, ?, ?)`)
      .bind(id, trimmedName, nowIso())
      .run();
    return id;
  }

  private async namesFor(contactId: string, table: "lists" | "tags"): Promise<string[]> {
    const joinTable = table === "lists" ? "contact_lists" : "contact_tags";
    const idColumn = table === "lists" ? "list_id" : "tag_id";
    const result = await this.db.prepare(
      `SELECT ${table}.name
       FROM ${joinTable}
       JOIN ${table} ON ${table}.id = ${joinTable}.${idColumn}
       WHERE ${joinTable}.contact_id = ?
       ORDER BY ${table}.name ASC`
    ).bind(contactId).all();
    return ((result.results ?? []) as Array<{ name: string }>).map((row) => row.name);
  }
}

interface ContactRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
}
