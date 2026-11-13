// Optional apps: software a project may install on top of the base image. Kept
// out of the image so a VM only carries (and its disk only holds) what it needs.
// Chosen at create or installed later from the project's detail view; a Rebuild
// puts the chosen ones back.
import { config } from "../config";
import { getDriver } from "../driver";
import { LONG_TASK_MS } from "../driver/types";
import { duringSetup } from "../net/setup";

export interface OptionalApp {
  id: string;
  label: string;
  summary: string;
  note?: string;          // how to use it in a VM without a desktop
  packages: string[];     // apt packages installed as root
  binary: string;         // what "installed" means
  versionCmd: string;     // prints the version
  approxMB?: number;      // rough installed + download size, shown in the UI
}

/** Installed state, probed from the VM itself. */
export interface OptionalAppView extends OptionalApp {
  installed: boolean;
  version: string | null;
}

// Order = display order. Add an app here and it appears on the create form and
// every project's detail view; no other change is needed.
export const OPTIONAL_APPS: OptionalApp[] = [
  {
    id: "blender",
    label: "Blender",
    summary: "3D modelling, rendering, and video editing.",
    note: "The VM has no desktop: use it from the terminal, for example `blender -b scene.blend -f 1`.",
    packages: ["blender"],
    binary: "blender",
    versionCmd: "blender --version",
    approxMB: 800,
  },
];

const byId = new Map(OPTIONAL_APPS.map((a) => [a.id, a]));

export function optionalAppCatalog(): OptionalApp[] {
  return OPTIONAL_APPS;
}

/** One catalog app, or a clear error for an unknown id. */
export function optionalApp(id: unknown): OptionalApp {
  const app = byId.get(String(id ?? "").trim());
  if (!app) throw new Error(`unknown optional app: ${String(id ?? "")}`);
  return app;
}

/** Ids from a create request: known, lowercased, de-duplicated. Unknown ids
 *  are refused rather than silently dropped, so a typo is noticed. */
export function normalizeAppIds(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string" ? input.split(",") : [];
  const ids = raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`unknown optional app(s): ${[...new Set(unknown)].join(", ")}`);
  return [...new Set(ids)];
}

/** Ids stored on a project row, in catalog order. An id the catalog no longer
 *  has is dropped: a row from a newer/older build must not break a create. */
export function storedAppIds(json: string | null | undefined): string[] {
  let parsed: unknown = [];
  try { parsed = JSON.parse(json || "[]"); } catch {}
  const ids = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  return OPTIONAL_APPS.filter((a) => ids.has(a.id)).map((a) => a.id);
}

// --- guest probe ------------------------------------------------------------
// One line per app, folded into the project's existing guest probe (so the
// detail view learns what is installed without a second exec). The version
// comes from dpkg rather than the program itself: `blender --version` is fast
// but not free, and this runs on every detail refresh.
const probeKey = (id: string) => `app_${id.replace(/[^a-z0-9]/gi, "_")}`;

export function optionalAppProbe(): string {
  return OPTIONAL_APPS.map((a) =>
    `command -v ${a.binary} >/dev/null 2>&1 && echo "${probeKey(a.id)}=$(dpkg-query -W ${a.packages[0]} 2>/dev/null | cut -f2)"`,
  ).join("; ");
}

function cleanVersion(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  // Debian's "4.3.2+dfsg-2" → "4.3.2"; a plain "4.3.2" stays as it is
  return t.match(/\d+(?:\.\d+)+(?:[a-z]\d*)?/i)?.[0] ?? t.match(/\d+[\w.\-]*/)?.[0] ?? t;
}

/** The catalog with each app's state, from the project's guest probe. When the
 *  VM is not running there is nothing to probe, so `fallbackIds` (the choice
 *  recorded on the project) stands in for the installed list. */
export function optionalAppsFromGuest(
  guest: Record<string, string>,
  fallbackIds?: string[] | null,
): OptionalAppView[] {
  const fallback = fallbackIds ? new Set(fallbackIds) : null;
  return OPTIONAL_APPS.map((a) => {
    const raw = guest[probeKey(a.id)];
    return {
      ...a,
      installed: fallback ? fallback.has(a.id) : raw != null,
      version: raw ? cleanVersion(raw) : null,
    };
  });
}

// --- installing in a VM -----------------------------------------------------
const driver = getDriver();

function aptEnv(): string {
  return `[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}; ` +
    `export DEBIAN_FRONTEND=noninteractive; `;
}

function pkgList(app: OptionalApp): string {
  return app.packages.map((p) => p.replace(/[^a-zA-Z0-9.+_-]/g, "")).filter(Boolean).join(" ");
}

/** Install (or refresh) an app's packages as root. Network goes through the
 *  project's proxy, so callers open the provisioning window around it. */
export async function installAppInGuest(ref: string, app: OptionalApp): Promise<void> {
  const cmd = aptEnv() +
    `apt-get update -qq && apt-get install -y -qq --no-install-recommends ` +
    `-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ${pkgList(app)}`;
  const r = await driver.exec(ref, ["sh", "-c", cmd], { user: "root", timeoutMs: LONG_TASK_MS });
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().slice(-500);
    throw new Error(`${app.label} could not be installed${why ? `: ${why}` : ""}`);
  }
}

/** Remove an app's packages (the VM's disk keeps any dependencies they pulled,
 *  as apt leaves them for other packages). */
export async function removeAppFromGuest(ref: string, app: OptionalApp): Promise<void> {
  const r = await driver.exec(ref, ["sh", "-c", aptEnv() + `apt-get remove -y -qq ${pkgList(app)}`], {
    user: "root", timeoutMs: LONG_TASK_MS,
  });
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().slice(-500);
    throw new Error(`${app.label} could not be removed${why ? `: ${why}` : ""}`);
  }
}

/** The version the VM now has, or null if the binary is not there. */
export async function guestAppVersion(ref: string, app: OptionalApp): Promise<string | null> {
  const r = await driver.exec(ref, ["sh", "-c",
    `command -v ${app.binary} >/dev/null 2>&1 && ${app.versionCmd} 2>/dev/null | head -1`]);
  return r.exitCode === 0 ? cleanVersion(r.stdout) : null;
}

/** Install and record it in one call, for provisioning a new/rebuilt VM.
 *  Best effort: an offline registry must not fail the whole create. */
export async function provisionApp(
  projectId: string,
  ref: string,
  app: OptionalApp,
  log: (type: string, detail: string) => void,
): Promise<void> {
  log("app.install", `${app.label} — installing`);
  try {
    await duringSetup(projectId, () => installAppInGuest(ref, app));
    const version = await guestAppVersion(ref, app);
    log("app.installed", `${app.label}${version ? ` ${version}` : ""}`);
  } catch (e) {
    log("app.install.error", `${app.label}: ${e instanceof Error ? e.message : e}`);
  }
}
