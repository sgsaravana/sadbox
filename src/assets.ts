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
import editorHtml from "../web/editor.html" with { type: "file" };
// Ace (the in-browser code editor): core, theme, search box, and a curated set
// of language modes. Ace fetches a mode by URL the first time a file of that
// language is opened, so every mode offered must be embedded here by name.
import ace_ace from "../node_modules/ace-builds/src-min-noconflict/ace.js" with { type: "file" };
import ace_theme_one_dark from "../node_modules/ace-builds/src-min-noconflict/theme-one_dark.js" with { type: "file" };
import ace_ext_searchbox from "../node_modules/ace-builds/src-min-noconflict/ext-searchbox.js" with { type: "file" };
import ace_ext_modelist from "../node_modules/ace-builds/src-min-noconflict/ext-modelist.js" with { type: "file" };
import ace_mode_astro from "../node_modules/ace-builds/src-min-noconflict/mode-astro.js" with { type: "file" };
import ace_mode_batchfile from "../node_modules/ace-builds/src-min-noconflict/mode-batchfile.js" with { type: "file" };
import ace_mode_c_cpp from "../node_modules/ace-builds/src-min-noconflict/mode-c_cpp.js" with { type: "file" };
import ace_mode_clojure from "../node_modules/ace-builds/src-min-noconflict/mode-clojure.js" with { type: "file" };
import ace_mode_csharp from "../node_modules/ace-builds/src-min-noconflict/mode-csharp.js" with { type: "file" };
import ace_mode_css from "../node_modules/ace-builds/src-min-noconflict/mode-css.js" with { type: "file" };
import ace_mode_csv from "../node_modules/ace-builds/src-min-noconflict/mode-csv.js" with { type: "file" };
import ace_mode_dart from "../node_modules/ace-builds/src-min-noconflict/mode-dart.js" with { type: "file" };
import ace_mode_diff from "../node_modules/ace-builds/src-min-noconflict/mode-diff.js" with { type: "file" };
import ace_mode_dockerfile from "../node_modules/ace-builds/src-min-noconflict/mode-dockerfile.js" with { type: "file" };
import ace_mode_elixir from "../node_modules/ace-builds/src-min-noconflict/mode-elixir.js" with { type: "file" };
import ace_mode_erlang from "../node_modules/ace-builds/src-min-noconflict/mode-erlang.js" with { type: "file" };
import ace_mode_gitignore from "../node_modules/ace-builds/src-min-noconflict/mode-gitignore.js" with { type: "file" };
import ace_mode_golang from "../node_modules/ace-builds/src-min-noconflict/mode-golang.js" with { type: "file" };
import ace_mode_graphqlschema from "../node_modules/ace-builds/src-min-noconflict/mode-graphqlschema.js" with { type: "file" };
import ace_mode_haskell from "../node_modules/ace-builds/src-min-noconflict/mode-haskell.js" with { type: "file" };
import ace_mode_html from "../node_modules/ace-builds/src-min-noconflict/mode-html.js" with { type: "file" };
import ace_mode_ini from "../node_modules/ace-builds/src-min-noconflict/mode-ini.js" with { type: "file" };
import ace_mode_java from "../node_modules/ace-builds/src-min-noconflict/mode-java.js" with { type: "file" };
import ace_mode_javascript from "../node_modules/ace-builds/src-min-noconflict/mode-javascript.js" with { type: "file" };
import ace_mode_json from "../node_modules/ace-builds/src-min-noconflict/mode-json.js" with { type: "file" };
import ace_mode_json5 from "../node_modules/ace-builds/src-min-noconflict/mode-json5.js" with { type: "file" };
import ace_mode_jsx from "../node_modules/ace-builds/src-min-noconflict/mode-jsx.js" with { type: "file" };
import ace_mode_kotlin from "../node_modules/ace-builds/src-min-noconflict/mode-kotlin.js" with { type: "file" };
import ace_mode_latex from "../node_modules/ace-builds/src-min-noconflict/mode-latex.js" with { type: "file" };
import ace_mode_less from "../node_modules/ace-builds/src-min-noconflict/mode-less.js" with { type: "file" };
import ace_mode_lua from "../node_modules/ace-builds/src-min-noconflict/mode-lua.js" with { type: "file" };
import ace_mode_makefile from "../node_modules/ace-builds/src-min-noconflict/mode-makefile.js" with { type: "file" };
import ace_mode_markdown from "../node_modules/ace-builds/src-min-noconflict/mode-markdown.js" with { type: "file" };
import ace_mode_nginx from "../node_modules/ace-builds/src-min-noconflict/mode-nginx.js" with { type: "file" };
import ace_mode_nix from "../node_modules/ace-builds/src-min-noconflict/mode-nix.js" with { type: "file" };
import ace_mode_ocaml from "../node_modules/ace-builds/src-min-noconflict/mode-ocaml.js" with { type: "file" };
import ace_mode_perl from "../node_modules/ace-builds/src-min-noconflict/mode-perl.js" with { type: "file" };
import ace_mode_php from "../node_modules/ace-builds/src-min-noconflict/mode-php.js" with { type: "file" };
import ace_mode_powershell from "../node_modules/ace-builds/src-min-noconflict/mode-powershell.js" with { type: "file" };
import ace_mode_prisma from "../node_modules/ace-builds/src-min-noconflict/mode-prisma.js" with { type: "file" };
import ace_mode_properties from "../node_modules/ace-builds/src-min-noconflict/mode-properties.js" with { type: "file" };
import ace_mode_protobuf from "../node_modules/ace-builds/src-min-noconflict/mode-protobuf.js" with { type: "file" };
import ace_mode_python from "../node_modules/ace-builds/src-min-noconflict/mode-python.js" with { type: "file" };
import ace_mode_r from "../node_modules/ace-builds/src-min-noconflict/mode-r.js" with { type: "file" };
import ace_mode_ruby from "../node_modules/ace-builds/src-min-noconflict/mode-ruby.js" with { type: "file" };
import ace_mode_rust from "../node_modules/ace-builds/src-min-noconflict/mode-rust.js" with { type: "file" };
import ace_mode_scala from "../node_modules/ace-builds/src-min-noconflict/mode-scala.js" with { type: "file" };
import ace_mode_scss from "../node_modules/ace-builds/src-min-noconflict/mode-scss.js" with { type: "file" };
import ace_mode_sh from "../node_modules/ace-builds/src-min-noconflict/mode-sh.js" with { type: "file" };
import ace_mode_sql from "../node_modules/ace-builds/src-min-noconflict/mode-sql.js" with { type: "file" };
import ace_mode_svg from "../node_modules/ace-builds/src-min-noconflict/mode-svg.js" with { type: "file" };
import ace_mode_swift from "../node_modules/ace-builds/src-min-noconflict/mode-swift.js" with { type: "file" };
import ace_mode_terraform from "../node_modules/ace-builds/src-min-noconflict/mode-terraform.js" with { type: "file" };
import ace_mode_text from "../node_modules/ace-builds/src-min-noconflict/mode-text.js" with { type: "file" };
import ace_mode_toml from "../node_modules/ace-builds/src-min-noconflict/mode-toml.js" with { type: "file" };
import ace_mode_tsx from "../node_modules/ace-builds/src-min-noconflict/mode-tsx.js" with { type: "file" };
import ace_mode_typescript from "../node_modules/ace-builds/src-min-noconflict/mode-typescript.js" with { type: "file" };
import ace_mode_vue from "../node_modules/ace-builds/src-min-noconflict/mode-vue.js" with { type: "file" };
import ace_mode_xml from "../node_modules/ace-builds/src-min-noconflict/mode-xml.js" with { type: "file" };
import ace_mode_yaml from "../node_modules/ace-builds/src-min-noconflict/mode-yaml.js" with { type: "file" };
import ace_mode_zig from "../node_modules/ace-builds/src-min-noconflict/mode-zig.js" with { type: "file" };
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
  "/editor": [editorHtml, "text/html; charset=utf-8"],
};

// file name under /vendor/ace/ -> embedded file path
export const aceFiles: Record<string, string> = {
  "ace.js": ace_ace,
  "theme-one_dark.js": ace_theme_one_dark,
  "ext-searchbox.js": ace_ext_searchbox,
  "ext-modelist.js": ace_ext_modelist,
  "mode-astro.js": ace_mode_astro,
  "mode-batchfile.js": ace_mode_batchfile,
  "mode-c_cpp.js": ace_mode_c_cpp,
  "mode-clojure.js": ace_mode_clojure,
  "mode-csharp.js": ace_mode_csharp,
  "mode-css.js": ace_mode_css,
  "mode-csv.js": ace_mode_csv,
  "mode-dart.js": ace_mode_dart,
  "mode-diff.js": ace_mode_diff,
  "mode-dockerfile.js": ace_mode_dockerfile,
  "mode-elixir.js": ace_mode_elixir,
  "mode-erlang.js": ace_mode_erlang,
  "mode-gitignore.js": ace_mode_gitignore,
  "mode-golang.js": ace_mode_golang,
  "mode-graphqlschema.js": ace_mode_graphqlschema,
  "mode-haskell.js": ace_mode_haskell,
  "mode-html.js": ace_mode_html,
  "mode-ini.js": ace_mode_ini,
  "mode-java.js": ace_mode_java,
  "mode-javascript.js": ace_mode_javascript,
  "mode-json.js": ace_mode_json,
  "mode-json5.js": ace_mode_json5,
  "mode-jsx.js": ace_mode_jsx,
  "mode-kotlin.js": ace_mode_kotlin,
  "mode-latex.js": ace_mode_latex,
  "mode-less.js": ace_mode_less,
  "mode-lua.js": ace_mode_lua,
  "mode-makefile.js": ace_mode_makefile,
  "mode-markdown.js": ace_mode_markdown,
  "mode-nginx.js": ace_mode_nginx,
  "mode-nix.js": ace_mode_nix,
  "mode-ocaml.js": ace_mode_ocaml,
  "mode-perl.js": ace_mode_perl,
  "mode-php.js": ace_mode_php,
  "mode-powershell.js": ace_mode_powershell,
  "mode-prisma.js": ace_mode_prisma,
  "mode-properties.js": ace_mode_properties,
  "mode-protobuf.js": ace_mode_protobuf,
  "mode-python.js": ace_mode_python,
  "mode-r.js": ace_mode_r,
  "mode-ruby.js": ace_mode_ruby,
  "mode-rust.js": ace_mode_rust,
  "mode-scala.js": ace_mode_scala,
  "mode-scss.js": ace_mode_scss,
  "mode-sh.js": ace_mode_sh,
  "mode-sql.js": ace_mode_sql,
  "mode-svg.js": ace_mode_svg,
  "mode-swift.js": ace_mode_swift,
  "mode-terraform.js": ace_mode_terraform,
  "mode-text.js": ace_mode_text,
  "mode-toml.js": ace_mode_toml,
  "mode-tsx.js": ace_mode_tsx,
  "mode-typescript.js": ace_mode_typescript,
  "mode-vue.js": ace_mode_vue,
  "mode-xml.js": ace_mode_xml,
  "mode-yaml.js": ace_mode_yaml,
  "mode-zig.js": ace_mode_zig,
};

// build-context files for `container build` of the base image (used by setup)
export const baseImageFiles: Record<string, string> = {
  Dockerfile: baseDockerfile,
  "tmux.conf": baseTmuxConf,
};
