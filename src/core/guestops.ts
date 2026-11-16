// Guest commands run while a VM is being provisioned. Right after boot the
// agent can miss a beat while update-ca-certificates and the proxy relay
// settle (seen on Intel/vz), so a step that is safe to repeat gets another
// chance instead of failing the whole create or rebuild.
import { getDriver } from "../driver";

/** Run an idempotent guest shell command. A timeout (124) or an unreachable
 *  agent (255) is tried twice more, a second apart. */
export async function repeatableGuestExec(
  ref: string,
  cmd: string,
  opts: { user?: string; stdin?: Uint8Array; timeoutMs?: number } = {},
) {
  const driver = getDriver();
  const { stdin, ...execOpts } = opts;
  for (let attempt = 1; ; attempt++) {
    const r = stdin != null
      ? await driver.execWithStdin(ref, cmd, stdin, execOpts)
      : await driver.exec(ref, ["sh", "-c", cmd], execOpts);
    if (r.exitCode === 0 || (r.exitCode !== 124 && r.exitCode !== 255) || attempt >= 3) return r;
    console.error(`⚠ ${ref}: the VM did not answer (exit ${r.exitCode}) — retrying (${attempt + 1}/3)`);
    await Bun.sleep(1000 * attempt);
  }
}
