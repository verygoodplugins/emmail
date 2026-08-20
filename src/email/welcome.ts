// Welcome-email copy. This is the ONE file to edit to change what a new
// contact-form lead receives. The body is Markdown, rendered through the same
// BroadcastEmail shell as campaigns. `firstName` is untrusted (public form) and
// is sanitized before interpolation.

export const WELCOME_SUBJECT = "Thanks for reaching out to South & Ozarks";
export const WELCOME_PREVIEW = "We got your message — here's what happens next.";

export function welcomeMarkdown(firstName: string): string {
  const name = sanitizeName(firstName);
  // Leave the literal {{first_name}} placeholder intact for automation templates.
  const greeting =
    firstName === "{{first_name}}" ? "Hi {{first_name}}," : name ? `Hi ${name},` : "Hi there,";
  return [
    greeting,
    "",
    "Thanks for reaching out to **South & Ozarks**. We've received your message and someone from our team will follow up with you shortly.",
    "",
    "If there's anything you'd like to add in the meantime, just reply to this email — it comes straight to us.",
    "",
    "Talk soon,",
    "The South & Ozarks team",
  ].join("\n");
}

export const FOLLOWUP_SUBJECT = "Anything else we can help with?";
export const FOLLOWUP_PREVIEW = "A quick check-in from South & Ozarks.";

export function followupMarkdown(firstName: string): string {
  const name = sanitizeName(firstName);
  const greeting =
    firstName === "{{first_name}}" ? "Hi {{first_name}}," : name ? `Hi ${name},` : "Hi there,";
  return [
    greeting,
    "",
    "Just checking in — if you still have questions for **South & Ozarks**, reply to this email and we'll take care of it.",
    "",
    "If you're all set, no action needed.",
    "",
    "Thanks,",
    "The South & Ozarks team",
  ].join("\n");
}

// The name arrives from an untrusted public contact form and flows into
// Markdown -> HTML -> outbound email. Strip anything that could inject Markdown
// or HTML: keep letters/marks, spaces, hyphens and apostrophes only, collapse
// whitespace, and cap length. Empty input yields "" so the greeting falls back.
export function sanitizeName(raw: string): string {
  return (raw ?? "")
    .replace(/[^\p{L}\p{M}\s'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
