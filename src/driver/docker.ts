// Docker, as sadbox builds with it: through BuildKit (`docker buildx build`).
// The recipes need what only BuildKit has — `-o type=local`, which writes a
// kernel or a disk to a folder, and `RUN --mount=type=bind,from=`, which the
// disk image uses to keep the image's filesystem as it is. Without the buildx
// plugin, `docker build` quietly falls back to the legacy builder and rejects
// those as `unknown flag: --progress`, so a machine without buildx gets told
// how to install it instead.
import type { ExecResult } from "./types";

export const dockerBin = () => process.env.SADBOX_DOCKER_BIN || "docker";

export interface DockerStatus {
  ok: boolean;
  error?: string;
  fix?: string;
}

/** Whether docker's BuildKit (the buildx plugin) is there to build with. */
export async function dockerStatus(): Promise<DockerStatus> {
  let r: ExecResult;
  try {
    const proc = Bun.spawn([dockerBin(), "buildx", "version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    r = { exitCode, stdout, stderr };
  } catch {
    return {
      ok: false,
      error: `docker was not found (${dockerBin()})`,
      fix: "install Docker — https://docs.docker.com/engine/install/",
    };
  }
  if (r.exitCode === 0) return { ok: true };
  const said = (r.stderr.trim() || r.stdout.trim()).split("\n")[0];
  return {
    ok: false,
    error: `docker has no BuildKit (the buildx plugin)${said ? `: ${said}` : ""}`,
    fix: "install it (`brew install docker-buildx` with colima or a Homebrew docker CLI, `docker-buildx-plugin` on Linux), " +
      "then add its plugin folder to cliPluginsExtraDirs in ~/.docker/config.json (the formula's notes name it) and " +
      "check that `docker buildx version` works — Docker Desktop ships it already",
  };
}

/** The command for a BuildKit build, or the fix when this machine has none. */
export async function dockerBuildArgs(args: string[]): Promise<string[]> {
  const s = await dockerStatus();
  if (!s.ok) throw new Error(`${s.error}${s.fix ? `\n  fix: ${s.fix}` : ""}`);
  return [dockerBin(), "buildx", "build", "--progress", "plain", ...args];
}
