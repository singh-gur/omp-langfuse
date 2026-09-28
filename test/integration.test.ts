/**
 * End-to-end tests: the installed omp CLI (override with OMP_BIN) + a
 * deterministic mock model + a fake Langfuse ingest, sandboxed in temp dirs.
 * Asserts the exported OTLP span tree: names, nesting, types, usage, cost,
 * errors, session grouping, subagent nesting and trace attachment.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
  type Capture,
  type CapturedSpan,
  createSandbox,
  FINAL_ANSWER_TEXT,
  FINAL_ANSWER_THINKING,
  type MockProvider,
  runOmp,
  type Sandbox,
  startCaptureServer,
  startMockProvider,
  SUBAGENT_TASK,
} from "./helpers.ts";

const A = {
  type: "langfuse.observation.type",
  input: "langfuse.observation.input",
  output: "langfuse.observation.output",
  level: "langfuse.observation.level",
  usage: "langfuse.observation.usage_details",
  cost: "langfuse.observation.cost_details",
  model: "langfuse.observation.model.name",
  firstToken: "langfuse.observation.completion_start_time",
  traceName: "langfuse.trace.name",
  session: "session.id",
  user: "user.id",
  tags: "langfuse.trace.tags",
} as const;

const meta = (span: CapturedSpan, key: string) => span.attrs[`langfuse.observation.metadata.${key}`];
const json = (span: CapturedSpan, key: string): unknown => {
  const raw = span.attrs[key];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};
const named = (spans: CapturedSpan[], name: string) => spans.filter((s) => s.name === name);
const byStart = (spans: CapturedSpan[]) => [...spans].sort((a, b) => (a.startNs < b.startNs ? -1 : 1));
const only = (spans: CapturedSpan[], name: string): CapturedSpan => {
  const matches = named(spans, name);
  assert.equal(matches.length, 1, `expected one "${name}" span, got ${matches.length}`);
  return matches[0]!;
};

describe("integration: omp -> extension -> Langfuse export", () => {
  let mock: MockProvider;
  let capture: Capture;
  const openCaptures: Capture[] = [];
  /** Fresh ingest per run so assertions only see that run's spans. */
  const openCapture = async () => {
    capture = await startCaptureServer();
    openCaptures.push(capture);
  };

  before(async () => {
    mock = await startMockProvider();
  });
  after(() => mock.close());
  // Also on failure: an open capture server would keep the test runner alive.
  afterEach(() => {
    for (const open of openCaptures.splice(0)) open.close();
  });

  async function traced(
    prompt: string,
    opts: { env?: Record<string, string | undefined>; sandbox?: Sandbox; continue?: boolean } = {},
  ) {
    await openCapture();
    const sandbox = opts.sandbox ?? createSandbox(mock.port);
    const result = await runOmp(sandbox, prompt, {
      continue: opts.continue,
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_BASE_URL: `http://127.0.0.1:${capture.port}`,
        LANGFUSE_USER_ID: "test-user",
        ...opts.env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return { spans: capture.spans(), sandbox, result };
  }

  it("exports one trace per prompt: generations and tools under the turn, with usage and cost", async () => {
    const { spans } = await traced("summarize this workspace");
    const root = only(spans, "Conversational Turn");
    assert.equal(root.attrs[A.type], "agent");
    assert.equal(root.parentSpanId, undefined);
    assert.deepEqual(json(root, A.input), { role: "user", content: "summarize this workspace" });
    assert.deepEqual(json(root, A.output), { role: "assistant", content: FINAL_ANSWER_TEXT });
    assert.equal(meta(root, "agent_kind"), "main");
    assert.equal(meta(root, "turn_number"), "1");

    for (const span of spans) {
      assert.equal(span.traceId, root.traceId, `${span.name} left the trace`);
      assert.equal(span.attrs[A.traceName], "OMP Turn");
      assert.equal(span.attrs[A.user], "test-user");
      assert.deepEqual(span.attrs[A.tags], ["omp"]);
      assert.equal(span.attrs[A.session], meta(root, "session_id"));
      if (span !== root) assert.equal(span.parentSpanId, root.spanId, `${span.name} is not under the turn`);
    }

    const generations = byStart(named(spans, "LLM Call"));
    assert.equal(generations.length, 3);
    assert.deepEqual(
      byStart(spans.filter((s) => s.attrs[A.type] === "tool")).map((s) => s.name),
      ["Tool: bash", "Tool: read"],
    );
    for (const generation of generations) {
      assert.equal(generation.attrs[A.model], "mock-gpt-1");
      assert.ok(generation.attrs[A.firstToken], "time to first token missing");
    }

    // Final call: 1600 prompt tokens with 1280 cached, 78 output of which 30 reasoning.
    const final = generations[2]!;
    assert.deepEqual(json(final, A.usage), {
      input: 320,
      output: 48,
      output_reasoning_tokens: 30,
      cache_read_input_tokens: 1280,
    });
    const cost = json(final, A.cost) as Record<string, number>;
    assert.deepEqual(Object.keys(cost).filter((k) => k !== "total").sort(), Object.keys(json(final, A.usage) as object).sort());
    assert.ok(Math.abs((cost.output ?? 0) / 48 - 15 / 1e6) < 1e-15, "output priced off the model rate card");
    assert.deepEqual(json(final, A.output), {
      role: "assistant",
      content: FINAL_ANSWER_TEXT,
      thinking: [{ type: "thinking", content: FINAL_ANSWER_THINKING }],
    });

    // Every generation sees the conversation up to its call, with system prompt and active tools up front.
    const input = json(final, A.input) as Array<{ role: string; content?: string; tools?: Array<{ name: string }> }>;
    assert.equal(input[0]?.role, "system");
    assert.ok(input[0]?.tools?.some((t) => t.name === "bash"), "active tool definitions missing");
    assert.deepEqual(
      input.slice(1).map((m) => m.role),
      ["user", "assistant", "tool", "assistant", "tool"],
    );
    assert.match(input.at(-1)?.content ?? "", /Used by integration tests/);
  });

  it("marks a failed tool and its turn with ERROR", async () => {
    const { spans } = await traced("[fail] read the log");
    assert.equal(only(spans, "Tool: bash").attrs[A.level], "ERROR");
    assert.equal(only(spans, "Conversational Turn").attrs[A.level], "ERROR");
  });

  it("nests an in-process task subagent under the spawning tool call, in the parent's trace and session", async () => {
    const { spans } = await traced("[delegate] inspect it");
    const root = only(spans, "Conversational Turn");
    const task = only(spans, "Tool: task");
    const sub = only(spans, "Subagent Turn");
    assert.equal(sub.attrs[A.type], "agent");
    assert.equal(sub.traceId, root.traceId);
    assert.equal(sub.parentSpanId, task.spanId);
    assert.equal(meta(sub, "agent_kind"), "sub");
    assert.equal(meta(sub, "parent_agent_id"), "Main");
    assert.equal(meta(sub, "subagent_depth"), "1");
    assert.match(JSON.stringify(json(sub, A.input)), new RegExp(SUBAGENT_TASK));
    assert.equal(sub.attrs[A.session], root.attrs[A.session]);

    const subChildren = spans.filter((s) => s.parentSpanId === sub.spanId).map((s) => s.name);
    assert.ok(subChildren.includes("LLM Call") && subChildren.includes("Tool: yield"), subChildren.join(","));
    // Two parent generations; the subagent's call is not counted in the parent turn.
    assert.equal(spans.filter((s) => s.name === "LLM Call" && s.parentSpanId === root.spanId).length, 2);
  });

  it("groups a continued session under one session id and keeps counting turns", async () => {
    const first = await traced("summarize this workspace");
    const second = await traced("summarize this workspace", { sandbox: first.sandbox, continue: true });
    const turn1 = only(first.spans, "Conversational Turn");
    const turn2 = only(second.spans, "Conversational Turn");
    assert.notEqual(turn1.traceId, turn2.traceId);
    assert.equal(turn2.attrs[A.session], turn1.attrs[A.session]);
    assert.equal(meta(turn2, "turn_number"), "2");
  });

  it("attaches every turn under an external traceparent and leaves the trace fields to its owner", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const { spans } = await traced("summarize this workspace", {
      env: { LANGFUSE_OMP_TRACEPARENT: `00-${traceId}-${spanId}-01` },
    });
    const root = only(spans, "Conversational Turn");
    assert.equal(root.traceId, traceId);
    assert.equal(root.parentSpanId, spanId);
    assert.equal(meta(root, "attached_to_external_parent"), "true");
    for (const span of spans) {
      assert.equal(span.attrs[A.traceName], undefined);
      assert.equal(span.attrs[A.session], undefined);
    }
  });

  it("redacts Langfuse keys before anything leaves the process", async () => {
    const { spans } = await traced("summarize; my key is sk-lf-test and pk-lf-leaked-123");
    const exported = JSON.stringify(spans.map((s) => s.attrs));
    assert.ok(!exported.includes("sk-lf-test") && !exported.includes("pk-lf-leaked-123"));
    assert.match(exported, /redacted-langfuse-secret/);
  });

  it("reads credentials from <agentDir>/langfuse.json", async () => {
    await openCapture();
    const sandbox = createSandbox(mock.port);
    writeFileSync(
      join(sandbox.agentDir, "langfuse.json"),
      JSON.stringify({ publicKey: "pk-lf-file", secretKey: "sk-lf-file", baseUrl: `http://127.0.0.1:${capture.port}` }),
    );
    const result = await runOmp(sandbox, "summarize this workspace");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(named(capture.spans(), "Conversational Turn").length, 1);
  });

  it("exports nothing with LANGFUSE_TRACING_ENABLED=false", async () => {
    await openCapture();
    const result = await runOmp(createSandbox(mock.port), "summarize this workspace", {
      env: {
        LANGFUSE_TRACING_ENABLED: "false",
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_BASE_URL: `http://127.0.0.1:${capture.port}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(capture.requests.length, 0);
  });

  it("exports OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES as resource attributes", async () => {
    await traced("summarize this workspace", {
      env: { OTEL_SERVICE_NAME: "omp-agents", OTEL_RESOURCE_ATTRIBUTES: "team.name=platform" },
    });
    const resource = capture.resourceAttrs();
    assert.equal(resource["service.name"], "omp-agents");
    assert.equal(resource["team.name"], "platform");
  });
});
