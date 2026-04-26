/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE: string;
  readonly PUBLIC_FACE_BASE: string;
  // server-only — typed for completeness, never read in client code
  readonly DATABASE_URL?: string;
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
  readonly VISITOR_HASH_KEY?: string;
  readonly SEED_SALT?: string;
  readonly MODAL_FACE_BASE?: string;
  readonly MODAL_ADMIN_STATUS_BASE?: string;
  readonly ADMIN_TOKEN?: string;
  readonly RATE_LIMIT_WINDOW_SEC?: string;
  readonly RATE_LIMIT_MAX?: string;
  readonly DAILY_LIMIT?: string;
  readonly ATTRIBUTE_RETENTION_DAYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
