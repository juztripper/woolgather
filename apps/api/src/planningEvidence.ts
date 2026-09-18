import { z } from "zod";
import type { Project } from "../../../packages/domain/src";
import {
  planningSource,
  thinkingOf,
  type PlanningTurn,
} from "../../../packages/domain/src/projectPlanning";

const prefix = "Authored evidence catalog (reference data):\n";
const normalize = (text: string) =>
  text.normalize("NFC").replace(/\s+/g, " ").trim();
export type PlanningEvidence = {
  ref: string;
  sourceTurn: string;
  quote: string;
};

/** Only server-owned authored text enters this catalog, never model replies. */
export function planningEvidence(project: Project, turns: PlanningTurn[]) {
  const entries: PlanningEvidence[] = [];
  const add = (sourceTurn: string, text: string) => {
    // Keep each passage within the existing durable quote limit. Long messages
    // remain separate passages; never join non-contiguous evidence or paraphrase.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 6000, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf("\n", end);
        if (boundary > start + 3000) end = boundary;
        else if (/^[\uDC00-\uDFFF]$/.test(text[end])) end--;
      }
      const quote = text.slice(start, end);
      start = end;
      // Keep even short replies and trailing qualifiers in the model context.
      // Only passages meeting the durable evidence minimum are selectable.
      if (
        entries.some(
          (entry) => entry.sourceTurn === sourceTurn && entry.quote === quote,
        )
      )
        continue;
      entries.push({ ref: `a${entries.length + 1}`, sourceTurn, quote });
    }
  };
  const state = thinkingOf(project);
  for (const turn of turns)
    add(
      `t${state.turns.findIndex((entry) => entry.id === turn.id) + 1}`,
      turn.text,
    );
  add("brief", planningSource(project));
  // Existing accepted thoughts may cite a turn outside the recent window.
  // Supply their already-validated original evidence, not their generated body.
  for (const item of project.items.filter((entry) => !entry.removed)) {
    if (!item.evidence) continue;
    const source =
      item.evidence.turnId === "brief"
        ? planningSource(project)
        : state.turns.find((turn) => turn.id === item.evidence?.turnId)?.text;
    if (
      source &&
      normalize(item.evidence.quote).length >= 3 &&
      normalize(source).includes(normalize(item.evidence.quote))
    )
      add(item.evidence.turnId, item.evidence.quote);
  }
  return entries;
}

export const evidenceMessage = (entries: PlanningEvidence[]) => ({
  role: "user",
  content: prefix + JSON.stringify(entries),
});

export function requestEvidence(request: {
  input?: unknown[];
}): PlanningEvidence[] {
  const message = request.input?.find(
    (entry: any) =>
      entry?.role === "user" &&
      typeof entry.content === "string" &&
      entry.content.startsWith(prefix),
  ) as { content: string } | undefined;
  return message ? JSON.parse(message.content.slice(prefix.length)) : [];
}

const evidenceDescription =
  "Select the authored passage that actually establishes this meaning, including its qualifiers. The server attaches its original source and text. A passage existing does not mean it supports your interpretation.";

export const usableEvidence = (entries: PlanningEvidence[]) =>
  entries.filter((entry) => normalize(entry.quote).length >= 3);

export function evidenceReference(catalog: PlanningEvidence[]) {
  const entries = usableEvidence(catalog);
  return entries.length
    ? z
        .string()
        .regex(
          new RegExp(`^(?:${entries.map((entry) => entry.ref).join("|")})$`),
        )
        .describe(evidenceDescription)
    : z.null();
}

/** Resolve the selected passage from the trusted request, before domain validation. */
export function resolvePlanningEvidence(
  request: { input?: unknown[] },
  raw: unknown,
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const catalog = new Map(
    requestEvidence(request).map((entry) => [entry.ref, entry]),
  );
  const resolve = (entry: any) => {
    if (!entry || typeof entry !== "object" || !("evidenceRef" in entry))
      return entry;
    const { evidenceRef, ...rest } = entry;
    const source = catalog.get(evidenceRef);
    // Unknown references fail the existing authored-source check. No guessed
    // quote, automatic downgrade to a suggestion, or extra inference request.
    return {
      ...rest,
      sourceTurn: source?.sourceTurn || "",
      quote: source?.quote || "",
    };
  };
  const value = raw as Record<string, unknown>;
  return {
    ...value,
    ...Object.fromEntries(
      ["concepts", "remove", "sourceUpdates"].flatMap((key) =>
        Array.isArray(value[key]) ? [[key, value[key].map(resolve)]] : [],
      ),
    ),
  };
}

/** History is trusted server output. Only its authored text extends evidence. */
export function appendHistoryEvidence(request: any, history: any) {
  if (!Array.isArray(history?.messages)) return;
  const entries = requestEvidence(request);
  if (!entries.length) return;
  for (const message of history.messages) {
    if (
      typeof message?.sourceTurn !== "string" ||
      typeof message?.text !== "string" ||
      normalize(message.text).length < 3
    )
      continue;
    if (
      entries.some(
        (entry) =>
          entry.sourceTurn === message.sourceTurn &&
          entry.quote === message.text,
      )
    )
      continue;
    entries.push({
      ref: `a${entries.length + 1}`,
      sourceTurn: message.sourceTurn,
      quote: message.text.slice(0, 6000),
    });
  }
  const message = request.input.find(
    (entry: any) =>
      entry?.role === "user" &&
      typeof entry.content === "string" &&
      entry.content.startsWith(prefix),
  );
  message.content = evidenceMessage(entries).content;
  const tool = request.tools.find(
    (entry: any) => entry.name === "develop_project",
  );
  // Source decisions remain restricted to the active conversation; retrieved
  // other-chat text is context for concepts, not authority over source metadata.
  const extend = (schema: any) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.description === evidenceDescription && schema.pattern)
      schema.pattern = `^(?:${usableEvidence(entries)
        .map((entry) => entry.ref)
        .join("|")})$`;
    for (const [key, value] of Object.entries(schema))
      if (key !== "sourceUpdates") {
        if (Array.isArray(value)) value.forEach(extend);
        else if (value && typeof value === "object") extend(value);
      }
  };
  extend(tool?.parameters);
}
