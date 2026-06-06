/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEFAULT_DOMAIN?: string;
  readonly VITE_CX_VOICEMAIL_BUTTON_ENABLED?: string;
  readonly VITE_LIVE_COACH_PANEL_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
