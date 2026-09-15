import { join } from "path";
import { homedir } from "os";

export const VERSION = "0.1.0";

export const config = {
  port: Number(process.env.SADBOX_PORT ?? 7070),
  // localhost by default (no auth yet) — set SADBOX_HOST=0.0.0.0 to expose
  host: process.env.SADBOX_HOST ?? "localhost",
  // per-user state dir — works the same for a repo checkout or an installed binary
  dataDir: process.env.SADBOX_DATA ?? join(homedir(), ".sadbox"),
  // built by `sadbox setup`; falls back to the spike image in a dev checkout
  workerImage: process.env.SADBOX_WORKER_IMAGE ?? "sadbox-worker:latest",
  workerImageFallback: "sadbox-worker:spike-b",
  containerBin: process.env.SADBOX_CONTAINER_BIN ?? "container",
  guestUser: "agent",
  guestHome: "/home/agent",
  guestWorkdir: "/home/agent/workdir",
  guestSecretsFile: "/home/agent/.sadbox/env",
  tmuxSession: "main",
};

export const dbPath = () => join(config.dataDir, "sadbox.db");
export const keyPath = () => join(config.dataDir, "master.key");
