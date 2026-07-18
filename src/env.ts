export interface Env {
  DB: D1Database;
  SEND_QUEUE: Queue<CampaignSendMessage>;
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
}

export interface CampaignSendMessage {
  campaignId: string;
  limit: number;
}
