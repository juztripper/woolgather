import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentRequest } from "../library/attachments";
import { uploadQueue, type PendingUpload } from "./composerUploads";
import type { ProjectPreviewFile } from "./ProjectFilePreview";

/** Preserve the file until both private storage and its project record agree. */
export function useSourceUploads(
  key: string,
  register: (file: ProjectPreviewFile) => Promise<void>,
) {
  const [entries, setEntries] = useState<PendingUpload[]>([]);
  const [working, setWorking] = useState<string[]>([]);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(new Set<string>());
  const registerRef = useRef(register);
  registerRef.current = register;
  useEffect(() => {
    mounted.current = true;
    void uploadQueue(key)
      .then((saved) => {
        if (mounted.current)
          setEntries(
            saved.map((entry) => ({
              ...entry,
              error:
                entry.error ||
                "Upload interrupted. Retry to finish saving this source.",
            })),
          );
      })
      .catch((cause) => {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not restore source uploads.",
          );
      });
    return () => {
      mounted.current = false;
    };
  }, [key]);
  const run = useCallback(
    async (entry: PendingUpload) => {
      if (inFlight.current.has(entry.id)) return;
      inFlight.current.add(entry.id);
      if (mounted.current) setWorking([...inFlight.current]);
      try {
        const file = (await (
          await attachmentRequest(entry.id, entry.file)
        ).json()) as ProjectPreviewFile;
        await registerRef.current(file);
        const saved = await uploadQueue(key, { remove: entry.id });
        if (mounted.current) setEntries(saved);
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : "Could not save this source. Retry when ready.";
        const failed = { ...entry, error: message };
        await uploadQueue(key, { put: failed }).catch(() => undefined);
        if (mounted.current) {
          setEntries((all) =>
            all.map((item) => (item.id === entry.id ? failed : item)),
          );
          setError(message);
        }
      } finally {
        inFlight.current.delete(entry.id);
        if (mounted.current) setWorking([...inFlight.current]);
      }
    },
    [key],
  );
  const add = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      if (
        files.length > 12 ||
        files.some((file) => !file.size || file.size > 20 * 1024 * 1024)
      )
        throw new Error(
          "Choose up to 12 non-empty files, no larger than 20 MB each.",
        );
      const queued: PendingUpload[] = [];
      for (const file of files) {
        const entry = { id: crypto.randomUUID(), file };
        const saved = await uploadQueue(key, { put: entry });
        queued.push(entry);
        if (mounted.current) setEntries(saved);
      }
      for (const entry of queued) await run(entry);
    },
    [key, run],
  );
  const remove = useCallback(
    async (id: string) => {
      if (inFlight.current.has(id)) return;
      const saved = await uploadQueue(key, { remove: id });
      if (mounted.current) setEntries(saved);
    },
    [key],
  );
  return {
    entries,
    working,
    error,
    clearError: () => setError(""),
    add,
    remove,
    retry: (id: string) => {
      const entry = entries.find((item) => item.id === id);
      return entry ? run(entry) : Promise.resolve();
    },
  };
}
