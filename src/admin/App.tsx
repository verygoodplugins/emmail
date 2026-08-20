import {
  BarChart3,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ContactRound,
  Database,
  FileUp,
  MailPlus,
  MousePointerClick,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  Workflow,
  Zap
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  clearSampleData,
  commitImport,
  createCampaign,
  getCampaignStats,
  listAutomations,
  listCampaigns,
  listContacts,
  listEvents,
  previewImport,
  seedSampleData,
  seedWelcomeAutomation,
  sendCampaign,
  setAutomationEnabled
} from "./api";
import type { AutomationSummary, Campaign, CampaignEvent, CampaignStats, ContactRow, CsvPreview } from "./types";

type Tab = "contacts" | "imports" | "campaigns" | "automations" | "events";

const seedCsv = "email,name,lists,tags\nada@example.com,Ada Lovelace,Newsletter,vip";

export function App() {
  const [tab, setTab] = useState<Tab>("contacts");
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [csv, setCsv] = useState(seedCsv);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({
    name: "June update",
    subject: "June update",
    previewText: "A short note from the list",
    markdownBody: "Hello **friends**,\n\nRead the latest update at [the site](https://example.com).",
    lists: "Newsletter",
    tags: ""
  });

  useEffect(() => {
    void refresh().catch(() => {
      setContacts([]);
      setCampaigns([]);
      setAutomations([]);
    });
  }, []);

  useEffect(() => {
    if (selectedCampaignId) {
      void listEvents(selectedCampaignId).then(setEvents).catch(() => setEvents([]));
      void getCampaignStats(selectedCampaignId).then(setStats).catch(() => setStats(null));
    }
  }, [selectedCampaignId, campaigns]);

  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? campaigns[0];

  async function refresh() {
    const [contactRows, campaignRows, automationRows] = await Promise.all([
      listContacts(),
      listCampaigns(),
      listAutomations().catch(() => [] as AutomationSummary[])
    ]);
    setContacts(contactRows);
    setCampaigns(campaignRows);
    setAutomations(automationRows);
    const nextCampaignId = selectedCampaignId && campaignRows.some((campaign) => campaign.id === selectedCampaignId)
      ? selectedCampaignId
      : campaignRows[0]?.id ?? "";
    setSelectedCampaignId(nextCampaignId);
    if (!nextCampaignId) {
      setEvents([]);
    }
  }

  async function runPreview() {
    setBusy(true);
    setNotice("");
    try {
      setPreview(await previewImport(csv));
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    setBusy(true);
    setNotice("");
    try {
      const result = await commitImport(csv);
      setPreview(result);
      setNotice(`${result.summary.acceptedRows} contacts imported`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runCreateCampaign() {
    setBusy(true);
    setNotice("");
    try {
      const campaign = await createCampaign({
        name: draft.name,
        subject: draft.subject,
        previewText: draft.previewText,
        markdownBody: draft.markdownBody,
        audience: {
          listIds: splitAudience(draft.lists),
          tagIds: splitAudience(draft.tags)
        }
      });
      setSelectedCampaignId(campaign.id);
      setNotice("Broadcast drafted");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runSendCampaign(campaignId: string) {
    setBusy(true);
    setNotice("");
    try {
      const result = await sendCampaign(campaignId);
      setNotice(`${result.createdRecipients} recipients queued`);
      await refresh();
      setTab("events");
    } finally {
      setBusy(false);
    }
  }

  async function runSeedSampleData() {
    setBusy(true);
    setNotice("");
    try {
      const result = await seedSampleData();
      setNotice(`${result.contacts} sample contacts loaded`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runClearSampleData() {
    setBusy(true);
    setNotice("");
    try {
      const result = await clearSampleData();
      setNotice(`${result.contacts} sample contacts cleared`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runSeedWelcomeAutomation() {
    setBusy(true);
    setNotice("");
    try {
      const automation = await seedWelcomeAutomation();
      setNotice(`Seeded “${automation.name}” (${automation.steps.length} steps)`);
      await refresh();
      setTab("automations");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Seed failed");
    } finally {
      setBusy(false);
    }
  }

  async function runToggleAutomation(id: string, enabled: boolean) {
    setBusy(true);
    setNotice("");
    try {
      const automation = await setAutomationEnabled(id, enabled);
      setNotice(`${automation.name} ${enabled ? "enabled" : "disabled"}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">EM</span>
          <span>EmMail</span>
        </div>
        <nav className="nav-list" aria-label="Admin">
          <NavButton active={tab === "contacts"} icon={<ContactRound size={17} />} label="Contacts" onClick={() => setTab("contacts")} />
          <NavButton active={tab === "imports"} icon={<FileUp size={17} />} label="Imports" onClick={() => setTab("imports")} />
          <NavButton active={tab === "campaigns"} icon={<MailPlus size={17} />} label="Campaigns" onClick={() => setTab("campaigns")} />
          <NavButton active={tab === "automations"} icon={<Workflow size={17} />} label="Automations" onClick={() => setTab("automations")} />
          <NavButton active={tab === "events"} icon={<BarChart3 size={17} />} label="Events" onClick={() => setTab("events")} />
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{titleFor(tab)}</h1>
            <span className="meta-line">{contacts.length} contacts · {campaigns.length} broadcasts · {automations.length} automations</span>
          </div>
          <div className="top-actions">
            {notice ? <span className="notice"><CheckCircle2 size={16} />{notice}</span> : null}
            <button onClick={() => void runSeedSampleData()} disabled={busy}><Database size={17} />Load sample data</button>
            <button className="danger" onClick={() => void runClearSampleData()} disabled={busy}><Trash2 size={17} />Clear sample data</button>
            <button className="icon-button" aria-label="Refresh" onClick={() => void refresh()}><RefreshCw size={17} /></button>
            <button className="primary" onClick={() => setTab("campaigns")}><MailPlus size={17} />New broadcast</button>
          </div>
        </header>

        <section className="content-grid">
          {tab === "contacts" ? (
            <ContactsView contacts={contacts} />
          ) : null}

          {tab === "imports" ? (
            <ImportView
              csv={csv}
              setCsv={setCsv}
              preview={preview}
              busy={busy}
              onPreview={() => void runPreview()}
              onCommit={() => void runCommit()}
            />
          ) : null}

          {tab === "campaigns" ? (
            <CampaignView
              draft={draft}
              setDraft={setDraft}
              campaigns={campaigns}
              busy={busy}
              onCreate={() => void runCreateCampaign()}
              onSend={(id) => void runSendCampaign(id)}
              onSelect={(id) => {
                setSelectedCampaignId(id);
                setTab("events");
              }}
            />
          ) : null}

          {tab === "automations" ? (
            <AutomationsView
              automations={automations}
              busy={busy}
              onSeed={() => void runSeedWelcomeAutomation()}
              onToggle={(id, enabled) => void runToggleAutomation(id, enabled)}
            />
          ) : null}

          {tab === "events" ? (
            <EventsView
              selectedCampaign={selectedCampaign}
              campaigns={campaigns}
              selectedCampaignId={selectedCampaignId}
              setSelectedCampaignId={setSelectedCampaignId}
              events={events}
              stats={stats}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {active ? <ChevronRight size={16} /> : null}
    </button>
  );
}

function ContactsView({ contacts }: { contacts: ContactRow[] }) {
  return (
    <div className="panel span-2">
      <div className="panel-head">
        <h2>Contacts</h2>
        <span>{contacts.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th>Lists</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <td>{contact.email}</td>
                <td>{[contact.firstName, contact.lastName].filter(Boolean).join(" ")}</td>
                <td><StatusLabel value={contact.status} /></td>
                <td>{contact.lists.join(", ")}</td>
                <td>{contact.tags.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportView(props: {
  csv: string;
  setCsv: (value: string) => void;
  preview: CsvPreview | null;
  busy: boolean;
  onPreview: () => void;
  onCommit: () => void;
}) {
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>CSV import</h2>
          <Upload size={18} />
        </div>
        <textarea className="csv-box" value={props.csv} onChange={(event) => props.setCsv(event.target.value)} />
        <div className="button-row">
          <button onClick={props.onPreview} disabled={props.busy}>Preview</button>
          <button className="primary" onClick={props.onCommit} disabled={props.busy}>Commit import</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Import status</h2>
          {props.preview?.summary.rejectedRows ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
        </div>
        <div className="metric-row">
          <Metric label="Accepted" value={props.preview?.summary.acceptedRows ?? 0} />
          <Metric label="Rejected" value={props.preview?.summary.rejectedRows ?? 0} tone="coral" />
        </div>
        <div className="reject-list">
          {(props.preview?.rejected ?? []).map((row) => (
            <div key={`${row.rowNumber}-${row.reason}`}>
              <span>Row {row.rowNumber}</span>
              <strong>{row.reason}</strong>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function CampaignView(props: {
  draft: { name: string; subject: string; previewText: string; markdownBody: string; lists: string; tags: string };
  setDraft: (value: { name: string; subject: string; previewText: string; markdownBody: string; lists: string; tags: string }) => void;
  campaigns: Campaign[];
  busy: boolean;
  onCreate: () => void;
  onSend: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const update = (patch: Partial<typeof props.draft>) => props.setDraft({ ...props.draft, ...patch });
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>New broadcast</h2>
          <MailPlus size={18} />
        </div>
        <div className="form-grid">
          <label>Name<input value={props.draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <label>Subject<input value={props.draft.subject} onChange={(event) => update({ subject: event.target.value })} /></label>
          <label>Preview<input value={props.draft.previewText} onChange={(event) => update({ previewText: event.target.value })} /></label>
          <label>Lists<input value={props.draft.lists} onChange={(event) => update({ lists: event.target.value })} /></label>
          <label>Tags<input value={props.draft.tags} onChange={(event) => update({ tags: event.target.value })} /></label>
          <label className="span-full">Markdown<textarea value={props.draft.markdownBody} onChange={(event) => update({ markdownBody: event.target.value })} /></label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={props.onCreate} disabled={props.busy}><MailPlus size={17} />Save draft</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Campaigns</h2>
          <Send size={18} />
        </div>
        <div className="campaign-list">
          {props.campaigns.map((campaign) => (
            <div className="campaign-row" key={campaign.id}>
              <button onClick={() => props.onSelect(campaign.id)}>
                <strong>{campaign.name}</strong>
                <span>{campaign.subject}</span>
              </button>
              <StatusLabel value={campaign.status} />
              <button className="icon-button" aria-label={`Send ${campaign.name}`} onClick={() => props.onSend(campaign.id)}><Send size={16} /></button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function AutomationsView(props: {
  automations: AutomationSummary[];
  busy: boolean;
  onSeed: () => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Sequences</h2>
          <Workflow size={18} />
        </div>
        <p className="send-progress">
          Multi-step flows on the same Worker + Queue + D1 stack. Seed the demo welcome sequence,
          enable it, then submit a contact form — email → wait → follow-up → tag.
        </p>
        <div className="button-row">
          <button className="primary" onClick={props.onSeed} disabled={props.busy}>
            <Zap size={17} />Seed welcome sequence
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Automations</h2>
          <span>{props.automations.length}</span>
        </div>
        <div className="campaign-list">
          {props.automations.length === 0 ? (
            <p className="send-progress">No automations yet. Seed the welcome sequence to start.</p>
          ) : null}
          {props.automations.map((automation) => (
            <div className="campaign-row automation-row" key={automation.id}>
              <div>
                <strong>{automation.name}</strong>
                <span>
                  {automation.triggerType} · {automation.steps.length} steps ·{" "}
                  {automation.enrollmentCounts.active + automation.enrollmentCounts.waiting} in flight ·{" "}
                  {automation.enrollmentCounts.completed} done
                </span>
                <ol className="step-list">
                  {automation.steps.map((step) => (
                    <li key={step.id}>{describeStep(step.stepType, step.config)}</li>
                  ))}
                </ol>
              </div>
              <StatusLabel value={automation.enabled ? "enabled" : "draft"} />
              <button
                className={automation.enabled ? "danger" : "primary"}
                disabled={props.busy}
                onClick={() => props.onToggle(automation.id, !automation.enabled)}
              >
                {automation.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function describeStep(stepType: string, config: Record<string, unknown>): string {
  if (stepType === "send_email") {
    return `Send email: ${String(config.subject ?? "(no subject)")}`;
  }
  if (stepType === "wait") {
    const seconds = Number(config.seconds ?? 0);
    if (seconds >= 86400 && seconds % 86400 === 0) {
      return `Wait ${seconds / 86400} day(s)`;
    }
    if (seconds >= 60 && seconds % 60 === 0) {
      return `Wait ${seconds / 60} minute(s)`;
    }
    return `Wait ${seconds}s`;
  }
  if (stepType === "add_tag") {
    return `Add tag: ${String(config.tagName ?? "")}`;
  }
  return stepType;
}

function EventsView(props: {
  selectedCampaign?: Campaign;
  campaigns: Campaign[];
  selectedCampaignId: string;
  setSelectedCampaignId: (id: string) => void;
  events: CampaignEvent[];
  stats: CampaignStats | null;
}) {
  const openRate = ratePercent(props.stats?.opened, props.stats?.sent);
  const clickRate = ratePercent(props.stats?.clicked, props.stats?.sent);
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Events</h2>
          <MousePointerClick size={18} />
        </div>
        <select value={props.selectedCampaignId} onChange={(event) => props.setSelectedCampaignId(event.target.value)}>
          {props.campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
        <div className="metric-row">
          <Metric label="Open rate" value={formatRate(props.stats?.opened, props.stats?.sent)} />
          <Metric label="Click rate" value={formatRate(props.stats?.clicked, props.stats?.sent)} tone="amber" />
        </div>
        <div className="mini-chart">
          <span style={{ width: `${openRate}%` }} />
          <span style={{ width: `${clickRate}%` }} />
        </div>
        <p className="send-progress">
          {props.stats && props.stats.total > 0
            ? `${props.stats.sent} sent · ${props.stats.pending} pending · ${props.stats.failed} failed · ${props.stats.total} recipients`
            : "No recipients yet"}
        </p>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>{props.selectedCampaign?.subject ?? "Ready to send"}</h2>
          <BarChart3 size={18} />
        </div>
        <div className="event-list">
          {props.events.map((event) => (
            <div key={event.id}>
              <StatusLabel value={event.type} />
              <span>{new Date(event.created_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value, tone = "teal" }: { label: string; value: number | string; tone?: "teal" | "amber" | "coral" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusLabel({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}

function titleFor(tab: Tab): string {
  return {
    contacts: "Contacts",
    imports: "Imports",
    campaigns: "Campaigns",
    automations: "Automations",
    events: "Events"
  }[tab];
}

function splitAudience(value: string): string[] {
  return value.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);
}

function ratePercent(numerator?: number, denominator?: number): number {
  if (!numerator || !denominator) {
    return 0;
  }
  return Math.round((numerator / denominator) * 100);
}

function formatRate(numerator?: number, denominator?: number): string {
  if (!denominator) {
    return "—";
  }
  return `${ratePercent(numerator, denominator)}%`;
}
