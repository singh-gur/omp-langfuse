/**
 * Cross-process trace propagation through environment variables.
 *
 * In-process subagents (task tool, eval `agent()`, `/tan`) nest through the
 * shared registry in runtime.ts. These variables cover the process boundary:
 *
 * - `LANGFUSE_OMP_TRACEPARENT`: a W3C traceparent set by an outside
 *   application; every turn attaches under it and leaves the trace-level
 *   fields (name, session, user) to that application.
 * - `LANGFUSE_OMP_PARENT_*`: published by the main omp session while a turn is
 *   live, so an `omp` process started from inside it (e.g. through bash) nests
 *   under that turn.
 */
import { type SpanContext, TraceFlags } from "@opentelemetry/api";

export const ENV_TRACEPARENT = "LANGFUSE_OMP_TRACEPARENT";
export const ENV_PARENT_TRACE_ID = "LANGFUSE_OMP_PARENT_TRACE_ID";
export const ENV_PARENT_SPAN_ID = "LANGFUSE_OMP_PARENT_SPAN_ID";
export const ENV_PARENT_SESSION_ID = "LANGFUSE_OMP_PARENT_SESSION_ID";
export const ENV_PARENT_DEPTH = "LANGFUSE_OMP_PARENT_DEPTH";
export const ENV_PARENT_EXTERNAL_TRACE = "LANGFUSE_OMP_PARENT_EXTERNAL_TRACE";

const PROPAGATION_KEYS = [
  ENV_TRACEPARENT,
  ENV_PARENT_TRACE_ID,
  ENV_PARENT_SPAN_ID,
  ENV_PARENT_SESSION_ID,
  ENV_PARENT_DEPTH,
  ENV_PARENT_EXTERNAL_TRACE,
];

type Env = Record<string, string | undefined>;

const isUsableTraceId = (v: string | undefined): v is string => !!v && /^[0-9a-f]{32}$/.test(v) && !/^0+$/.test(v);
const isUsableSpanId = (v: string | undefined): v is string => !!v && /^[0-9a-f]{16}$/.test(v) && !/^0+$/.test(v);

const TRACEPARENT = /^(?!ff)([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** Parses a W3C traceparent; rejects version ff, all-zero ids and v00 trailers. */
export function parseTraceparent(value: string): { traceId: string; spanId: string } | undefined {
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const [, version, traceId, spanId, , trailing] = match;
  if (version === "00" && trailing) return undefined;
  if (!isUsableTraceId(traceId) || !isUsableSpanId(spanId)) return undefined;
  return { traceId, spanId };
}

export interface InheritedParent {
  spanContext: SpanContext;
  sessionId?: string;
  depth: number;
  source: "process" | "attached";
  /** The trace belongs to an outside application: never stamp trace-level fields. */
  externalTrace: boolean;
}

export function readInheritedParent(env: Env, warn: (message: string) => void = () => {}): InheritedParent | undefined {
  let ids: { traceId: string; spanId: string; source: InheritedParent["source"] } | undefined;
  const raw = env[ENV_TRACEPARENT]?.trim();
  if (raw) {
    const parsed = parseTraceparent(raw);
    if (parsed) ids = { ...parsed, source: "attached" };
    else warn(`Ignoring malformed ${ENV_TRACEPARENT}: ${JSON.stringify(raw)}`);
  }
  if (!ids) {
    const traceId = env[ENV_PARENT_TRACE_ID]?.trim().toLowerCase();
    const spanId = env[ENV_PARENT_SPAN_ID]?.trim().toLowerCase();
    if (!isUsableTraceId(traceId) || !isUsableSpanId(spanId)) return undefined;
    ids = { traceId, spanId, source: "process" };
  }
  const depth = Number(env[ENV_PARENT_DEPTH] ?? "0");
  return {
    spanContext: { traceId: ids.traceId, spanId: ids.spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true },
    sessionId: env[ENV_PARENT_SESSION_ID]?.trim() || undefined,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 0,
    source: ids.source,
    externalTrace: ids.source === "attached" || env[ENV_PARENT_EXTERNAL_TRACE] === "1",
  };
}

/** Snapshot of the propagation variables this process started with. */
export function snapshotPropagationEnv(env: Env): Env {
  return Object.fromEntries(PROPAGATION_KEYS.map((key) => [key, env[key]]));
}

/**
 * Points child processes at `parent` (a sampled span of the live turn).
 * Unsampled spans are never published: children would reference a trace
 * without an exported root.
 */
export function publishParentContext(
  env: Env,
  parent: SpanContext,
  sessionId: string,
  inherited: InheritedParent | undefined,
): void {
  if (!(parent.traceFlags & TraceFlags.SAMPLED)) return;
  delete env[ENV_TRACEPARENT];
  env[ENV_PARENT_TRACE_ID] = parent.traceId;
  env[ENV_PARENT_SPAN_ID] = parent.spanId;
  env[ENV_PARENT_SESSION_ID] = sessionId;
  env[ENV_PARENT_DEPTH] = String((inherited?.depth ?? 0) + 1);
  if (inherited?.externalTrace) env[ENV_PARENT_EXTERNAL_TRACE] = "1";
  else delete env[ENV_PARENT_EXTERNAL_TRACE];
}

/** A child must not attach to an ended turn; the inherited values stay valid, so restore them. */
export function withdrawParentContext(env: Env, snapshot: Env): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}
