/** The environment variables a client reads for settings it was not given. */
export const ENV = {
  apiKey: "HANZO_API_KEY",
  baseURL: "HANZO_BASE_URL",
  model: "KAI_MODEL",
  logLevel: "KAI_LOG_LEVEL",
} as const;

export type EnvVar = (typeof ENV)[keyof typeof ENV];

/** The variable's trimmed value; undefined when unset, blank, or unreadable in this runtime. */
export function env(name: EnvVar): string | undefined {
  try {
    const process = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return process?.env?.[name]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
