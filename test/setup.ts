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
const guestTools = join(dir, "guest-tools"); // stands in for /usr/local/lib/sadbox in the VM
const statsLog = join(dir, "stats.log");
const containerData = join(dir, "container-data"); // the runtime's own files, per VM
const bin = join(dir, "container");
writeFileSync(bin, `#!/bin/sh
case "$1" in
  inspect) if [ -e "${dir}/stopped-$2" ]; then st=stopped; else st=running; fi
           echo '[{"configuration":{"id":"'"$2"'"},"status":{"state":"'"$st"'","networks":[{"ipv4Address":"127.0.0.1/24"}]}}]';;
  # stop [--time N] <ref> / start <ref>: remembered in a marker file
  stop) for last; do :; done; : > "${dir}/stopped-$last";;
  start) rm -f "${dir}/stopped-$2";;
  kill) exit 0;;
  list) echo '[]';;
  # stats --no-stream --format json <ref>: slow like the real one, and logged so
  # a test can count calls. A ref containing "stuck" never answers.
  stats) echo "$5" >> "${statsLog}"
         case "$5" in *stuck*) exec sleep 30;; esac
         sleep 0.5
         # the limit is the VM's stored size, when a test gave it one
         limit=$(sed -n 's/.*"memoryInBytes":\\([0-9]*\\).*/\\1/p' "${containerData}/containers/$5/runtime-configuration.json" 2>/dev/null)
         echo '[{"cpuUsageUsec":'"$(date +%s)"'000000,"memoryUsageBytes":1048576,"memoryLimitBytes":'"\${limit:-4194304}"',"numProcesses":7}]';;
  # exec [-i] [-u user] <ref> sh -c <script>: run the script here, with the
  # guest workdir path swapped for a scratch dir standing in for the VM's disk.
  # The scratch path is baked in (a spawned child does not see env set by this
  # preload) and the script must mention the workdir, so a snippet can never
  # run against wherever the test happened to be started from.
  exec) case " $* " in *" sadbox-stuck "*) exec sleep 30;; esac # a VM that never answers
        for last; do :; done
        case "$last" in *"/home/agent/workdir"*|*"/usr/local/lib/sadbox"*) ;; *) echo "stub: script does not target the workdir or the guest tools" >&2; exit 97;; esac
        cd "${workdir}" || exit 98
        # tmux is stubbed out: the snippets must never reach a tmux on this machine
        exec sh -c "tmux() { :; }; $(printf %s "$last" | sed -e "s#/home/agent/workdir#${workdir}#g" -e "s#/usr/local/lib/sadbox#${guestTools}#g" -e "s#/home/agent/.bun/bin/bun#${process.execPath}#g")";;
  *) exit 1;;
esac
`);
chmodSync(bin, 0o755);

process.env.SADBOX_TEST_WORKDIR = workdir; // for the tests themselves, to seed and inspect it
process.env.SADBOX_TEST_STATS_LOG = statsLog;
process.env.SADBOX_DATA = join(dir, "data");
process.env.SADBOX_CONTAINER_BIN = bin;
process.env.SADBOX_CONTAINER_DATA = containerData;
process.env.SADBOX_FORWARD_HOST = "127.0.0.1";

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
