/**
 * Process-wide tracing state.
 *
 * omp runs subagents in-process and rebinds this extension's factory to every
 * session without re-evaluating the module, so one exporter and one agent
 * registry are shared by the main session and all its subagents. The tracer
 * provider is private to this extension; the global OTel provider is never
 * touched.
 */
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import type { SpanContext } from "@opentelemetry/api";
import { defaultResource, detectResources, envDetector } from "@opentelemetry/resources";
import { AlwaysOnSampler, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LangfuseConfig } from "./config.ts";
import { createSecretRedactor } from "./payload.ts";

export type TraceAttributes = Record<string, string | string[]>;

interface Runtime {
  processor: LangfuseSpanProcessor;
  provider: NodeTracerProvider;
  /** Media uploads are pending in this runtime; exit flushes get a larger budget. */
  hadMedia: boolean;
}

let runtime: Runtime | undefined;

/**
 * Trace-level fields (name, session, user, tags) per trace id. Langfuse reads
 * them per span, and stamping them in `onStart` avoids installing the global
 * OTel context manager that `propagateAttributes()` would need. Subagent spans
 * share their parent's trace id and so inherit its fields.
 */
const traceAttributes = new Map<string, TraceAttributes>();
const MAX_TRACKED_TRACES = 512;

export function registerTraceAttributes(traceId: string, attributes: TraceAttributes): void {
  traceAttributes.delete(traceId);
  traceAttributes.set(traceId, attributes);
  if (traceAttributes.size > MAX_TRACKED_TRACES) {
    const oldest = traceAttributes.keys().next().value;
    if (oldest !== undefined) traceAttributes.delete(oldest);
  }
}

export function ensureRuntime(config: LangfuseConfig): Runtime {
  if (runtime) return runtime;
  const redactSecrets = createSecretRedactor(config.publicKey, config.secretKey);
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
    mask: ({ data }) => redactSecrets(data),
    shouldExportSpan: ({ otelSpan }) => typeof otelSpan.attributes["langfuse.observation.type"] === "string",
  });
  const baseOnStart = processor.onStart.bind(processor);
  processor.onStart = (span, parentContext) => {
    baseOnStart(span, parentContext);
    const attributes = traceAttributes.get(span.spanContext().traceId);
    if (attributes) span.setAttributes(attributes);
  };
  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(detectResources({ detectors: [envDetector] })),
    spanProcessors: [processor],
    sampler: new AlwaysOnSampler(),
    spanLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
  });
  setLangfuseTracerProvider(provider);
  runtime = { processor, provider, hadMedia: false };
  return runtime;
}

export function noteMediaExported(): void {
  if (runtime) runtime.hadMedia = true;
}

/** Resolves "timeout" after `ms` without keeping the process alive. */
function timeout(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  const { promise, resolve } = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => resolve("timeout"), ms);
  timer.unref?.();
  return { promise, cancel: () => clearTimeout(timer) };
}

export const FLUSH_TIMEOUT_MS = 3000;
/**
 * `forceFlush` awaits pending media uploads before exporting spans; aborting
 * one at exit leaves a media token without its binary, so exits that uploaded
 * images wait longer.
 */
const EXIT_FLUSH_WITH_MEDIA_TIMEOUT_MS = 15000;

/**
 * Bounded flush: tracing must never block omp. Mid-session a timeout is
 * harmless; the export finishes in the background.
 */
export async function flushRuntime(
  budgetMs: number = FLUSH_TIMEOUT_MS,
  warn: (message: string) => void = () => {},
): Promise<void> {
  if (!runtime) return;
  const { hadMedia, processor } = runtime;
  const deadline = timeout(budgetMs);
  try {
    const outcome = await Promise.race([processor.forceFlush().then(() => "done" as const), deadline.promise]);
    if (outcome === "timeout" && hadMedia) {
      warn(`flush timed out after ${budgetMs}ms with media pending; images may be missing from the trace`);
    }
  } catch (error) {
    warn(`flush failed: ${String(error)}`);
  } finally {
    deadline.cancel();
  }
}

/** Flushes and shuts the exporter down; the next traced turn builds a fresh runtime. */
export async function shutdownRuntime(warn: (message: string) => void = () => {}): Promise<void> {
  const current = runtime;
  if (!current) return;
  const budgetMs = current.hadMedia ? EXIT_FLUSH_WITH_MEDIA_TIMEOUT_MS : FLUSH_TIMEOUT_MS;
  await flushRuntime(budgetMs, warn);
  runtime = undefined;
  const deadline = timeout(budgetMs);
  try {
    await Promise.race([current.provider.shutdown(), deadline.promise]);
  } catch (error) {
    warn(`exporter shutdown failed: ${String(error)}`);
  } finally {
    deadline.cancel();
  }
}

/**
 * What an agent exposes to the subagents it spawns, keyed by omp agent
 * registry id (`ctx.agent.id`); a subagent finds its spawner through
 * `ctx.agent.parentId`.
 */
export interface AgentLink {
  /** Session id that groups this agent's traces in Langfuse. */
  sessionId: string;
  /** Nesting depth of this agent's turns (main session: 0). */
  depth: number;
  /** Span that subagents spawned now should nest under; undefined between turns. */
  spawnParent?: () => SpanContext;
}

export const agentLinks = new Map<string, AgentLink>();
