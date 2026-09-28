/**
 * Pure conversions from omp event payloads to Langfuse observation fields:
 * redaction, ChatML history, tool definitions, model parameters, usage/cost.
 */

type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_REDACTION_MARK = "[redacted-langfuse-secret]";
const CYCLE_MARK = "[circular-ref]";
const LANGFUSE_KEY_TOKEN = String.raw`\b[sp]k-lf-[\w-]+\b`;

/**
 * Deep-copies `value`, replacing Langfuse key tokens and the given literal
 * secrets in every string. Cycles collapse to a marker; `__proto__` keys stay
 * plain data.
 */
export function createSecretRedactor(...extraSecrets: string[]): (value: unknown) => unknown {
  const alternatives = extraSecrets
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  alternatives.push(LANGFUSE_KEY_TOKEN);
  const pattern = new RegExp(alternatives.join("|"), "g");
  const walk = (value: unknown, ancestors: readonly object[]): unknown => {
    if (typeof value === "string") return value.replace(pattern, SECRET_REDACTION_MARK);
    if (value === null || typeof value !== "object") return value;
    if (ancestors.includes(value)) return CYCLE_MARK;
    const chain = [...ancestors, value];
    if (Array.isArray(value)) return value.map((item) => walk(item, chain));
    const fields: UnknownRecord = {};
    for (const [key, field] of Object.entries(value)) {
      Object.defineProperty(fields, key, {
        value: walk(field, chain),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return fields;
  };
  return (value) => walk(value, []);
}

export const redactLangfuseKeys = createSecretRedactor();

/** Joins omp's system prompt blocks; undefined when blank or unreadable. */
export function readSystemPrompt(ctx: { getSystemPrompt?: () => string[] | string | undefined }): string | undefined {
  let raw: unknown;
  try {
    raw = ctx.getSystemPrompt?.();
  } catch {
    return undefined;
  }
  const text = Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join("\n\n") : raw;
  if (typeof text !== "string" || !text.trim()) return undefined;
  return String(redactLangfuseKeys(text));
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface ChatMlToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments?: string };
}

export interface ChatMlThinkingPart {
  type: "thinking";
  content: string;
  redacted?: true;
}

function contentParts(content: unknown): UnknownRecord[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentParts(content)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

/** Tool calls without arguments: the tool observations carry the inputs. */
export function extractToolCalls(content: unknown): ChatMlToolCall[] {
  return contentParts(content)
    .filter((part) => part.type === "toolCall")
    .map((part) => ({ id: String(part.id ?? ""), type: "function" as const, function: { name: String(part.name ?? "") } }));
}

const DATA_URI = /data:[^;,]{0,100};base64,[A-Za-z0-9+/]+=*/g;

/** Replaces inline base64 data URIs with a size marker. */
export function markDataUris(text: string): string {
  return text.replace(DATA_URI, (uri) => `[data uri ~${Math.floor((uri.length * 3) / 4 / 1024)}KB]`);
}

export function extractThinking(content: unknown): ChatMlThinkingPart[] {
  const parts: ChatMlThinkingPart[] = [];
  for (const part of contentParts(content)) {
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      parts.push({ type: "thinking", content: markDataUris(part.thinking) });
    } else if (part.type === "redactedThinking") {
      // The payload is provider-encrypted; only its presence is informative.
      parts.push({ type: "thinking", content: "[redacted thinking]", redacted: true });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

export function extractImages(content: unknown): ImagePart[] {
  return contentParts(content).filter(
    (part): part is UnknownRecord & ImagePart =>
      part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
  );
}

export function describeImage(image: { data?: unknown; mimeType?: unknown }): string {
  const mime = typeof image.mimeType === "string" && image.mimeType ? image.mimeType : "unknown type";
  if (typeof image.data !== "string" || !image.data) return `[image ${mime}]`;
  return `[image ${mime} ~${Math.floor((image.data.length * 3) / 4 / 1024)}KB]`;
}

export function renderContentWithImageMarkers(content: unknown): string {
  if (typeof content === "string") return content;
  return contentParts(content)
    .map((part) => {
      if (part.type === "text") return typeof part.text === "string" ? part.text : "";
      if (part.type === "image") return describeImage(part);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * The Langfuse media processor detects `data:[^;]+;base64,[A-Za-z0-9+/]+=*`,
 * which also matches a prefix of malformed base64 and would upload a corrupt
 * file, so only well-formed payloads become data URIs.
 */
export function toDataUri(image: ImagePart): string | undefined {
  const data = image.data.replace(/\s+/g, "");
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  if (!image.mimeType || image.mimeType.includes(";")) return undefined;
  return `data:${image.mimeType};base64,${data}`;
}

export function toMultimodalContent(text: string, images: readonly ImagePart[] | undefined): string | ContentPart[] {
  const urls = (images ?? []).map(toDataUri).filter((url): url is string => !!url);
  if (!urls.length) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...urls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDefinitionInput {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface ToolRegistryView {
  getAllTools(): Array<{ name: string; description?: string; parameters?: unknown }>;
  getActiveTools(): string[];
}

/** Active tools in active order, reduced to the ChatML tool fields. */
export function activeToolDefinitions(registry: ToolRegistryView): ToolDefinitionInput[] {
  try {
    const byName = new Map(registry.getAllTools().map((tool) => [tool.name, tool]));
    const out: ToolDefinitionInput[] = [];
    for (const name of new Set(registry.getActiveTools())) {
      const tool = byName.get(name);
      if (tool) out.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
    }
    return out;
  } catch {
    return [];
  }
}

/** Langfuse's playground reads tool definitions from the first input message. */
export function attachToolDefinitions(input: unknown, tools: ToolDefinitionInput[]): unknown {
  if (!tools.length || !Array.isArray(input)) return input;
  const [first, ...rest] = input;
  return isRecord(first) ? [{ ...first, tools }, ...rest] : input;
}

// ---------------------------------------------------------------------------
// Model parameters
// ---------------------------------------------------------------------------

const MAX_TOKENS_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens", "maxTokens"];
const THINKING_BUDGET_KEYS = [
  "thinking_token_budget",
  "thinking_budget",
  "thinking_budget_tokens",
  "budget_tokens",
  "thinkingBudget",
];
/** Top-level scalar request fields shown as model-parameter chips. */
const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed"];

/** Searches `keys` in `bag` and up to `depth` nested objects; arrays (messages) are skipped. */
function findPositiveInteger(bag: unknown, keys: string[], depth = 2): number | undefined {
  if (!isRecord(bag)) return undefined;
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  if (depth === 0) return undefined;
  for (const value of Object.values(bag)) {
    const found = findPositiveInteger(value, keys, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pickCacheRetention(payload: UnknownRecord): string | undefined {
  if (typeof payload.prompt_cache_retention === "string") return payload.prompt_cache_retention;
  if (!Array.isArray(payload.system)) return undefined;
  for (const block of payload.system) {
    const control = isRecord(block) ? block.cache_control : undefined;
    if (isRecord(control) && typeof control.ttl === "string") return control.ttl;
  }
  return undefined;
}

/**
 * Reads the parameters the provider request really carried (after omp's
 * clamping), whatever the wire dialect calls them. Never throws.
 */
export function extractModelParameters(
  payload: unknown,
  model: { reasoning?: boolean } | undefined,
  thinkingLevel: string | undefined,
): Record<string, string | number> | undefined {
  const out: Record<string, string | number> = {};
  try {
    const maxTokens = findPositiveInteger(payload, MAX_TOKENS_KEYS);
    if (maxTokens !== undefined) out.max_tokens = maxTokens;
    if (model?.reasoning && thinkingLevel && thinkingLevel !== "off") out.thinking_level = thinkingLevel;
    const thinkingBudget = findPositiveInteger(payload, THINKING_BUDGET_KEYS);
    if (thinkingBudget !== undefined) out.thinking_budget_tokens = thinkingBudget;
    if (!isRecord(payload)) return Object.keys(out).length ? out : undefined;
    const cacheRetention = pickCacheRetention(payload);
    if (cacheRetention !== undefined) out.prompt_cache_retention = cacheRetention;
    if (typeof payload.service_tier === "string") out.service_tier = payload.service_tier;
    const toolChoice = payload.tool_choice;
    if (typeof toolChoice === "string") out.tool_choice = toolChoice;
    else if (isRecord(toolChoice) && typeof toolChoice.type === "string") out.tool_choice = toolChoice.type;
    const effort = isRecord(payload.reasoning) ? payload.reasoning.effort : payload.reasoning_effort;
    if (typeof effort === "string") out.reasoning_effort = effort;
    for (const key of SAMPLING_KEYS) {
      const value = payload[key];
      if (typeof value === "number") out[key] = value;
    }
  } catch {
    // A hostile payload (throwing getters) must not break tracing.
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// ChatML history
// ---------------------------------------------------------------------------

export type ChatMlMessage =
  | { role: "user" | "developer"; content: string }
  | { role: "assistant"; content?: string; thinking?: ChatMlThinkingPart[]; tool_calls?: ChatMlToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error?: true };

function renderHistoryContent(content: unknown): string {
  return typeof content === "string" || Array.isArray(content)
    ? renderContentWithImageMarkers(content)
    : safeStringify(content);
}

function historyToolCalls(content: unknown): ChatMlToolCall[] {
  return contentParts(content)
    .filter((part) => part.type === "toolCall")
    .map((part) => {
      const args = safeStringify(redactLangfuseKeys(part.arguments));
      return {
        id: String(part.id ?? ""),
        type: "function" as const,
        function: { name: String(part.name ?? ""), ...(args ? { arguments: markDataUris(args) } : {}) },
      };
    });
}

/** Converts one provider-bound omp message (user/developer/assistant/toolResult) to ChatML. */
export function toChatMlMessage(message: unknown): ChatMlMessage | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role === "user" || message.role === "developer") {
    return { role: message.role, content: markDataUris(renderHistoryContent(message.content)) };
  }
  if (message.role === "assistant") {
    const content = markDataUris(extractText(message.content));
    const thinking = extractThinking(message.content);
    const toolCalls = historyToolCalls(message.content);
    if (!content && !thinking.length && !toolCalls.length) return undefined;
    return {
      role: "assistant",
      ...(content ? { content } : {}),
      ...(thinking.length ? { thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: typeof message.toolCallId === "string" ? message.toolCallId : "",
      name: typeof message.toolName === "string" ? message.toolName : "",
      content: markDataUris(renderHistoryContent(message.content)),
      ...(message.isError ? { is_error: true as const } : {}),
    };
  }
  return undefined;
}

/**
 * Builds the conversation a generation received. `convertToLlm` is omp's own
 * agent-message → provider-message projection, so custom roles (bash runs,
 * compaction summaries, file mentions) appear exactly as the model saw them.
 */
export function buildHistoryInput<M>(
  messages: M[],
  convertToLlm: (messages: M[]) => unknown[],
): ChatMlMessage[] | undefined {
  try {
    const history = convertToLlm(messages)
      .map(toChatMlMessage)
      .filter((message): message is ChatMlMessage => message !== undefined);
    return history.length ? history : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Usage and cost
// ---------------------------------------------------------------------------

/** Subset of omp's `Usage` (pi-catalog) this extension reads. */
export interface OmpUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output`; undefined means unknown. */
  reasoningTokens?: number;
  /** Anthropic cache-write TTL split; components sum to `cacheWrite`. */
  cttl?: { ephemeral5m?: number; ephemeral1h?: number };
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * omp reports reasoning as a subset of `output`. A provider that reports more
 * reasoning than output would produce a negative bucket, so both builders fall
 * back to one `output` bucket then. They MUST agree, or a usage bucket loses
 * its cost twin.
 */
function reasoningSplit(usage: OmpUsage): { reasoning: number; canSplit: boolean } {
  const reasoning = usage.reasoningTokens ?? 0;
  return { reasoning, canSplit: reasoning > 0 && reasoning <= usage.output };
}

/** Maps omp usage to Langfuse usage keys; each token lands in exactly one key. */
export function buildUsageDetails(usage: OmpUsage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  if (usage.input > 0) details.input = usage.input;
  const { reasoning, canSplit } = reasoningSplit(usage);
  const output = canSplit ? usage.output - reasoning : usage.output;
  if (output > 0) details.output = output;
  if (canSplit) details.output_reasoning_tokens = reasoning;
  if (usage.cacheRead > 0) details.cache_read_input_tokens = usage.cacheRead;
  if (usage.cacheWrite > 0) details.cache_creation_input_tokens = usage.cacheWrite;
  return Object.keys(details).length ? details : undefined;
}

/**
 * Cost keys mirror {@link buildUsageDetails}: Langfuse joins usage and cost by
 * key name. Without an omp price, Langfuse's server-side pricing takes over.
 */
export function buildCostDetails(usage: OmpUsage): Record<string, number> | undefined {
  const cost = usage.cost;
  if (!cost || !(cost.total > 0)) return undefined;
  const details: Record<string, number> = { total: cost.total };
  if (cost.input > 0) details.input = cost.input;
  if (cost.output > 0) {
    const { reasoning, canSplit } = reasoningSplit(usage);
    if (canSplit) {
      const reasoningCost = cost.output * (reasoning / usage.output);
      const nonReasoningCost = cost.output - reasoningCost;
      if (nonReasoningCost > 0) details.output = nonReasoningCost;
      if (reasoningCost > 0) details.output_reasoning_tokens = reasoningCost;
    } else {
      details.output = cost.output;
    }
  }
  if (cost.cacheRead > 0) details.cache_read_input_tokens = cost.cacheRead;
  if (cost.cacheWrite > 0) details.cache_creation_input_tokens = cost.cacheWrite;
  return details;
}
