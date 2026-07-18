import { normalizeEmail, parseNameParts } from "./email";

export interface ImportedContact {
  email: string;
  firstName: string;
  lastName: string;
  status: "subscribed" | "unsubscribed" | "bounced";
  lists: string[];
  tags: string[];
}

export interface CsvPreview {
  accepted: ImportedContact[];
  rejected: Array<{ rowNumber: number; reason: string; email?: string }>;
  summary: { totalRows: number; acceptedRows: number; rejectedRows: number };
}

export function parseContactsCsv(csv: string): Record<string, string>[] {
  const matrix = parseCsvMatrix(csv);
  if (matrix.length === 0) {
    return [];
  }

  const headers = matrix[0].map(canonicalHeader);
  return matrix.slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ""])));
}

export function previewContactsCsv(csv: string): CsvPreview {
  const rows = parseContactsCsv(csv);
  const seen = new Set<string>();
  const accepted: ImportedContact[] = [];
  const rejected: CsvPreview["rejected"] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const originalEmail = row.email || row.e_mail || "";
    const email = normalizeEmail(originalEmail);
    if (!email) {
      rejected.push({ rowNumber, reason: "Invalid email address", email: originalEmail });
      return;
    }
    if (seen.has(email)) {
      rejected.push({ rowNumber, reason: "Duplicate email in file", email });
      return;
    }

    seen.add(email);
    const nameParts = parseNameParts(row.name ?? "");
    const firstName = row.first_name || nameParts.firstName;
    const lastName = row.last_name || nameParts.lastName;
    accepted.push({
      email,
      firstName,
      lastName,
      status: normalizeStatus(row.status),
      lists: splitMultiValue(row.lists || row.list || ""),
      tags: splitMultiValue(row.tags || row.tag || "")
    });
  });

  return {
    accepted,
    rejected,
    summary: {
      totalRows: rows.length,
      acceptedRows: accepted.length,
      rejectedRows: rejected.length
    }
  };
}

function parseCsvMatrix(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ""));
}

function canonicalHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeStatus(status: string): ImportedContact["status"] {
  if (status === "unsubscribed" || status === "bounced") {
    return status;
  }
  return "subscribed";
}

function splitMultiValue(value: string): string[] {
  return value.split(";").map((entry) => entry.trim()).filter(Boolean);
}
