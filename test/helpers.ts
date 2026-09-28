/**
 * Shared test infrastructure, fully self-contained (no external services):
 *
 * - startMockProvider(): OpenAI-compatible chat/completions server with a
 *   deterministic script (bash ls → read README.md → final answer, realistic
 *   usage incl. cache and reasoning tokens). Prompt markers select other
 *   scripts: "[fail]" runs a failing command, "[delegate]" spawns a `task`
 *   subagent.
 * - startCaptureServer(): fake Langfuse OTLP ingest that records every request.
 * - runOmp(): spawns the real omp CLI in a throwaway sandbox (HOME and
 *   PI_CODING_AGENT_DIR point at temp dirs), loading the extension via `-e`.
 *   The user's ~/.omp is never touched.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import zlib from "node:zlib";

const REPO_ROOT = resolve(import.meta.dirname, "..");
/**
 * The installed omp binary. `pnpm test` puts node_modules/.bin first on PATH,
 * where the type-only devDependency ships a bun-based `omp` shim, so skip it.
 * OMP_BIN overrides this to test another omp build.
 */
const OMP_BIN =
  process.env.OMP_BIN ||
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !dir.includes("node_modules"))
    .map((dir) => join(dir, "omp"))
    .find((candidate) => existsSync(candidate)) ||
  "omp";
export const EXTENSION = join(REPO_ROOT, "src", "index.ts");

// --------------------------------------------------------------------------
// Mock OpenAI-compatible provider
// --------------------------------------------------------------------------

export interface OpenAiMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  reasoning_content?: string;
}

export interface MockProvider {
  port: number;
  close: () => void;
}

function writeSseEvent(res: http.ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

interface ScriptStep {
  text?: string;
  thinking?: string;
  tool?: { name: string; args: unknown };
  finish: string;
  usage: unknown;
}

function streamChunks(res: http.ServerResponse, model: string, parts: ScriptStep) {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model };
  writeSseEvent(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (parts.thinking) {
    writeSseEvent(res, {
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: parts.thinking }, finish_reason: null }],
    });
  }
  if (parts.text) {
    writeSseEvent(res, { ...base, choices: [{ index: 0, delta: { content: parts.text }, finish_reason: null }] });
  }
  if (parts.tool) {
    writeSseEvent(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: { name: parts.tool.name, arguments: JSON.stringify(parts.tool.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  writeSseEvent(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: parts.finish }] });
  writeSseEvent(res, { ...base, choices: [], usage: parts.usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

export const FINAL_ANSWER_TEXT = "This is the test workspace. Done.";
export const FINAL_ANSWER_THINKING =
  "The workspace holds a single README, so a one-line summary answers the prompt.";
export const SUBAGENT_TASK = "inspect the repository";
export const SUBAGENT_ANSWER = "The repository holds one README.";

/** The omp openai adapter reads reasoning tokens from completion_tokens_details. */
function usage(prompt: number, completion: number, cached: number, reasoning = 0) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
}

function pickStep(messages: OpenAiMessage[], toolNames: string[]): ScriptStep {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = textOf(messages[lastUserIdx]?.content);
  const stage = messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool").length;

  // A subagent spawned by the `task` tool receives the task text as its prompt
  // and must hand its result back through the `yield` tool.
  if (lastUser.includes(SUBAGENT_TASK) && toolNames.includes("yield")) {
    if (stage === 0) {
      return {
        text: "Inspecting. ",
        tool: { name: "yield", args: { data: SUBAGENT_ANSWER } },
        finish: "tool_calls",
        usage: usage(700, 20, 0),
      };
    }
    return { text: SUBAGENT_ANSWER, finish: "stop", usage: usage(760, 12, 512) };
  }
  if (lastUser.includes("[delegate]")) {
    if (stage === 0) {
      return {
        text: "Delegating to a subagent. ",
        tool: {
          name: "task",
          args: { agent: "task", task: SUBAGENT_TASK, solutionSpace: "one read-only look" },
        },
        finish: "tool_calls",
        usage: usage(1200, 30, 0),
      };
    }
    return { text: "The subagent reported back. Done.", finish: "stop", usage: usage(1500, 26, 1100) };
  }
  if (lastUser.includes("[fail]")) {
    if (stage === 0) {
      return {
        text: "Reading the log file. ",
        tool: { name: "bash", args: { command: "cat does-not-exist.log" } },
        finish: "tool_calls",
        usage: usage(900, 28, 0),
      };
    }
    return { text: "The file does not exist, so I stopped.", finish: "stop", usage: usage(980, 30, 512) };
  }
  if (stage === 0) {
    return {
      text: "Looking at the project. ",
      tool: { name: "bash", args: { command: "ls" } },
      finish: "tool_calls",
      usage: usage(1200, 32, 0),
    };
  }
  if (stage === 1) {
    return {
      text: "Reading the README. ",
      tool: { name: "read", args: { path: "README.md" } },
      finish: "tool_calls",
      usage: usage(1350, 41, 1024),
    };
  }
  return {
    thinking: FINAL_ANSWER_THINKING,
    text: FINAL_ANSWER_TEXT,
    finish: "stop",
    usage: usage(1600, 78, 1280, 30),
  };
}

/** Resolves with the ephemeral port once `server` listens on loopback. */
function listen(server: http.Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(address && typeof address === "object" ? address.port : 0);
  });
  return promise;
}

interface MockRequest {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload: MockRequest = JSON.parse(body || "{}");
      const toolNames = (payload.tools ?? []).map((t) => t.function?.name ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      streamChunks(res, payload.model ?? "mock-gpt-1", pickStep(payload.messages ?? [], toolNames));
    });
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}

// --------------------------------------------------------------------------
// Capture server (fake Langfuse OTLP ingest)
// --------------------------------------------------------------------------

export interface CapturedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attrs: Record<string, unknown>;
  startNs: bigint;
  endNs: bigint;
}

export interface Capture {
  port: number;
  /** Raw export requests, in arrival order. */
  requests: unknown[];
  spans: () => CapturedSpan[];
  resourceAttrs: () => Record<string, unknown>;
  close: () => void;
}

interface OtlpValue {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
}

function parseAttrValue(v: OtlpValue): unknown {
  if (v.arrayValue) return (v.arrayValue.values ?? []).map((inner) => parseAttrValue(inner));
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: Array<{ key: string; value: OtlpValue }>;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
}

/** OTLP/HTTP JSON export body, as the Langfuse exporter sends it. */
interface OtlpRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: Array<{ key: string; value: OtlpValue }> };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

export async function startCaptureServer(): Promise<Capture> {
  const requests: OtlpRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let raw = Buffer.concat(chunks);
      if ((req.headers["content-encoding"] ?? "") === "gzip") raw = zlib.gunzipSync(raw);
      const parsed: OtlpRequest = JSON.parse(raw.toString("utf8"));
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listen(server);
  const resourceSpans = () => requests.flatMap((r) => r.resourceSpans ?? []);
  return {
    port,
    requests,
    spans: () =>
      resourceSpans()
        .flatMap((rs) => rs.scopeSpans ?? [])
        .flatMap((ss) => ss.spans ?? [])
        .map((sp) => ({
          traceId: sp.traceId,
          spanId: sp.spanId,
          parentSpanId: sp.parentSpanId || undefined,
          name: sp.name,
          attrs: Object.fromEntries((sp.attributes ?? []).map((a) => [a.key, parseAttrValue(a.value)])),
          startNs: BigInt(sp.startTimeUnixNano ?? 0),
          endNs: BigInt(sp.endTimeUnixNano ?? 0),
        })),
    resourceAttrs: () =>
      Object.fromEntries(
        resourceSpans().flatMap((rs) => (rs.resource?.attributes ?? []).map((a) => [a.key, parseAttrValue(a.value)])),
      ),
    close: () => server.close(),
  };
}

// --------------------------------------------------------------------------
// omp sandbox runner
// --------------------------------------------------------------------------

export interface Sandbox {
  home: string;
  agentDir: string;
  workspace: string;
}

/**
 * One temp root per test process. omp unpacks its ~370MB native addon under
 * $HOME/.omp/natives, so HOME is shared by all sandboxes (extracted once) and
 * the whole root is removed on exit. Isolation comes from PI_CODING_AGENT_DIR,
 * which holds each sandbox's models, config, sessions and langfuse.json.
 */
let sandboxRoot: string | undefined;
function getSandboxRoot(): string {
  if (sandboxRoot) return sandboxRoot;
  const root = mkdtempSync(join(tmpdir(), "omp-lf-"));
  sandboxRoot = root;
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function createSandbox(mockPort: number): Sandbox {
  const root = getSandboxRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = mkdtempSync(join(root, "agent-"));
  const workspace = mkdtempSync(join(root, "ws-"));
  writeFileSync(join(workspace, "README.md"), "# Test workspace\nUsed by integration tests.\n");
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  mock:",
      `    baseUrl: http://127.0.0.1:${mockPort}/v1`,
      "    api: openai-completions",
      "    apiKey: mock-key",
      "    models:",
      "      - id: mock-gpt-1",
      "        name: Mock GPT 1",
      "        reasoning: false",
      "        input: [text]",
      "        contextWindow: 128000",
      "        maxTokens: 8192",
      "        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }",
      "",
    ].join("\n"),
  );
  // Background tasks would outlive a print-mode run; run `task` inline instead.
  writeFileSync(join(agentDir, "config.yml"), "async:\n  enabled: false\n");
  return { home, agentDir, workspace };
}

/** Env vars from the developer's shell that must never leak into a run. */
const SCRUBBED_ENV = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_HOST",
  "LANGFUSE_USER_ID",
  "LANGFUSE_TRACING_ENVIRONMENT",
  "LANGFUSE_RELEASE",
  "LANGFUSE_TRACING_ENABLED",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "LANGFUSE_OMP_TRACEPARENT",
  "LANGFUSE_OMP_PARENT_TRACE_ID",
  "LANGFUSE_OMP_PARENT_SPAN_ID",
  "LANGFUSE_OMP_PARENT_SESSION_ID",
  "LANGFUSE_OMP_PARENT_DEPTH",
  "LANGFUSE_OMP_PARENT_EXTERNAL_TRACE",
  "PI_CODING_AGENT_DIR",
];

export interface OmpRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Async on purpose: the mock provider and capture server run inside the test
 * process, so a synchronous spawn would deadlock omp against its own backend.
 * omp awaits the extension's shutdown flush, so every export has reached the
 * capture server once this resolves.
 */
export function runOmp(
  sandbox: Sandbox,
  prompt: string,
  opts: { continue?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<OmpRun> {
  const args = ["--no-extensions", "-e", EXTENSION];
  args.push("--model", "mock/mock-gpt-1", "--no-lsp", "--no-title", "--no-skills", "--no-rules", "--auto-approve");
  if (opts.continue) args.push("-c");
  args.push("-p", prompt);

  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  Object.assign(env, { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir }, opts.env);

  const { promise, resolve } = Promise.withResolvers<OmpRun>();
  const child = spawn(OMP_BIN, args, { cwd: sandbox.workspace, stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  // Safety net for a hung omp, not a wait: runs normally finish in ~2s.
  const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  // A failed spawn emits "error" and then "close"; only "error" carries the cause.
  let settled = false;
  const finish = (status: number | null, spawnError = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    resolve({ status, stdout, stderr: stderr + spawnError });
  };
  child.on("error", (err) => finish(null, String(err)));
  child.on("close", (code) => finish(code));
  return promise;
}
