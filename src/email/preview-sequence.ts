import {
  validateStepInput,
  type StepInput,
  type AutomationStepType,
} from "../db/automation-repository";
import { sanitizeName } from "./welcome";
import { renderCampaignEmail } from "./render";
import { applyTemplate } from "../lib/templates";

export type PreviewTimelineItem =
  | {
      kind: "send_email";
      offsetSeconds: number;
      timingLabel: string;
      subject: string;
      previewText: string;
      html: string;
    }
  | {
      kind: "wait";
      offsetSeconds: number;
      timingLabel: string;
      seconds: number;
      durationLabel: string;
    }
  | {
      kind: "add_tag";
      offsetSeconds: number;
      timingLabel: string;
      tagName: string;
    };

export interface AutomationPreviewResult {
  sample: { firstName: string };
  timeline: PreviewTimelineItem[];
}

export async function buildAutomationPreview(input: {
  firstName?: string;
  steps: StepInput[];
}): Promise<AutomationPreviewResult> {
  const steps = input.steps ?? [];
  for (const step of steps) {
    validateStepInput(step);
  }

  const firstName = sanitizeName(String(input.firstName ?? "").trim());
  const timeline: PreviewTimelineItem[] = [];
  let offsetSeconds = 0;

  for (const step of steps) {
    const timingLabel = formatTimingLabel(offsetSeconds);
    if (step.stepType === "send_email") {
      const subject = applyTemplate(String(step.config.subject ?? ""), firstName);
      const previewText = applyTemplate(String(step.config.previewText ?? ""), firstName);
      const markdownBody = applyTemplate(String(step.config.markdownBody ?? ""), firstName);
      const { html } = await renderCampaignEmail({ previewText, markdownBody });
      timeline.push({
        kind: "send_email",
        offsetSeconds,
        timingLabel,
        subject,
        previewText,
        html,
      });
      continue;
    }
    if (step.stepType === "wait") {
      const seconds = Number(step.config.seconds);
      timeline.push({
        kind: "wait",
        offsetSeconds,
        timingLabel,
        seconds,
        durationLabel: formatDuration(seconds),
      });
      offsetSeconds += seconds;
      continue;
    }
    if (step.stepType === "add_tag") {
      timeline.push({
        kind: "add_tag",
        offsetSeconds,
        timingLabel,
        tagName: String(step.config.tagName ?? "").trim(),
      });
    }
  }

  return {
    sample: { firstName },
    timeline,
  };
}

export function formatTimingLabel(offsetSeconds: number): string {
  if (offsetSeconds <= 0) {
    return "Immediately";
  }
  return `After ${formatDuration(offsetSeconds)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) {
    const days = seconds / 86400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export type { AutomationStepType };
