interface ImportMetaEnv {
  readonly VITE_API_HOST?: string;
  readonly VITE_CALL_ICE_SERVERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_VERSION__: string;
