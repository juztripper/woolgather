import { useRef, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Feedback, useToast } from "../ui/Toast";
import { deletionApi } from "./deletion";
export function DeleteAccount({
  auth,
  user,
  onClose,
}: {
  auth: SupabaseClient;
  user: User;
  onClose: () => void;
}) {
  const requestId = useRef(crypto.randomUUID());
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { notify } = useToast();
  async function send() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await deletionApi(auth, "request", { requestId: requestId.current });
      notify(`Confirmation sent to ${user.email}.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      confirmation
      title="Delete account?"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger-primary"
            disabled={busy}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send confirmation email"}
          </Button>
        </>
      }
    >
      <p>
        We’ll email you a link to permanently delete your account and all its
        projects.
      </p>
      <Feedback message={error} tone="error" />
    </Modal>
  );
}
