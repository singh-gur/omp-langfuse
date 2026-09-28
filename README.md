# omp-langfuse

An [omp](https://omp.sh) extension that sends your coding-agent sessions to
[Langfuse](https://langfuse.com): every prompt, model call, tool call and
subagent, with token usage, cost and timing.

Adapted from Langfuse's official
[pi observability plugin](https://github.com/langfuse/pi-observability-plugin)
and reworked for omp's runtime (in-process subagents, shared exporter, omp
event model).

## What gets traced

Each user prompt becomes one Langfuse **trace**. All prompts of an omp session
share one Langfuse **session**, so a whole conversation is grouped together,
including after `omp --continue` or a restart.

```text
OMP Turn (trace)
└── Conversational Turn            agent   prompt in, final answer out
    ├── LLM Call                   generation
    ├── Tool: bash                 tool
    ├── LLM Call                   generation
    ├── Tool: task                 tool
    │   └── Subagent Turn          agent   the subagent's own prompt
    │       ├── LLM Call           generation
    │       └── Tool: yield        tool
    ├── User Message               event   steering message sent mid-run
    ├── Compaction                 span    context compaction summary
    └── LLM Call                   generation
```

| Observation | Contents |
| --- | --- |
| **Conversational Turn** | The prompt (with attached images uploaded as Langfuse media), the final assistant text, the effective system prompt, turn number, cwd, git branch, model, agent id. `ERROR` level if a tool or model call failed; `cancelled` metadata if the turn was interrupted. |
| **LLM Call** | Full conversation the model received (system prompt, history, tool results, active tool definitions), output text, reasoning/thinking blocks, tool calls, model parameters actually sent (max tokens, thinking level/budget, temperature, service tier, cache retention…), usage and cost, time to first token, stop reason, response id. |
| **Tool: &lt;name&gt;** | Arguments, output text, `ERROR` level on failure, the tool-call intent when omp provides one. |
| **Subagent Turn** | A `task` or eval `agent()` subagent, nested under the tool call that spawned it, in the parent's trace and session. |
| **User Message** | A steering / follow-up message delivered while the agent was still running. |
| **Compaction** / **Branch Summary** | The summary text, token counts before/after, compaction method. Recorded inside the live turn, or as a trace of its own when idle. |

### Usage and cost

Token usage is mapped to Langfuse's canonical keys so every token is counted
exactly once:

| omp usage | Langfuse usage key |
| --- | --- |
| input (non-cached) | `input` |
| output minus reasoning | `output` |
| reasoning tokens | `output_reasoning_tokens` |
| cache reads | `cache_read_input_tokens` |
| cache writes | `cache_creation_input_tokens` |

Cost uses the same keys, taken from omp's own pricing for the model. When omp
has no price for a model, no cost is sent and Langfuse's server-side model
pricing applies instead.

## Requirements

- omp (tested with 18.4.2)
- A Langfuse project (Cloud or self-hosted) and its public/secret API keys

## Installation

Pick one of the options below. All of them load `src/index.ts` through the
`omp.extensions` entry in `package.json`; there is no build step.

### Option 1: install from a local checkout (recommended for now)

```bash
git clone <this-repo-url> omp-langfuse
cd omp-langfuse
pnpm install          # the extension needs its runtime dependencies on disk
omp plugin install "$PWD"
```

`omp plugin install` with a local path symlinks the checkout into
`~/.omp/plugins/node_modules`, so pulling new commits takes effect on the next
omp start. `just link` does the same (`omp plugin link`).

### Option 2: install from git

```bash
omp plugin install git+https://<host>/<owner>/omp-langfuse.git
# or a shorthand such as: omp plugin install github:<owner>/omp-langfuse
```

omp runs `bun install` in `~/.omp/plugins`, which also installs the extension's
dependencies.

### Option 3: try it for a single run

```bash
omp -e /absolute/path/to/omp-langfuse/src/index.ts
# or, from the checkout:
just try
```

Nothing is installed; the extension is only active for that omp process. Run
`pnpm install` in the checkout first.

### Check that it loaded

```bash
omp plugin list
```

In the interactive TUI the status line shows:

| Status | Meaning |
| --- | --- |
| `langfuse ✓` | Credentials found, tracing is on. |
| `langfuse ✓ (trace sent)` | The last turn was exported. |
| `langfuse: off (no keys)` | No credentials, or tracing is switched off (see below). |

## Configuration

### Credentials

Either create `~/.omp/agent/langfuse.json`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "userId": "your-name",
  "environment": "development",
  "release": "v1"
}
```

Only `publicKey` and `secretKey` are required. The file holds a secret, so keep
it private (`chmod 600 ~/.omp/agent/langfuse.json`). With
`omp --profile <name>` or `PI_CODING_AGENT_DIR`, the file is read from that
profile's agent directory instead.

Or set environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
```

Environment variables take precedence over the file, field by field, so you can
keep keys in the file and override, say, the environment per shell.

### All settings

| Variable | `langfuse.json` field | Description | Default |
| --- | --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` | `publicKey` | Public key (`pk-lf-...`). Required. | |
| `LANGFUSE_SECRET_KEY` | `secretKey` | Secret key (`sk-lf-...`). Required. | |
| `LANGFUSE_BASE_URL` (alias `LANGFUSE_HOST`) | `baseUrl` | Langfuse host. EU `https://cloud.langfuse.com`, US `https://us.cloud.langfuse.com`, JP `https://jp.cloud.langfuse.com`, HIPAA `https://hipaa.cloud.langfuse.com`, or your self-hosted URL. | EU cloud |
| `LANGFUSE_USER_ID` | `userId` | User id on every trace, to filter by teammate. | none |
| `LANGFUSE_TRACING_ENVIRONMENT` | `environment` | Environment label (e.g. `production`). | none |
| `LANGFUSE_RELEASE` | `release` | Release/version label. | none |
| `LANGFUSE_TRACING_ENABLED` | | `false` turns tracing off (see below). | on |
| `LANGFUSE_MEDIA_UPLOAD_ENABLED` | | `false` stops uploading prompt/tool images as Langfuse media; images are then shown as `[image image/png ~12KB]` markers only. | on |
| `OTEL_SERVICE_NAME` | | OpenTelemetry service name of the exported spans. | OTel default |
| `OTEL_RESOURCE_ATTRIBUTES` | | Extra resource attributes, `key=value,key2=value2`; shown under `resourceAttributes` in Langfuse. | none |

## Turning tracing off

| Scope | How |
| --- | --- |
| One run | `LANGFUSE_TRACING_ENABLED=false omp` |
| Current shell | `export LANGFUSE_TRACING_ENABLED=false` (undo with `unset`) |
| Everywhere, keep installed | `omp plugin disable omp-langfuse` (re-enable with `omp plugin enable omp-langfuse`) |
| Uninstall | `omp plugin uninstall omp-langfuse` |

The kill switch wins over both environment keys and the config file. To delete
stored keys, remove `~/.omp/agent/langfuse.json`.

## Subagents and nested traces

- **In-process subagents** (`task` tool, eval `agent()`, `/tan` clones) are
  traced by the same extension instance and nest under the tool call that
  spawned them. When several spawning tool calls run in parallel, subagents
  nest under the turn itself. Background (async) subagents that finish after
  the parent turn has ended get their own trace in the parent's session.
- **Child omp processes**: while a main-session turn is running, the extension
  exports its span context in `LANGFUSE_OMP_PARENT_*` environment variables,
  so an `omp -p ...` started from inside the session (for example through the
  bash tool) nests under that turn. Nothing to configure.
- **Attaching to your own trace**: set `LANGFUSE_OMP_TRACEPARENT` to a
  [W3C traceparent](https://www.w3.org/TR/trace-context/#traceparent-header)
  (`00-<32 hex trace id>-<16 hex span id>-01`) to put every turn under a span of
  your application, e.g. a CI job or an eval harness. The trace then belongs to
  your application: the extension does not set the trace name, session or user.
  A malformed value is ignored with a warning in the omp log.

## Privacy and security

- Langfuse keys (`pk-lf-…`, `sk-lf-…`) and the configured key values are
  redacted from every exported field, including prompts, tool arguments and
  outputs, and the system prompt.
- Everything else is sent as-is: prompts, model outputs, reasoning, tool
  arguments and tool outputs (file contents, command output). Do not enable the
  extension on sessions whose content must not leave your machine, or point it
  at a self-hosted Langfuse.
- Inline base64 data in tool arguments and history is replaced with size
  markers; only images attached to prompts or returned by tools are uploaded as
  media.

## Troubleshooting

- **Nothing shows up**: check the status line; `langfuse: off (no keys)` means
  no credentials were found or `LANGFUSE_TRACING_ENABLED=false` is set. Check
  `LANGFUSE_BASE_URL` matches your project's region.
- **Logs**: the extension never writes to the terminal. Warnings (unreadable
  `langfuse.json`, failed or timed-out exports, malformed traceparent) go to
  omp's log file:

  ```bash
  grep omp-langfuse ~/.omp/logs/omp.$(date +%F).*.log
  ```

- **Traces appear late**: spans are flushed when a turn ends (bounded to 3 s,
  up to 15 s at exit when images are uploading). A slow network never blocks
  omp; unflushed spans are exported in the background.
- **Plugin did not load**: run `omp plugin doctor`, and make sure
  `pnpm install` was run in a linked checkout.

## Development

```bash
pnpm install
just             # list tasks
just typecheck   # tsc --noEmit
just test-unit   # unit tests, no omp needed
just test        # unit + end-to-end tests
```

The end-to-end tests run the real `omp` binary from your `PATH` (override with
`OMP_BIN=/path/to/omp`) against a mock OpenAI-compatible model and a fake
Langfuse ingest server, in a throwaway `HOME`/agent directory. Your own
`~/.omp` is never touched and no network access is needed.

Source layout:

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension factory: omp event handlers → Langfuse observations. |
| `src/config.ts` | Credential loading (env vars, `langfuse.json`, kill switch). |
| `src/payload.ts` | Pure conversions: redaction, ChatML history, usage/cost, model parameters, images. |
| `src/runtime.ts` | Process-wide exporter, trace-field registry, subagent registry, flush/shutdown. |
| `src/propagation.ts` | Cross-process trace propagation via environment variables. |

`@oh-my-pi/pi-coding-agent` is a dev dependency used only for its type
declarations; at runtime omp provides the extension API.

## License

[MIT](./LICENSE). Portions adapted from
[langfuse/pi-observability-plugin](https://github.com/langfuse/pi-observability-plugin),
© Langfuse GmbH.
