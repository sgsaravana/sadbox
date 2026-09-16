import { join } from "path";
import { homedir } from "os";

export const VERSION = "0.1.0";

export const config = {
  port: Number(process.env.SADBOX_PORT ?? 7070),
  // localhost by default (no auth yet) — set SADBOX_HOST=0.0.0.0 to expose
  host: process.env.SADBOX_HOST ?? "localhost",
  // per-user state dir — works the same for a repo checkout or an installed binary
  dataDir: process.env.SADBOX_DATA ?? join(homedir(), ".sadbox"),
  // base image every project VM boots from; built by `sadbox setup`.
  // fallbacks keep older dev checkouts working until they rebuild.
  baseImage: process.env.SADBOX_BASE_IMAGE ?? "sadbox-base:latest",
  baseImageFallbacks: ["sadbox-worker:latest", "sadbox-worker:spike-b"],
  containerBin: process.env.SADBOX_CONTAINER_BIN ?? "container",
  guestUser: "agent",
  guestHome: "/home/agent",
  guestWorkdir: "/home/agent/workdir",
  guestSecretsFile: "/home/agent/.sadbox/env",
  tmuxSession: "main",
};

export const dbPath = () => join(config.dataDir, "sadbox.db");
export const keyPath = () => join(config.dataDir, "master.key");
