import type {
  AutomationEnrollment,
  AutomationPreviewResult,
  AutomationSummary,
  Campaign,
  CampaignEvent,
  CampaignStats,
  ContactRow,
  CsvPreview,
  SampleDataSummary,
  StepDraft,
} from "./types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(appPath(path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ? `${fallback}: ${body.error}` : fallback;
  } catch {
    return fallback;
  }
}

export function listContacts(): Promise<ContactRow[]> {
  return requestJson<ContactRow[]>("/api/contacts?limit=100&offset=0");
}

export async function previewImport(csv: string): Promise<CsvPreview> {
  const response = await fetch(appPath("/api/imports/preview"), { method: "POST", body: csv });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<CsvPreview>;
}

export function commitImport(csv: string): Promise<CsvPreview> {
  return requestJson<CsvPreview>("/api/imports/commit", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
}

export function listCampaigns(): Promise<Campaign[]> {
  return requestJson<Campaign[]>("/api/campaigns");
}

export function createCampaign(input: {
  name: string;
  subject: string;
  previewText: string;
  markdownBody: string;
  audience: { listIds: string[]; tagIds: string[] };
}): Promise<Campaign> {
  return requestJson<Campaign>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCampaign(
  campaignId: string,
  input: {
    name: string;
    subject: string;
    previewText: string;
    markdownBody: string;
    audience: { listIds: string[]; tagIds: string[] };
  }
): Promise<Campaign> {
  return requestJson<Campaign>(`/api/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function sendCampaign(
  campaignId: string
): Promise<{ createdRecipients: number; skippedSuppressed: number; queuedJobs: number }> {
  return requestJson(`/api/campaigns/${campaignId}/send`, { method: "POST" });
}

export function listEvents(campaignId: string): Promise<CampaignEvent[]> {
  return requestJson<CampaignEvent[]>(`/api/campaigns/${campaignId}/events`);
}

export function getCampaignStats(campaignId: string): Promise<CampaignStats> {
  return requestJson<CampaignStats>(`/api/campaigns/${campaignId}/stats`);
}

export function seedSampleData(): Promise<SampleDataSummary> {
  return requestJson<SampleDataSummary>("/api/sample-data/seed", { method: "POST" });
}

export function clearSampleData(): Promise<SampleDataSummary> {
  return requestJson<SampleDataSummary>("/api/sample-data/clear", { method: "POST" });
}

export function listAutomations(): Promise<AutomationSummary[]> {
  return requestJson<AutomationSummary[]>("/api/automations");
}

export function createAutomation(name: string): Promise<AutomationSummary> {
  return requestJson<AutomationSummary>("/api/automations", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function updateAutomationName(id: string, name: string): Promise<AutomationSummary> {
  return requestJson<AutomationSummary>(`/api/automations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function replaceAutomationSteps(
  id: string,
  steps: StepDraft[],
  options: { name?: string } = {}
): Promise<AutomationSummary> {
  return requestJson<AutomationSummary>(`/api/automations/${id}/steps`, {
    method: "PUT",
    body: JSON.stringify({
      steps,
      ...(options.name === undefined ? {} : { name: options.name }),
    }),
  });
}

export function previewAutomationDraft(input: {
  firstName?: string;
  steps: StepDraft[];
}): Promise<AutomationPreviewResult> {
  return requestJson<AutomationPreviewResult>("/api/automations/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function seedWelcomeAutomation(): Promise<AutomationSummary> {
  return requestJson<AutomationSummary>("/api/automations/seed-welcome", { method: "POST" });
}

export function setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationSummary> {
  return requestJson<AutomationSummary>(
    `/api/automations/${id}/${enabled ? "enable" : "disable"}`,
    {
      method: "POST",
    }
  );
}

export function listAutomationEnrollments(id: string): Promise<AutomationEnrollment[]> {
  return requestJson<AutomationEnrollment[]>(`/api/automations/${id}/enrollments`);
}

function appPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const base = new URL(".", window.location.href).pathname;
  return `${base}${normalizedPath}`;
}
