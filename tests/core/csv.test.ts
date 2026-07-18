import { describe, expect, it } from "vitest";
import { parseContactsCsv, previewContactsCsv } from "../../src/lib/csv";

describe("CSV contact import", () => {
  it("parses quoted CSV cells with commas", () => {
    const rows = parseContactsCsv('email,first_name,last_name\n"ada@example.com","Ada, Countess","Lovelace"');
    expect(rows).toEqual([{ email: "ada@example.com", first_name: "Ada, Countess", last_name: "Lovelace" }]);
  });

  it("previews supported core fields and reports invalid rows", () => {
    const csv = [
      "email,name,status,lists,tags,ignored",
      "ADA@Example.com,Ada Lovelace,subscribed,Newsletter;Clergy,donor;vip,x",
      "bad-email,Bad Row,subscribed,Newsletter,,x",
      "ada@example.com,Ada Duplicate,subscribed,Newsletter,,x"
    ].join("\n");

    const preview = previewContactsCsv(csv);

    expect(preview.accepted).toHaveLength(1);
    expect(preview.accepted[0]).toMatchObject({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      status: "subscribed",
      lists: ["Newsletter", "Clergy"],
      tags: ["donor", "vip"]
    });
    expect(preview.rejected).toEqual([
      { rowNumber: 3, reason: "Invalid email address", email: "bad-email" },
      { rowNumber: 4, reason: "Duplicate email in file", email: "ada@example.com" }
    ]);
    expect(preview.summary).toEqual({ totalRows: 3, acceptedRows: 1, rejectedRows: 2 });
  });
});
