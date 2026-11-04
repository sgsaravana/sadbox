// One-click network cutoff for a project VM. A VM has no network interface —
// the proxy is its only way out — so refusing everything here takes the VM
// fully offline: every request is refused before rules, approvals or
// credentials are looked at, and a CONNECT is refused before any TLS tunnel
// opens. Held approvals are denied at once. Kept in the projects row, so it
// survives restarts. A legacy VM still on the NAT network has its own route
// out and is not covered (the UI says so).
import { db, logEvent } from "../db";
import { clearProjectApprovals } from "./approvals";
import { publish } from "./events";

export const CUTOFF_MESSAGE = "network is cut off for this VM";

export function isCutOff(projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return db.query<{ net_cutoff: number }, [string]>(
    "SELECT net_cutoff FROM projects WHERE id = ?",
  ).get(projectId)?.net_cutoff === 1;
}

export function setCutoff(projectId: string, on: boolean): boolean {
  const n = db.query("UPDATE projects SET net_cutoff = ? WHERE id = ? AND state != 'destroyed' RETURNING id")
    .all(on ? 1 : 0, projectId).length;
  if (!n) throw new Error("project not found");
  logEvent(projectId, on ? "net.cutoff" : "net.restore", on ? "all egress refused" : "egress follows the rules again");
  if (on) clearProjectApprovals(projectId, "network cut off");
  publish(projectId, { type: "cutoff", on });
  return on;
}
