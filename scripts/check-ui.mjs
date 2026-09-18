// Keep shared production controls from drifting back into one-off screen styles.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      ),
    )
  ).flat();
}
const errors = [];
const tokens = await readFile("apps/web/src/ui/tokens.css", "utf8");
const faces = await readFile("apps/web/src/ui/fonts.css", "utf8");
const entry = await readFile("apps/web/index.html", "utf8");
const interfaceFamily = tokens.match(/--sans:\s*"([^"]+)"/)?.[1];
const interfaceFace = faces
  .match(/@font-face\s*\{[^}]+\}/g)
  ?.find((face) => face.includes(`font-family: "${interfaceFamily}"`));
const interfaceFont = interfaceFace?.match(/url\("([^"]+)"\)/)?.[1];
if (!interfaceFont || !entry.includes(`href="${interfaceFont}"`))
  errors.push(
    "index.html: preload the active interface font from ui/fonts.css",
  );
const config = JSON.parse(await readFile("components.json", "utf8"));
if (config.style !== "base-nova" || !config.tailwind.cssVariables)
  errors.push(
    "components.json: preserve the selected shadcn Nova token system",
  );
const theme = await readFile("apps/web/src/ui/shadcn.css", "utf8");
if (!theme.includes('@import "shadcn/tailwind.css"'))
  errors.push("ui/shadcn.css: keep shadcn state and orientation variants");
const classMerger = await readFile("apps/web/src/lib/utils.ts", "utf8");
for (const [, name] of theme.matchAll(/--spacing-([\w-]+)\s*:/g))
  if (!classMerger.includes(`"${name}"`))
    errors.push(
      `lib/utils.ts: register spacing token ${name} with the class merger`,
    );
// A token declaration alone does not establish a shared scale. Verify that
// Tailwind and the controls actually consume it; this previously drifted apart.
for (const [utility, token] of [
  ["text-sm", "control-font"],
  ["text-sm--line-height", "control-leading"],
  ["spacing-control", "control-height"],
  ["spacing-control-padding", "control-padding"],
  ["spacing-field-padding", "field-padding"],
]) {
  if (!theme.includes(`--${utility}: var(--${token})`))
    errors.push(`ui/shadcn.css: ${utility} must consume the shared ${token}`);
}
for (const [component, utilities] of [
  ["button", ["h-control", "px-control-padding", "text-sm"]],
  ["input", ["h-control", "px-field-padding", "md:text-sm"]],
  ["textarea", ["px-field-padding", "md:text-sm"]],
  ["select", ["h-control", "pl-field-padding", "text-sm"]],
  ["input-group", ["h-control", "pl-field-padding"]],
  ["tabs", ["h-control", "px-control-padding-sm", "text-sm"]],
]) {
  const source = await readFile(
    `apps/web/src/components/ui/${component}.tsx`,
    "utf8",
  );
  for (const utility of utilities)
    if (!source.includes(utility))
      errors.push(`${component}: use the shared ${utility} scale`);
  if (/focus-visible(?:\])?:ring-(?:3|\[3px\])/.test(source))
    errors.push(`${component}: retain the shared thin focus treatment`);
}
const materials = await readFile("apps/web/src/ui/materials.css", "utf8");
if (/\.library-workspace\s*\{[^}]*view-transition-name/.test(materials))
  errors.push(
    "materials.css: transition library results, not the live toolbar and heading",
  );
const ideaEditor = await readFile(
  "apps/web/src/library/IdeaEditor.tsx",
  "utf8",
);
if (
  /FocusedIdeaGuidance|idea-guidance|Idea views|Writing prompts/.test(
    ideaEditor,
  )
)
  errors.push("IdeaEditor: Ideas must remain intervention-free (DEC-131)");
const apiRouter = await readFile("apps/api/src/index.ts", "utf8");
if (/\/api\/idea-guidance|ideaGuidance:\s*/.test(apiRouter))
  errors.push("api/index: do not expose the retired Idea guidance route");
// Updating either upstream menu must preserve the shared material and row owner.
for (const menu of ["dropdown-menu", "context-menu"]) {
  const source = await readFile(
    `apps/web/src/components/ui/${menu}.tsx`,
    "utf8",
  );
  for (const shared of [
    "menuStyles.popup",
    "menuStyles.item",
    "menuStyles.subTrigger",
    "menuStyles.selectionItem",
    "material-menu-body",
    "useMaterialSurface",
  ])
    if (!source.includes(shared))
      errors.push(`${menu}: retain shared menu presentation (${shared})`);
}
for (const file of await files("apps/web/src")) {
  const src = await readFile(file, "utf8");
  if (/data-visual-study|design-review\/study/.test(src))
    errors.push(
      `${file}: production must use shared owners, not a study overlay`,
    );
  if (
    file.endsWith(".tsx") &&
    !file.includes("/components/ui/") &&
    !file.endsWith("/ui/Button.tsx") &&
    /<button\b/.test(src)
  )
    errors.push(`${file}: use Button, IconButton or ProviderButton`);
  if (
    file.endsWith(".tsx") &&
    !file.includes("/components/ui/") &&
    /<(?:textarea|select)\b/.test(src)
  )
    errors.push(`${file}: use the shared shadcn form component`);
  if (file.endsWith(".css") && !file.endsWith("/ui/tokens.css")) {
    if (!file.endsWith("/ui/workspace.css")) {
      for (const rule of src.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        if (
          /\.app-shell|\.main-shell|\.topbar/.test(rule[1]) &&
          /(?:display|margin(?:-[\w-]+)?|padding(?:-[\w-]+)?|(?:min-|max-)?height|grid-template[\w-]*)\s*:/.test(
            rule[2],
          )
        )
          errors.push(
            `${file}: app shell geometry belongs in ui/workspace.css`,
          );
      }
    }
    if (
      !file.endsWith("/ui/shadcn.css") &&
      /--(?:text-[\w-]+|control-[\w-]+|sans|serif)\s*:/.test(src)
    )
      errors.push(
        `${file}: typography and control tokens belong in ui/tokens.css`,
      );
    if (/@font-face\b/.test(src) && !file.endsWith("/ui/fonts.css"))
      errors.push(`${file}: font faces belong in ui/fonts.css`);
    if (
      !file.endsWith("/ui/shadcn.css") &&
      /--(?:muted|accent|primary)\s*:/.test(src)
    )
      errors.push(
        `${file}: shared surface tokens belong in ui/shadcn.css; use muted-foreground for text`,
      );
    if (/font-size\s*:\s*\d+(?:\.\d+)?px/.test(src))
      errors.push(`${file}: use a shared typography token`);
    if (
      [
        ...src
          .replace(/@font-face\s*\{[^}]*\}/g, "")
          .matchAll(/font-family\s*:\s*([^;]+);/g),
      ].some((m) => !/^(var\(|inherit)/.test(m[1].trim()))
    )
      errors.push(`${file}: use an existing font-family token`);
    if (!file.endsWith("/ui/controls.css")) {
      for (const match of src.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        if (
          /\.button--(?:primary|secondary|danger|quiet|provider)\b/.test(
            match[1],
          ) &&
          /(?:font(?:-size|-family|-weight)?|background|box-shadow|border-radius|min-height)\s*:/.test(
            match[2],
          )
        )
          errors.push(
            `${file}: button appearance belongs in components/ui/button.tsx`,
          );
      }
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Shared UI checks passed.");
