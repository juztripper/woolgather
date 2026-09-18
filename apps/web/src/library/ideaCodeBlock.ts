import { createExtension, defaultBlockSpecs } from "@blocknote/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const codeLanguages: Record<string, string> = {
  text: "Plain text",
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  python: "Python",
  lua: "Lua",
  luau: "Luau",
  gdscript: "GDScript",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  go: "Go",
  rust: "Rust",
  ruby: "Ruby",
  php: "PHP",
  sql: "SQL",
  bash: "Shell",
  powershell: "PowerShell",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  markdown: "Markdown",
  dockerfile: "Dockerfile",
};
const nativeCode = defaultBlockSpecs.codeBlock;
export const ideaCodeBlock = {
  ...nativeCode,
  implementation: {
    ...nativeCode.implementation,
    render(
      this: ThisParameterType<typeof nativeCode.implementation.render>,
      ...args: Parameters<typeof nativeCode.implementation.render>
    ) {
      const [block, editor] = args;
      const rendered = nativeCode.implementation.render.apply(this, args);
      const header = document.createElement("div");
      header.className = "idea-code-language";
      header.contentEditable = "false";
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Code language");
      select.title = "Code language";
      const options =
        block.props.language in codeLanguages
          ? codeLanguages
          : {
              ...codeLanguages,
              [block.props.language]: block.props.language,
            };
      for (const [id, name] of Object.entries(options)) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = name;
        select.appendChild(option);
      }
      select.value = block.props.language;
      select.disabled = !editor.isEditable;
      const change = () => {
        if (editor.isEditable && editor.getBlock(block.id)) {
          editor.updateBlock(block.id, { props: { language: select.value } });
          editor.focus();
        }
      };
      select.addEventListener("change", change);
      header.appendChild(select);
      (rendered.dom as DocumentFragment).prepend(header);
      return {
        ...rendered,
        destroy() {
          select.removeEventListener("change", change);
          rendered.destroy?.();
        },
      };
    },
  },
};

// Let ProseMirror own selection attributes so node-view DOM is never reparsed
// in response to a manually toggled control attribute.
export const codeBlockSelection = createExtension(() => ({
  key: "ideaCodeBlockSelection",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        decorations(state) {
          const decorations: Decoration[] = [];
          const { from, to } = state.selection;
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === "codeBlock" &&
              from < pos + node.nodeSize &&
              to > pos
            ) {
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  "data-code-selected": "true",
                }),
              );
            }
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
  ],
}));
