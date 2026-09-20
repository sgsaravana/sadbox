// The agent/dev toolchain baked into the base image. Surfaced in the UI so an
// operator sees what a VM ships with (new-project form: the base image; detail
// view: probed from the actual VM, so an older VM correctly shows what it lacks).
import { config } from "../config";
import { getDriver } from "../driver";

export interface ToolInfo {
  key: string;
  label: string;
  version: string | null; // null ⇒ not installed in this VM/image
}

// order = display order; `cmd` is the version invocation run in the guest
const TOOLS: { key: string; label: string; cmd: string }[] = [
  { key: "claude",   label: "Claude Code", cmd: "claude --version" },
  { key: "omp",      label: "omp",         cmd: "omp --version" },
  { key: "opencode", label: "opencode",    cmd: "opencode --version" },
  { key: "bun",      label: "Bun",         cmd: "bun --version" },
  { key: "git",      label: "git",         cmd: "git --version" },
  { key: "rg",       label: "ripgrep",     cmd: "rg --version" },
  { key: "jq",       label: "jq",          cmd: "jq --version" },
  { key: "tmux",     label: "tmux",        cmd: "tmux -V" },
];

// A POSIX-sh script that prints "<key>\t<first line of version output>" for
// each tool. PATH is set explicitly (the agents live in ~/.local/bin and
// ~/.bun/bin) so this works under a plain `sh -c`, not just a login shell.
function probeScript(): string {
  const lines = TOOLS.map((t) => {
    const bin = t.cmd.split(" ")[0];
    return `command -v ${bin} >/dev/null 2>&1 && printf '${t.key}\\t%s\\n' "$(${t.cmd} 2>/dev/null | head -1)"`;
  });
  return `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n${lines.join("\n")}`;
}

// Pull a clean version token out of a tool's raw `--version` line, e.g.
// "git version 2.47.3" → "2.47.3", "omp/18.2.0" → "18.2.0", "tmux 3.5a" → "3.5a".
function cleanVersion(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return t.match(/\d+[\w.\-]*/)?.[0] ?? t;
}

/** Parse the probe stdout into the canonical tool list (order preserved,
 *  tools not printed by the guest reported as version:null). */
export function parseToolchain(stdout: string): ToolInfo[] {
  const found = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) found.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
  }
  return TOOLS.map((t) => ({
    key: t.key,
    label: t.label,
    version: found.has(t.key) ? cleanVersion(found.get(t.key)!) : null,
  }));
}

/** Probe the toolchain inside a running VM. */
export async function vmToolchain(ref: string): Promise<ToolInfo[]> {
  const driver = getDriver();
  const r = await driver.exec(ref, ["sh", "-c", probeScript()]);
  return parseToolchain(r.stdout);
}

// --- base-image toolchain (for the new-project form) ------------------------
// Probed once via an ephemeral `container run`, then cached by image ref for a
// short TTL (the base image only changes on `sadbox setup`).
const CACHE_TTL_MS = 10 * 60_000;
let cache: { image: string; at: number; tools: ToolInfo[] } | null = null;

async function imageExists(image: string): Promise<boolean> {
  return (await Bun.spawn([config.containerBin, "image", "inspect", image], {
    stdout: "ignore", stderr: "ignore",
  }).exited) === 0;
}

/** The image a new project would boot from (base image, or a fallback for
 *  dev checkouts that haven't rebuilt yet). Mirrors projects.resolveImage. */
async function resolveBaseImage(): Promise<string> {
  for (const img of [config.baseImage, ...config.baseImageFallbacks]) {
    if (await imageExists(img)) return img;
  }
  return config.baseImage;
}

/** Toolchain baked into the image new projects use. Cached; pass force to
 *  re-probe (e.g. after rebuilding the base image without restarting). */
export async function baseImageToolchain(force = false): Promise<{ image: string; tools: ToolInfo[] }> {
  const image = await resolveBaseImage();
  if (!force && cache && cache.image === image && Date.now() - cache.at < CACHE_TTL_MS) {
    return { image, tools: cache.tools };
  }
  const proc = Bun.spawn(
    [config.containerBin, "run", "--rm", image, "sh", "-c", probeScript()],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`could not probe base image ${image}`);
  const tools = parseToolchain(out);
  cache = { image, at: Date.now(), tools };
  return { image, tools };
}
