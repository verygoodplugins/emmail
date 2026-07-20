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

export interface AutomationStep {
  id: string;
  automationId: string;
  position: number;
  stepType: "send_email" | "wait" | "add_tag";
  config: Record<string, unknown>;
  createdAt: string;
}

export interface AutomationSummary {
  id: string;
  name: string;
  slug: string;
  triggerType: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  steps: AutomationStep[];
  enrollmentCounts: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
}

export interface AutomationEnrollment {
  id: string;
  automationId: string;
  contactId: string;
  currentPosition: number;
  status: string;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
