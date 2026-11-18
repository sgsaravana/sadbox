// Latest releases of the updatable agent tools, and the one-click update that
// runs inside a project's VM. The version checks happen on the host (no VM
// egress approval); the update itself runs where the tools live, so a proxy
// approval may appear in the project page while it runs.
import { VERSION, config } from "../config";
import { getDriver } from "../driver";
import { getProject, refFor, redactLog } from "./projects";
import { vmToolchain } from "./toolchain";
import { forgetToolchain, setToolchain } from "./vitals";

const driver = getDriver();

/** How long a tool update may take (a download + install). */
const TOOL_UPDATE_MS = 10 * 60_000;
/** Latest-version lookups are cheap; keep them for a few minutes. */
const LATEST_TTL_MS = 5 * 60_000;

export interface LatestTool {
  key: string;
  label: string;
  latest: string | null;
  error?: string;
}

type LatestSource =
  | { label: string; url: string; kind: "text" }
  | { label: string; url: string; kind: "json" };

const LATEST: Record<string, LatestSource> = {
  claude: { label: "Claude Code", url: "https://downloads.claude.ai/claude-code-releases/latest", kind: "text" },
  omp: { label: "omp", url: "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent/latest", kind: "json" },
  opencode: { label: "opencode", url: "https://registry.npmjs.org/opencode-ai/latest", kind: "json" },
  bun: { label: "Bun", url: "https://registry.npmjs.org/bun/latest", kind: "json" },
};

let latestCache: { at: number; data: LatestTool[] } | null = null;

/** Latest releases of the tools that can be updated in place. Each source is
 *  independent: one failing registry leaves the others' answers intact. */
export async function latestToolVersions(force = false): Promise<LatestTool[]> {
  if (!force && latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) return latestCache.data;
  const data = await Promise.all(Object.entries(LATEST).map(async ([key, src]) => {
    try {
      const r = await fetch(src.url, {
        headers: { "user-agent": `sadbox/${VERSION}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.text();
      const latest = src.kind === "json" ? String((JSON.parse(body) as { version?: unknown }).version ?? "").trim() : body.trim();
      if (!/^\d/.test(latest)) throw new Error(`unexpected version ${JSON.stringify(latest.slice(0, 40))}`);
      return { key, label: src.label, latest };
    } catch (e) {
      return { key, label: src.label, latest: null, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  latestCache = { at: Date.now(), data };
  return data;
}

const UPDATES: Record<string, { label: string; command: string }> = {
  claude: {
    label: "Claude Code",
    command: `if command -v claude >/dev/null 2>&1; then unset DISABLE_AUTOUPDATER; claude update; else curl -fsSL https://claude.ai/install.sh | bash; fi`,
  },
  omp: { label: "omp", command: "bun install -g @oh-my-pi/pi-coding-agent@latest" },
  opencode: { label: "opencode", command: "bun install -g opencode-ai@latest" },
  bun: { label: "Bun", command: "bun upgrade" },
};

const busy = new Set<string>(); // project ids with an update running

/** Update one agent tool inside its running VM, then probe the new versions.
 *  The VM's egress rules apply: the known hosts are allowed by default, and
 *  anything else waits for an approval on the project page. */
export async function updateTool(projectId: string, key: string): Promise<{ ok: true; tools: unknown }> {
  const spec = UPDATES[key];
  if (!spec) throw new Error(`unknown updatable tool: ${key}`);
  const p = getProject(projectId);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  const ref = refFor(p.name);
  if ((await driver.inspect(ref)).state !== "running") throw new Error("start the VM first — tools update inside it");
  if (busy.has(projectId)) throw new Error("a tool update is already running in this VM");
  busy.add(projectId);
  try {
    const env = `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; ` +
      `export CI=1 PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.nvm/current/bin:$PATH"; `;
    const r = await driver.exec(ref, ["sh", "-c", env + spec.command], { timeoutMs: TOOL_UPDATE_MS });
    if (r.exitCode !== 0) {
      const out = redactLog((r.stderr || r.stdout || "").trim()).slice(-2_000);
      throw new Error(`${spec.label} update failed (exit ${r.exitCode}): ${out || "no output"}`);
    }
    forgetToolchain(ref);
    const tools = await vmToolchain(ref, 15_000).catch(() => null);
    if (tools) setToolchain(ref, tools);
    return { ok: true, tools };
  } finally {
    busy.delete(projectId);
  }
}
