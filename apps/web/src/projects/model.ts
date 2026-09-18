import type { ItemInput } from "../../../../packages/domain/src";

export const labels: Record<string, string> = {
  purpose: "Purpose",
  feature: "Features",
  constraint: "Constraints",
  decision: "Decisions",
  question: "Questions",
  gap: "Gaps",
  note: "Notes",
  stated: "Stated",
  tentative: "Tentative",
  confirmed: "Confirmed",
  open: "Open",
  answered: "Answered",
  deferred: "For later",
  resolved: "Resolved",
  recheck: "Needs recheck",
};
export const singular: Record<string, string> = {
  purpose: "Purpose",
  feature: "Feature",
  constraint: "Constraint",
  decision: "Decision",
  question: "Question",
  gap: "Gap",
  note: "Note",
};
export function blankThought(): ItemInput {
  return {
    title: "",
    body: "",
    category: "note",
    certainty: "stated",
    status: "open",
    answer: "",
    links: [],
  };
}
export function readDraft(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function storeDraft(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Retain the mounted editor. */
  }
}

/** Presentation only: retain the exact text when developing a brief section. */
export function briefSections(text: string): { title: string; body: string }[] {
  const result: { title: string; body: string }[] = [];
  let title = "",
    lines: string[] = [],
    fenced = false;
  const flush = () => {
    if (title || lines.some((line) => line.trim()))
      result.push({ title, body: lines.join("\n").trim() });
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      title = heading[1];
      lines = [];
    } else lines.push(line);
  }
  flush();
  return result;
}
