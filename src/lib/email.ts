export interface ContactSendState {
  email: string;
  status: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return null;
  }
  return email;
}

export function parseNameParts(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function shouldSkipSuppressed(contact: ContactSendState, suppressedEmails: string[]): boolean {
  if (contact.status === "unsubscribed" || contact.status === "bounced") {
    return true;
  }
  return suppressedEmails.includes(contact.email.toLowerCase());
}

export function formatFromHeader(name: string, email: string): string {
  const safeName = name.replace(/[<>\r\n"]/g, "").trim();
  return safeName ? `${safeName} <${email}>` : email;
}
