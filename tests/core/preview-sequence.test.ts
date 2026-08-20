import { describe, expect, it } from "vitest";
import {
  buildAutomationPreview,
  formatDuration,
  formatTimingLabel,
} from "../../src/email/preview-sequence";
import { applyTemplate } from "../../src/lib/templates";
import { WELCOME_SUBJECT, welcomeMarkdown } from "../../src/email/welcome";

describe("automation sequence preview", () => {
  it("applies merge tags and accumulates wait offsets", async () => {
    const preview = await buildAutomationPreview({
      firstName: "Ada",
      steps: [
        {
          stepType: "send_email",
          config: {
            subject: WELCOME_SUBJECT,
            previewText: "Hello {{first_name}}",
            markdownBody: welcomeMarkdown("{{first_name}}"),
          },
        },
        { stepType: "wait", config: { seconds: 120 } },
        {
          stepType: "send_email",
          config: {
            subject: "Follow up for {{first_name}}",
            previewText: "",
            markdownBody: "Hi {{first_name}},\n\nJust checking in.",
          },
        },
        { stepType: "add_tag", config: { tagName: "welcome-sequence-complete" } },
      ],
    });

    expect(preview.sample.firstName).toBe("Ada");
    expect(preview.timeline).toHaveLength(4);
    expect(preview.timeline[0]).toMatchObject({
      kind: "send_email",
      offsetSeconds: 0,
      timingLabel: "Immediately",
      subject: WELCOME_SUBJECT,
    });
    if (preview.timeline[0].kind === "send_email") {
      expect(preview.timeline[0].html).toContain("Ada");
      expect(preview.timeline[0].previewText).toBe("Hello Ada");
    }
    expect(preview.timeline[1]).toMatchObject({
      kind: "wait",
      offsetSeconds: 0,
      durationLabel: "2 minutes",
      timingLabel: "Immediately",
    });
    expect(preview.timeline[2]).toMatchObject({
      kind: "send_email",
      offsetSeconds: 120,
      timingLabel: "After 2 minutes",
      subject: "Follow up for Ada",
    });
    expect(preview.timeline[3]).toMatchObject({
      kind: "add_tag",
      offsetSeconds: 120,
      timingLabel: "After 2 minutes",
      tagName: "welcome-sequence-complete",
    });
  });

  it("rejects invalid step configs", async () => {
    await expect(
      buildAutomationPreview({
        firstName: "Ada",
        steps: [{ stepType: "send_email", config: { subject: "", markdownBody: "" } }],
      })
    ).rejects.toThrow(/subject and markdownBody/i);

    await expect(
      buildAutomationPreview({
        firstName: "Ada",
        steps: [{ stepType: "wait", config: undefined as unknown as Record<string, unknown> }],
      })
    ).rejects.toThrow(/config object/i);
  });

  it("formats timing helpers", () => {
    expect(formatTimingLabel(0)).toBe("Immediately");
    expect(formatTimingLabel(120)).toBe("After 2 minutes");
    expect(formatDuration(1)).toBe("1 second");
    expect(formatDuration(86400)).toBe("1 day");
    expect(applyTemplate("Hi {{first_name}},", "")).toBe("Hi there,");
  });
});
