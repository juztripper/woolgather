import { ModalPresence } from "@/ui/Modal";
import { Input } from "@/components/ui/input";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient, PasskeyListItem } from "@supabase/supabase-js";
import { Plus } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { passkeyMessage, passkeySupport } from "./passkeys";

export function PasskeySettings({
  auth,
  busy,
  setBusy,
  hasAlternative,
}: {
  auth: SupabaseClient;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  hasAlternative: boolean;
}) {
  const { notify } = useToast();
  const formId = useId();
  const [items, setItems] = useState<PasskeyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [configured, setConfigured] = useState(true);
  const [editing, setEditing] = useState<{
    key: PasskeyListItem;
    action: "rename" | "remove";
  } | null>(null);
  const [name, setName] = useState("");
  const request = useRef<AbortController | null>(null);
  const support = passkeySupport();
  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const { data, error } = await auth.auth.passkey.list();
      if (error) {
        if (error.code === "passkey_disabled") setConfigured(false);
        throw error;
      }
      setConfigured(true);
      setItems(data || []);
    } catch (error) {
      setLoadError(passkeyMessage(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [auth]);
  async function add() {
    if (busy || support) return;
    setBusy(true);
    setAdding(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const { error } = await auth.auth.registerPasskey({
        options: { signal: controller.signal },
      });
      if (error) throw error;
      notify("Passkey added. You can use it the next time you sign in.");
      await load();
    } catch (error) {
      if (!controller.signal.aborted)
        notify(passkeyMessage(error), { tone: "error" });
    } finally {
      request.current = null;
      setAdding(false);
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing || busy) return;
    if (editing.action === "rename" && !name.trim()) return;
    if (editing.action === "remove" && !hasAlternative && items.length < 2)
      return;
    setBusy(true);
    try {
      const { error } =
        editing.action === "rename"
          ? await auth.auth.passkey.update({
              passkeyId: editing.key.id,
              friendlyName: name.trim(),
            })
          : await auth.auth.passkey.delete({ passkeyId: editing.key.id });
      if (error) throw error;
      notify(
        editing.action === "rename"
          ? "Passkey renamed."
          : "Passkey removed from your account.",
      );
      setEditing(null);
      await load();
    } catch (error) {
      notify(passkeyMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="passkey-section" aria-labelledby="passkeys-title">
      <div className="settings-section-heading settings-heading-actions">
        <div>
          <h3 id="passkeys-title">Passkeys</h3>
          <p>
            Sign in with your fingerprint, face, device PIN or security key.
          </p>
        </div>
        {configured && !loading && !loadError && !support && (
          <Button disabled={busy} onClick={() => void add()}>
            <Plus size={15} /> Add passkey
          </Button>
        )}
      </div>
      {adding && (
        <div className="account-setting-row">
          <p role="status">Adding passkey…</p>
        </div>
      )}
      {loading ? (
        <p className="settings-hint" role="status">
          Loading passkeys…
        </p>
      ) : loadError ? (
        <div className="account-setting-row">
          <p>{loadError}</p>
          <Button disabled={busy} onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {items.length === 0 && (
            <p className="settings-hint">No passkeys added yet.</p>
          )}
          {items.map((key) => (
            <div className="account-setting-row" key={key.id}>
              <div className="account-setting-copy">
                <h3>{key.friendly_name || "Passkey"}</h3>
                <p>
                  {key.last_used_at
                    ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}`
                    : `Added ${new Date(key.created_at).toLocaleDateString()}`}
                </p>
              </div>
              <div className="account-setting-control">
                <Button
                  variant="inline"
                  disabled={busy}
                  aria-label={`Rename ${key.friendly_name || "passkey"}`}
                  onClick={() => {
                    setName(key.friendly_name || "Passkey");
                    setEditing({ key, action: "rename" });
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="inline"
                  disabled={busy || (!hasAlternative && items.length < 2)}
                  title={
                    !hasAlternative && items.length < 2
                      ? "Add another sign-in method before removing your last passkey"
                      : undefined
                  }
                  aria-label={`Remove ${key.friendly_name || "passkey"}`}
                  onClick={() => setEditing({ key, action: "remove" })}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
      {!loading && configured && support && (
        <p className="settings-hint">
          {support}
          {location.hostname === "127.0.0.1" && (
            <>
              {" "}
              <a href="http://localhost:4200/account/security">
                Open localhost
              </a>
            </>
          )}
        </p>
      )}
      <ModalPresence>
        {editing && (
          <Modal
            confirmation={editing.action === "remove"}
            title={
              editing.action === "rename" ? "Rename passkey" : "Remove passkey"
            }
            onClose={() => {
              if (!busy) setEditing(null);
            }}
            footer={
              <>
                <Button disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form={formId}
                  variant={
                    editing.action === "remove" ? "danger-primary" : "primary"
                  }
                  disabled={
                    busy || (editing.action === "rename" && !name.trim())
                  }
                >
                  {busy
                    ? "Saving…"
                    : editing.action === "rename"
                      ? "Save name"
                      : "Remove passkey"}
                </Button>
              </>
            }
          >
            <form id={formId} onSubmit={save}>
              {editing.action === "rename" ? (
                <label>
                  Passkey name
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    required
                    autoFocus
                    disabled={busy}
                  />
                </label>
              ) : (
                <p>
                  You’ll no longer be able to sign in with{" "}
                  {editing.key.friendly_name || "this passkey"}. Your other
                  sign-in methods will still work. You can also remove the saved
                  entry from your password manager.
                </p>
              )}
            </form>
          </Modal>
        )}
      </ModalPresence>
    </section>
  );
}
