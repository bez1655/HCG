/// <reference types="vite/client" />

/**
 * Build-time configuration exposed to the client.
 *
 * Declared explicitly rather than relying on the ambient Vite types alone, so
 * that a typo in the variable name is a compile error rather than a silent
 * undefined that only shows up as a broken APK.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the game server, e.g. https://hcg.bez12.store
   *
   * Empty in the browser build (the client is served by the server itself).
   * Required for the standalone Android build, which has no server of its own.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
