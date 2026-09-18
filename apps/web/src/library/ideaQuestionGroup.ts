import { createExtension } from "@blocknote/core";
import { Plugin } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import {
  emptiedQuestionHeadings,
  type QuestionGroupBlock,
} from "../../../../packages/domain/src/ideaDocument";

function blocks(node: Node): QuestionGroupBlock[] {
  const result: QuestionGroupBlock[] = [];
  node.forEach((child) => {
    if (child.type.name === "blockContainer") {
      result.push({
        id: child.attrs.id,
        type: child.firstChild?.type.name || "",
        children: blocks(child),
      });
    } else if (child.type.name === "blockGroup") result.push(...blocks(child));
  });
  return result;
}

export const questionGroupPlugin = () =>
  new Plugin({
    appendTransaction(transactions, previous, current) {
      if (!transactions.some((transaction) => transaction.docChanged))
        return null;
      const empty = new Set(
        emptiedQuestionHeadings(blocks(previous.doc), blocks(current.doc)),
      );
      if (!empty.size) return null;
      const ranges: { from: number; to: number }[] = [];
      current.doc.descendants((node, pos) => {
        if (node.type.name === "blockContainer" && empty.has(node.attrs.id)) {
          // Do not remove writing newly nested under the title in the same edit.
          if (node.childCount === 1)
            ranges.push({ from: pos, to: pos + node.nodeSize });
          return false;
        }
      });
      if (!ranges.length) return null;
      const transaction = current.tr;
      for (const range of ranges.sort((a, b) => b.from - a.from))
        transaction.delete(range.from, range.to);
      return transaction;
    },
  });

export const ideaQuestionGroup = createExtension(() => ({
  key: "ideaQuestionGroup",
  prosemirrorPlugins: [questionGroupPlugin()],
}));
