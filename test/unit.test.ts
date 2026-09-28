import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeToolDefinitions,
  attachToolDefinitions,
  buildCostDetails,
  buildHistoryInput,
  buildUsageDetails,
  createSecretRedactor,
  extractModelParameters,
  extractThinking,
  type OmpUsage,
  readSystemPrompt,
  toChatMlMessage,
  toDataUri,
  toMultimodalContent,
} from "../src/payload.ts";
import {
  ENV_PARENT_SPAN_ID,
  ENV_PARENT_TRACE_ID,
  ENV_TRACEPARENT,
  parseTraceparent,
  publishParentContext,
  readInheritedParent,
  snapshotPropagationEnv,
  withdrawParentContext,
} from "../src/propagation.ts";

const MARK = "[redacted-langfuse-secret]";

describe("createSecretRedactor", () => {
  it("redacts Langfuse key tokens and literal secrets, escaping regex metacharacters", () => {
    const redact = createSecretRedactor("we+rd(secret)$");
    assert.equal(redact("a sk-lf-abc123 b pk-lf-def c we+rd(secret)$"), `a ${MARK} b ${MARK} c ${MARK}`);
  });

  it("deep-copies nested structures, collapsing only true cycles", () => {
    const shared = { v: "ok" };
    const obj: Record<string, unknown> = { key: ["sk-lf-x1"], a: shared, b: shared, n: 1 };
    obj.self = obj;
    assert.deepEqual(createSecretRedactor()(obj), {
      key: [MARK],
      a: { v: "ok" },
      b: { v: "ok" },
      n: 1,
      self: "[circular-ref]",
    });
  });

  it("keeps a literal __proto__ key as data instead of touching the prototype", () => {
    const redacted = createSecretRedactor()(JSON.parse('{"__proto__": {"x": "sk-lf-hidden"}}'));
    assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(redacted, "__proto__")?.value, { x: MARK });
  });
});

describe("readSystemPrompt", () => {
  it("joins omp's prompt blocks and redacts keys", () => {
    assert.equal(readSystemPrompt({ getSystemPrompt: () => ["base", "key sk-lf-1"] }), `base\n\nkey ${MARK}`);
  });

  it("returns undefined for blank, missing or throwing accessors", () => {
    assert.equal(readSystemPrompt({ getSystemPrompt: () => ["  "] }), undefined);
    assert.equal(readSystemPrompt({}), undefined);
    assert.equal(
      readSystemPrompt({
        getSystemPrompt: () => {
          throw new Error("boom");
        },
      }),
      undefined,
    );
  });
});

describe("buildUsageDetails / buildCostDetails", () => {
  const withReasoning: OmpUsage = {
    input: 500,
    output: 300,
    cacheRead: 100,
    cacheWrite: 50,
    reasoningTokens: 200,
    cost: { input: 0.001, output: 0.003, cacheRead: 0.00002, cacheWrite: 0.0001875, total: 0.0042075 },
  };

  it("keeps every token in exactly one bucket, splitting reasoning out of output", () => {
    assert.deepEqual(buildUsageDetails(withReasoning), {
      input: 500,
      output: 100,
      output_reasoning_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    });
  });

  it("mirrors usage keys in cost keys so Langfuse can join them", () => {
    const usageKeys = Object.keys(buildUsageDetails(withReasoning) ?? {}).sort();
    const costKeys = Object.keys(buildCostDetails(withReasoning) ?? {})
      .filter((k) => k !== "total")
      .sort();
    assert.deepEqual(costKeys, usageKeys);
  });

  it("splits output cost at one per-token rate and re-sums exactly", () => {
    const details = buildCostDetails(withReasoning);
    assert.ok(Math.abs((details?.output ?? 0) - 0.001) < 1e-12);
    assert.ok(Math.abs((details?.output_reasoning_tokens ?? 0) - 0.002) < 1e-12);
    assert.equal((details?.output ?? 0) + (details?.output_reasoning_tokens ?? 0), 0.003);
  });

  it("falls back to one output bucket in both builders when reasoning exceeds output", () => {
    const inconsistent: OmpUsage = {
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 300,
      cost: { input: 0, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
    };
    assert.deepEqual(buildUsageDetails(inconsistent), { output: 100 });
    assert.deepEqual(buildCostDetails(inconsistent), { total: 0.0015, output: 0.0015 });
  });

  it("emits no cost without an omp price, so Langfuse server-side pricing applies", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    assert.equal(buildCostDetails({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
    assert.equal(buildCostDetails({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: zero }), undefined);
    assert.equal(buildUsageDetails({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
  });
});

describe("images", () => {
  it("only turns well-formed base64 into data URIs", () => {
    assert.equal(toDataUri({ type: "image", data: "aGVs\nbG8=", mimeType: "image/png" }), "data:image/png;base64,aGVsbG8=");
    assert.equal(toDataUri({ type: "image", data: "not base64!", mimeType: "image/png" }), undefined);
    assert.equal(toDataUri({ type: "image", data: "aGVsbG8=", mimeType: "image/png;x=1" }), undefined);
  });

  it("keeps plain text when no image survives validation", () => {
    assert.equal(toMultimodalContent("hi", [{ type: "image", data: "%%", mimeType: "image/png" }]), "hi");
    assert.deepEqual(toMultimodalContent("hi", [{ type: "image", data: "aGk=", mimeType: "image/png" }]), [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
    ]);
  });
});

describe("toChatMlMessage", () => {
  it("renders assistant text, thinking and redacted thinking without the encrypted payload", () => {
    const message = toChatMlMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "redactedThinking", data: "ENCRYPTED" },
        { type: "text", text: "done" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo sk-lf-secret" } },
      ],
    });
    assert.deepEqual(message, {
      role: "assistant",
      content: "done",
      thinking: [
        { type: "thinking", content: "plan" },
        { type: "thinking", content: "[redacted thinking]", redacted: true },
      ],
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: `{"command":"echo ${MARK}"}` } }],
    });
    assert.ok(!JSON.stringify(message).includes("ENCRYPTED"));
  });

  it("maps tool results, flags errors and replaces inline data URIs", () => {
    assert.deepEqual(
      toChatMlMessage({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: true,
        content: [
          { type: "text", text: "see data:image/png;base64,AAAA" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      }),
      {
        role: "tool",
        tool_call_id: "c1",
        name: "read",
        content: "see [data uri ~0KB]\n[image image/png ~0KB]",
        is_error: true,
      },
    );
  });

  it("keeps developer instructions and drops empty assistant turns", () => {
    assert.deepEqual(toChatMlMessage({ role: "developer", content: "reminder" }), { role: "developer", content: "reminder" });
    assert.equal(toChatMlMessage({ role: "assistant", content: [] }), undefined);
    assert.equal(toChatMlMessage({ role: "bashExecution", command: "ls" }), undefined);
  });
});

describe("buildHistoryInput", () => {
  it("projects through omp's converter and never throws", () => {
    const converted = buildHistoryInput([{ id: 1 }], () => [{ role: "user", content: "hello" }]);
    assert.deepEqual(converted, [{ role: "user", content: "hello" }]);
    const failing = buildHistoryInput([{ id: 1 }], () => {
      throw new Error("boom");
    });
    assert.equal(failing, undefined);
  });
});

describe("extractModelParameters", () => {
  it("reads what the request carried across wire dialects", () => {
    assert.deepEqual(
      extractModelParameters(
        {
          max_completion_tokens: 4096,
          temperature: 0.2,
          service_tier: "priority",
          tool_choice: { type: "auto" },
          reasoning: { effort: "high" },
          system: [{ type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }],
          thinking: { type: "enabled", budget_tokens: 2048 },
        },
        { reasoning: true },
        "high",
      ),
      {
        max_tokens: 4096,
        thinking_level: "high",
        thinking_budget_tokens: 2048,
        prompt_cache_retention: "1h",
        service_tier: "priority",
        tool_choice: "auto",
        reasoning_effort: "high",
        temperature: 0.2,
      },
    );
  });

  it("reports a thinking level only for reasoning models with thinking on", () => {
    assert.equal(extractModelParameters({}, { reasoning: false }, "high"), undefined);
    assert.equal(extractModelParameters({}, { reasoning: true }, "off"), undefined);
  });

  it("never mistakes a number inside the message history for a cap", () => {
    const payload = { messages: [{ role: "user", content: "x", max_tokens: 99 }] };
    assert.equal(extractModelParameters(payload, undefined, undefined), undefined);
  });

  it("keeps collected values when a getter throws", () => {
    const hostile = {
      max_tokens: 100,
      get tool_choice(): never {
        throw new Error("boom");
      },
    };
    assert.deepEqual(extractModelParameters(hostile, undefined, undefined), { max_tokens: 100 });
  });
});

describe("tool definitions", () => {
  const registry = {
    getAllTools: () => [
      { name: "read", description: "Read", parameters: { type: "object" } },
      { name: "bash", description: "Run", parameters: { type: "object" } },
      { name: "hidden", description: "Off", parameters: {} },
    ],
    getActiveTools: () => ["bash", "read", "bash", "unknown"],
  };

  it("keeps only active tools, in active order, once each", () => {
    assert.deepEqual(
      activeToolDefinitions(registry).map((t) => t.name),
      ["bash", "read"],
    );
  });

  it("degrades to no tools when the registry throws", () => {
    const broken = {
      getAllTools: () => {
        throw new Error("not initialized");
      },
      getActiveTools: () => [],
    };
    assert.deepEqual(activeToolDefinitions(broken), []);
  });

  it("attaches tools to the first message without mutating the input", () => {
    const input = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    const tools = [{ name: "bash" }];
    assert.deepEqual(attachToolDefinitions(input, tools), [{ role: "system", content: "s", tools }, input[1]]);
    assert.deepEqual(input[0], { role: "system", content: "s" });
  });
});

describe("extractThinking", () => {
  it("skips blank thinking blocks", () => {
    assert.deepEqual(extractThinking([{ type: "thinking", thinking: "  " }]), []);
  });
});

describe("trace propagation", () => {
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const spanId = "b7ad6b7169203331";

  it("parses valid traceparents and rejects unusable ones", () => {
    assert.deepEqual(parseTraceparent(`00-${traceId}-${spanId}-01`), { traceId, spanId });
    assert.equal(parseTraceparent(`ff-${traceId}-${spanId}-01`), undefined);
    assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${spanId}-01`), undefined);
    assert.equal(parseTraceparent(`00-${traceId}-${spanId}-01-extra`), undefined);
    assert.deepEqual(parseTraceparent(`01-${traceId}-${spanId}-01-extra`), { traceId, spanId });
  });

  it("treats an external traceparent as someone else's trace and falls back on garbage", () => {
    const attached = readInheritedParent({ [ENV_TRACEPARENT]: `00-${traceId}-${spanId}-01` });
    assert.equal(attached?.source, "attached");
    assert.equal(attached?.externalTrace, true);
    const warnings: string[] = [];
    const fallback = readInheritedParent(
      { [ENV_TRACEPARENT]: "garbage", [ENV_PARENT_TRACE_ID]: traceId, [ENV_PARENT_SPAN_ID]: spanId },
      (m) => warnings.push(m),
    );
    assert.equal(fallback?.source, "process");
    assert.equal(fallback?.externalTrace, false);
    assert.equal(warnings.length, 1);
  });

  it("publishes a live turn to child processes and restores the inherited values after", () => {
    const env: Record<string, string | undefined> = { [ENV_TRACEPARENT]: `00-${traceId}-${spanId}-01`, OTHER: "x" };
    const snapshot = snapshotPropagationEnv(env);
    const inherited = readInheritedParent(env);
    const turn = { traceId, spanId: "1111111111111111", traceFlags: 1 };
    publishParentContext(env, turn, "session-1", inherited);

    const child = readInheritedParent(env);
    assert.equal(child?.source, "process");
    assert.equal(child?.spanContext.spanId, "1111111111111111");
    assert.equal(child?.sessionId, "session-1");
    assert.equal(child?.depth, 1);
    // An attached run stays off the outside application's trace fields in its children too.
    assert.equal(child?.externalTrace, true);

    withdrawParentContext(env, snapshot);
    assert.deepEqual(env, { [ENV_TRACEPARENT]: `00-${traceId}-${spanId}-01`, OTHER: "x" });
  });

  it("never publishes an unsampled span", () => {
    const env: Record<string, string | undefined> = {};
    publishParentContext(env, { traceId, spanId, traceFlags: 0 }, "s", undefined);
    assert.deepEqual(env, {});
  });
});
