import { db } from "../db";

export interface Settings {
  defaultCpus: number;
  defaultMemoryMB: number;
  defaultDiskGB: number;   // sized volume mounted at the project workdir
}

const DEFAULTS: Settings = { defaultCpus: 4, defaultMemoryMB: 1024, defaultDiskGB: 10 };
const LIMITS = { cpus: [1, 16], memoryMB: [256, 65536], diskGB: [1, 500] };

export function getSettings(): Settings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    defaultCpus: Number(map.defaultCpus ?? DEFAULTS.defaultCpus),
    defaultMemoryMB: Number(map.defaultMemoryMB ?? DEFAULTS.defaultMemoryMB),
    defaultDiskGB: Number(map.defaultDiskGB ?? DEFAULTS.defaultDiskGB),
  };
}

function clampInt(v: unknown, [lo, hi]: number[], fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  const next: Settings = {
    defaultCpus: patch.defaultCpus != null ? clampInt(patch.defaultCpus, LIMITS.cpus, cur.defaultCpus) : cur.defaultCpus,
    defaultMemoryMB: patch.defaultMemoryMB != null ? clampInt(patch.defaultMemoryMB, LIMITS.memoryMB, cur.defaultMemoryMB) : cur.defaultMemoryMB,
    defaultDiskGB: patch.defaultDiskGB != null ? clampInt(patch.defaultDiskGB, LIMITS.diskGB, cur.defaultDiskGB) : cur.defaultDiskGB,
  };
  const up = db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  up.run("defaultCpus", String(next.defaultCpus));
  up.run("defaultMemoryMB", String(next.defaultMemoryMB));
  up.run("defaultDiskGB", String(next.defaultDiskGB));
  return next;
}

export const settingsLimits = LIMITS;
