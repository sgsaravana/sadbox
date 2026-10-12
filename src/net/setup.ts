// Provisioning window: while the supervisor itself is setting a VM up (cloning
// the repo, installing extra packages) there is nobody watching the approval
// prompt, so requests that would otherwise be held are let through. Explicit
// block rules still apply, and everything is still logged. The window is opened
// and closed by the supervisor, never by anything inside the VM.
const active = new Map<string, number>(); // projectId -> open windows

export const inSetup = (projectId: string) => active.has(projectId);

/** Run `fn` with the project's provisioning window open. */
export async function duringSetup<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  active.set(projectId, (active.get(projectId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (active.get(projectId) ?? 1) - 1;
    if (n > 0) active.set(projectId, n); else active.delete(projectId);
  }
}
