import { signToken } from "./tokens";

export interface CampaignLink {
  id: string;
  url: string;
}

export async function rewriteLinksForRecipient(
  html: string,
  options: { baseUrl: string; recipientId: string; links: CampaignLink[]; tokenSecret: string }
): Promise<string> {
  let rewritten = html;
  for (const link of options.links) {
    if (shouldSkipUrl(link.url)) {
      continue;
    }
    const token = await signToken(options.tokenSecret, "click", [options.recipientId, link.id]);
    const trackedUrl = `${trimSlash(options.baseUrl)}/t/click/${encodeURIComponent(options.recipientId)}/${encodeURIComponent(link.id)}/${token}`;
    rewritten = rewritten.replace(new RegExp(`href=(["'])${escapeRegExp(link.url)}\\1`, "g"), `href="${trackedUrl}"`);
  }
  return rewritten;
}

export async function appendOpenPixel(
  html: string,
  options: { baseUrl: string; campaignId: string; recipientId: string; tokenSecret: string }
): Promise<string> {
  const token = await signToken(options.tokenSecret, "open", [options.recipientId, options.campaignId]);
  const pixelUrl = `${trimSlash(options.baseUrl)}/t/open/${encodeURIComponent(options.recipientId)}/${encodeURIComponent(options.campaignId)}/${token}.gif`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none!important" />`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}

export function extractLinks(html: string): Array<{ url: string; position: number }> {
  const links: Array<{ url: string; position: number }> = [];
  const seen = new Set<string>();
  const regex = /href=(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const url = match[2];
    if (!shouldSkipUrl(url) && !seen.has(url)) {
      seen.add(url);
      links.push({ url, position: links.length });
    }
  }
  return links;
}

function shouldSkipUrl(url: string): boolean {
  return url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("#") || url.includes("/unsubscribe/");
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
