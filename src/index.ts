/**
 * omp extension that traces sessions to Langfuse: one trace per user prompt,
 * with model generations (tokens, cost, time to first token), tool calls,
 * compactions, branch summaries and in-process subagents nested under the
 * turn that spawned them.
 */
import {
  type LangfuseAgent,
  type LangfuseGeneration,
  LangfuseOtelSpanAttributes,
  type LangfuseTool,
  startObservation,
} from "@langfuse/tracing";
import type { Span, SpanContext } from "@opentelemetry/api";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import {
  activeToolDefinitions,
  attachToolDefinitions,
  buildCostDetails,
  buildHistoryInput,
  buildUsageDetails,
  type ChatMlMessage,
  describeImage,
  extractImages,
  extractModelParameters,
  extractText,
  extractThinking,
  extractToolCalls,
  type ImagePart,
  markDataUris,
  type OmpUsage,
  readSystemPrompt,
  redactLangfuseKeys,
  renderContentWithImageMarkers,
  safeStringify,
  toMultimodalContent,
} from "./payload.ts";
import {
  type InheritedParent,
  publishParentContext,
  readInheritedParent,
  snapshotPropagationEnv,
  withdrawParentContext,
} from "./propagation.ts";
import {
  agentLinks,
  type AgentLink,
  ensureRuntime,
  flushRuntime,
  noteMediaExported,
  registerTraceAttributes,
  shutdownRuntime,
  type TraceAttributes,
} from "./runtime.ts";

const EXTENSION_NAME = packageJson.name;
const EXTENSION_VERSION = packageJson.version;
const ROOT_OBSERVATION_NAME = "Conversational Turn";
const SUBAGENT_ROOT_OBSERVATION_NAME = "Subagent Turn";
const TRACE_NAME = "OMP Turn";
const GENERATION_NAME = "LLM Call";
const TOOL_PREFIX = "Tool:";
const STEERING_OBSERVATION_NAME = "User Message";
const COMPACTION_OBSERVATION_NAME = "Compaction";
const BRANCH_SUMMARY_OBSERVATION_NAME = "Branch Summary";
const TRACE_TAGS = ["omp"];
const STATUS_KEY = "langfuse";

/**
 * A data: URI only pays off when the span processor swaps it for a media
 * reference; with uploads off it would stay in the span as raw base64.
 */
const EMIT_IMAGE_MEDIA = !["false", "0"].includes(
  (process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED ?? "").trim().toLowerCase(),
);

/**
 * Read once per process, before any session publishes into `process.env`:
 * the factory is rebound for every in-process subagent, and those must not
 * mistake the main session's published context for an inherited one.
 */
let processParent: { inherited: InheritedParent | undefined; snapshot: Record<string, string | undefined> } | undefined;

interface OpenTool {
  obs: LangfuseTool;
  name: string;
}

interface TurnState {
  root: LangfuseAgent;
  generationCount: number;
  openGeneration?: { obs: LangfuseGeneration; sawFirstToken: boolean };
  openTools: Map<string, OpenTool>;
  /** Tool results since the last generation; fallback input when no context snapshot exists. */
  pendingToolResults: Array<{ tool_call_id: string; name: string; content: string }>;
  lastAssistantText?: string;
  sawError: boolean;
  userText: string;
  images: ImagePart[];
  systemPrompt?: string;
  /** Between agent_start and agent_end: a new prompt now is a steering message. */
  loopActive: boolean;
  link: AgentLink;
  /** This turn published itself for child omp processes (main session only). */
  publishedToEnv: boolean;
}

/** Where a new turn lands in Langfuse. */
interface Placement {
  parent?: SpanContext;
  sessionId: string;
  depth: number;
  /** Trace-level fields to stamp; undefined when the trace belongs to someone else. */
  traceAttributes?: TraceAttributes;
}

type ObservationLevel = "WARNING" | "ERROR";

export default function langfuseExtension(pi: ExtensionAPI): void {
  const warn = (message: string) => pi.logger.warn(`[omp-langfuse] ${message}`);
  const debug = (message: string, context?: Record<string, unknown>) =>
    pi.logger.debug(`[omp-langfuse] ${message}`, context);

  const config = loadConfig(pi.pi.getAgentDir(), process.env, warn);
  if (!config) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI && ctx.agent.kind === "main") ctx.ui.setStatus(STATUS_KEY, "langfuse: off (no keys)");
    });
    return;
  }

  processParent ??= { inherited: readInheritedParent(process.env, warn), snapshot: snapshotPropagationEnv(process.env) };
  const { inherited, snapshot: propagationSnapshot } = processParent;

  let state: TurnState | undefined;
  let gitBranch: string | undefined;
  let fallbackTurnCounter = 0;
  let lastContextHistory: ChatMlMessage[] | undefined;
  let compactionStartedAt: Date | undefined;
  let ownLink: { agentId: string; link: AgentLink } | undefined;

  const traceFields = (name: string | undefined, sessionId: string): TraceAttributes => ({
    ...(name ? { [LangfuseOtelSpanAttributes.TRACE_NAME]: name } : {}),
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: sessionId,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: TRACE_TAGS,
    ...(config.userId ? { [LangfuseOtelSpanAttributes.TRACE_USER_ID]: config.userId } : {}),
  });

  const placeTurn = (ctx: ExtensionContext, traceName: string): Placement => {
    const ownSessionId = ctx.sessionManager.getSessionId();
    const spawner = ctx.agent.parentId ? agentLinks.get(ctx.agent.parentId) : undefined;
    if (spawner) {
      const parent = spawner.spawnParent?.();
      // Nested under the spawner's live turn, the span shares its trace id and
      // with it the trace fields registered for that trace.
      if (parent) return { parent, sessionId: spawner.sessionId, depth: spawner.depth + 1 };
      return {
        sessionId: spawner.sessionId,
        depth: spawner.depth + 1,
        traceAttributes: traceFields(traceName, spawner.sessionId),
      };
    }
    if (inherited) {
      const sessionId = inherited.sessionId ?? ownSessionId;
      return {
        parent: inherited.spanContext,
        sessionId,
        depth: inherited.depth,
        traceAttributes: inherited.externalTrace ? undefined : traceFields(undefined, sessionId),
      };
    }
    return { sessionId: ownSessionId, depth: 0, traceAttributes: traceFields(traceName, ownSessionId) };
  };

  const stampTrace = (span: { otelSpan: Span }, attributes: TraceAttributes | undefined) => {
    if (!attributes) return;
    span.otelSpan.setAttributes(attributes);
    registerTraceAttributes(span.otelSpan.spanContext().traceId, attributes);
  };

  /**
   * omp persists the prompt only after before_agent_start (at its message_end),
   * so the turn number is the persisted user-message count plus one. Survives
   * restarts and `--continue` because it reads the session file.
   */
  const resolveTurnNumber = (ctx: ExtensionContext): number => {
    try {
      fallbackTurnCounter =
        ctx.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length + 1;
    } catch {
      fallbackTurnCounter += 1;
    }
    return fallbackTurnCounter;
  };

  const closeOpenObservations = (reason: "interrupted" | "superseded") => {
    if (!state) return;
    for (const tool of state.openTools.values()) {
      tool.obs.update({ level: "WARNING", statusMessage: `Tool run ${reason}`, metadata: { [reason]: true } });
      tool.obs.end();
    }
    state.openTools.clear();
    const generation = state.openGeneration;
    if (generation) {
      generation.obs.update({ level: "WARNING", statusMessage: `Generation ${reason}`, metadata: { [reason]: true } });
      generation.obs.end();
      state.openGeneration = undefined;
    }
  };

  const finalizeTurn = (opts: { cancelled: boolean }) => {
    if (!state) return;
    closeOpenObservations("interrupted");
    const media = EMIT_IMAGE_MEDIA ? state.images : [];
    if (media.length) noteMediaExported();
    const level: ObservationLevel | undefined = state.sawError ? "ERROR" : undefined;
    state.root.update({
      input: media.length ? { role: "user", content: toMultimodalContent(state.userText, media) } : undefined,
      output: state.lastAssistantText ? { role: "assistant", content: state.lastAssistantText } : undefined,
      level,
      metadata: {
        ...(state.images.length ? { image_count: state.images.length } : {}),
        ...(opts.cancelled ? { cancelled: true } : {}),
      },
    });
    state.root.end();
    state.link.spawnParent = undefined;
    if (state.publishedToEnv) withdrawParentContext(process.env, propagationSnapshot);
    state = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI && ctx.agent.kind === "main") ctx.ui.setStatus(STATUS_KEY, "langfuse ✓");
    try {
      const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd, timeout: 1000 });
      gitBranch = result.code === 0 ? result.stdout.trim() || undefined : undefined;
    } catch {
      gitBranch = undefined;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const promptImages = extractImages(event.images);
    const userText = [event.prompt, ...promptImages.map(describeImage)].filter(Boolean).join("\n");

    if (state?.loopActive) {
      // A steering or follow-up batch dequeued into the live agent loop.
      state.root.startObservation(
        STEERING_OBSERVATION_NAME,
        { input: { role: "user", content: userText } },
        { asType: "event" },
      );
      state.images.push(...promptImages);
      return;
    }
    if (state) finalizeTurn({ cancelled: true });

    ensureRuntime(config);
    const isSubagent = ctx.agent.kind === "sub" || inherited?.source === "process";
    const placement = placeTurn(ctx, TRACE_NAME);
    const turnNumber = resolveTurnNumber(ctx);
    lastContextHistory = undefined;

    const root = startObservation(
      isSubagent ? SUBAGENT_ROOT_OBSERVATION_NAME : ROOT_OBSERVATION_NAME,
      {
        input: { role: "user", content: userText },
        metadata: {
          source: "omp",
          extension: EXTENSION_NAME,
          extension_version: EXTENSION_VERSION,
          session_id: ctx.sessionManager.getSessionId(),
          turn_number: turnNumber,
          cwd: ctx.cwd,
          agent_id: ctx.agent.id,
          agent_name: ctx.agent.name,
          agent_kind: ctx.agent.kind,
          ...(gitBranch ? { git_branch: gitBranch } : {}),
          ...(ctx.model ? { model: ctx.model.id, provider: ctx.model.provider } : {}),
          ...(isSubagent ? { subagent_depth: placement.depth } : {}),
          ...(ctx.agent.parentId ? { parent_agent_id: ctx.agent.parentId } : {}),
          ...(inherited?.source === "attached" ? { attached_to_external_parent: true } : {}),
        },
      },
      { asType: "agent", ...(placement.parent ? { parentSpanContext: placement.parent } : {}) },
    );
    stampTrace(root, placement.traceAttributes);

    const link: AgentLink = { sessionId: placement.sessionId, depth: placement.depth };
    const turn: TurnState = {
      root,
      generationCount: 0,
      openTools: new Map(),
      pendingToolResults: [],
      sawError: false,
      userText,
      images: [...promptImages],
      loopActive: false,
      link,
      publishedToEnv: ctx.agent.kind === "main",
    };
    // Subagents nest under the one live spawning tool call (task / eval
    // agent()); with several in flight the pairing is unknowable, so they
    // fall back to the turn itself.
    link.spawnParent = () => {
      const spawning = [...turn.openTools.values()].filter((tool) => tool.name === "task" || tool.name === "eval");
      const only = spawning.length === 1 ? spawning[0] : undefined;
      return (only?.obs ?? turn.root).otelSpan.spanContext();
    };
    agentLinks.set(ctx.agent.id, link);
    ownLink = { agentId: ctx.agent.id, link };
    state = turn;
    if (turn.publishedToEnv) {
      publishParentContext(process.env, root.otelSpan.spanContext(), placement.sessionId, inherited);
    }
    debug("turn started", { agent: ctx.agent.id, turn: turnNumber });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!state) return;
    state.loopActive = true;
    const systemPrompt = readSystemPrompt(ctx);
    if (!systemPrompt || systemPrompt === state.systemPrompt) return;
    state.systemPrompt = systemPrompt;
    state.root.update({ metadata: { system_prompt: systemPrompt } });
  });

  pi.on("context", (event) => {
    if (state) lastContextHistory = buildHistoryInput(event.messages, pi.pi.convertToLlm);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!state) return;
    const previous = state.openGeneration;
    if (previous) {
      previous.obs.update({
        level: "WARNING",
        statusMessage: "Superseded by provider retry",
        metadata: { superseded: true },
      });
      previous.obs.end();
    }
    const index = ++state.generationCount;
    const history = lastContextHistory;
    const baseInput: unknown[] =
      history ??
      (index === 1
        ? [{ role: "user", content: state.userText }]
        : state.pendingToolResults.length
          ? [{ role: "tool", tool_results: state.pendingToolResults }]
          : []);
    const input = state.systemPrompt ? [{ role: "system", content: state.systemPrompt }, ...baseInput] : baseInput;

    const obs = state.root.startObservation(
      GENERATION_NAME,
      {
        input: input.length ? attachToolDefinitions(input, activeToolDefinitions(pi)) : undefined,
        model: ctx.model?.id,
        modelParameters: extractModelParameters(event.payload, ctx.model, pi.getThinkingLevel()),
        metadata: {
          assistant_index: index - 1,
          input_source: history ? "context" : "delta",
          ...(history ? { history_message_count: history.length } : {}),
          ...(ctx.model ? { provider: ctx.model.provider, context_window: ctx.model.contextWindow } : {}),
        },
      },
      { asType: "generation" },
    );
    state.openGeneration = { obs, sawFirstToken: false };
  });

  pi.on("message_update", (event) => {
    const generation = state?.openGeneration;
    if (!generation || generation.sawFirstToken || event.message.role !== "assistant") return;
    const content = event.message.content;
    if (extractText(content) || extractThinking(content).length || extractToolCalls(content).length) {
      generation.sawFirstToken = true;
      generation.obs.update({ completionStartTime: new Date() });
    }
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    const generation = state?.openGeneration;
    if (!state || !generation || message.role !== "assistant") return;

    const text = extractText(message.content);
    const toolCalls = extractToolCalls(message.content);
    const thinking = extractThinking(message.content);
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    if (message.stopReason === "error") state.sawError = true;
    const usage: OmpUsage | undefined = message.usage;

    generation.obs.update({
      output: {
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(thinking.length ? { thinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      model: message.model,
      usageDetails: usage ? buildUsageDetails(usage) : undefined,
      costDetails: usage ? buildCostDetails(usage) : undefined,
      ...(failed ? { level: "ERROR" as const, statusMessage: message.errorMessage || `stopReason: ${message.stopReason}` } : {}),
      metadata: {
        tool_count: toolCalls.length,
        stop_reason: message.stopReason,
        api: message.api,
        ...(message.responseId ? { response_id: message.responseId } : {}),
        ...(message.upstreamProvider ? { upstream_provider: message.upstreamProvider } : {}),
        ...(message.upstreamModel && message.upstreamModel !== message.model
          ? { upstream_model: message.upstreamModel }
          : {}),
        ...(usage?.cttl?.ephemeral1h ? { cache_write_1h_tokens: usage.cttl.ephemeral1h } : {}),
      },
    });
    generation.obs.end();
    state.openGeneration = undefined;
    if (text) state.lastAssistantText = text;
    state.pendingToolResults = [];
  });

  pi.on("tool_execution_start", (event) => {
    if (!state) return;
    const args = redactLangfuseKeys(event.args);
    const serialized = safeStringify(args);
    const marked = markDataUris(serialized);
    const obs = state.root.startObservation(
      `${TOOL_PREFIX} ${event.toolName}`,
      {
        // Inline images in arguments would bloat the span; keep the structure otherwise.
        input: marked === serialized ? args : marked,
        metadata: {
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
          ...(event.intent ? { intent: event.intent } : {}),
        },
      },
      { asType: "tool" },
    );
    state.openTools.set(event.toolCallId, { obs, name: event.toolName });
  });

  pi.on("tool_execution_end", (event) => {
    const open = state?.openTools.get(event.toolCallId);
    if (!state || !open) return;
    state.openTools.delete(event.toolCallId);

    const content = event.result && typeof event.result === "object" && "content" in event.result
      ? event.result.content
      : event.result;
    const images = extractImages(content);
    const output = renderContentWithImageMarkers(content) || safeStringify(content);
    if (event.isError) state.sawError = true;
    state.images.push(...images);

    open.obs.update({
      output: output || undefined,
      ...(event.isError ? { level: "ERROR" as const, statusMessage: "Tool execution failed" } : {}),
      metadata: { is_error: event.isError, ...(images.length ? { image_count: images.length } : {}) },
    });
    open.obs.end();
    state.pendingToolResults.push({ tool_call_id: event.toolCallId, name: open.name, content: output });
  });

  /** Compactions and branch summaries: nested in the live turn, else a trace of their own. */
  const recordSummary = (
    name: string,
    ctx: ExtensionContext,
    attributes: { output?: { role: string; content: string }; metadata: Record<string, unknown> },
    startedAt?: Date,
  ) => {
    if (state) {
      state.root
        .startObservation(name, attributes, { asType: "span", ...(startedAt ? { startTime: startedAt } : {}) })
        .end();
      return;
    }
    ensureRuntime(config);
    const placement = placeTurn(ctx, `OMP ${name}`);
    const obs = startObservation(
      name,
      {
        ...attributes,
        metadata: {
          ...attributes.metadata,
          source: "omp",
          extension: EXTENSION_NAME,
          extension_version: EXTENSION_VERSION,
          session_id: ctx.sessionManager.getSessionId(),
          agent_id: ctx.agent.id,
        },
      },
      {
        asType: "span",
        ...(startedAt ? { startTime: startedAt } : {}),
        ...(placement.parent ? { parentSpanContext: placement.parent } : {}),
      },
    );
    stampTrace(obs, placement.traceAttributes);
    obs.end();
    void flushRuntime(undefined, warn);
  };

  pi.on("session_before_compact", () => {
    compactionStartedAt = new Date();
  });

  pi.on("session_compact", (event, ctx) => {
    const startedAt = compactionStartedAt;
    compactionStartedAt = undefined;
    const entry = event.compactionEntry;
    recordSummary(
      COMPACTION_OBSERVATION_NAME,
      ctx,
      {
        output: entry.summary ? { role: "assistant", content: entry.summary } : undefined,
        metadata: {
          tokens_before: entry.tokensBefore,
          ...(entry.tokensAfter !== undefined ? { tokens_after: entry.tokensAfter } : {}),
          ...(entry.method ? { method: entry.method } : {}),
          ...(event.fromExtension ? { from_extension: true } : {}),
          ...(ctx.model ? { model: ctx.model.id, provider: ctx.model.provider } : {}),
        },
      },
      startedAt,
    );
  });

  pi.on("session_tree", (event, ctx) => {
    const entry = event.summaryEntry;
    if (!entry) return; // Plain navigation, no summarization call.
    recordSummary(BRANCH_SUMMARY_OBSERVATION_NAME, ctx, {
      output: entry.summary ? { role: "assistant", content: entry.summary } : undefined,
      metadata: {
        ...(event.fromExtension ? { from_extension: true } : {}),
        ...(ctx.model ? { model: ctx.model.id, provider: ctx.model.provider } : {}),
      },
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state) return;
    state.loopActive = false;
    // An automatic continuation (retry, pending background job) keeps the turn open.
    if (event.willContinue) return;
    finalizeTurn({ cancelled: false });
    // Subagent spans ship with the spawner's flush or the exporter's own batch timer.
    if (ctx.agent.kind !== "main") return;
    await flushRuntime(undefined, warn);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "langfuse ✓ (trace sent)");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state) finalizeTurn({ cancelled: true });
    if (ownLink && agentLinks.get(ownLink.agentId) === ownLink.link) agentLinks.delete(ownLink.agentId);
    ownLink = undefined;
    if (ctx.agent.kind === "main") await shutdownRuntime(warn);
  });
}
