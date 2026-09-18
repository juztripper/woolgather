import {
  libraryCommandSchema,
  type Library,
  type LibraryCommand,
} from "../../../../packages/domain/src/library";
import { api } from "../client";

export function restoreBlankIdeaRequest(value: unknown): LibraryCommand | null {
  const parsed = libraryCommandSchema.safeParse(value);
  return parsed.success &&
    parsed.data.type === "save_idea" &&
    parsed.data.expectedRevision === 0 &&
    parsed.data.body === "" &&
    !parsed.data.document
    ? parsed.data
    : null;
}

/** Callers retain this request until both creation and the library read succeed. */
export function blankIdeaRequest(
  folderId: string | null = null,
): LibraryCommand {
  return {
    id: crypto.randomUUID(),
    targetId: crypto.randomUUID(),
    expectedRevision: 0,
    type: "save_idea",
    body: "",
    folderId,
  };
}
export async function createBlankIdea(command: LibraryCommand, request = api) {
  await request("/library", command);
  const library = await request<Library>("/library");
  const idea = library.ideas.find((entry) => entry.id === command.targetId);
  if (!idea)
    throw new Error(
      "Your new idea could not be confirmed. Try again to recover it.",
    );
  return { library, idea };
}
