// Live readings behind the project detail view. `container stats` takes a
// couple of seconds per call and the toolchain probe starts every agent once,
// so neither is run while the page waits: the view is refreshed every few
// seconds, and each refresh is handed the reading the previous one kicked off.
// Only the first look at a VM has to wait, and then only briefly — whatever is
// not ready by then is reported as pending and filled in by the next refresh.
import { config } from "../config";
import { getDriver } from "../driver";
import type { ProjectStats } from "../driver/types";
import { vmToolchain, type ToolInfo } from "./toolchain";

/** A status query that has not answered by now is stuck, not slow. */
export const QUERY_TIMEOUT_MS = 8_000;
/** How long a request waits for a reading it has no earlier copy of. */
const FIRST_WAIT_MS = 1_000;
/** Stats older than this are not shown as current. */
const STATS_MAX_AGE_MS = 30_000;
const TOOLCHAIN_TTL_MS = 5 * 60_000;

interface Sample { at: number; stats: ProjectStats }
interface Vitals {
  samples: Sample[];              // newest last, at most two (CPU % needs a pair)
  statsBusy: Promise<void> | null;
  tools: ToolInfo[] | null;
  toolsAt: number;
  toolsBusy: Promise<void> | null;
  toolsGen: number;              // a probe finishing after an update is stale
}

const vitals = new Map<string, Vitals>();
const of = (ref: string): Vitals => {
  let v = vitals.get(ref);
  if (!v) vitals.set(ref, v = { samples: [], statsBusy: null, tools: null, toolsAt: 0, toolsBusy: null, toolsGen: 0 });
  return v;
};

/** Drop what is known about a VM (it was destroyed or rebuilt). */
export function forgetVitals(ref: string): void {
  vitals.delete(ref);
  slows.delete(ref);
}

/** Split `key=value` lines (the guest probes print one per line). */
export function kv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// The expensive half of the detail view's guest probe — walking the whole
// workdir and running `git status` — is refreshed here, behind the request.
// On a big or busy repository it can outrun any sane timeout, and that used to
// make a perfectly healthy VM show as "not responding"; the status page now
// answers from the cheap probe and this fills in when it can.
const SLOW_TTL_MS = 15_000;
const SLOW_TIMEOUT_MS = 60_000;
const SLOW_PROBE = [
  `echo "workdir_bytes=$(du -sb ${config.guestWorkdir} 2>/dev/null | cut -f1)"`,
  `cd ${config.guestWorkdir} 2>/dev/null && echo "git_dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d \\ )"`,
  "true", // a missing repo must not make the probe look dead
].join("; ");

interface Slow { at: number; guest: Record<string, string>; busy: boolean }
const slows = new Map<string, Slow>();

/** The last expensive readings (empty until there is one). Never waits: the
 *  caller paints what it has and asks again on its next refresh. */
export function slowGuestProbe(ref: string): Record<string, string> {
  let s = slows.get(ref);
  if (!s) slows.set(ref, s = { at: 0, guest: {}, busy: false });
  if (!s.busy && Date.now() - s.at > SLOW_TTL_MS) {
    s.busy = true;
    getDriver().exec(ref, ["sh", "-c", SLOW_PROBE], { timeoutMs: SLOW_TIMEOUT_MS })
      .then((r) => { if (r.exitCode === 0) { s!.guest = kv(r.stdout); s!.at = Date.now(); } })
      .catch(() => {})
      .finally(() => { s!.busy = false; });
  }
  return s.guest;
}

/** Forget the cached tool versions after an in-VM update; the next detail
 *  refresh probes the VM again. A probe already in flight is ignored. */
export function forgetToolchain(ref: string): void {
  const v = vitals.get(ref);
  if (!v) return;
  v.tools = null;
  v.toolsAt = 0;
  v.toolsGen++;
}

/** Store freshly probed versions (after an update) without waiting for the
 *  detail view's next probe. */
export function setToolchain(ref: string, tools: ToolInfo[]): void {
  const v = of(ref);
  v.tools = tools;
  v.toolsAt = Date.now();
  v.toolsGen++;
}

const briefly = (p: Promise<void>, ms: number) => Promise.race([p, Bun.sleep(ms)]);

/** Share of the VM's CPUs in use between two samples, 0–100. */
export function cpuPercent(a: Sample, b: Sample, cpus: number): number | null {
  const wallUsec = (b.at - a.at) * 1000;
  if (a.stats.cpuUsageUsec == null || b.stats.cpuUsageUsec == null || !cpus || wallUsec < 200_000) return null;
  const used = b.stats.cpuUsageUsec - a.stats.cpuUsageUsec;
  return Math.max(0, Math.min(100, (used / (wallUsec * cpus)) * 100));
}

export interface LiveStats { stats: ProjectStats | null; cpuPercent: number | null; pending: boolean }

/** Latest resource usage of a running VM. Always starts a new sample (one at a
 *  time per VM) and answers with the most recent one there is. */
export async function liveStats(ref: string, cpus: number | undefined, firstWaitMs = FIRST_WAIT_MS): Promise<LiveStats> {
  const v = of(ref);
  if (!v.statsBusy) {
    const started = Date.now();
    v.statsBusy = getDriver().stats(ref, QUERY_TIMEOUT_MS).catch(() => null).then((stats) => {
      v.statsBusy = null;
      // stamped mid-flight: the CLI reads the counters partway through the call
      if (stats) v.samples = [...v.samples, { at: (started + Date.now()) / 2, stats }].slice(-2);
    });
  }
  const current = () => {
    const s = v.samples[v.samples.length - 1];
    return s && Date.now() - s.at < STATS_MAX_AGE_MS ? s : null;
  };
  if (!current() && v.statsBusy) await briefly(v.statsBusy, firstWaitMs);
  const last = current();
  const prev = v.samples.length === 2 ? v.samples[0]! : null;
  return {
    stats: last?.stats ?? null,
    cpuPercent: last && prev && last.at - prev.at < STATS_MAX_AGE_MS ? cpuPercent(prev, last, cpus ?? 0) : null,
    pending: !last && v.statsBusy != null,
  };
}

/** Agents and tools installed in a running VM. They change rarely, so the
 *  answer is kept for a few minutes and refreshed behind the scenes. */
export async function liveToolchain(ref: string, firstWaitMs = FIRST_WAIT_MS): Promise<{ tools: ToolInfo[] | null; pending: boolean }> {
  const v = of(ref);
  if (!v.toolsBusy && Date.now() - v.toolsAt > TOOLCHAIN_TTL_MS) {
    const gen = v.toolsGen;
    v.toolsBusy = vmToolchain(ref, QUERY_TIMEOUT_MS).catch(() => null).then((tools) => {
      v.toolsBusy = null;
      if (tools && gen === v.toolsGen) { v.tools = tools; v.toolsAt = Date.now(); }
    });
  }
  if (!v.tools && v.toolsBusy) await briefly(v.toolsBusy, firstWaitMs);
  return { tools: v.tools, pending: !v.tools && v.toolsBusy != null };
}
