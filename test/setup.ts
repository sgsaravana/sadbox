// Test preload: isolate state and stub the VM backend. Runs before any test
// file imports src/, so config/db pick these up instead of ~/.sadbox and the
// real `container` CLI.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "sadbox-test-"));

// Stub `container`: every VM "inspects" as running on loopback, so a port
// forward's guest side can be an ordinary local server, and `exec` runs the
// guest shell snippets on this machine against a scratch workdir.
const workdir = join(dir, "workdir");
mkdirSync(workdir);
const bin = join(dir, "container");
writeFileSync(bin, `#!/bin/sh
case "$1" in
  inspect) echo '[{"configuration":{"id":"'"$2"'"},"status":{"state":"running","networks":[{"ipv4Address":"127.0.0.1/24"}]}}]';;
  list) echo '[]';;
  # exec [-i] [-u user] <ref> sh -c <script>: run the script here, with the
  # guest workdir path swapped for a scratch dir standing in for the VM's disk.
  # The scratch path is baked in (a spawned child does not see env set by this
  # preload) and the script must mention the workdir, so a snippet can never
  # run against wherever the test happened to be started from.
  exec) for last; do :; done
        case "$last" in *"/home/agent/workdir"*) ;; *) echo "stub: script does not target the workdir" >&2; exit 97;; esac
        cd "${workdir}" || exit 98
        exec sh -c "$(printf %s "$last" | sed "s#/home/agent/workdir#${workdir}#g")";;
  *) exit 1;;
esac
`);
chmodSync(bin, 0o755);

process.env.SADBOX_TEST_WORKDIR = workdir; // for the tests themselves, to seed and inspect it
process.env.SADBOX_DATA = join(dir, "data");
process.env.SADBOX_CONTAINER_BIN = bin;
process.env.SADBOX_FORWARD_HOST = "127.0.0.1";

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
