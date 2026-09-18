export type PendingUpload = {
  id: string;
  file: File;
  error?: string;
  /** Per-scope insertion order; older records may omit it until read. */
  order?: number;
};

function hasOrder(entry: PendingUpload) {
  return (
    typeof entry.order === "number" &&
    Number.isSafeInteger(entry.order) &&
    entry.order >= 0
  );
}

/**
 * Sort a queue by its durable insertion order. Records written before the
 * order field existed are sorted by ID as a deterministic migration fallback.
 * The returned positions are contiguous so a subsequent retry can preserve
 * the recovered order even while the legacy records are being upgraded.
 */
export function orderPendingUploads(entries: PendingUpload[]) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aOrdered = hasOrder(a.entry);
      const bOrdered = hasOrder(b.entry);
      if (aOrdered !== bOrdered) return aOrdered ? 1 : -1;
      if (aOrdered && bOrdered && a.entry.order !== b.entry.order)
        return a.entry.order! - b.entry.order!;
      if (!aOrdered && a.entry.id !== b.entry.id)
        return a.entry.id < b.entry.id ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ entry }, order) => ({ ...entry, order }));
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("woolgather-composer-uploads", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("files", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "This browser could not preserve the upload. Keep this page open and retry.",
        ),
      );
  });
}
export async function uploadQueue(
  key: string,
  change?: { put?: PendingUpload; remove?: string },
) {
  const db = await database();
  try {
    return await new Promise<PendingUpload[]>((resolve, reject) => {
      // Reads also use a write transaction so records created before the
      // durable order field can be upgraded in the same atomic operation.
      const tx = db.transaction("files", "readwrite");
      const store = tx.objectStore("files");
      let result: PendingUpload[] = [];
      const request = store.getAll();
      request.onsuccess = () => {
        const scoped = request.result.filter((entry) => entry.key === key);
        // Normalize all existing records before applying the change. This
        // persists the deterministic legacy fallback and gives retries a
        // stable position across unmount/reopen cycles.
        const ordered = orderPendingUploads(scoped);
        for (const [index, entry] of ordered.entries()) {
          const prior = scoped.find((candidate) => candidate.id === entry.id);
          if (prior?.order !== index) store.put({ ...entry, key });
        }
        let next = ordered;
        if (change?.put) {
          const existing = next.find((entry) => entry.id === change.put!.id);
          const entry = {
            ...change.put,
            order: existing?.order ?? next.length,
          };
          store.put({ ...entry, key });
          next = [
            ...next.filter((candidate) => candidate.id !== entry.id),
            entry,
          ];
        }
        if (change?.remove) {
          store.delete(change.remove);
          next = next.filter((entry) => entry.id !== change.remove);
        }
        result = orderPendingUploads(next);
      };
      const fail = () =>
        reject(
          new Error(
            "The upload recovery copy could not be saved. Please retry.",
          ),
        );
      tx.oncomplete = () => resolve(result);
      tx.onerror = fail;
      tx.onabort = fail;
    });
  } finally {
    db.close();
  }
}
