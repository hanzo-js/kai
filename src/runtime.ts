interface Globals {
  window?: { document?: unknown };
  navigator?: { userAgent?: string };
  process?: { versions?: { node?: string }; platform?: string; arch?: string };
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  EdgeRuntime?: unknown;
}

const g = globalThis as Globals;

/** Whether this is a browser page: a window with a document, and a navigator. */
export function browser(): boolean {
  return g.window?.document !== undefined && g.navigator !== undefined;
}

/** Runtime name, version and platform, as sent in X-Kai-Runtime. */
export function runtime(): string {
  const p = g.process;
  const os = p?.platform && p.arch ? ` (${p.platform}; ${p.arch})` : "";
  if (g.Bun?.version) return `bun/${g.Bun.version}${os}`;
  if (g.Deno?.version?.deno) return `deno/${g.Deno.version.deno}${os}`;
  if (g.EdgeRuntime !== undefined) return "edge-runtime";
  if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd";
  if (p?.versions?.node) return `node/${p.versions.node}${os}`;
  if (browser()) return "browser";
  return "unknown";
}
