import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "langfuse.json";
export const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  userId?: string;
  environment?: string;
  release?: string;
}

type Env = Record<string, string | undefined>;
type ConfigFileFields = Partial<Record<keyof LangfuseConfig, unknown>>;

/** `LANGFUSE_TRACING_ENABLED=false` wins over env keys and the config file. */
export function isTracingDisabled(env: Env): boolean {
  return (env.LANGFUSE_TRACING_ENABLED ?? "").trim().toLowerCase() === "false";
}

/**
 * Resolve credentials from the environment first, then from
 * `<agentDir>/langfuse.json`. Returns undefined when tracing is switched off
 * or either key is missing.
 */
export function loadConfig(
  agentDir: string,
  env: Env = process.env,
  warn: (message: string) => void = () => {},
): LangfuseConfig | undefined {
  if (isTracingDisabled(env)) return undefined;
  const file = readConfigFile(join(agentDir, CONFIG_FILE_NAME), warn);
  const fromEnv = (key: string): string | undefined => env[key]?.trim() || undefined;

  const publicKey = fromEnv("LANGFUSE_PUBLIC_KEY") ?? trimmedString(file.publicKey);
  const secretKey = fromEnv("LANGFUSE_SECRET_KEY") ?? trimmedString(file.secretKey);
  if (!publicKey || !secretKey) return undefined;
  const baseUrl =
    fromEnv("LANGFUSE_BASE_URL") ?? fromEnv("LANGFUSE_HOST") ?? trimmedString(file.baseUrl) ?? DEFAULT_BASE_URL;
  return {
    publicKey,
    secretKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    userId: fromEnv("LANGFUSE_USER_ID") ?? trimmedString(file.userId),
    environment: fromEnv("LANGFUSE_TRACING_ENVIRONMENT") ?? trimmedString(file.environment),
    release: fromEnv("LANGFUSE_RELEASE") ?? trimmedString(file.release),
  };
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConfigFile(path: string, warn: (message: string) => void): ConfigFileFields {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    warn(`Ignoring unreadable ${CONFIG_FILE_NAME}: ${String(error)}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    warn(`Ignoring ${CONFIG_FILE_NAME}: expected a JSON object`);
  } catch (error) {
    warn(`Ignoring malformed ${CONFIG_FILE_NAME}: ${String(error)}`);
  }
  return {};
}
