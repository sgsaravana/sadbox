// @ts-nocheck — `with { type: "file" }` imports resolve to path strings at
// runtime, but TS's ambient loaders type them otherwise; verified by running
// the compiled binary, not the type-checker.
// Static assets embedded into the compiled binary.
// `with { type: "file" }` keeps each file raw and, under `bun build --compile`,
// bundles it into the executable — the import resolves to a path Bun.file() can
// read both in dev (real path on disk) and in the single-binary build.
import indexHtml from "../web/index.html" with { type: "file" };
import terminalHtml from "../web/terminal.html" with { type: "file" };
import appJs from "../web/app.js" with { type: "file" };
import styleCss from "../web/style.css" with { type: "file" };
import xtermJs from "../node_modules/@xterm/xterm/lib/xterm.js" with { type: "file" };
import xtermCss from "../node_modules/@xterm/xterm/css/xterm.css" with { type: "file" };
import addonFitJs from "../node_modules/@xterm/addon-fit/lib/addon-fit.js" with { type: "file" };
import baseDockerfile from "../images/base/Dockerfile" with { type: "file" };
import baseTmuxConf from "../images/base/tmux.conf" with { type: "file" };

// route path -> [embedded file path, content-type]
export const staticRoutes: Record<string, [string, string]> = {
  "/": [indexHtml, "text/html; charset=utf-8"],
  "/terminal": [terminalHtml, "text/html; charset=utf-8"],
  "/app.js": [appJs, "text/javascript"],
  "/style.css": [styleCss, "text/css"],
  "/vendor/xterm.js": [xtermJs, "text/javascript"],
  "/vendor/xterm.css": [xtermCss, "text/css"],
  "/vendor/addon-fit.js": [addonFitJs, "text/javascript"],
};

// build-context files for `container build` of the base image (used by setup)
export const baseImageFiles: Record<string, string> = {
  Dockerfile: baseDockerfile,
  "tmux.conf": baseTmuxConf,
};
