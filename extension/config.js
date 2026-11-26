// Default cloud API configuration (bundled for team distribution).
// Users can optionally override these in the extension panel's Settings drawer.
const ASR_DEFAULT_CONFIG = {
  GEMINI_MODEL: "gemini-3.8-flash",
  GEMINI_BASE_URL: "https://quanzil.com/v1",
  GEMINI_API_KEY: "sk-Y49cInJa4cim79wy2m9t7wLD3LW6EayTLy33oKBdWgoH2BGe",
  MAX_UTTERANCE_SEC: 20,
  MIN_UTTERANCE_MS: 100,
  THINKING_BUDGET: 0,
  TIMEOUT_MS: 90000,
  // Fill in your team's hosted version.json URL (e.g. GitHub Raw / Cloudflare Pages / Internal Static Host)
  UPDATE_CHECK_URL: "https://raw.githubusercontent.com/Spesxxx/big-asr-helper/main/version.json"
};

if (typeof globalThis !== "undefined") {
  globalThis.ASR_DEFAULT_CONFIG = ASR_DEFAULT_CONFIG;
}
