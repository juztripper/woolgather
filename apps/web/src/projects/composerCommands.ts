import {
  planningTools,
  type ComposerOptions,
} from "../../../../packages/domain/src/planningComposer";

export type ComposerTool = ComposerOptions["tool"];
export const composerToolDetails = {
  discuss: {
    command: "discuss",
    shortLabel: "Discuss",
    description: "Think through your project together",
    placeholder: "Write whatever’s on your mind…",
  },
  alternatives: {
    command: "alternatives",
    shortLabel: "Alternatives",
    description: "Find other ways forward",
    placeholder: "What would you like to explore other ways of doing?",
  },
  compare: {
    command: "compare",
    shortLabel: "Compare",
    description: "Weigh options and trade-offs",
    placeholder: "Which approaches would you like to compare?",
  },
  challenge: {
    command: "challenge",
    shortLabel: "Challenge",
    description: "Question assumptions and risks",
    placeholder: "Which idea or assumption would you like to test?",
  },
  next_steps: {
    command: "next",
    shortLabel: "Next steps",
    description: "Find a useful place to start",
    placeholder: "What would you like to move forward?",
  },
} satisfies Record<
  ComposerTool,
  {
    command: string;
    shortLabel: string;
    description: string;
    placeholder: string;
  }
>;

export const composerCommands = (
  Object.keys(planningTools) as ComposerTool[]
).map((id) => ({
  id,
  label: planningTools[id].label,
  ...composerToolDetails[id],
}));

export type ComposerCommand = { start: number; end: number; query: string };

/** Commands begin at a whitespace boundary. Paths, URLs and selected text stay native. */
export function readComposerCommand(
  text: string,
  caret: number,
  selectionEnd = caret,
): ComposerCommand | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const nextLine = text.indexOf("\n", caret);
  const end = nextLine === -1 ? text.length : nextLine;
  const line = text.slice(lineStart, end);
  const match = /(^|[\t ])\/([\w\t -]*)$/.exec(line);
  if (!match) return null;
  const start = lineStart + match.index + match[1].length;
  if (caret <= start) return null;
  return { start, end, query: match[2].trim() };
}

export function filterComposerCommands(query: string) {
  const words = query
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return composerCommands.filter((command) => {
    const searchable =
      `${command.command} ${command.label} ${command.description}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

export function consumeComposerCommand(text: string, command: ComposerCommand) {
  return text.slice(0, command.start) + text.slice(command.end);
}
