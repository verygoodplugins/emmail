import { describe, expect, it } from "vitest";
import { normalizeEmail, parseNameParts, shouldSkipSuppressed } from "../../src/lib/email";

describe("email helpers", () => {
  it("normalizes valid email addresses and rejects invalid values", () => {
    expect(normalizeEmail("  PERSON+List@Example.COM ")).toBe("person+list@example.com");
    expect(normalizeEmail("missing-at")).toBeNull();
    expect(normalizeEmail("bad@")).toBeNull();
  });

  it("splits a display name into first and last name fallbacks", () => {
    expect(parseNameParts("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(parseNameParts("Prince")).toEqual({ firstName: "Prince", lastName: "" });
  });

  it("skips contacts with explicit suppressions or unsubscribed/bounced status", () => {
    expect(shouldSkipSuppressed({ email: "a@example.com", status: "subscribed" }, [])).toBe(false);
    expect(shouldSkipSuppressed({ email: "a@example.com", status: "unsubscribed" }, [])).toBe(true);
    expect(
      shouldSkipSuppressed({ email: "a@example.com", status: "subscribed" }, ["a@example.com"])
    ).toBe(true);
  });
});
