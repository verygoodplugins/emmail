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
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AutomationsView } from "./AutomationsView";
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
  sendCampaign,
  updateCampaign,
} from "./api";
import {
  campaignEditorHash,
  campaignEventsHash,
  parseHash,
  routeHash,
  type AppRoute,
  type Tab,
} from "./route";
import type {
  AutomationSummary,
  Campaign,
  CampaignEvent,
  CampaignStats,
  ContactRow,
  CsvPreview,
} from "./types";

const seedCsv =
  "email,name,lists,tags\nada@example.com,Ada Lovelace,Newsletter,vip";

const emptyDraft = {
  name: "June update",
  subject: "June update",
  previewText: "A short note from the list",
  markdownBody:
    "Hello **friends**,\n\nRead the latest update at [the site](https://example.com).",
  lists: "Newsletter",
  tags: "",
};

function currentRoute(): AppRoute {
  return parseHash(window.location.hash);
}

export function App() {
  const [tab, setTab] = useState<Tab>(() => currentRoute().tab);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [statsByCampaign, setStatsByCampaign] = useState<
    Record<string, CampaignStats>
  >({});
  const [selectedCampaignId, setSelectedCampaignId] = useState(
    () => currentRoute().campaignId,
  );
  const [editingCampaignId, setEditingCampaignId] = useState(() => {
    const route = currentRoute();
    return route.tab === "campaigns" ? route.campaignId : "";
  });
  const [selectedAutomationId, setSelectedAutomationId] = useState(
    () => currentRoute().automationId,
  );
  const [csv, setCsv] = useState(seedCsv);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const createSequenceRef = useRef<(() => void) | null>(null);
  const automationsDirtyRef = useRef(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [draft, setDraft] = useState(emptyDraft);

  function applyRoute(route: AppRoute) {
    setTab(route.tab);
    if (route.campaignId) {
      setSelectedCampaignId(route.campaignId);
    }
    if (route.automationId) {
      setSelectedAutomationId(route.automationId);
    }
    if (route.tab === "campaigns") {
      setEditingCampaignId(route.campaignId);
      if (!route.campaignId) {
        setDraft(emptyDraft);
      }
    }
  }

  function canLeave(next: Tab): boolean {
    if (
      tabRef.current === "automations" &&
      next !== "automations" &&
      automationsDirtyRef.current &&
      !window.confirm(
        "You have unsaved sequence changes. Leave Automations and discard them?",
      )
    ) {
      return false;
    }
    if (next !== "automations") {
      automationsDirtyRef.current = false;
    }
    return true;
  }

  function navigate(route: AppRoute, replace = false) {
    if (!canLeave(route.tab)) {
      return;
    }
    const hash = routeHash(route);
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    if (replace) {
      history.replaceState(null, "", url);
    } else if (window.location.hash !== hash) {
      history.pushState(null, "", url);
    }
    applyRoute(route);
  }

  useEffect(() => {
    void refresh().catch(() => {
      setContacts([]);
      setCampaigns([]);
      setAutomations([]);
    });
    const route = currentRoute();
    if (!window.location.hash) {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${routeHash(route)}`,
      );
    }
    const onPop = () => {
      applyRoute(currentRoute());
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  useEffect(() => {
    if (!selectedCampaignId) {
      setEvents([]);
      return;
    }
    void listEvents(selectedCampaignId)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [selectedCampaignId, campaigns]);

  useEffect(() => {
    let cancelled = false;
    if (campaigns.length === 0) {
      setStatsByCampaign({});
      return;
    }
    void Promise.all(
      campaigns.map((campaign) =>
        getCampaignStats(campaign.id)
          .then((row) => [campaign.id, row] as const)
          .catch(() => [campaign.id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, CampaignStats> = {};
      for (const [id, row] of entries) {
        if (row) {
          next[id] = row;
        }
      }
      setStatsByCampaign(next);
    });
    return () => {
      cancelled = true;
    };
  }, [campaigns]);

  useEffect(() => {
    if (!editingCampaignId) {
      return;
    }
    const campaign = campaigns.find((row) => row.id === editingCampaignId);
    if (campaign) {
      setDraft(draftFromCampaign(campaign));
    }
  }, [editingCampaignId, campaigns]);

  useEffect(() => {
    if (tab !== "automations") {
      return;
    }
    const knownId =
      selectedAutomationId &&
      automations.some((automation) => automation.id === selectedAutomationId)
        ? selectedAutomationId
        : "";
    if (knownId) {
      return;
    }
    const firstId = automations[0]?.id;
    if (firstId) {
      navigate(
        {
          tab: "automations",
          campaignId: "",
          automationId: firstId,
        },
        true,
      );
    }
  }, [tab, automations, selectedAutomationId]);

  const selectedCampaign =
    campaigns.find((campaign) => campaign.id === selectedCampaignId) ??
    campaigns[0];
  const stats = selectedCampaignId
    ? (statsByCampaign[selectedCampaignId] ?? null)
    : null;
  const editingCampaign = campaigns.find(
    (campaign) => campaign.id === editingCampaignId,
  );

  async function refresh() {
    const [contactRows, campaignRows, automationResult] = await Promise.all([
      listContacts(),
      listCampaigns(),
      listAutomations().then(
        (rows) => ({ ok: true as const, rows }),
        () => ({ ok: false as const }),
      ),
    ]);
    setContacts(contactRows);
    setCampaigns(campaignRows);
    if (automationResult.ok) {
      setAutomations(automationResult.rows);
    }
    const nextCampaignId =
      selectedCampaignId &&
      campaignRows.some((campaign) => campaign.id === selectedCampaignId)
        ? selectedCampaignId
        : (campaignRows[0]?.id ?? "");
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
      const campaign = await createCampaign(campaignInputFromDraft(draft));
      setNotice("Broadcast drafted");
      await refresh();
      navigate({
        tab: "campaigns",
        campaignId: campaign.id,
        automationId: "",
      });
    } finally {
      setBusy(false);
    }
  }

  async function runUpdateCampaign(campaignId: string) {
    setBusy(true);
    setNotice("");
    try {
      await updateCampaign(campaignId, campaignInputFromDraft(draft));
      setNotice("Broadcast saved");
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
      navigate({ tab: "events", campaignId, automationId: "" });
    } finally {
      setBusy(false);
    }
  }

  async function runSeedSampleData() {
    setBusy(true);
    setNotice("");
    try {
      const result = await seedSampleData();
      setNotice(
        `${result.contacts} sample contacts loaded · ${result.automations} automation`,
      );
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

  function requestTab(next: Tab, campaignId = "") {
    navigate({
      tab: next,
      campaignId: campaignId || (next === "events" ? selectedCampaignId : ""),
      automationId: next === "automations" ? selectedAutomationId : "",
    });
  }

  function onNavClick(event: React.MouseEvent<HTMLAnchorElement>, next: Tab) {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    requestTab(next, next === "events" ? selectedCampaignId : "");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">EM</span>
          <span>EmMail</span>
        </div>
        <nav className="nav-list" aria-label="Admin">
          <NavButton
            active={tab === "contacts"}
            href={routeHash({
              tab: "contacts",
              campaignId: "",
              automationId: "",
            })}
            icon={<ContactRound size={17} />}
            label="Contacts"
            onClick={(event) => onNavClick(event, "contacts")}
          />
          <NavButton
            active={tab === "imports"}
            href={routeHash({
              tab: "imports",
              campaignId: "",
              automationId: "",
            })}
            icon={<FileUp size={17} />}
            label="Imports"
            onClick={(event) => onNavClick(event, "imports")}
          />
          <NavButton
            active={tab === "campaigns"}
            href={routeHash({
              tab: "campaigns",
              campaignId: "",
              automationId: "",
            })}
            icon={<MailPlus size={17} />}
            label="Campaigns"
            onClick={(event) => onNavClick(event, "campaigns")}
          />
          <NavButton
            active={tab === "automations"}
            href={routeHash({
              tab: "automations",
              campaignId: "",
              automationId: selectedAutomationId,
            })}
            icon={<Workflow size={17} />}
            label="Automations"
            onClick={(event) => onNavClick(event, "automations")}
          />
          <NavButton
            active={tab === "events"}
            href={routeHash({
              tab: "events",
              campaignId: selectedCampaignId,
              automationId: "",
            })}
            icon={<BarChart3 size={17} />}
            label="Events"
            onClick={(event) => onNavClick(event, "events")}
          />
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{titleFor(tab)}</h1>
            <span className="meta-line">
              {contacts.length} contacts · {campaigns.length} broadcasts ·{" "}
              {automations.length}{" "}
              {automations.length === 1 ? "automation" : "automations"}
            </span>
          </div>
          <div className="top-actions">
            {notice ? (
              <span className="notice">
                <CheckCircle2 size={16} />
                {notice}
              </span>
            ) : null}
            <button onClick={() => void runSeedSampleData()} disabled={busy}>
              <Database size={17} />
              Load sample data
            </button>
            <button
              className="danger"
              onClick={() => void runClearSampleData()}
              disabled={busy}
            >
              <Trash2 size={17} />
              Clear sample data
            </button>
            <button
              className="icon-button"
              aria-label="Refresh"
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} />
            </button>
            {tab === "automations" ? (
              <button
                className="primary"
                onClick={() => createSequenceRef.current?.()}
                disabled={busy}
              >
                <Plus size={17} />
                New sequence
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => requestTab("campaigns")}
              >
                <MailPlus size={17} />
                New broadcast
              </button>
            )}
          </div>
        </header>

        <section
          className={`content-grid${
            tab === "automations"
              ? " automations-layout"
              : tab === "campaigns"
                ? " campaigns-layout"
                : ""
          }`}
        >
          {tab === "contacts" ? <ContactsView contacts={contacts} /> : null}

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
              statsByCampaign={statsByCampaign}
              editingCampaignId={editingCampaignId}
              editingCampaign={editingCampaign}
              busy={busy}
              onCreate={() => void runCreateCampaign()}
              onSave={(id) => void runUpdateCampaign(id)}
              onSend={(id) => void runSendCampaign(id)}
              onNew={() => requestTab("campaigns")}
            />
          ) : null}

          {tab === "automations" ? (
            <AutomationsView
              automations={automations}
              selectedId={selectedAutomationId}
              busy={busy}
              createSequenceRef={createSequenceRef}
              onBusyChange={setBusy}
              onDirtyChange={(dirty) => {
                automationsDirtyRef.current = dirty;
              }}
              onNotice={setNotice}
              onRefresh={refresh}
              onSelectId={(id) =>
                navigate({
                  tab: "automations",
                  campaignId: "",
                  automationId: id,
                })
              }
            />
          ) : null}

          {tab === "events" ? (
            <EventsView
              selectedCampaign={selectedCampaign}
              campaigns={campaigns}
              selectedCampaignId={selectedCampaignId}
              onSelectCampaign={(id) =>
                navigate({
                  tab: "events",
                  campaignId: id,
                  automationId: "",
                })
              }
              events={events}
              stats={stats}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function NavButton({
  active,
  href,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  href: string;
  icon: React.ReactNode;
  label: string;
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      className={`nav-button ${active ? "active" : ""}`}
      href={href}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {active ? <ChevronRight size={16} /> : null}
    </a>
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
                <td>
                  {[contact.firstName, contact.lastName]
                    .filter(Boolean)
                    .join(" ")}
                </td>
                <td>
                  <StatusLabel value={contact.status} />
                </td>
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
        <textarea
          className="csv-box"
          value={props.csv}
          onChange={(event) => props.setCsv(event.target.value)}
        />
        <div className="button-row">
          <button onClick={props.onPreview} disabled={props.busy}>
            Preview
          </button>
          <button
            className="primary"
            onClick={props.onCommit}
            disabled={props.busy}
          >
            Commit import
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Import status</h2>
          {props.preview?.summary.rejectedRows ? (
            <CircleAlert size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
        </div>
        <div className="metric-row">
          <Metric
            label="Accepted"
            value={props.preview?.summary.acceptedRows ?? 0}
          />
          <Metric
            label="Rejected"
            value={props.preview?.summary.rejectedRows ?? 0}
            tone="coral"
          />
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
  draft: {
    name: string;
    subject: string;
    previewText: string;
    markdownBody: string;
    lists: string;
    tags: string;
  };
  setDraft: (value: {
    name: string;
    subject: string;
    previewText: string;
    markdownBody: string;
    lists: string;
    tags: string;
  }) => void;
  campaigns: Campaign[];
  statsByCampaign: Record<string, CampaignStats>;
  editingCampaignId: string;
  editingCampaign?: Campaign;
  busy: boolean;
  onCreate: () => void;
  onSave: (id: string) => void;
  onSend: (id: string) => void;
  onNew: () => void;
}) {
  const update = (patch: Partial<typeof props.draft>) =>
    props.setDraft({ ...props.draft, ...patch });
  const editing = Boolean(props.editingCampaignId);
  const editingStats = props.editingCampaignId
    ? (props.statsByCampaign[props.editingCampaignId] ?? null)
    : null;
  return (
    <>
      <div className="panel campaigns-list">
        <div className="panel-head">
          <h2>Campaigns</h2>
          <Send size={18} />
        </div>
        <div className="campaign-list">
          {props.campaigns.map((campaign) => (
            <div
              className={`campaign-row${campaign.id === props.editingCampaignId ? " selected" : ""}`}
              key={campaign.id}
            >
              <a
                className="campaign-row-main"
                href={campaignEditorHash(campaign.id)}
              >
                <strong>{campaign.name}</strong>
                <span>{campaign.subject}</span>
              </a>
              <CampaignEventsSummary
                campaignId={campaign.id}
                campaignName={campaign.name}
                stats={props.statsByCampaign[campaign.id] ?? null}
                layout="row"
              />
              <div className="campaign-row-meta">
                <StatusLabel value={campaign.status} />
                <button
                  className="icon-button"
                  aria-label={`Send ${campaign.name}`}
                  onClick={() => props.onSend(campaign.id)}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`panel campaigns-editor${editing ? " is-editing" : ""}`}>
        <div className="panel-head">
          <h2>
            {editing
              ? (props.editingCampaign?.name ?? "Broadcast")
              : "New broadcast"}
          </h2>
          <MailPlus size={18} />
        </div>
        <div className="form-grid">
          <label>
            Name
            <input
              value={props.draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label>
            Subject
            <input
              value={props.draft.subject}
              onChange={(event) => update({ subject: event.target.value })}
            />
          </label>
          <label className="span-full">
            Preview
            <input
              value={props.draft.previewText}
              onChange={(event) => update({ previewText: event.target.value })}
            />
          </label>
          <label>
            Lists
            <input
              value={props.draft.lists}
              onChange={(event) => update({ lists: event.target.value })}
            />
          </label>
          <label>
            Tags
            <input
              value={props.draft.tags}
              onChange={(event) => update({ tags: event.target.value })}
            />
          </label>
          <label className="span-full">
            Markdown
            <textarea
              value={props.draft.markdownBody}
              onChange={(event) => update({ markdownBody: event.target.value })}
            />
          </label>
        </div>
        {editing ? (
          <CampaignEventsSummary
            campaignId={props.editingCampaignId}
            campaignName={props.editingCampaign?.name ?? "campaign"}
            stats={editingStats}
            layout="panel"
          />
        ) : null}
        <div className="button-row">
          {editing ? (
            <>
              <button onClick={props.onNew}>New broadcast</button>
              <button
                className="primary"
                onClick={() => props.onSave(props.editingCampaignId)}
                disabled={props.busy}
              >
                Save changes
              </button>
            </>
          ) : (
            <button
              className="primary"
              onClick={props.onCreate}
              disabled={props.busy}
            >
              <MailPlus size={17} />
              Save draft
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function CampaignEventsSummary({
  campaignId,
  campaignName,
  stats,
  layout,
}: {
  campaignId: string;
  campaignName: string;
  stats: CampaignStats | null;
  layout: "row" | "panel";
}) {
  const openRate = ratePercent(stats?.opened, stats?.sent);
  const clickRate = ratePercent(stats?.clicked, stats?.sent);
  return (
    <a
      className={`campaign-events-summary ${layout}`}
      href={campaignEventsHash(campaignId)}
      aria-label={`View events for ${campaignName}`}
    >
      <span className="campaign-sparkline" aria-hidden="true">
        <span style={{ width: `${openRate}%` }} />
        <span style={{ width: `${clickRate}%` }} />
      </span>
      <span className="campaign-events-rates">
        {formatRate(stats?.opened, stats?.sent)} open ·{" "}
        {formatRate(stats?.clicked, stats?.sent)} click
      </span>
      <span className="campaign-events-label">Events</span>
    </a>
  );
}

function EventsView(props: {
  selectedCampaign?: Campaign;
  campaigns: Campaign[];
  selectedCampaignId: string;
  onSelectCampaign: (id: string) => void;
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
        <select
          value={props.selectedCampaignId}
          onChange={(event) => props.onSelectCampaign(event.target.value)}
        >
          {props.campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
        <div className="metric-row">
          <Metric
            label="Open rate"
            value={formatRate(props.stats?.opened, props.stats?.sent)}
          />
          <Metric
            label="Click rate"
            value={formatRate(props.stats?.clicked, props.stats?.sent)}
            tone="amber"
          />
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

function Metric({
  label,
  value,
  tone = "teal",
}: {
  label: string;
  value: number | string;
  tone?: "teal" | "amber" | "coral";
}) {
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
    events: "Events",
  }[tab];
}

function draftFromCampaign(campaign: Campaign): typeof emptyDraft {
  return {
    name: campaign.name,
    subject: campaign.subject,
    previewText: campaign.previewText,
    markdownBody: campaign.markdownBody,
    lists: campaign.audience.listIds.join(", "),
    tags: campaign.audience.tagIds.join(", "),
  };
}

function campaignInputFromDraft(draft: typeof emptyDraft) {
  return {
    name: draft.name,
    subject: draft.subject,
    previewText: draft.previewText,
    markdownBody: draft.markdownBody,
    audience: {
      listIds: splitAudience(draft.lists),
      tagIds: splitAudience(draft.tags),
    },
  };
}

function splitAudience(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
