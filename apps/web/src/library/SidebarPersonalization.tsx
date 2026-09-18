import { useState } from "react";
import { Checkbox } from "../ui/Checkbox";
import {
  ArrowUp,
  ArrowDown,
  PinOff,
  Folder,
  Lightbulb,
  PanelsTopLeft,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button, IconButton } from "../ui/Button";
import { Feedback } from "../ui/Toast";
import {
  defaultSidebarPreferences,
  sidebarShortcuts,
  setShortcut,
  movePin,
  setPin,
  pinKey,
  type ResolvedPin,
  type SidebarPreferences,
} from "./sidebarPreferences";

export function SidebarPersonalization({
  preferences: savedPreferences,
  pins: savedPins,
  busy,
  error,
  onSave,
  onClose,
}: {
  preferences: SidebarPreferences;
  pins: ResolvedPin[];
  busy: boolean;
  error: string;
  onSave: (
    update: (current: SidebarPreferences) => SidebarPreferences,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const [preferences, setPreferences] = useState(savedPreferences);
  const pins = preferences.pins.flatMap((pin) => {
    const resolved = savedPins.find((saved) => pinKey(saved) === pinKey(pin));
    return resolved ? [resolved] : [];
  });
  const onChange = setPreferences;
  async function save() {
    if (await onSave(() => preferences)) onClose();
  }
  return (
    <Modal
      title="Personalize sidebar"
      className="sidebar-personalization"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button
            variant="quiet"
            disabled={
              busy || (!preferences.hidden.length && !preferences.pins.length)
            }
            onClick={() => void onChange(defaultSidebarPreferences)}
          >
            Reset to default
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <p className="muted sidebar-preference-intro">
        Choose your shortcuts, then save. Hiding a shortcut doesn't remove its
        contents.
      </p>
      <fieldset className="sidebar-shortcut-options" disabled={busy}>
        <legend>Shortcuts</legend>
        <div className="sidebar-fixed-shortcut">
          <span>Workspace</span>
          <small>Always shown</small>
        </div>
        {sidebarShortcuts.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <Checkbox
              checked={!preferences.hidden.includes(key)}
              onCheckedChange={(visible) => {
                void onChange((current) => setShortcut(current, key, visible));
              }}
            />
          </label>
        ))}
      </fieldset>
      <section className="sidebar-pin-settings" aria-label="Pinned items">
        <h3>Pinned items</h3>
        {pins.length ? (
          pins.map((pin, index) => {
            const Icon =
              pin.kind === "folder"
                ? Folder
                : pin.kind === "idea"
                  ? Lightbulb
                  : PanelsTopLeft;
            return (
              <div className="sidebar-pin-setting" key={pinKey(pin)}>
                <Icon size={18} aria-hidden="true" />
                <span className="sidebar-pin-name">
                  {pin.name}
                  <small>
                    {pin.kind === "folder"
                      ? "Folder"
                      : pin.kind === "idea"
                        ? "Idea"
                        : "Project"}
                  </small>
                </span>
                <IconButton
                  aria-label={`Move ${pin.name} up`}
                  disabled={busy || index === 0}
                  onClick={() =>
                    void onChange((current) =>
                      movePin(current, pinKey(pin), pinKey(pins[index - 1])),
                    )
                  }
                >
                  <ArrowUp size={16} />
                </IconButton>
                <IconButton
                  aria-label={`Move ${pin.name} down`}
                  disabled={busy || index === pins.length - 1}
                  onClick={() =>
                    void onChange((current) =>
                      movePin(current, pinKey(pin), pinKey(pins[index + 1])),
                    )
                  }
                >
                  <ArrowDown size={16} />
                </IconButton>
                <IconButton
                  aria-label={`Unpin ${pin.name}`}
                  disabled={busy}
                  onClick={() =>
                    void onChange((current) => setPin(current, pin, false))
                  }
                >
                  <PinOff size={16} />
                </IconButton>
              </div>
            );
          })
        ) : (
          <p className="muted">
            Pin folders, ideas or projects from their action menus.
          </p>
        )}
      </section>
      {error && <Feedback tone="error" message={error} />}
    </Modal>
  );
}
