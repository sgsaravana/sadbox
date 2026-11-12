// How sadbox finds BuildKit: builds go through `docker buildx build`, and a
// docker without the buildx plugin is reported with the fix rather than as a
// legacy builder rejecting `--progress`.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerBuildArgs, dockerStatus } from "./docker";

const tmp = mkdtempSync("/tmp/sbdocker-");
const saved = process.env.SADBOX_DOCKER_BIN;

function fake(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

afterAll(() => {
  if (saved === undefined) delete process.env.SADBOX_DOCKER_BIN;
  else process.env.SADBOX_DOCKER_BIN = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("docker and BuildKit", () => {
  test("with the buildx plugin, a build names buildx and plain progress", async () => {
    const bin = fake("with-buildx", `#!/bin/sh
[ "$1" = buildx ] && [ "$2" = version ] && { echo "github.com/docker/buildx v0.1"; exit 0; }
exit 1
`);
    process.env.SADBOX_DOCKER_BIN = bin;
    expect(await dockerStatus()).toEqual({ ok: true });
    expect(await dockerBuildArgs(["-t", "x", "."])).toEqual([bin, "buildx", "build", "--progress", "plain", "-t", "x", "."]);
  });

  test("without buildx, the status says how to install it and builds refuse", async () => {
    process.env.SADBOX_DOCKER_BIN = fake("no-buildx", `#!/bin/sh
echo "docker: 'buildx' is not a docker command." >&2
exit 1
`);
    const s = await dockerStatus();
    expect(s.ok).toBe(false);
    expect(s.error).toContain("BuildKit");
    expect(s.fix).toContain("brew install docker-buildx");
    await expect(dockerBuildArgs(["."])).rejects.toThrow(/docker-buildx/);
  });

  test("a docker that does not exist is named", async () => {
    process.env.SADBOX_DOCKER_BIN = join(tmp, "missing");
    const s = await dockerStatus();
    expect(s.ok).toBe(false);
    expect(s.error).toContain("docker was not found");
  });
});
