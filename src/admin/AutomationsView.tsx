import { ArrowDown, ArrowUp, Clock3, Mail, Plus, Tag, Trash2, Workflow, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  createAutomation,
  listAutomationEnrollments,
  previewAutomationDraft,
  replaceAutomationSteps,
  seedWelcomeAutomation,
  setAutomationEnabled,
} from "./api";
import { automationEditorHash } from "./route";
import type {
  AutomationEnrollment,
  AutomationPreviewResult,
  AutomationStepType,
  AutomationSummary,
  StepDraft,
} from "./types";

const WELCOME_SEQUENCE_SLUG = "welcome-sequence";

interface EditorDraft {
  id: string;
  name: string;
  enabled: boolean;
  steps: StepDraft[];
  inFlight: number;
}

interface AutomationsViewProps {
  automations: AutomationSummary[];
  selectedId: string;
  busy: boolean;
  createSequenceRef: MutableRefObject<(() => void) | null>;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (message: string) => void;
  onRefresh: () => Promise<void>;
  onSelectId: (id: string) => void;
}

export function AutomationsView(props: AutomationsViewProps) {
  const selectedId = props.selectedId || null;
  const [draft, setDraft] = useState<EditorDraft | null>(() => {
    const current =
      props.automations.find((automation) => automation.id === props.selectedId) ??
      props.automations[0];
    return current ? toEditorDraft(current) : null;
  });
  const [dirty, setDirty] = useState(false);
  const [enrollments, setEnrollments] = useState<AutomationEnrollment[]>([]);
  const [sampleFirstName, setSampleFirstName] = useState("Ada");
  const [sequencePreview, setSequencePreview] = useState<AutomationPreviewResult | null>(null);
  const selectedIdRef = useRef(selectedId);
  const dirtyRef = useRef(dirty);
  const previewEpochRef = useRef(0);
  selectedIdRef.current = selectedId;
  dirtyRef.current = dirty;

  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => {
      props.onDirtyChange(false);
    };
  }, [dirty, props.onDirtyChange]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);

  const welcomeExists = useMemo(
    () => props.automations.some((automation) => automation.slug === WELCOME_SEQUENCE_SLUG),
    [props.automations]
  );

  useEffect(() => {
    if (props.automations.length === 0) {
      setDraft(null);
      setDirty(false);
      setEnrollments([]);
      setSequencePreview(null);
      return;
    }
    const currentId =
      selectedId && props.automations.some((automation) => automation.id === selectedId)
        ? selectedId
        : props.automations[0].id;
    const current = props.automations.find((automation) => automation.id === currentId)!;
    if (!dirty) {
      setDraft(toEditorDraft(current));
      return;
    }
    // Keep unsaved step edits, but lock the editor if Enable flipped on the server.
    setDraft((existing) => {
      if (!existing || existing.id !== current.id || existing.enabled === current.enabled) {
        return existing;
      }
      return {
        ...existing,
        enabled: current.enabled,
        inFlight: current.enrollmentCounts.active + current.enrollmentCounts.waiting,
      };
    });
  }, [props.automations, selectedId, dirty]);

  useEffect(() => {
    if (!selectedId) {
      setEnrollments([]);
      return;
    }
    let cancelled = false;
    void listAutomationEnrollments(selectedId)
      .then((rows) => {
        if (!cancelled) {
          setEnrollments(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEnrollments([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, props.automations]);

  useEffect(() => {
    props.createSequenceRef.current = () => {
      void handleNewSequence();
    };
    return () => {
      props.createSequenceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.createSequenceRef, props.busy, props.automations]);

  function selectAutomation(automation: AutomationSummary) {
    if (
      dirtyRef.current &&
      automation.id !== selectedId &&
      !window.confirm("You have unsaved changes. Discard them and switch sequences?")
    ) {
      return;
    }
    previewEpochRef.current += 1;
    setDirty(false);
    props.onDirtyChange(false);
    props.onSelectId(automation.id);
    setDraft(toEditorDraft(automation));
    setSequencePreview(null);
  }

  async function handleNewSequence() {
    if (
      dirtyRef.current &&
      !window.confirm("You have unsaved changes. Discard them and create a new sequence?")
    ) {
      return;
    }
    props.onBusyChange(true);
    props.onNotice("");
    try {
      const automation = await createAutomation("New sequence");
      await props.onRefresh();
      previewEpochRef.current += 1;
      setDirty(false);
      props.onDirtyChange(false);
      props.onSelectId(automation.id);
      setDraft(toEditorDraft(automation));
      setSequencePreview(null);
      props.onNotice(`Created “${automation.name}”`);
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : "Create failed");
    } finally {
      props.onBusyChange(false);
    }
  }

  async function handleSeedWelcome() {
    if (
      dirtyRef.current &&
      !window.confirm("You have unsaved changes. Discard them and seed the welcome sequence?")
    ) {
      return;
    }
    props.onBusyChange(true);
    props.onNotice("");
    try {
      const automation = await seedWelcomeAutomation();
      await props.onRefresh();
      previewEpochRef.current += 1;
      setDirty(false);
      props.onDirtyChange(false);
      props.onSelectId(automation.id);
      setDraft(toEditorDraft(automation));
      setSequencePreview(null);
      props.onNotice(`Seeded “${automation.name}” (${automation.steps.length} steps)`);
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : "Seed failed");
    } finally {
      props.onBusyChange(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    if (dirty && id === selectedId) {
      props.onNotice("Save or discard edits before enabling or disabling this sequence");
      return;
    }
    props.onBusyChange(true);
    props.onNotice("");
    try {
      const automation = await setAutomationEnabled(id, enabled);
      props.onNotice(`${automation.name} ${enabled ? "enabled" : "disabled"}`);
      if (id === selectedId) {
        setDirty(false);
      }
      await props.onRefresh();
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : "Toggle failed");
    } finally {
      props.onBusyChange(false);
    }
  }

  async function handleSave() {
    if (!draft || draft.enabled) {
      return;
    }
    const saveForId = draft.id;
    const saveEpoch = previewEpochRef.current;
    props.onBusyChange(true);
    props.onNotice("");
    try {
      const savedName = draft.name.trim() || "Untitled sequence";
      const saved = await replaceAutomationSteps(draft.id, draft.steps, {
        name: savedName,
      });
      await props.onRefresh();
      if (selectedIdRef.current !== saveForId || previewEpochRef.current !== saveEpoch) {
        return;
      }
      setDraft(toEditorDraft(saved));
      setDirty(false);
      props.onNotice(`Saved “${saved.name}”`);
    } catch (error) {
      if (selectedIdRef.current !== saveForId || previewEpochRef.current !== saveEpoch) {
        return;
      }
      props.onNotice(error instanceof Error ? error.message : "Save failed");
    } finally {
      props.onBusyChange(false);
    }
  }

  async function handlePreview() {
    if (!draft) {
      return;
    }
    const previewForId = draft.id;
    const previewEpoch = previewEpochRef.current;
    props.onBusyChange(true);
    props.onNotice("");
    try {
      const result = await previewAutomationDraft({
        firstName: sampleFirstName,
        steps: draft.steps,
      });
      if (selectedIdRef.current !== previewForId || previewEpochRef.current !== previewEpoch) {
        return;
      }
      setSequencePreview(result);
      props.onNotice(`Preview ready for “${sampleFirstName || "there"}”`);
    } catch (error) {
      if (selectedIdRef.current !== previewForId || previewEpochRef.current !== previewEpoch) {
        return;
      }
      setSequencePreview(null);
      props.onNotice(error instanceof Error ? error.message : "Preview failed");
    } finally {
      props.onBusyChange(false);
    }
  }

  function updateDraft(patch: Partial<EditorDraft>) {
    previewEpochRef.current += 1;
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setSequencePreview(null);
  }

  function updateStep(index: number, patch: Partial<StepDraft>) {
    if (!draft) {
      return;
    }
    const steps = draft.steps.map((step, stepIndex) =>
      stepIndex === index
        ? {
            ...step,
            ...patch,
            config: { ...step.config, ...(patch.config ?? {}) },
          }
        : step
    );
    updateDraft({ steps });
  }

  function moveStep(index: number, direction: -1 | 1) {
    if (!draft) {
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= draft.steps.length) {
      return;
    }
    const steps = [...draft.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    updateDraft({ steps });
  }

  function removeStep(index: number) {
    if (!draft) {
      return;
    }
    updateDraft({
      steps: draft.steps.filter((_, stepIndex) => stepIndex !== index),
    });
  }

  function addStep(stepType: AutomationStepType) {
    if (!draft || draft.enabled) {
      return;
    }
    updateDraft({ steps: [...draft.steps, defaultStep(stepType)] });
  }

  const readOnly = Boolean(draft?.enabled);

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Sequences</h2>
          <span>{props.automations.length}</span>
        </div>
        {props.automations.length === 0 ? (
          <div className="automation-empty">
            <p>No sequences yet. Seed the demo welcome flow or start from a blank sequence.</p>
            <div className="button-row">
              {!welcomeExists ? (
                <button onClick={() => void handleSeedWelcome()} disabled={props.busy}>
                  <Zap size={17} />
                  Seed welcome sequence
                </button>
              ) : null}
              <button
                className="primary"
                onClick={() => void handleNewSequence()}
                disabled={props.busy}
              >
                <Plus size={17} />
                Create blank sequence
              </button>
            </div>
          </div>
        ) : (
          <>
            {!welcomeExists ? (
              <div className="button-row automation-list-actions">
                <button onClick={() => void handleSeedWelcome()} disabled={props.busy}>
                  <Zap size={17} />
                  Seed welcome
                </button>
              </div>
            ) : null}
            <div className="campaign-list">
              {props.automations.map((automation) => {
                const inFlight =
                  automation.enrollmentCounts.active + automation.enrollmentCounts.waiting;
                return (
                  <div
                    className={`automation-list-row ${automation.id === selectedId ? "selected" : ""}`}
                    key={automation.id}
                  >
                    <a
                      href={automationEditorHash(automation.id)}
                      className="automation-list-select"
                      onClick={(event) => {
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
                        selectAutomation(automation);
                      }}
                    >
                      <strong>{automation.name}</strong>
                      <span>{triggerLabel(automation.triggerType)}</span>
                      <span>
                        {automation.steps.length} steps · {inFlight} in flight ·{" "}
                        {automation.enrollmentCounts.completed} done
                      </span>
                    </a>
                    <div className="automation-row-actions">
                      <StatusLabel value={automation.enabled ? "enabled" : "draft"} />
                      <button
                        className={automation.enabled ? "danger" : "primary"}
                        disabled={
                          props.busy ||
                          (dirty && automation.id === selectedId) ||
                          (!automation.enabled && automation.steps.length === 0)
                        }
                        title={
                          dirty && automation.id === selectedId
                            ? "Save edits before enabling or disabling"
                            : undefined
                        }
                        onClick={() => void handleToggle(automation.id, !automation.enabled)}
                      >
                        {automation.enabled ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{draft?.name || "Editor"}</h2>
          <Workflow size={18} />
        </div>
        {!draft ? (
          <p className="send-progress">Select a sequence to view or edit its steps.</p>
        ) : (
          <div className="automation-editor">
            {readOnly ? (
              <p className="automation-lock-notice">
                This sequence is enabled. Disable it from the list to edit.
              </p>
            ) : null}
            {!readOnly && draft.inFlight > 0 ? (
              <p className="automation-lock-notice">
                {draft.inFlight} contact(s) are mid-flow. Saving replaces all steps; position-based
                enrollments may skip or repeat steps.
              </p>
            ) : null}
            <div className="form-grid">
              <label>
                Name
                <input
                  value={draft.name}
                  disabled={readOnly || props.busy}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </label>
              <label>
                Trigger
                <input value="When a contact is created" readOnly disabled />
              </label>
            </div>

            <div className="automation-steps">
              {draft.steps.map((step, index) => (
                <StepCard
                  key={`${draft.id}-${index}`}
                  index={index}
                  step={step}
                  total={draft.steps.length}
                  readOnly={readOnly || props.busy}
                  onChange={(patch) => updateStep(index, patch)}
                  onMoveUp={() => moveStep(index, -1)}
                  onMoveDown={() => moveStep(index, 1)}
                  onRemove={() => removeStep(index)}
                />
              ))}
            </div>

            {!readOnly ? (
              <div className="button-row automation-add-steps">
                <button onClick={() => addStep("send_email")} disabled={props.busy}>
                  <Mail size={16} />
                  Add email
                </button>
                <button onClick={() => addStep("wait")} disabled={props.busy}>
                  <Clock3 size={16} />
                  Add wait
                </button>
                <button onClick={() => addStep("add_tag")} disabled={props.busy}>
                  <Tag size={16} />
                  Add tag
                </button>
              </div>
            ) : null}

            <div className="button-row automation-preview-actions">
              <label className="preview-sample-name">
                Sample first name
                <input
                  value={sampleFirstName}
                  disabled={props.busy}
                  onChange={(event) => {
                    setSampleFirstName(event.target.value);
                    setSequencePreview(null);
                  }}
                />
              </label>
              <button
                onClick={() => void handlePreview()}
                disabled={props.busy || draft.steps.length === 0}
              >
                Preview sequence
              </button>
              {!readOnly ? (
                <button
                  className="primary"
                  onClick={() => void handleSave()}
                  disabled={props.busy || !dirty}
                >
                  Save sequence
                </button>
              ) : null}
            </div>

            {sequencePreview ? (
              <div className="automation-preview">
                <h3>Preview timeline</h3>
                <p className="field-hint">
                  Rendered for “{sequencePreview.sample.firstName || "there"}” from the unsaved
                  draft. Does not send mail.
                </p>
                <ol className="preview-timeline">
                  {sequencePreview.timeline.map((item, index) => (
                    <li
                      key={`${item.kind}-${index}`}
                      className={`preview-item preview-${item.kind}`}
                    >
                      <div className="preview-item-meta">
                        <strong>{item.timingLabel}</strong>
                        {item.kind === "send_email" ? <span>Send email</span> : null}
                        {item.kind === "wait" ? <span>Wait {item.durationLabel}</span> : null}
                        {item.kind === "add_tag" ? <span>Add tag “{item.tagName}”</span> : null}
                      </div>
                      {item.kind === "send_email" ? (
                        <div className="preview-email">
                          <p>
                            <span>Subject</span>
                            <strong>{item.subject}</strong>
                          </p>
                          {item.previewText ? (
                            <p>
                              <span>Preview</span>
                              {item.previewText}
                            </p>
                          ) : null}
                          <iframe
                            title={`Preview email ${index + 1}`}
                            className="preview-email-frame"
                            sandbox=""
                            srcDoc={item.html}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <div className="automation-enrollments">
              <h3>Recent enrollments</h3>
              {enrollments.length === 0 ? (
                <p className="send-progress">No enrollments yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Contact</th>
                        <th>Status</th>
                        <th>Step</th>
                        <th>Next run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrollments.map((enrollment) => (
                        <tr key={enrollment.id}>
                          <td>{enrollment.contactId}</td>
                          <td>
                            <StatusLabel value={enrollment.status} />
                          </td>
                          <td>
                            {enrollment.status === "completed"
                              ? "—"
                              : enrollment.currentPosition + 1}
                          </td>
                          <td>
                            {enrollment.nextRunAt
                              ? new Date(enrollment.nextRunAt).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function StepCard(props: {
  index: number;
  step: StepDraft;
  total: number;
  readOnly: boolean;
  onChange: (patch: Partial<StepDraft>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const title = stepTitle(props.step.stepType);
  return (
    <div className="automation-step-card">
      <div className="automation-step-head">
        <strong>
          {props.index + 1}. {title}
        </strong>
        {!props.readOnly ? (
          <div className="automation-step-actions">
            <button
              className="icon-button"
              aria-label="Move step up"
              disabled={props.index === 0}
              onClick={props.onMoveUp}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Move step down"
              disabled={props.index >= props.total - 1}
              onClick={props.onMoveDown}
            >
              <ArrowDown size={16} />
            </button>
            <button
              className="icon-button danger"
              aria-label="Remove step"
              onClick={props.onRemove}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ) : null}
      </div>

      {props.step.stepType === "send_email" ? (
        <div className="form-grid automation-email-fields">
          <label className="span-full">
            Subject
            <input
              value={String(props.step.config.subject ?? "")}
              readOnly={props.readOnly}
              onChange={(event) => props.onChange({ config: { subject: event.target.value } })}
            />
          </label>
          <label className="span-full">
            Preview text
            <input
              value={String(props.step.config.previewText ?? "")}
              readOnly={props.readOnly}
              onChange={(event) => props.onChange({ config: { previewText: event.target.value } })}
            />
          </label>
          <label className="span-full">
            Markdown body
            <textarea
              value={String(props.step.config.markdownBody ?? "")}
              readOnly={props.readOnly}
              onChange={(event) => props.onChange({ config: { markdownBody: event.target.value } })}
            />
            <span className="field-hint">Use {"{{first_name}}"} for personalization.</span>
          </label>
        </div>
      ) : null}

      {props.step.stepType === "wait" ? (
        <WaitFields
          seconds={Number(props.step.config.seconds ?? 60)}
          readOnly={props.readOnly}
          onChange={(seconds) => props.onChange({ config: { seconds } })}
        />
      ) : null}

      {props.step.stepType === "add_tag" ? (
        <label>
          Tag name
          <input
            value={String(props.step.config.tagName ?? "")}
            readOnly={props.readOnly}
            onChange={(event) => props.onChange({ config: { tagName: event.target.value } })}
          />
        </label>
      ) : null}
    </div>
  );
}

function WaitFields(props: {
  seconds: number;
  readOnly: boolean;
  onChange: (seconds: number) => void;
}) {
  const display = secondsToDisplay(props.seconds);
  return (
    <div className="wait-fields">
      <label>
        Wait
        <input
          type="number"
          min={1}
          value={display.amount}
          readOnly={props.readOnly}
          onChange={(event) =>
            props.onChange(displayToSeconds(Number(event.target.value), display.unit))
          }
        />
      </label>
      <label>
        Unit
        <select
          value={display.unit}
          disabled={props.readOnly}
          onChange={(event) =>
            props.onChange(displayToSeconds(display.amount, event.target.value as WaitUnit))
          }
        >
          <option value="seconds">Seconds</option>
          <option value="minutes">Minutes</option>
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </label>
    </div>
  );
}

type WaitUnit = "seconds" | "minutes" | "hours" | "days";

function toEditorDraft(automation: AutomationSummary): EditorDraft {
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    inFlight: automation.enrollmentCounts.active + automation.enrollmentCounts.waiting,
    steps: automation.steps.map((step) => ({
      stepType: step.stepType,
      config: { ...step.config },
    })),
  };
}

function defaultStep(stepType: AutomationStepType): StepDraft {
  if (stepType === "send_email") {
    return {
      stepType,
      config: { subject: "", previewText: "", markdownBody: "" },
    };
  }
  if (stepType === "wait") {
    return { stepType, config: { seconds: 60 } };
  }
  return { stepType, config: { tagName: "" } };
}

function stepTitle(stepType: AutomationStepType): string {
  if (stepType === "send_email") {
    return "Send email";
  }
  if (stepType === "wait") {
    return "Wait";
  }
  return "Add tag";
}

function triggerLabel(triggerType: string): string {
  if (triggerType === "contact_created") {
    return "When a contact is created";
  }
  return triggerType;
}

function secondsToDisplay(seconds: number): { amount: number; unit: WaitUnit } {
  if (seconds >= 86400 && seconds % 86400 === 0) {
    return { amount: seconds / 86400, unit: "days" };
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return { amount: seconds / 3600, unit: "hours" };
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return { amount: seconds / 60, unit: "minutes" };
  }
  return { amount: seconds, unit: "seconds" };
}

function displayToSeconds(amount: number, unit: WaitUnit): number {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 1;
  if (unit === "days") {
    return safeAmount * 86400;
  }
  if (unit === "hours") {
    return safeAmount * 3600;
  }
  if (unit === "minutes") {
    return safeAmount * 60;
  }
  return safeAmount;
}

function StatusLabel({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}
