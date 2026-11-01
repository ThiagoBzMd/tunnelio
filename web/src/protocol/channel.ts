// Application messages inside the encrypted channel (SPEC §7). Requests are what the browser
// sends (§7.3); the inbound allowlist is what it accepts from the tray (§7.4).

import {
  CHAT_MODES,
  CHAT_ROLES,
  DONE_REASONS,
  LIMITS,
  SKILL_CATEGORIES,
  SKILLS_MODES,
  type AppErrorCode,
  type ChatMode,
  type ChatRole,
  type DoneReason,
  type KeepAlive,
  type SkillCategory,
  type SkillsMode,
} from "./constants";
import { isBool, isInt, isNumber, isRecord, isString, isStringArray, opt, type JsonObject } from "./validate";
import { base64DecodedLength, isStandardBase64 } from "../lib/images";

// ── Requests (browser → tray) ────────────────────────────────────────────────

export interface ChatMessageItem {
  role: ChatRole;
  content: string;
  /**
   * Standard base64 (RFC 4648, padded) of raw JPEG/PNG/WebP/GIF bytes, no data-URL prefix.
   * Only `user` messages; ≤ MAX_IMAGES_PER_MESSAGE, each ≤ MAX_IMAGE_BYTES decoded.
   */
  images?: string[];
}

/** Allowed `options` keys (SPEC §8.3). Anything else is rejected by the tray with E_INVALID. */
export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  num_ctx?: number;
  num_predict?: number;
  repeat_penalty?: number;
  seed?: number;
  stop?: string[];
}

export interface ListModelsRequest {
  type: "list_models";
  id: string;
}
export interface ListRunningRequest {
  type: "list_running";
  id: string;
}
export interface ShowModelRequest {
  type: "show_model";
  id: string;
  name: string;
}
export interface ChatRequest {
  type: "chat";
  id: string;
  conversation_id: string;
  mode: ChatMode;
  model: string;
  messages: ChatMessageItem[];
  options?: ChatOptions;
  think?: boolean;
  title?: string;
  keep_alive?: KeepAlive;
  /** rev. 1.8: the agent and the skills applied to this turn (the system message is composed here); the computer records them on the conversation. */
  agent_id?: string;
  skill_ids?: string[];
  /** rev. 1.9: with an agent chain, what the agents before this last one answered (kept with the reply). */
  chain?: ChainStep[];
}
/** rev. 1.9 (capability "chain"): one earlier agent of a chain and its answer (SPEC §9.4). */
export interface ChainStep {
  agent_id: string;
  name: string;
  model: string;
  content: string;
}
export interface AbortRequest {
  type: "abort";
  id: string;
  target_id: string;
}
export interface PullModelRequest {
  type: "pull_model";
  id: string;
  name: string;
}
export interface DeleteModelRequest {
  type: "delete_model";
  id: string;
  name: string;
}
export interface HistoryListRequest {
  type: "history_list";
  id: string;
  limit?: number;
  before?: string;
}
export interface HistoryGetRequest {
  type: "history_get";
  id: string;
  conversation_id: string;
  after_seq?: number;
  limit?: number;
}
export interface HistoryDeleteRequest {
  type: "history_delete";
  id: string;
  conversation_id: string;
}
/** rev. 1.4 (capability "history_clear"): delete every conversation on the device and give the space back. */
export interface HistoryClearRequest {
  type: "history_clear";
  id: string;
}
// rev. 1.8 (capability "agents"): agents and skills kept on the computer (SPEC §9.4).
export interface AgentInput {
  id: string;
  name: string;
  description: string;
  /** A name of the app's agent icon set. */
  icon: string;
  model: string;
  instructions: string;
  options?: ChatOptions;
  think?: boolean;
  skills: SkillsMode;
  skill_ids: string[];
  /** rev. 1.9 (capability "chain"): the agents that answer after this one, in order (≤ 5). */
  chain?: string[];
}
export interface Agent extends AgentInput {
  created_at: string;
  updated_at: string;
}
export interface SkillInput {
  id: string;
  name: string;
  /** When the skill should apply. */
  description: string;
  category: SkillCategory | "";
  /** Markdown. */
  instructions: string;
}
export interface Skill extends SkillInput {
  created_at: string;
  updated_at: string;
}
export interface AgentListRequest {
  type: "agent_list";
  id: string;
}
export interface AgentSaveRequest {
  type: "agent_save";
  id: string;
  agent: AgentInput;
}
export interface AgentDeleteRequest {
  type: "agent_delete";
  id: string;
  agent_id: string;
}
export interface SkillListRequest {
  type: "skill_list";
  id: string;
}
export interface SkillSaveRequest {
  type: "skill_save";
  id: string;
  skill: SkillInput;
}
export interface SkillDeleteRequest {
  type: "skill_delete";
  id: string;
  skill_id: string;
}
export type OutboundRequest =
  | ListModelsRequest
  | ListRunningRequest
  | ShowModelRequest
  | ChatRequest
  | AbortRequest
  | PullModelRequest
  | DeleteModelRequest
  | HistoryListRequest
  | HistoryGetRequest
  | HistoryDeleteRequest
  | HistoryClearRequest
  | AgentListRequest
  | AgentSaveRequest
  | AgentDeleteRequest
  | SkillListRequest
  | SkillSaveRequest
  | SkillDeleteRequest;

export type OutboundRequestType = OutboundRequest["type"];

/** The tray allowlist (SPEC §7.2) — the browser never sends anything else. */
export const OUTBOUND_TYPES: readonly OutboundRequestType[] = [
  "list_models",
  "list_running",
  "show_model",
  "chat",
  "abort",
  "pull_model",
  "delete_model",
  "history_list",
  "history_get",
  "history_delete",
  "history_clear",
  "agent_list",
  "agent_save",
  "agent_delete",
  "skill_list",
  "skill_save",
  "skill_delete",
] as const;

// ── Responses and events (tray → browser) ────────────────────────────────────

export interface OllamaStatus {
  status: "running" | "stopped" | "not_installed";
  version?: string;
}
export interface DeviceLimits {
  max_message_bytes: number;
  chat_concurrency: number;
  pull_concurrency: number;
  /** Present when `capabilities` includes "images". */
  max_images_per_message?: number;
  max_image_bytes?: number;
}
export interface DeviceInfoMessage {
  type: "device_info";
  protocol_versions: number[];
  tray_version: string;
  platform: string;
  ollama: OllamaStatus;
  limits: DeviceLimits;
  capabilities: string[];
  /** rev. 1.9: the model the computer is downloading right now (pull_model with that name joins it). */
  pull?: { name: string };
}

export interface ModelDetails {
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
  format?: string;
}
export interface ModelSummary {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
  details: ModelDetails;
}
export interface ModelsMessage {
  type: "models";
  id: string;
  models: ModelSummary[];
}

export interface RunningModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
  details?: ModelDetails;
  /** rev. 1.9: the context the model is loaded with, when the computer's Ollama says (SPEC §7.7). */
  context_length?: number;
}
export interface RunningMessage {
  type: "running";
  id: string;
  models: RunningModel[];
}

export interface ModelInfoMessage {
  type: "model_info";
  id: string;
  name: string;
  details: ModelDetails;
  capabilities?: string[];
  context_length?: number;
  parameters?: string;
  template?: string;
  license?: string;
}

export interface ChatChunkMessage {
  type: "chat_chunk";
  id: string;
  content: string;
  thinking?: string;
}

export interface ChatStats {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}
export interface ChatDoneMessage {
  type: "chat_done";
  id: string;
  conversation_id: string;
  done_reason: DoneReason;
  stats?: ChatStats;
  message_id?: string;
}

export interface PullProgressMessage {
  type: "pull_progress";
  id: string;
  name: string;
  status: string;
  total?: number;
  completed?: number;
}
export interface PullDoneMessage {
  type: "pull_done";
  id: string;
  name: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** rev. 1.8: the agent / skills applied on the last turn. */
  agent_id?: string;
  skill_ids?: string[];
}
export interface HistoryMessage {
  type: "history";
  id: string;
  conversations: ConversationSummary[];
  has_more: boolean;
  /** rev. 1.4: every conversation on the device, and the size of its conversation file in bytes. */
  total_conversations?: number;
  total_bytes?: number;
}

export interface ConversationMeta {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  agent_id?: string;
  skill_ids?: string[];
}
export interface StoredMessage {
  id: string;
  seq: number;
  role: ChatRole;
  content: string;
  thinking?: string;
  created_at: string;
  model?: string;
  stats?: ChatStats;
  aborted?: boolean;
  /** Same encoding as `ChatMessageItem.images` (user messages only). */
  images?: string[];
  /** rev. 1.9: on a reply from an agent chain, the answers of the agents before the last one. */
  chain?: ChainStep[];
}
export interface ConversationMessage {
  type: "conversation";
  id: string;
  conversation: ConversationMeta;
  messages: StoredMessage[];
  has_more: boolean;
}

export interface AgentsMessage {
  type: "agents";
  id: string;
  agents: Agent[];
}
export interface AgentMessage {
  type: "agent";
  id: string;
  agent: Agent;
}
export interface SkillsMessage {
  type: "skills";
  id: string;
  skills: Skill[];
}
export interface SkillMessage {
  type: "skill";
  id: string;
  skill: Skill;
}

export interface OkMessage {
  type: "ok";
  id: string;
}
export interface ErrorMessage {
  type: "error";
  id?: string;
  code: AppErrorCode | string;
  message?: string;
  retry_after_ms?: number;
}

export type InboundMessage =
  | DeviceInfoMessage
  | ModelsMessage
  | RunningMessage
  | ModelInfoMessage
  | ChatChunkMessage
  | ChatDoneMessage
  | PullProgressMessage
  | PullDoneMessage
  | HistoryMessage
  | ConversationMessage
  | AgentsMessage
  | AgentMessage
  | SkillsMessage
  | SkillMessage
  | OkMessage
  | ErrorMessage;

export type InboundMessageType = InboundMessage["type"];

/** Closed allowlist of inbound types; anything else is ignored with a console warning (SPEC §7.1). */
export const INBOUND_TYPES: readonly InboundMessageType[] = [
  "device_info",
  "models",
  "running",
  "model_info",
  "chat_chunk",
  "chat_done",
  "pull_progress",
  "pull_done",
  "history",
  "conversation",
  "agents",
  "agent",
  "skills",
  "skill",
  "ok",
  "error",
] as const;

const INBOUND_SET: ReadonlySet<string> = new Set(INBOUND_TYPES);

export function isInboundType(t: string): t is InboundMessageType {
  return INBOUND_SET.has(t);
}

function isModelDetails(v: unknown): v is ModelDetails {
  return (
    isRecord(v) &&
    opt(v.family, isString) &&
    opt(v.families, isStringArray) &&
    opt(v.parameter_size, isString) &&
    opt(v.quantization_level, isString) &&
    opt(v.format, isString)
  );
}

function isModelSummary(v: unknown): v is ModelSummary {
  return (
    isRecord(v) && isString(v.name) && isNumber(v.size) && isString(v.modified_at) && isString(v.digest) && isModelDetails(v.details)
  );
}

function isRunningModel(v: unknown): v is RunningModel {
  return (
    isRecord(v) &&
    isString(v.name) &&
    isNumber(v.size) &&
    isNumber(v.size_vram) &&
    isString(v.expires_at) &&
    opt(v.details, isModelDetails) &&
    opt(v.context_length, isInt)
  );
}

function isStats(v: unknown): v is ChatStats {
  return (
    isRecord(v) &&
    opt(v.total_duration, isNumber) &&
    opt(v.load_duration, isNumber) &&
    opt(v.prompt_eval_count, isNumber) &&
    opt(v.prompt_eval_duration, isNumber) &&
    opt(v.eval_count, isNumber) &&
    opt(v.eval_duration, isNumber)
  );
}

function isConversationSummary(v: unknown): v is ConversationSummary {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.title) &&
    isString(v.model) &&
    isString(v.created_at) &&
    isString(v.updated_at) &&
    isInt(v.message_count) &&
    opt(v.agent_id, isString) &&
    opt(v.skill_ids, isStringArray)
  );
}

function isConversationMeta(v: unknown): v is ConversationMeta {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.title) &&
    isString(v.model) &&
    isString(v.created_at) &&
    isString(v.updated_at) &&
    opt(v.agent_id, isString) &&
    opt(v.skill_ids, isStringArray)
  );
}

function isAgent(v: unknown): v is Agent {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.name) &&
    isString(v.description) &&
    isString(v.icon) &&
    isString(v.model) &&
    isString(v.instructions) &&
    opt(v.options, isRecord) &&
    opt(v.think, isBool) &&
    isString(v.skills) &&
    (SKILLS_MODES as readonly string[]).includes(v.skills) &&
    isStringArray(v.skill_ids) &&
    opt(v.chain, isStringArray) &&
    isString(v.created_at) &&
    isString(v.updated_at)
  );
}

function isChainStep(v: unknown): v is ChainStep {
  return isRecord(v) && isString(v.agent_id) && isString(v.name) && isString(v.model) && isString(v.content);
}

function isSkill(v: unknown): v is Skill {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.name) &&
    isString(v.description) &&
    isString(v.category) &&
    isString(v.instructions) &&
    isString(v.created_at) &&
    isString(v.updated_at)
  );
}

function isRole(v: unknown): v is ChatRole {
  return isString(v) && (CHAT_ROLES as readonly string[]).includes(v);
}

function isStoredMessage(v: unknown): v is StoredMessage {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isInt(v.seq) &&
    isRole(v.role) &&
    isString(v.content) &&
    opt(v.thinking, isString) &&
    isString(v.created_at) &&
    opt(v.model, isString) &&
    opt(v.stats, isStats) &&
    opt(v.aborted, isBool) &&
    opt(v.images, isStringArray) &&
    opt(v.chain, (c: unknown): c is ChainStep[] => Array.isArray(c) && c.every(isChainStep))
  );
}

export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: "unknown_type" | "malformed"; type: string };

/**
 * Validate one decrypted application message. Unknown fields are preserved (forward
 * compatibility); unknown types and malformed known types are reported, never thrown.
 */
export function parseInboundMessage(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, reason: "malformed", type: "?" };
  const m = value;
  const t: unknown = m.type;
  if (!isString(t)) return { ok: false, reason: "malformed", type: "?" };
  if (!isInboundType(t)) return { ok: false, reason: "unknown_type", type: t };
  const bad: ParseResult = { ok: false, reason: "malformed", type: t };
  const good = (): ParseResult => ({ ok: true, message: m as unknown as InboundMessage });
  const withId = isString(m.id);
  switch (t) {
    case "device_info":
      return Array.isArray(m.protocol_versions) &&
        m.protocol_versions.every(isInt) &&
        isString(m.tray_version) &&
        isString(m.platform) &&
        isRecord(m.ollama) &&
        isString(m.ollama.status) &&
        opt(m.ollama.version, isString) &&
        isRecord(m.limits) &&
        isNumber(m.limits.max_message_bytes) &&
        isNumber(m.limits.chat_concurrency) &&
        isNumber(m.limits.pull_concurrency) &&
        opt(m.limits.max_images_per_message, isNumber) &&
        opt(m.limits.max_image_bytes, isNumber) &&
        isStringArray(m.capabilities) &&
        opt(m.pull, (p: unknown): p is { name: string } => isRecord(p) && isString(p.name))
        ? good()
        : bad;
    case "models":
      return withId && Array.isArray(m.models) && m.models.every(isModelSummary) ? good() : bad;
    case "running":
      return withId && Array.isArray(m.models) && m.models.every(isRunningModel) ? good() : bad;
    case "model_info":
      return withId &&
        isString(m.name) &&
        isModelDetails(m.details) &&
        opt(m.capabilities, isStringArray) &&
        opt(m.context_length, isNumber) &&
        opt(m.parameters, isString) &&
        opt(m.template, isString) &&
        opt(m.license, isString)
        ? good()
        : bad;
    case "chat_chunk":
      return withId && isString(m.content) && opt(m.thinking, isString) ? good() : bad;
    case "chat_done":
      return withId &&
        isString(m.conversation_id) &&
        isString(m.done_reason) &&
        (DONE_REASONS as readonly string[]).includes(m.done_reason) &&
        opt(m.stats, isStats) &&
        opt(m.message_id, isString)
        ? good()
        : bad;
    case "pull_progress":
      return withId && isString(m.name) && isString(m.status) && opt(m.total, isNumber) && opt(m.completed, isNumber) ? good() : bad;
    case "pull_done":
      return withId && isString(m.name) ? good() : bad;
    case "history":
      return withId &&
        Array.isArray(m.conversations) &&
        m.conversations.every(isConversationSummary) &&
        isBool(m.has_more) &&
        opt(m.total_conversations, isInt) &&
        opt(m.total_bytes, isInt)
        ? good()
        : bad;
    case "conversation":
      return withId &&
        isConversationMeta(m.conversation) &&
        Array.isArray(m.messages) &&
        m.messages.every(isStoredMessage) &&
        isBool(m.has_more)
        ? good()
        : bad;
    case "agents":
      return withId && Array.isArray(m.agents) && m.agents.every(isAgent) ? good() : bad;
    case "agent":
      return withId && isAgent(m.agent) ? good() : bad;
    case "skills":
      return withId && Array.isArray(m.skills) && m.skills.every(isSkill) ? good() : bad;
    case "skill":
      return withId && isSkill(m.skill) ? good() : bad;
    case "ok":
      return withId ? good() : bad;
    case "error":
      return isString(m.code) && opt(m.id, isString) && opt(m.message, isString) && opt(m.retry_after_ms, isNumber) ? good() : bad;
    default:
      return bad;
  }
}

// ── Outbound validation (early, before encryption) ───────────────────────────

export class ChannelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelValidationError";
  }
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Validate a request against the SPEC limits so the UI fails fast instead of the tray. */
export function validateOutbound(msg: OutboundRequest): void {
  if (!isString(msg.id) || msg.id.length === 0 || msg.id.length > LIMITS.REQUEST_ID_MAX_LENGTH) {
    throw new ChannelValidationError("invalid request id");
  }
  if (!(OUTBOUND_TYPES as readonly string[]).includes(msg.type)) {
    throw new ChannelValidationError(`type ${msg.type} is not allowed`);
  }
  if (msg.type === "chat") {
    if (!(CHAT_MODES as readonly string[]).includes(msg.mode)) throw new ChannelValidationError("invalid mode");
    if (!isString(msg.model) || msg.model.length === 0) throw new ChannelValidationError("model is required");
    if (msg.messages.length < LIMITS.CHAT_MESSAGES_MIN || msg.messages.length > LIMITS.CHAT_MESSAGES_MAX) {
      throw new ChannelValidationError("messages must have 1–500 items");
    }
    for (const it of msg.messages) {
      if (!isRole(it.role) || !isString(it.content)) throw new ChannelValidationError("invalid message item");
      if (it.images !== undefined) validateImages(it.role, it.images);
    }
    if (msg.title !== undefined && utf8Len(msg.title) > LIMITS.CHAT_TITLE_MAX_BYTES) throw new ChannelValidationError("title too long");
    if (msg.agent_id !== undefined && !UUID.test(msg.agent_id)) throw new ChannelValidationError("agent_id must be a UUID");
    if (msg.skill_ids !== undefined) validateIds(msg.skill_ids);
    if (msg.chain !== undefined) validateChainSteps(msg.chain);
  }
  if (msg.type === "agent_save") validateAgent(msg.agent);
  if (msg.type === "skill_save") validateSkill(msg.skill);
  if ((msg.type === "agent_delete" && !UUID.test(msg.agent_id)) || (msg.type === "skill_delete" && !UUID.test(msg.skill_id))) {
    throw new ChannelValidationError("id must be a UUID");
  }
  if (msg.type === "history_list" && msg.limit !== undefined) {
    if (!isInt(msg.limit) || msg.limit < 1 || msg.limit > LIMITS.HISTORY_LIST_LIMIT_MAX) {
      throw new ChannelValidationError("history_list limit out of range");
    }
  }
  if (msg.type === "history_get") {
    if (msg.limit !== undefined && (!isInt(msg.limit) || msg.limit < 1 || msg.limit > LIMITS.HISTORY_GET_LIMIT_MAX)) {
      throw new ChannelValidationError("history_get limit out of range");
    }
    if (msg.after_seq !== undefined && (!isInt(msg.after_seq) || msg.after_seq < 0)) {
      throw new ChannelValidationError("after_seq must be ≥ 0");
    }
  }
  const bytes = utf8Len(JSON.stringify(msg));
  if (bytes > LIMITS.MAX_MESSAGE_BYTES) throw new ChannelValidationError("message exceeds 8 MiB");
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ICON = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const chars = (s: string): number => [...s].length;

function validateIds(ids: unknown): void {
  if (!isStringArray(ids) || ids.length > LIMITS.MAX_SKILLS || !ids.every((id) => UUID.test(id))) {
    throw new ChannelValidationError("skill_ids must be UUIDs");
  }
}

function validateText(field: string, v: unknown, max: number, multiline: boolean): void {
  if (!isString(v) || chars(v) > max || (multiline ? CONTROL_MULTILINE : CONTROL).test(v)) {
    throw new ChannelValidationError(`${field} is invalid`);
  }
}

function validateName(field: string, v: unknown): void {
  validateText(field, v, LIMITS.NAME_MAX_CHARS, false);
  if ((v as string).trim().length === 0) throw new ChannelValidationError(`${field} is required`);
}

function validateInstructions(v: unknown): void {
  if (!isString(v) || utf8Len(v) > LIMITS.INSTRUCTIONS_MAX_BYTES) throw new ChannelValidationError("instructions are too long");
}

/** Mirrors the computer's checks (SPEC §9.4) so the editor fails fast. */
function validateAgent(a: AgentInput): void {
  if (!isRecord(a) || !UUID.test(a.id)) throw new ChannelValidationError("agent.id must be a UUID");
  validateName("agent.name", a.name);
  validateText("agent.description", a.description, LIMITS.AGENT_DESCRIPTION_MAX_CHARS, true);
  if (!isString(a.icon) || a.icon.length > 40 || (a.icon !== "" && !ICON.test(a.icon))) throw new ChannelValidationError("agent.icon is invalid");
  if (!isString(a.model) || a.model.length === 0 || a.model.length > LIMITS.MODEL_NAME_MAX_LENGTH) throw new ChannelValidationError("agent.model is required");
  validateInstructions(a.instructions);
  if (a.think !== undefined && !isBool(a.think)) throw new ChannelValidationError("agent.think must be a boolean");
  if (!(SKILLS_MODES as readonly string[]).includes(a.skills)) throw new ChannelValidationError("agent.skills is invalid");
  validateIds(a.skill_ids);
  if (a.chain !== undefined) {
    const chain: unknown = a.chain;
    if (!isStringArray(chain) || chain.length > LIMITS.CHAIN_MAX || !chain.every((id) => UUID.test(id))) throw new ChannelValidationError("agent.chain is invalid");
    if (chain.includes(a.id) || new Set(chain).size !== chain.length) throw new ChannelValidationError("agent.chain repeats an agent");
  }
}

/** chat.chain: the earlier agents' answers kept with the reply (SPEC §9.4). */
function validateChainSteps(steps: unknown): void {
  if (!Array.isArray(steps) || steps.length > LIMITS.CHAIN_MAX) throw new ChannelValidationError("chain is invalid");
  for (const st of steps) {
    if (!isChainStep(st) || !UUID.test(st.agent_id)) throw new ChannelValidationError("chain step is invalid");
    validateName("chain.name", st.name);
    if (st.model.length === 0 || st.model.length > LIMITS.MODEL_NAME_MAX_LENGTH) throw new ChannelValidationError("chain.model is required");
    if (utf8Len(st.content) > LIMITS.CHAIN_STEP_MAX_BYTES) throw new ChannelValidationError("chain answer is too long");
  }
}

function validateSkill(k: SkillInput): void {
  if (!isRecord(k) || !UUID.test(k.id)) throw new ChannelValidationError("skill.id must be a UUID");
  validateName("skill.name", k.name);
  validateText("skill.description", k.description, LIMITS.SKILL_DESCRIPTION_MAX_CHARS, true);
  if (k.category !== "" && !(SKILL_CATEGORIES as readonly string[]).includes(k.category)) throw new ChannelValidationError("skill.category is invalid");
  validateInstructions(k.instructions);
}

/** Images: user messages only, ≤ 4 per message, standard base64 without prefix, ≤ 4 MiB decoded each. */
function validateImages(role: ChatRole, images: unknown): void {
  if (!isStringArray(images)) throw new ChannelValidationError("images must be an array of base64 strings");
  if (images.length === 0) return;
  if (role !== "user") throw new ChannelValidationError("only user messages can carry images");
  if (images.length > LIMITS.MAX_IMAGES_PER_MESSAGE) {
    throw new ChannelValidationError(`at most ${LIMITS.MAX_IMAGES_PER_MESSAGE} images per message`);
  }
  for (const img of images) {
    if (!isStandardBase64(img)) throw new ChannelValidationError("image must be standard base64 without a data-URL prefix");
    if (base64DecodedLength(img) > LIMITS.MAX_IMAGE_BYTES) throw new ChannelValidationError("image exceeds 4 MiB");
  }
}

export type { JsonObject };
