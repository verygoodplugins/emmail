import { describe, expect, it } from "vitest";
import { appendOpenPixel, rewriteLinksForRecipient } from "../../src/lib/tracking";
import { verifyToken } from "../../src/lib/tokens";

describe("owned tracking", () => {
  it("rewrites campaign links to signed click redirects", async () => {
    const html =
      '<p><a href="https://example.com/path?a=1">Read more</a> <a href="mailto:test@example.com">Email</a></p>';
    const rewritten = await rewriteLinksForRecipient(html, {
      baseUrl: "https://mail.example.com",
      recipientId: "recipient_1",
      links: [{ id: "link_1", url: "https://example.com/path?a=1" }],
      tokenSecret: "secret",
    });

    const match = rewritten.match(
      /href="https:\/\/mail\.example\.com\/t\/click\/recipient_1\/link_1\/([^"]+)"/
    );
    expect(match).not.toBeNull();
    expect(rewritten).toContain('href="mailto:test@example.com"');
    await expect(
      verifyToken("secret", "click", ["recipient_1", "link_1"], match![1])
    ).resolves.toBe(true);
  });

  it("appends a signed open pixel before the closing body when present", async () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const tracked = await appendOpenPixel(html, {
      baseUrl: "https://mail.example.com",
      campaignId: "campaign_1",
      recipientId: "recipient_1",
      tokenSecret: "secret",
    });

    expect(tracked).toContain('<img src="https://mail.example.com/t/open/recipient_1/campaign_1/');
    expect(tracked.indexOf("<img")).toBeLessThan(tracked.indexOf("</body>"));
  });
});
