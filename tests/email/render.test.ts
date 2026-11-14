import { describe, expect, it } from "vitest";
import { renderCampaignEmail } from "../../src/email/render";

describe("renderCampaignEmail", () => {
  it("preserves campaign content and links in HTML and plain-text output", async () => {
    const { html, text } = await renderCampaignEmail({
      previewText: "A short preview",
      markdownBody: "# Hello there\n\nRead **the update** at [our site](https://example.com/news).",
    });

    expect(html).toContain("A short preview");
    expect(html).toContain("<strong>the update</strong>");
    expect(html).toContain('href="https://example.com/news"');
    expect(text).toContain("HELLO THERE");
    expect(text).toContain("the update");
    expect(text).toContain("https://example.com/news");
    expect(text).toContain("You are receiving this because you subscribed to this list.");
  });
});
