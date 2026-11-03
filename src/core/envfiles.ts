// Env files hold this machine's secrets. The VM gets its secrets from sadbox
// (Secrets), where they can be delivered as placeholders — so no copy of a
// folder into a VM (create, rebuild, push) ever carries one: `.env` and
// `.env.*` (.env.local, .env.production, …) at any depth, and anything under
// a directory of that name.
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?(\/|$)/;

/** Is this path (relative to the folder) an env file, or inside an `.env` directory? */
export const isEnvFile = (path: string) => ENV_FILE.test(path);
