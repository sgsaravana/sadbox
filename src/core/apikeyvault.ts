// API keys an agent login put in the vault (core/logins.ts).
//
// An API key typed into omp or opencode used to be copied into every VM
// readable. For a provider this file knows, the key instead becomes a proxy
// vault item — the same mechanism as Claude's login: the VM holds a
// placeholder shaped like the key, and the proxy swaps the real key in only
// on requests to the provider's own hosts. The vault item also gives those
// hosts an allow rule, so the agent's own calls need no approval.
//
// A provider that is not listed here keeps the old copy-in behaviour: no
// guessing at hostnames (a wrong host would only produce 401s), and no vault
// item the user did not ask for.
import { logEvent } from "../db";
import { hostMatch } from "../net/rules";
import { existingPlaceholder, placeholderFor } from "./placeholders";
import {
  applyItem, createItem, getItem, itemValue, listItems, setItemProjects, updateItem, type ItemView,
} from "./vault";

export interface ProjectLike { id: string; name: string }

interface ProviderSpec {
  /** The env-var style item name, and what omp reads when the key is in env. */
  name: string;
  /** Where the key may be sent; also the item's bindings and allow rules. */
  hosts: string[];
}

// Provider ids are compared case- and punctuation-insensitively (omp's
// "google-gemini" and opencode's "google" are different ids on purpose).
const SPECS: Record<string, ProviderSpec> = {
  anthropic: { name: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  openai: { name: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
  deepseek: { name: "DEEPSEEK_API_KEY", hosts: ["api.deepseek.com"] },
  openrouter: { name: "OPENROUTER_API_KEY", hosts: ["openrouter.ai"] },
  groq: { name: "GROQ_API_KEY", hosts: ["api.groq.com"] },
  xai: { name: "XAI_API_KEY", hosts: ["api.x.ai"] },
  mistral: { name: "MISTRAL_API_KEY", hosts: ["api.mistral.ai"] },
  moonshot: { name: "MOONSHOT_API_KEY", hosts: ["api.moonshot.ai", "api.moonshot.cn"] },
  together: { name: "TOGETHER_API_KEY", hosts: ["api.together.xyz"] },
};

const norm = (provider: string) => provider.toLowerCase().replace(/[^a-z0-9]/g, "");
const BY_ID = new Map(Object.entries(SPECS).map(([id, spec]) => [norm(id), spec]));

const specFor = (provider: string): ProviderSpec | null => BY_ID.get(norm(provider)) ?? null;

/** True when this provider's captured key lives in the vault (and the item
 *  still exists). Used for the Agents page's "placeholders" badge. */
export function isVaultBacked(provider: string): boolean {
  const spec = specFor(provider);
  return !!spec && !!itemFor(spec);
}

/** The item sadbox keeps for a provider: same name, proxy mode, bound to one
 *  of its hosts. Prefers the one `projectId` already has. */
function itemFor(spec: ProviderSpec, projectId?: string): ItemView | null {
  const items = listItems().filter((i) =>
    i.name === spec.name && i.mode === "proxy" &&
    i.bindings.some((b) => spec.hosts.some((h) => hostMatch(b.host, h))));
  if (projectId) {
    const mine = items.find((i) => i.projectIds.includes(projectId));
    if (mine) return mine;
  }
  return items[0] ?? null;
}

/** Keep a captured API key in the vault as a proxy item, so VMs get a
 *  placeholder instead of the real key. Returns the item, or null when the
 *  provider is not mapped (the caller then keeps the copy-in behaviour) or an
 *  item the user owns stops it (a name clash, or a non-proxy item). */
export async function keepApiKeyInVault(
  p: ProjectLike, tool: string, provider: string, key: string,
): Promise<ItemView | null> {
  const spec = specFor(provider);
  if (!spec) return null;
  const existing = itemFor(spec, p.id);
  if (existing) {
    if (existing.kind !== "secret") return null; // a variable the user keeps, not ours
    try {
      if (!existing.projectIds.includes(p.id)) {
        await setItemProjects(existing.id, [...existing.projectIds, p.id]);
      }
      if (itemValue(existing.id) !== key) {
        await updateItem(existing.id, { value: key });
        logEvent(p.id, "vault.capture", `${spec.name}: ${tool} login kept in the vault (placeholders in VMs)`);
      }
      return getItem(existing.id);
    } catch (e) {
      logEvent(p.id, "vault.capture.error", `${spec.name}: ${(e as Error).message}`);
      return null;
    }
  }
  try {
    const item = createItem({
      name: spec.name,
      kind: "secret",
      type: "string",
      mode: "proxy",
      value: key,
      bindings: spec.hosts.map((host) => ({ host })),
      projectIds: [p.id],
      note: `${tool} login captured in ${p.name}`,
    });
    await applyItem(item.id); // this project's shells get the placeholder now
    logEvent(p.id, "vault.capture", `${spec.name}: ${tool} login kept in the vault (placeholders in VMs)`);
    return item;
  } catch (e) {
    // the name is taken by another item of theirs, or the project may not see it
    logEvent(p.id, "vault.capture.error", `${spec.name}: ${(e as Error).message}`);
    return null;
  }
}

/** This project's placeholder for a vault-backed login, or null when the
 *  login is not vault-backed. Adds the project to the item's access first, so
 *  the proxy may swap it there. */
export async function apiKeyPlaceholder(p: ProjectLike, provider: string): Promise<string | null> {
  const spec = specFor(provider);
  if (!spec) return null;
  const item = itemFor(spec, p.id);
  if (!item) return null;
  if (!item.projectIds.includes(p.id)) {
    try {
      await setItemProjects(item.id, [...item.projectIds, p.id]);
    } catch (e) {
      logEvent(p.id, "vault.capture.error", `${spec.name}: ${(e as Error).message}`);
      return null;
    }
  }
  return existingPlaceholder(p.id, item.id) ?? placeholderFor(p.id, item.id, itemValue(item.id));
}
