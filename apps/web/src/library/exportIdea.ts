import type { ComposerOptions } from "../../../../packages/domain/src/planningComposer";
import { zip, strToU8 } from "fflate";
import type { Project } from "../../../../packages/domain/src";
import {
  emptyIdeaDocument,
  type ImageReference,
} from "../../../../packages/domain/src/ideaDocument";
import {
  type IdeaDocument,
  materializeIdea,
} from "../../../../packages/domain/src/ideaDocument";
import {
  attachmentScheme,
  flatBlocks,
  attachmentId,
  blocksMarkdown,
  legacyImageScheme,
} from "../../../../packages/domain/src/ideaBlocks";
import { attachmentBlob } from "./attachments";
export async function ideaArchive(
  body: string,
  document: IdeaDocument,
  extra: Record<string, string> = {},
  conversationFiles: ComposerOptions["attachments"] = [],
  legacyReferences: ImageReference[] = [],
) {
  const source = materializeIdea(body, document).document;
  const files: Record<string, Uint8Array> = {};
  const assets: Record<string, string> = {};
  const addAsset = async (
    id: string,
    rawName: string,
    blob: Blob,
    legacy = false,
  ) => {
    let name = String(rawName || "attachment")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
    if (legacy)
      name =
        name.replace(/\.[^.]+$/, "") +
        ({ "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg" }[
          blob.type
        ] || ".bin");
    const path = "attachments/" + id + "-" + name;
    assets[id] = path;
    files[path] = new Uint8Array(await blob.arrayBuffer());
  };
  // Fetch one original at a time to bound concurrent transfers. ZIP compression
  // runs asynchronously; failures abort export rather than silently omitting files.
  for (const block of flatBlocks(source.blocks)) {
    if (!["image", "file"].includes(block.type)) continue;
    const url = String(block.props.url),
      ref = attachmentId(url);
    if (!ref || assets[ref.id]) continue;
    const blob = await attachmentBlob(url);
    await addAsset(
      ref.id,
      String(block.props.name || "attachment"),
      blob,
      ref.legacy,
    );
  }
  // Project-level references predate the block document and can survive with
  // no ideaDocument at all. Fetch them explicitly so a rich project export
  // still contains their original bytes.
  for (const reference of legacyReferences) {
    if (assets[reference.id]) continue;
    const blob = await attachmentBlob(legacyImageScheme + reference.id);
    await addAsset(reference.id, reference.name, blob, true);
  }
  for (const file of conversationFiles) {
    if (assets[file.id]) continue;
    const blob = await attachmentBlob(attachmentScheme + file.id);
    await addAsset(file.id, file.name, blob);
  }
  files["attachments.json"] = strToU8(JSON.stringify(assets, null, 2));
  files["idea.json"] = strToU8(
    JSON.stringify({ body, document: source }, null, 2),
  );
  files["idea.md"] = strToU8(
    (source.title ? "# " + source.title + "\n\n" : "") +
      blocksMarkdown(source.blocks, assets) +
      "\n",
  );
  for (const [name, text] of Object.entries(extra)) files[name] = strToU8(text);
  return new Promise<Blob>((resolve, reject) =>
    zip(files, { level: 1 }, (error, data) =>
      error
        ? reject(error)
        : resolve(new Blob([data as BlobPart], { type: "application/zip" })),
    ),
  );
}

/**
 * Build the attachment list used by either Project workspace export entry
 * point. Sources are intentionally included even when archived: they remain
 * retained project content and the export must preserve their bytes.
 */
function projectExportAttachments(
  project: Project,
): ComposerOptions["attachments"] {
  return [
    ...(project.thinking?.turns || []).flatMap(
      (turn) => turn.composer?.attachments || [],
    ),
    ...(project.sources || []).map((source) => ({
      id: source.attachmentId,
      name: source.name,
      mime: source.mime,
      size: source.size,
    })),
  ];
}

/**
 * Return the rich project export for projects that have structured source
 * content or private files. Legacy projects without either remain a small
 * Markdown download; that format already carries legacy image references as
 * data URLs. When a project is rich for another reason, legacy references are
 * also copied into the ZIP as original bytes.
 */
export async function projectArchive(
  project: Project,
  markdown: string,
): Promise<Blob> {
  const attachments = projectExportAttachments(project);
  const hasRichSource =
    project.ideaDocument?.version === 2 || attachments.length > 0;
  if (!hasRichSource) return new Blob([markdown], { type: "text/markdown" });
  return ideaArchive(
    project.originalIdea || "",
    project.ideaDocument || emptyIdeaDocument(),
    {
      "project.md": markdown,
      "project.json": JSON.stringify(project, null, 2),
    },
    attachments,
    project.references || [],
  );
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
