export interface Env {
  DB: D1Database;
  SEND_QUEUE: Queue<SendQueueMessage>;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  TRACKING_SECRET: string;
  APP_BASE_URL: string;
  DEFAULT_FROM_EMAIL: string;
  DEFAULT_FROM_NAME: string;
  EMMAIL_INGEST_SECRET: string;
  EMMAIL_SEND_MODE: "dry-run" | "live";
  EMMAIL_ADMIN_TOKEN?: string;
  // "true" enables the ingest-triggered welcome email. Default (unset/"false")
  // keeps it inert, independent of EMMAIL_SEND_MODE.
  EMMAIL_WELCOME_ENABLED?: string;
}

// A campaign drain token: "send the next batch of this campaign". `type` is
// optional so existing producers ({ campaignId, limit }) still satisfy it.
export interface CampaignSendMessage {
  type?: "campaign";
  campaignId: string;
  limit: number;
}

// A one-shot transactional welcome for a single contact.
export interface WelcomeSendMessage {
  type: "welcome";
  contactId: string;
}

export type SendQueueMessage = CampaignSendMessage | WelcomeSendMessage;
