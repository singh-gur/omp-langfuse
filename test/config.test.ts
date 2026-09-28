import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "omp-lf-config-"));
after(() => rmSync(root, { recursive: true, force: true }));

function agentDirWith(file?: unknown): string {
  const dir = mkdtempSync(join(root, "agent-"));
  if (file !== undefined) {
    writeFileSync(join(dir, "langfuse.json"), typeof file === "string" ? file : JSON.stringify(file));
  }
  return dir;
}

describe("loadConfig", () => {
  it("is off without both keys", () => {
    assert.equal(loadConfig(agentDirWith(), {}), undefined);
    assert.equal(loadConfig(agentDirWith(), { LANGFUSE_PUBLIC_KEY: "pk-lf-1" }), undefined);
  });

  it("reads the agent-dir file with the EU cloud default", () => {
    assert.deepEqual(loadConfig(agentDirWith({ publicKey: "pk-lf-f", secretKey: "sk-lf-f", userId: "me" }), {}), {
      publicKey: "pk-lf-f",
      secretKey: "sk-lf-f",
      baseUrl: "https://cloud.langfuse.com",
      userId: "me",
      environment: undefined,
      release: undefined,
    });
  });

  it("lets each env var override its file field, with LANGFUSE_HOST as a base URL alias", () => {
    const dir = agentDirWith({ publicKey: "pk-lf-f", secretKey: "sk-lf-f", baseUrl: "https://file", environment: "dev" });
    const config = loadConfig(dir, { LANGFUSE_SECRET_KEY: "sk-lf-env", LANGFUSE_HOST: "https://us.cloud.langfuse.com/" });
    assert.equal(config?.publicKey, "pk-lf-f");
    assert.equal(config?.secretKey, "sk-lf-env");
    assert.equal(config?.baseUrl, "https://us.cloud.langfuse.com");
    assert.equal(config?.environment, "dev");
  });

  it("honors the kill switch over env keys and the file", () => {
    const dir = agentDirWith({ publicKey: "pk-lf-f", secretKey: "sk-lf-f" });
    assert.equal(
      loadConfig(dir, { LANGFUSE_TRACING_ENABLED: "FALSE", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }),
      undefined,
    );
  });

  it("warns about and ignores a malformed or non-object file", () => {
    for (const file of ["{not json", "[1,2]"]) {
      const warnings: string[] = [];
      const config = loadConfig(agentDirWith(file), { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }, (m) =>
        warnings.push(m),
      );
      assert.equal(config?.publicKey, "pk");
      assert.equal(warnings.length, 1);
    }
  });

  it("ignores blank and non-string file values", () => {
    assert.equal(loadConfig(agentDirWith({ publicKey: 42, secretKey: "  " }), {}), undefined);
  });
});
