import { stableJson } from "../../../../packages/domain/src/stableJson";
import { useContext, useEffect, useRef, useState } from "react";
import {
  emptyIdeaDocument,
  materializeIdea,
  ideaDocumentSchema,
  type IdeaDocument,
} from "../../../../packages/domain/src/ideaDocument";
import {
  libraryCommandSchema,
  type Idea,
  type Library,
  type LibraryCommand,
} from "../../../../packages/domain/src/library";
import { IdeaLibraryTransport } from "./IdeaLibraryTransport";
import { maxIdeaText } from "../../../../packages/domain/src/ideaBlocks";

export type IdeaValue = { body: string; document: IdeaDocument };
const valueOf = (idea: Idea): IdeaValue =>
  materializeIdea(
    idea.body,
    idea.document
      ? ideaDocumentSchema.parse(idea.document)
      : emptyIdeaDocument(),
  );
const fingerprint = (value: IdeaValue) =>
  stableJson({
    body: value.body,
    document: ideaDocumentSchema.parse(value.document),
  });
export function useIdeaDraft(
  idea: Idea,
  owner: string,
  onSaved: (library: Library) => void,
) {
  const api = useContext(IdeaLibraryTransport);
  const key = `woolgather:idea:${owner}:${idea.id}`;
  const [recovery] = useState(() => {
    try {
      const data = JSON.parse(localStorage.getItem(key) || "null");
      if (
        !data ||
        typeof data.body !== "string" ||
        data.body.length > maxIdeaText ||
        !Number.isInteger(data.revision)
      )
        return null;
      return {
        value: materializeIdea(
          data.body,
          data.document
            ? ideaDocumentSchema.parse(data.document)
            : valueOf(idea).document,
        ),
        revision: data.revision,
      };
    } catch {
      return null;
    }
  });
  const [saved, setSaved] = useState(idea);
  const readOnly = !!saved.projectId || saved.trashed || !!saved.archived;
  const [value, setValue] = useState<IdeaValue>(() =>
    readOnly ? valueOf(idea) : recovery?.value || valueOf(idea),
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [latest, setLatest] = useState<Idea | null>(null);
  const current = useRef(value);
  current.current = value;
  const acknowledged = useRef(saved);
  acknowledged.current = saved;
  const baseRevision = useRef(recovery?.revision ?? idea.revision);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const flight = useRef<Promise<boolean> | null>(null);
  const [initialPending] = useState(() => {
    try {
      const parsed = libraryCommandSchema.safeParse(
        JSON.parse(localStorage.getItem(key + ":pending") || "null"),
      );
      return parsed.success &&
        parsed.data.targetId === idea.id &&
        parsed.data.type === "save_idea"
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const pending = useRef<LibraryCommand | null>(initialPending);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = fingerprint(value) !== fingerprint(valueOf(saved));
  function writeRecovery(next: IdeaValue) {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ ...next, revision: baseRevision.current }),
      );
    } catch {
      setError(
        "This browser could not keep a recovery copy. Keep the idea open until saving succeeds.",
      );
    }
  }
  function edit(next: IdeaValue) {
    if (readOnly) return;
    current.current = next;
    setValue(next);
    writeRecovery(next);
  }
  function clearPending() {
    pending.current = null;
    try {
      localStorage.removeItem(key + ":pending");
    } catch {}
  }
  async function save(): Promise<boolean> {
    if (flight.current) return flight.current;
    if (readOnly) return true;
    if (latestRef.current) return false;
    if (
      !pending.current &&
      fingerprint(current.current) ===
        fingerprint(valueOf(acknowledged.current))
    )
      return true;
    if (
      !pending.current &&
      baseRevision.current !== acknowledged.current.revision
    ) {
      setLatest(acknowledged.current);
      setError(
        "This idea changed since your recovery draft. Compare both versions before saving.",
      );
      return false;
    }
    const command = pending.current || {
      id: crypto.randomUUID(),
      type: "save_idea" as const,
      targetId: idea.id,
      expectedRevision: acknowledged.current.revision,
      ...current.current,
    };
    pending.current = command;
    try {
      localStorage.setItem(key + ":pending", JSON.stringify(command));
    } catch {}
    setBusy(true);
    setError("");
    const task = (async () => {
      try {
        const receipt = await api<Library>("/library", command);
        const library = await api<Library>("/library");
        const next = library.ideas.find((i) => i.id === idea.id);
        clearPending();
        if (!next) {
          setError(
            "This idea is no longer available. Your local writing is kept.",
          );
          return false;
        }
        if (
          next.revision !==
          receipt.ideas.find((i) => i.id === idea.id)?.revision
        ) {
          setLatest(next);
          setError(
            "This idea changed in another window. Compare the saved version before replacing it.",
          );
          return false;
        }
        acknowledged.current = next;
        baseRevision.current = next.revision;
        if (mounted.current) {
          setSaved(next);
          onSaved(library);
        }
        if (fingerprint(current.current) === fingerprint(valueOf(next))) {
          try {
            localStorage.removeItem(key);
          } catch {}
        } else writeRecovery(current.current);
        return true;
      } catch (e) {
        if (mounted.current) {
          setError((e as Error).message);
          if (
            [409, 422, 404].includes((e as { status?: number }).status || 0)
          ) {
            clearPending();
            if ((e as { status?: number }).status === 409) {
              try {
                const data = await api<Library>("/library");
                setLatest(data.ideas.find((i) => i.id === idea.id) || null);
              } catch {}
            }
          }
        }
        return false;
      } finally {
        flight.current = null;
        if (mounted.current) setBusy(false);
      }
    })();
    flight.current = task;
    return task;
  }
  async function flush() {
    if (!(await save())) return false;
    if (
      fingerprint(current.current) !==
        fingerprint(valueOf(acknowledged.current)) &&
      !(await save())
    )
      return false;
    return (
      fingerprint(current.current) ===
      fingerprint(valueOf(acknowledged.current))
    );
  }
  useEffect(() => {
    if ((!dirty && !pending.current) || readOnly || error || busy || latest)
      return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [value, saved, readOnly, error, busy, latest]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        fingerprint(current.current) !==
        fingerprint(valueOf(acknowledged.current))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  function resolve(keepLocal: boolean) {
    if (!latest) return;
    clearPending();
    baseRevision.current = latest.revision;
    acknowledged.current = latest;
    setSaved(latest);
    if (!keepLocal || latest.projectId || latest.trashed || latest.archived) {
      current.current = valueOf(latest);
      setValue(current.current);
      try {
        localStorage.removeItem(key);
      } catch {}
    } else writeRecovery(current.current);
    latestRef.current = null;
    setLatest(null);
    setError("");
  }
  return {
    value,
    saved,
    readOnly,
    dirty,
    busy,
    error,
    latest,
    edit,
    save,
    flush,
    resolve,
    setError,
    setLatest,
    acknowledged,
    key,
  };
}
