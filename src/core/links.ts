// Find the links currently on a project's terminal, so they can be opened or
// copied without selecting text. Selecting a long URL in the browser terminal
// is unreliable: tmux has the mouse, and a URL that a full-screen program (an
// agent's login screen, say) wraps over several rows comes out of a selection
// with line breaks, indentation and box-drawing characters in the middle.
import { config } from "../config";
import { getDriver } from "../driver";
import { getProject, refFor } from "./projects";

const driver = getDriver();

// characters that end a URL on screen: whitespace, quotes/brackets that wrap
// one, and the box-drawing bars TUIs draw panels with
const STOP = `\\s<>"'\`│┃║|`;
const URL_RE = new RegExp(`https?://[^${STOP}]+`, "g");
const HEAD_RE = new RegExp(`^[^${STOP}]+`);
const EDGE = /[\s│┃║|]+$/;         // trailing padding + a panel's right border
const LEAD = /^[\s│┃║|]+/;         // a panel's left border + indentation
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

/** Pull URLs out of a screen capture. `width` is the pane width in columns: a
 *  URL that runs up to the right edge of its row is assumed to continue on the
 *  next row, and is stitched back together across the wrap. Newest (lowest on
 *  screen) first, no duplicates. */
export function extractLinks(text: string, width: number): string[] {
  const lines = text.split("\n");
  const body = lines.map((l) => l.replace(EDGE, ""));
  // Is row i filled to its right margin, so that text ending there probably
  // continues on the next row? Either it reaches the pane edge, or it sits in a
  // drawn panel and runs up to the panel's right border (at most a column or
  // two of padding before the bar).
  const BORDER = /[│┃║|]$/;
  const full = (i: number) => {
    const raw = lines[i].replace(/\s+$/, "");
    if (!BORDER.test(raw)) return raw.length >= width - 2;
    const inner = raw.slice(0, -1);
    return inner.length - inner.trimEnd().length <= 2;
  };
  const found: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (const m of body[i].matchAll(URL_RE)) {
      let url = m[0];
      const first = url;
      // reaches the end of this row's text, and the row is full: follow the wrap
      let endsRow = m.index! + url.length === body[i].length;
      for (let j = i + 1, prev = i; endsRow && j < lines.length; prev = j, j++) {
        const rest = body[j].replace(LEAD, "");
        const head = HEAD_RE.exec(rest)?.[0];
        if (!head || /^https?:\/\//.test(head)) break;
        const wholeRow = head.length === rest.length;
        // the row above must have been filled to its margin — or, failing that,
        // this row is one unbroken run ending in exactly the same column, which
        // is what consecutive rows of a wrapped URL look like
        if (!full(prev) && !(wholeRow && body[j].length === body[prev].length)) break;
        // a plain word that starts a sentence ("Paste the code…") is the text
        // after the URL, not more of it — the URL's last row just happened to
        // end at the margin
        if (!wholeRow && /^[A-Za-z]+$/.test(head)) break;
        url += head;
        endsRow = wholeRow;
      }
      // when stitched, offer the single-row reading too in case the guess is wrong
      // (pushed first: the list is reversed below, so the stitched one leads)
      for (const u of url === first ? [url] : [first, url]) {
        const clean = u.replace(TRAILING_PUNCT, "");
        if (clean.length > "https://".length) found.push(clean);
      }
    }
  }
  return [...new Set(found.reverse())].slice(0, 30);
}

/** Links on the active pane of the project's tmux session, recent history included. */
export async function terminalLinks(projectId: string): Promise<{ links: string[] }> {
  const p = getProject(projectId);
  if (!p || p.state === "destroyed") throw new Error("project not found");
  // -J rejoins rows that tmux itself wrapped (plain shell output); rows a
  // full-screen program wrapped are stitched by extractLinks
  const r = await driver.exec(refFor(p.name), ["sh", "-c",
    `tmux display-message -p -t ${config.tmuxSession} '#{pane_width}' && ` +
    `tmux capture-pane -p -J -t ${config.tmuxSession} -S -300`]);
  if (r.exitCode !== 0) throw new Error("could not read the terminal (is the VM running?)");
  const nl = r.stdout.indexOf("\n");
  const width = Number(r.stdout.slice(0, nl)) || 80;
  return { links: extractLinks(r.stdout.slice(nl + 1), width) };
}
