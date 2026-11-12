/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "demo" (default), "research" or "stress" (synthetic scale tests): the dataset the app loads. */
  readonly VITE_DATASET?: string;
  readonly VITE_BASE?: string;
  readonly VITE_ASK_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
