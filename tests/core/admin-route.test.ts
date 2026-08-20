import { describe, expect, it } from "vitest";
import {
  automationEditorHash,
  campaignEditorHash,
  campaignEventsHash,
  parseHash,
  routeHash,
} from "../../src/admin/route";

describe("admin hash routes", () => {
  it("maps empty hashes to the contacts tab", () => {
    expect(parseHash("")).toEqual({
      tab: "contacts",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#")).toEqual({
      tab: "contacts",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#/")).toEqual({
      tab: "contacts",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#/campaigns/%")).toEqual({
      tab: "campaigns",
      campaignId: "%",
      automationId: "",
    });
  });

  it("parses section hashes for browser history and deep links", () => {
    expect(parseHash("#/imports")).toEqual({
      tab: "imports",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#/campaigns")).toEqual({
      tab: "campaigns",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#/automations")).toEqual({
      tab: "automations",
      campaignId: "",
      automationId: "",
    });
    expect(parseHash("#/events")).toEqual({
      tab: "events",
      campaignId: "",
      automationId: "",
    });
  });

  it("opens a campaign in the editor, not events", () => {
    expect(parseHash("#/campaigns/cmp_june")).toEqual({
      tab: "campaigns",
      campaignId: "cmp_june",
      automationId: "",
    });
    expect(campaignEditorHash("cmp_june")).toBe("#/campaigns/cmp_june");
    expect(
      routeHash({
        tab: "campaigns",
        campaignId: "cmp_june",
        automationId: "",
      })
    ).toBe("#/campaigns/cmp_june");
  });

  it("keeps events on a distinct campaign URL", () => {
    expect(parseHash("#/campaigns/cmp_june/events")).toEqual({
      tab: "events",
      campaignId: "cmp_june",
      automationId: "",
    });
    expect(campaignEventsHash("cmp_june")).toBe("#/campaigns/cmp_june/events");
    expect(
      routeHash({
        tab: "events",
        campaignId: "cmp_june",
        automationId: "",
      })
    ).toBe("#/campaigns/cmp_june/events");
  });

  it("opens an automation sequence from the URL", () => {
    expect(parseHash("#/automations/aut_welcome")).toEqual({
      tab: "automations",
      campaignId: "",
      automationId: "aut_welcome",
    });
    expect(automationEditorHash("aut_welcome")).toBe("#/automations/aut_welcome");
    expect(
      routeHash({
        tab: "automations",
        campaignId: "",
        automationId: "aut_welcome",
      })
    ).toBe("#/automations/aut_welcome");
  });

  it("round-trips tab routes used by back/forward", () => {
    const routes = [
      { tab: "contacts" as const, campaignId: "", automationId: "" },
      { tab: "imports" as const, campaignId: "", automationId: "" },
      { tab: "campaigns" as const, campaignId: "", automationId: "" },
      { tab: "campaigns" as const, campaignId: "cmp_1", automationId: "" },
      { tab: "events" as const, campaignId: "", automationId: "" },
      { tab: "events" as const, campaignId: "cmp_1", automationId: "" },
      { tab: "automations" as const, campaignId: "", automationId: "" },
      {
        tab: "automations" as const,
        campaignId: "",
        automationId: "aut_1",
      },
    ];
    for (const route of routes) {
      expect(parseHash(routeHash(route))).toEqual(route);
    }
  });
});
