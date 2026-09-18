import { createBundledHighlighter } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

const createHighlighter = createBundledHighlighter({
  langs: {
    javascript: () => import("@shikijs/langs/javascript"),
    typescript: () => import("@shikijs/langs/typescript"),
    jsx: () => import("@shikijs/langs/jsx"),
    tsx: () => import("@shikijs/langs/tsx"),
    html: () => import("@shikijs/langs/html"),
    css: () => import("@shikijs/langs/css"),
    json: () => import("@shikijs/langs/json"),
    python: () => import("@shikijs/langs/python"),
    lua: () => import("@shikijs/langs/lua"),
    luau: () => import("@shikijs/langs/luau"),
    gdscript: () => import("@shikijs/langs/gdscript"),
    c: () => import("@shikijs/langs/c"),
    cpp: () => import("@shikijs/langs/cpp"),
    csharp: () => import("@shikijs/langs/csharp"),
    java: () => import("@shikijs/langs/java"),
    kotlin: () => import("@shikijs/langs/kotlin"),
    swift: () => import("@shikijs/langs/swift"),
    go: () => import("@shikijs/langs/go"),
    rust: () => import("@shikijs/langs/rust"),
    ruby: () => import("@shikijs/langs/ruby"),
    php: () => import("@shikijs/langs/php"),
    sql: () => import("@shikijs/langs/sql"),
    bash: () => import("@shikijs/langs/shellscript"),
    powershell: () => import("@shikijs/langs/powershell"),
    yaml: () => import("@shikijs/langs/yaml"),
    toml: () => import("@shikijs/langs/toml"),
    xml: () => import("@shikijs/langs/xml"),
    markdown: () => import("@shikijs/langs/markdown"),
    dockerfile: () => import("@shikijs/langs/docker"),
  },
  themes: { "dark-plus": () => import("@shikijs/themes/dark-plus") },
  engine: () => createOnigurumaEngine(import("shiki/wasm")),
});

export function createCodeHighlighter() {
  return createHighlighter({ langs: [], themes: ["dark-plus"] });
}
