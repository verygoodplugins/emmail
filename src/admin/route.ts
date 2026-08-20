export type Tab = "contacts" | "imports" | "campaigns" | "automations" | "events";

export interface AppRoute {
  tab: Tab;
  campaignId: string;
  automationId: string;
}

const TABS = new Set<Tab>(["contacts", "imports", "campaigns", "automations", "events"]);

export function parseHash(hash: string): AppRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw
    .split("/")
    .map((part) => decodeHashPart(part))
    .filter(Boolean);

  if (parts[0] === "campaigns") {
    const campaignId = parts[1] ?? "";
    if (parts[2] === "events") {
      return { tab: "events", campaignId, automationId: "" };
    }
    return { tab: "campaigns", campaignId, automationId: "" };
  }

  if (parts[0] === "events") {
    return { tab: "events", campaignId: parts[1] ?? "", automationId: "" };
  }

  if (parts[0] === "automations") {
    return {
      tab: "automations",
      campaignId: "",
      automationId: parts[1] ?? "",
    };
  }

  if (parts[0] && TABS.has(parts[0] as Tab)) {
    return { tab: parts[0] as Tab, campaignId: "", automationId: "" };
  }

  return { tab: "contacts", campaignId: "", automationId: "" };
}

function decodeHashPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function routeHash(route: AppRoute): string {
  if (route.tab === "events") {
    return route.campaignId ? campaignEventsHash(route.campaignId) : "#/events";
  }
  if (route.tab === "campaigns") {
    return route.campaignId ? campaignEditorHash(route.campaignId) : "#/campaigns";
  }
  if (route.tab === "automations") {
    return route.automationId ? automationEditorHash(route.automationId) : "#/automations";
  }
  return `#/${route.tab}`;
}

export function campaignEditorHash(campaignId: string): string {
  return `#/campaigns/${encodeURIComponent(campaignId)}`;
}

export function campaignEventsHash(campaignId: string): string {
  return `#/campaigns/${encodeURIComponent(campaignId)}/events`;
}

export function automationEditorHash(automationId: string): string {
  return `#/automations/${encodeURIComponent(automationId)}`;
}
