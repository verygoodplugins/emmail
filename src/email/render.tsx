import { render } from "@react-email/render";
import { marked } from "marked";
import { BroadcastEmail } from "./BroadcastEmail";

export interface RenderCampaignInput {
  previewText: string;
  markdownBody: string;
}

export async function renderCampaignEmail(
  input: RenderCampaignInput
): Promise<{ html: string; text: string }> {
  const htmlBody = await marked.parse(input.markdownBody, { async: false });
  const element = <BroadcastEmail previewText={input.previewText} htmlBody={htmlBody} />;
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { html, text };
}
