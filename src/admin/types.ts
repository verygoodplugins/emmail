export interface ContactRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  lists: string[];
  tags: string[];
}

export interface CsvPreview {
  accepted: ContactRow[];
  rejected: Array<{ rowNumber: number; reason: string; email?: string }>;
  summary: { totalRows: number; acceptedRows: number; rejectedRows: number };
  imported?: number;
}

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  previewText: string;
  markdownBody: string;
  fromName: string;
  fromEmail: string;
  audience: { listIds: string[]; tagIds: string[] };
  status: string;
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

export interface CampaignEvent {
  id: string;
  type: string;
  recipient_id: string;
  link_id: string | null;
  url: string | null;
  created_at: string;
}

export interface SampleDataSummary {
  contacts: number;
  lists: number;
  tags: number;
  campaigns: number;
  recipients: number;
  events: number;
  suppressions: number;
}
