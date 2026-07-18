export interface SampleDataSummary {
  contacts: number;
  lists: number;
  tags: number;
  campaigns: number;
  recipients: number;
  events: number;
  suppressions: number;
}

const createdAt = "2026-06-16T15:00:00.000Z";
const sentAt = "2026-06-16T15:08:00.000Z";

const sampleLists = [
  { id: "sample_list_newsletter", name: "Sample: Newsletter" },
  { id: "sample_list_donors", name: "Sample: Donor updates" },
  { id: "sample_list_events", name: "Sample: Events" }
] as const;

const sampleTags = [
  { id: "sample_tag_engaged", name: "sample-engaged" },
  { id: "sample_tag_new", name: "sample-new" },
  { id: "sample_tag_donor", name: "sample-donor" },
  { id: "sample_tag_followup", name: "sample-follow-up" }
] as const;

const sampleContacts = [
  {
    id: "sample_contact_ava",
    email: "ava.reed@example.com",
    firstName: "Ava",
    lastName: "Reed",
    status: "subscribed",
    listIds: ["sample_list_newsletter", "sample_list_events"],
    tagIds: ["sample_tag_engaged"]
  },
  {
    id: "sample_contact_miles",
    email: "miles.chen@example.com",
    firstName: "Miles",
    lastName: "Chen",
    status: "subscribed",
    listIds: ["sample_list_newsletter"],
    tagIds: ["sample_tag_donor"]
  },
  {
    id: "sample_contact_sofia",
    email: "sofia.patel@example.com",
    firstName: "Sofia",
    lastName: "Patel",
    status: "subscribed",
    listIds: ["sample_list_newsletter", "sample_list_events"],
    tagIds: ["sample_tag_engaged", "sample_tag_new"]
  },
  {
    id: "sample_contact_noah",
    email: "noah.brooks@example.com",
    firstName: "Noah",
    lastName: "Brooks",
    status: "subscribed",
    listIds: ["sample_list_donors"],
    tagIds: ["sample_tag_donor", "sample_tag_followup"]
  },
  {
    id: "sample_contact_ellie",
    email: "ellie.morgan@example.com",
    firstName: "Ellie",
    lastName: "Morgan",
    status: "subscribed",
    listIds: ["sample_list_events"],
    tagIds: ["sample_tag_new"]
  },
  {
    id: "sample_contact_jordan",
    email: "jordan.lee@example.com",
    firstName: "Jordan",
    lastName: "Lee",
    status: "subscribed",
    listIds: ["sample_list_newsletter", "sample_list_donors"],
    tagIds: ["sample_tag_engaged", "sample_tag_donor"]
  },
  {
    id: "sample_contact_casey",
    email: "casey.rivera@example.com",
    firstName: "Casey",
    lastName: "Rivera",
    status: "unsubscribed",
    listIds: ["sample_list_newsletter"],
    tagIds: ["sample_tag_followup"]
  },
  {
    id: "sample_contact_taylor",
    email: "taylor.quinn@example.com",
    firstName: "Taylor",
    lastName: "Quinn",
    status: "bounced",
    listIds: ["sample_list_newsletter"],
    tagIds: ["sample_tag_followup"]
  }
] as const;

const sampleCampaigns = [
  {
    id: "sample_campaign_june",
    name: "Sample: June newsletter",
    subject: "Your June field notes",
    previewText: "A short sample broadcast with opens and clicks.",
    markdownBody: [
      "Hello **friends**,",
      "",
      "Here are this month's field notes and the next events calendar.",
      "",
      "- Read the [field notes](https://example.com/emmail/field-notes)",
      "- Check the [events calendar](https://example.com/emmail/events)",
      "",
      "Thanks for staying connected."
    ].join("\n"),
    fromName: "EmMail Demo",
    fromEmail: "demo@example.com",
    audience: { listIds: ["sample_list_newsletter"], tagIds: [] },
    status: "sent",
    sentAt
  },
  {
    id: "sample_campaign_donor_followup",
    name: "Sample: Donor follow-up",
    subject: "A quick donor update",
    previewText: "Draft sample for the donor list.",
    markdownBody: [
      "Hi there,",
      "",
      "This draft is ready to send to contacts tagged as sample donors.",
      "",
      "Review the [donor dashboard](https://example.com/emmail/donors) before sending."
    ].join("\n"),
    fromName: "EmMail Demo",
    fromEmail: "demo@example.com",
    audience: { listIds: ["sample_list_donors"], tagIds: ["sample_tag_donor"] },
    status: "draft",
    sentAt: null
  }
] as const;

const sampleLinks = [
  {
    id: "sample_link_field_notes",
    campaignId: "sample_campaign_june",
    url: "https://example.com/emmail/field-notes",
    position: 0
  },
  {
    id: "sample_link_events",
    campaignId: "sample_campaign_june",
    url: "https://example.com/emmail/events",
    position: 1
  }
] as const;

const sampleRecipients = [
  {
    id: "sample_recipient_ava",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_ava",
    email: "ava.reed@example.com",
    status: "clicked",
    resendEmailId: "sample_email_ava",
    sentAt,
    deliveredAt: "2026-06-16T15:09:00.000Z",
    openedAt: "2026-06-16T15:31:00.000Z",
    clickedAt: "2026-06-16T15:33:00.000Z",
    error: null
  },
  {
    id: "sample_recipient_miles",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_miles",
    email: "miles.chen@example.com",
    status: "delivered",
    resendEmailId: "sample_email_miles",
    sentAt,
    deliveredAt: "2026-06-16T15:10:00.000Z",
    openedAt: null,
    clickedAt: null,
    error: null
  },
  {
    id: "sample_recipient_sofia",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_sofia",
    email: "sofia.patel@example.com",
    status: "opened",
    resendEmailId: "sample_email_sofia",
    sentAt,
    deliveredAt: "2026-06-16T15:10:00.000Z",
    openedAt: "2026-06-16T16:04:00.000Z",
    clickedAt: null,
    error: null
  },
  {
    id: "sample_recipient_jordan",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_jordan",
    email: "jordan.lee@example.com",
    status: "clicked",
    resendEmailId: "sample_email_jordan",
    sentAt,
    deliveredAt: "2026-06-16T15:11:00.000Z",
    openedAt: "2026-06-16T17:12:00.000Z",
    clickedAt: "2026-06-16T17:14:00.000Z",
    error: null
  },
  {
    id: "sample_recipient_casey",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_casey",
    email: "casey.rivera@example.com",
    status: "sent",
    resendEmailId: "sample_email_casey",
    sentAt,
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    error: null
  },
  {
    id: "sample_recipient_taylor",
    campaignId: "sample_campaign_june",
    contactId: "sample_contact_taylor",
    email: "taylor.quinn@example.com",
    status: "bounced",
    resendEmailId: "sample_email_taylor",
    sentAt,
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    error: "sample hard bounce"
  }
] as const;

const sampleEvents = [
  event("sample_event_send_ava", "sample_recipient_ava", "send", "sample_email_ava", "2026-06-16T15:08:00.000Z"),
  event("sample_event_send_miles", "sample_recipient_miles", "send", "sample_email_miles", "2026-06-16T15:08:00.000Z"),
  event("sample_event_send_sofia", "sample_recipient_sofia", "send", "sample_email_sofia", "2026-06-16T15:08:00.000Z"),
  event("sample_event_send_jordan", "sample_recipient_jordan", "send", "sample_email_jordan", "2026-06-16T15:08:00.000Z"),
  event("sample_event_send_casey", "sample_recipient_casey", "send", "sample_email_casey", "2026-06-16T15:08:00.000Z"),
  event("sample_event_send_taylor", "sample_recipient_taylor", "send", "sample_email_taylor", "2026-06-16T15:08:00.000Z"),
  event("sample_event_delivered_ava", "sample_recipient_ava", "delivered", "sample_email_ava", "2026-06-16T15:09:00.000Z"),
  event("sample_event_delivered_miles", "sample_recipient_miles", "delivered", "sample_email_miles", "2026-06-16T15:10:00.000Z"),
  event("sample_event_delivered_sofia", "sample_recipient_sofia", "delivered", "sample_email_sofia", "2026-06-16T15:10:00.000Z"),
  event("sample_event_delivered_jordan", "sample_recipient_jordan", "delivered", "sample_email_jordan", "2026-06-16T15:11:00.000Z"),
  event("sample_event_opened_ava", "sample_recipient_ava", "opened", null, "2026-06-16T15:31:00.000Z"),
  event("sample_event_opened_sofia", "sample_recipient_sofia", "opened", null, "2026-06-16T16:04:00.000Z"),
  event("sample_event_opened_jordan", "sample_recipient_jordan", "opened", null, "2026-06-16T17:12:00.000Z"),
  event("sample_event_clicked_ava", "sample_recipient_ava", "clicked", null, "2026-06-16T15:33:00.000Z", "sample_link_field_notes"),
  event("sample_event_clicked_jordan", "sample_recipient_jordan", "clicked", null, "2026-06-16T17:14:00.000Z", "sample_link_events"),
  event("sample_event_unsubscribe_casey", "sample_recipient_casey", "unsubscribe", null, "2026-06-16T18:05:00.000Z"),
  event("sample_event_bounced_taylor", "sample_recipient_taylor", "bounced", "sample_email_taylor", "2026-06-16T15:12:00.000Z")
] as const;

const sampleSuppressions = [
  {
    id: "sample_suppression_casey",
    email: "casey.rivera@example.com",
    type: "unsubscribe",
    source: "sample-data",
    reason: "Sample unsubscribe"
  },
  {
    id: "sample_suppression_taylor",
    email: "taylor.quinn@example.com",
    type: "bounce",
    source: "sample-data",
    reason: "Sample hard bounce"
  }
] as const;

const sampleSummary: SampleDataSummary = {
  contacts: sampleContacts.length,
  lists: sampleLists.length,
  tags: sampleTags.length,
  campaigns: sampleCampaigns.length,
  recipients: sampleRecipients.length,
  events: sampleEvents.length,
  suppressions: sampleSuppressions.length
};

export async function seedSampleData(db: D1Database): Promise<SampleDataSummary> {
  await clearSampleData(db);

  for (const list of sampleLists) {
    await db.prepare(
      `INSERT INTO lists (id, name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).bind(list.id, list.name, createdAt).run();
  }

  for (const tag of sampleTags) {
    await db.prepare(
      `INSERT INTO tags (id, name, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).bind(tag.id, tag.name, createdAt).run();
  }

  for (const contact of sampleContacts) {
    await db.prepare(
      `INSERT INTO contacts (id, email, first_name, last_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).bind(contact.id, contact.email, contact.firstName, contact.lastName, contact.status, createdAt, createdAt).run();

    for (const listId of contact.listIds) {
      await db.prepare(
        "INSERT OR IGNORE INTO contact_lists (contact_id, list_id, created_at) VALUES (?, ?, ?)"
      ).bind(contact.id, listId, createdAt).run();
    }

    for (const tagId of contact.tagIds) {
      await db.prepare(
        "INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, created_at) VALUES (?, ?, ?)"
      ).bind(contact.id, tagId, createdAt).run();
    }
  }

  for (const campaign of sampleCampaigns) {
    await db.prepare(
      `INSERT INTO campaigns
       (id, name, subject, preview_text, markdown_body, from_name, from_email, audience_json, status, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         subject = excluded.subject,
         preview_text = excluded.preview_text,
         markdown_body = excluded.markdown_body,
         from_name = excluded.from_name,
         from_email = excluded.from_email,
         audience_json = excluded.audience_json,
         status = excluded.status,
         updated_at = excluded.updated_at,
         sent_at = excluded.sent_at`
    ).bind(
      campaign.id,
      campaign.name,
      campaign.subject,
      campaign.previewText,
      campaign.markdownBody,
      campaign.fromName,
      campaign.fromEmail,
      JSON.stringify(campaign.audience),
      campaign.status,
      createdAt,
      createdAt,
      campaign.sentAt
    ).run();
  }

  for (const link of sampleLinks) {
    await db.prepare(
      `INSERT INTO campaign_links (id, campaign_id, url, position, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         url = excluded.url,
         position = excluded.position`
    ).bind(link.id, link.campaignId, link.url, link.position, createdAt).run();
  }

  for (const recipient of sampleRecipients) {
    await db.prepare(
      `INSERT INTO campaign_recipients
       (id, campaign_id, contact_id, email, status, resend_email_id, error, created_at, updated_at, sent_at, delivered_at, opened_at, clicked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         contact_id = excluded.contact_id,
         email = excluded.email,
         status = excluded.status,
         resend_email_id = excluded.resend_email_id,
         error = excluded.error,
         updated_at = excluded.updated_at,
         sent_at = excluded.sent_at,
         delivered_at = excluded.delivered_at,
         opened_at = excluded.opened_at,
         clicked_at = excluded.clicked_at`
    ).bind(
      recipient.id,
      recipient.campaignId,
      recipient.contactId,
      recipient.email,
      recipient.status,
      recipient.resendEmailId,
      recipient.error,
      createdAt,
      createdAt,
      recipient.sentAt,
      recipient.deliveredAt,
      recipient.openedAt,
      recipient.clickedAt
    ).run();
  }

  for (const sampleEvent of sampleEvents) {
    const link = sampleEvent.linkId ? sampleLinks.find((candidate) => candidate.id === sampleEvent.linkId) : null;
    const recipient = sampleRecipients.find((candidate) => candidate.id === sampleEvent.recipientId);
    await db.prepare(
      `INSERT INTO events
       (id, campaign_id, contact_id, recipient_id, type, provider_event_id, link_id, url, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         contact_id = excluded.contact_id,
         recipient_id = excluded.recipient_id,
         type = excluded.type,
         provider_event_id = excluded.provider_event_id,
         link_id = excluded.link_id,
         url = excluded.url,
         metadata_json = excluded.metadata_json,
         created_at = excluded.created_at`
    ).bind(
      sampleEvent.id,
      recipient?.campaignId ?? "sample_campaign_june",
      recipient?.contactId ?? null,
      sampleEvent.recipientId,
      sampleEvent.type,
      sampleEvent.providerEventId,
      sampleEvent.linkId,
      link?.url ?? null,
      JSON.stringify({ source: "sample-data" }),
      sampleEvent.createdAt
    ).run();
  }

  for (const suppression of sampleSuppressions) {
    await db.prepare(
      `INSERT INTO suppressions (id, email, type, source, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email, type) DO UPDATE SET
         id = excluded.id,
         source = excluded.source,
         reason = excluded.reason,
         created_at = excluded.created_at`
    ).bind(suppression.id, suppression.email, suppression.type, suppression.source, suppression.reason, createdAt).run();
  }

  return sampleSummary;
}

export async function clearSampleData(db: D1Database): Promise<SampleDataSummary> {
  const status = await getSampleDataStatus(db);
  await deleteSampleEvents(db);
  await deleteSuppressions(db);
  await deleteByIds(db, "send_jobs", "campaign_id", ids(sampleCampaigns));
  await deleteByIds(db, "campaign_recipients", "id", ids(sampleRecipients));
  await deleteByIds(db, "campaign_links", "id", ids(sampleLinks));
  await deleteByIds(db, "campaigns", "id", ids(sampleCampaigns));
  await deleteByIds(db, "contact_lists", "contact_id", ids(sampleContacts));
  await deleteByIds(db, "contact_tags", "contact_id", ids(sampleContacts));
  await deleteContacts(db);
  await deleteByIds(db, "lists", "id", ids(sampleLists));
  await deleteByIds(db, "tags", "id", ids(sampleTags));
  return status;
}

export async function getSampleDataStatus(db: D1Database): Promise<SampleDataSummary> {
  return {
    contacts: await countContacts(db),
    lists: await countByIds(db, "lists", "id", ids(sampleLists)),
    tags: await countByIds(db, "tags", "id", ids(sampleTags)),
    campaigns: await countByIds(db, "campaigns", "id", ids(sampleCampaigns)),
    recipients: await countByIds(db, "campaign_recipients", "id", ids(sampleRecipients)),
    events: await countByIds(db, "events", "id", ids(sampleEvents)),
    suppressions: await countSuppressions(db)
  };
}

function event(
  id: string,
  recipientId: string,
  type: string,
  providerEventId: string | null,
  createdAtValue: string,
  linkId: string | null = null
) {
  return { id, recipientId, type, providerEventId, createdAt: createdAtValue, linkId };
}

function ids(records: ReadonlyArray<{ id: string }>): string[] {
  return records.map((record) => record.id);
}

function emails(): string[] {
  return sampleContacts.map((contact) => contact.email);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

async function countByIds(db: D1Database, table: string, column: string, values: string[]): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders(values)})`
  ).bind(...values).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function countContacts(db: D1Database): Promise<number> {
  const contactIds = ids(sampleContacts);
  const sampleEmails = emails();
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM contacts
     WHERE id IN (${placeholders(contactIds)})
     OR email IN (${placeholders(sampleEmails)})`
  ).bind(...contactIds, ...sampleEmails).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function countSuppressions(db: D1Database): Promise<number> {
  const suppressionIds = ids(sampleSuppressions);
  const sampleEmails = emails();
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM suppressions
     WHERE id IN (${placeholders(suppressionIds)})
     OR email IN (${placeholders(sampleEmails)})`
  ).bind(...suppressionIds, ...sampleEmails).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function deleteByIds(db: D1Database, table: string, column: string, values: string[]): Promise<void> {
  await db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`)
    .bind(...values)
    .run();
}

async function deleteContacts(db: D1Database): Promise<void> {
  const contactIds = ids(sampleContacts);
  const sampleEmails = emails();
  await db.prepare(
    `DELETE FROM contacts
     WHERE id IN (${placeholders(contactIds)})
     OR email IN (${placeholders(sampleEmails)})`
  ).bind(...contactIds, ...sampleEmails).run();
}

async function deleteSuppressions(db: D1Database): Promise<void> {
  const suppressionIds = ids(sampleSuppressions);
  const sampleEmails = emails();
  await db.prepare(
    `DELETE FROM suppressions
     WHERE id IN (${placeholders(suppressionIds)})
     OR email IN (${placeholders(sampleEmails)})`
  ).bind(...suppressionIds, ...sampleEmails).run();
}

async function deleteSampleEvents(db: D1Database): Promise<void> {
  const eventIds = ids(sampleEvents);
  const campaignIds = ids(sampleCampaigns);
  const contactIds = ids(sampleContacts);
  const recipientIds = ids(sampleRecipients);
  const linkIds = ids(sampleLinks);
  await db.prepare(
    `DELETE FROM events
     WHERE id IN (${placeholders(eventIds)})
     OR campaign_id IN (${placeholders(campaignIds)})
     OR contact_id IN (${placeholders(contactIds)})
     OR recipient_id IN (${placeholders(recipientIds)})
     OR link_id IN (${placeholders(linkIds)})`
  ).bind(...eventIds, ...campaignIds, ...contactIds, ...recipientIds, ...linkIds).run();
}
