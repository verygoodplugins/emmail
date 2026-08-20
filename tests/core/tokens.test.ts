import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../../src/lib/tokens";

describe("signed public tokens", () => {
  it("verifies a token created for the same purpose and parts", async () => {
    const token = await signToken("secret", "open", ["recipient_1", "campaign_1"]);
    await expect(verifyToken("secret", "open", ["recipient_1", "campaign_1"], token)).resolves.toBe(
      true
    );
  });

  it("rejects tokens for a different purpose or payload", async () => {
    const token = await signToken("secret", "click", ["recipient_1", "link_1"]);
    await expect(verifyToken("secret", "open", ["recipient_1", "link_1"], token)).resolves.toBe(
      false
    );
    await expect(verifyToken("secret", "click", ["recipient_2", "link_1"], token)).resolves.toBe(
      false
    );
  });
});
