// Protocol constants (SPEC §0.3, §3, §6.3, §7.6).

export const PROTOCOL_VERSION = 1 as const;
export const RELAY_SUBPROTOCOL = "tunnelio.v1";
export const RELAY_CLIENT_PATH = "/ws/client";
export const APP_NAME = "web" as const;

export const LIMITS = {
  /** Relay frame cap (RELAY_MAX_FRAME_BYTES default). */
  MAX_FRAME_BYTES: 1_048_576,
  /** Application message plaintext cap (8 MiB, so a `chat` can carry images). */
  MAX_MESSAGE_BYTES: 8 * 1024 * 1024,
  /** Images per `user` chat message. */
  MAX_IMAGES_PER_MESSAGE: 4,
  /** Decoded bytes per image (JPEG/PNG/WebP/GIF). */
  MAX_IMAGE_BYTES: 4 * 1024 * 1024,
  /** Envelope counter cap (SPEC §6.3). */
  MAX_COUNTER: Number.MAX_SAFE_INTEGER,
  REQUEST_ID_MAX_LENGTH: 64,
  CHAT_MESSAGES_MIN: 1,
  CHAT_MESSAGES_MAX: 500,
  CHAT_TITLE_MAX_BYTES: 200,
  HISTORY_LIST_LIMIT_DEFAULT: 50,
  HISTORY_LIST_LIMIT_MAX: 100,
  HISTORY_GET_LIMIT_DEFAULT: 200,
  HISTORY_GET_LIMIT_MAX: 200,
  MODEL_NAME_MAX_LENGTH: 256,
  STOP_SEQUENCES_MAX: 8,
  STOP_SEQUENCE_MAX_BYTES: 64,
  /** Agents and skills (SPEC §9.4): per computer, and per field. */
  MAX_AGENTS: 100,
  MAX_SKILLS: 100,
  NAME_MAX_CHARS: 80,
  AGENT_DESCRIPTION_MAX_CHARS: 300,
  SKILL_DESCRIPTION_MAX_CHARS: 500,
  INSTRUCTIONS_MAX_BYTES: 32 * 1024,
  /** rev. 1.9 (capability "chain"): agents that may answer after the chosen one, and the size of each earlier answer kept. */
  CHAIN_MAX: 5,
  CHAIN_STEP_MAX_BYTES: 512 * 1024,
} as const;

/** Skill categories (SPEC §9.4); "" = none. */
export const SKILL_CATEGORIES = ["ideas", "travel", "learning", "writing", "shopping", "code", "misc", "roleplay", "finance"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** Which skills an agent brings: none, every skill of the computer, or the ones it lists. */
export const SKILLS_MODES = ["off", "all", "selected"] as const;
export type SkillsMode = (typeof SKILLS_MODES)[number];

export const TIMEOUTS = {
  PING_INTERVAL_MS: 30_000,
  PONG_DEAD_MS: 45_000,
  BACKOFF_BASE_MS: 1_000,
  BACKOFF_MAX_MS: 60_000,
  BACKOFF_STABLE_MS: 60_000,
  /** Non-streaming request (SPEC §7.6). */
  REQUEST_MS: 30_000,
  /** Chat stream with no chunk (SPEC §7.6). */
  CHAT_IDLE_MS: 120_000,
  /** Pull stream with no progress. */
  PULL_IDLE_MS: 120_000,
  /** Each pairing step (SPEC §4.2 rule 2). */
  PAIRING_STEP_MS: 60_000,
  /**
   * Relay `open` and each handshake step. The device drops a bad/malformed handshake silently,
   * so the client times out, retries with a fresh `hello` (3 attempts) and then suggests re-pairing.
   */
  HANDSHAKE_MS: 10_000,
  HANDSHAKE_ATTEMPTS: 3,
} as const;

export const CLOSE_CODES = {
  UNAUTHORIZED: 4001,
  PROTOCOL_VIOLATION: 4002,
  RATE_LIMIT: 4003,
  FRAME_TOO_LARGE: 4004,
  SERVER_SHUTDOWN: 4005,
  REPLACED: 4006,
} as const;

export const RELAY_ERROR_CODES = [
  "E_AUTH",
  "E_INVALID",
  "E_VERSION",
  "E_RATE_LIMIT",
  "E_TOO_LARGE",
  "E_NOT_FOUND",
  "E_DEVICE_OFFLINE",
  "E_NO_SESSION",
  "E_PAIR_NOT_FOUND",
  "E_PAIR_BUSY",
  "E_PAIR_EXPIRED",
  "E_PAIR_FAILED",
  "E_LIMIT",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export const APP_ERROR_CODES = [
  "E_INVALID",
  "E_BUSY",
  "E_RATE_LIMIT",
  "E_TOO_LARGE",
  "E_OLLAMA_DOWN",
  "E_OLLAMA_ERROR",
  "E_MODEL_NOT_FOUND",
  "E_BAD_MODEL_NAME",
  "E_NOT_FOUND",
  "E_PULL_BUSY",
  "E_INTERNAL",
] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export const HANDSHAKE_REJECT_CODES = ["E_UNKNOWN_PAIRING", "E_VERSION", "E_BUSY"] as const;
export type HandshakeRejectCode = (typeof HANDSHAKE_REJECT_CODES)[number];

export const KEEP_ALIVE_VALUES = ["0", "5m", "30m", "1h"] as const;
export type KeepAlive = (typeof KEEP_ALIVE_VALUES)[number];

/** `chat.mode`: only "private" exists since rev. 1.3 (conversations never leave the computer); the tray rejects anything else. */
/** "private": kept in the computer's history; "incognito" (rev. 1.6): nothing written, gone when the tab closes. */
export const CHAT_MODES = ["private", "incognito"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

export const CHAT_ROLES = ["system", "user", "assistant"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const DONE_REASONS = ["stop", "length", "abort", "error"] as const;
export type DoneReason = (typeof DONE_REASONS)[number];

/** Model name regex (SPEC §8.2), mirrored in the browser for early validation. */
export const MODEL_NAME_RE =
  /^[a-z0-9]([a-z0-9._-]{0,63})?(\/[a-z0-9]([a-z0-9._-]{0,63})?)?(:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$/;
/** Strict pull form: `family:tag` or `namespace/family:tag` (tag mandatory, no digest). */
export const PULL_MODEL_NAME_RE = /^([a-z0-9]([a-z0-9._-]{0,63})?\/)?[a-z0-9]([a-z0-9._-]{0,63})?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
