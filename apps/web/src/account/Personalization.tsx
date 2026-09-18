import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Shuffle, X } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import {
  Avatar,
  avatarId,
  avatars,
  shuffledAvatar,
  type AvatarSelection,
} from "./Avatar";
import { displayName } from "./model";

type EditorProps = {
  user: User;
  busy: boolean;
  onSave: (data: Record<string, string>) => void;
  onDirty: (dirty: boolean) => void;
};
export function ProfileEditor({ user, busy, onSave, onDirty }: EditorProps) {
  const [name, setName] = useState(() => displayName(user));
  const [avatar, setAvatar] = useState<AvatarSelection>(() => avatarId(user));
  const savedName = displayName(user);
  const savedAvatar = avatarId(user);
  useEffect(() => {
    setName(savedName);
    setAvatar(savedAvatar);
  }, [savedName, savedAvatar]);
  const dirty = name !== displayName(user) || avatar !== avatarId(user);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <form
      className="profile-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && name.trim())
          onSave({ display_name: name.trim(), avatar_id: avatar });
      }}
    >
      <div className="account-setting-row profile-avatar-row">
        <div className="account-setting-copy">
          <h3>Profile picture</h3>
          <p>Click to shuffle through our collection.</p>
        </div>
        <div className="avatar-editor-control">
          <Button
            variant="surface"
            className="avatar-shuffle relative grid size-14 place-items-center rounded-full"
            disabled={busy}
            aria-label={`Shuffle profile picture. Current: ${avatar === "initials" ? "Initials" : avatars.find((a) => a.id === avatar)?.name}`}
            onClick={() => setAvatar(shuffledAvatar(avatar))}
          >
            <Avatar
              user={{
                ...user,
                user_metadata: { ...user.user_metadata, display_name: name },
              }}
              value={avatar}
              large
            />
            <span className="avatar-shuffle-overlay" aria-hidden="true">
              <Shuffle className="size-[18px]" />
            </span>
          </Button>
          {avatar !== "initials" && (
            <IconButton
              className="avatar-clear rounded-full border-border bg-secondary hover:bg-accent [@media(pointer:coarse)]:size-11"
              size="icon-xs"
              aria-label="Clear avatar"
              title="Clear avatar"
              disabled={busy}
              onClick={() => setAvatar("initials")}
            >
              <X />
            </IconButton>
          )}
        </div>
      </div>
      <label className="account-setting-row profile-name-row">
        <span>Display name</span>
        <Input
          aria-label="Display name"
          value={name}
          maxLength={80}
          required
          autoComplete="nickname"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {dirty && (
        <div
          className="settings-form-actions"
          aria-label="Unsaved profile changes"
        >
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              setName(displayName(user));
              setAvatar(avatarId(user));
            }}
          >
            Discard
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
export function PreferencesEditor({
  user,
  busy,
  onSave,
  onDirty,
}: EditorProps) {
  const initialMotion =
    user.user_metadata.motion === "reduce" ? "reduce" : "system";
  const initialContrast =
    user.user_metadata.contrast === "more" ? "more" : "system";
  const [motion, setMotion] = useState(initialMotion);
  const [contrast, setContrast] = useState(initialContrast);
  useEffect(() => {
    setMotion(initialMotion);
    setContrast(initialContrast);
  }, [initialMotion, initialContrast]);
  const dirty = motion !== initialMotion || contrast !== initialContrast;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSave({ motion, contrast });
      }}
    >
      <div className="account-setting-row">
        <div className="account-setting-copy">
          <h3>Motion</h3>
          <p>Reduce decorative animation.</p>
        </div>
        <Select
          label="Motion"
          value={motion}
          onValueChange={setMotion}
          disabled={busy}
          options={[
            { value: "system", label: "Follow device" },
            { value: "reduce", label: "Reduce motion" },
          ]}
        />
      </div>
      <div className="account-setting-row">
        <div className="account-setting-copy">
          <h3>Contrast</h3>
          <p>Make text and boundaries more distinct.</p>
        </div>
        <Select
          label="Contrast"
          value={contrast}
          onValueChange={setContrast}
          disabled={busy}
          options={[
            { value: "system", label: "Follow device" },
            { value: "more", label: "Increase contrast" },
          ]}
        />
      </div>
      {dirty && (
        <div
          className="settings-form-actions"
          aria-label="Unsaved preference changes"
        >
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              setMotion(initialMotion);
              setContrast(initialContrast);
            }}
          >
            Discard
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
