import { useId } from "react";
import { Folder as FolderIcon, House, Check } from "lucide-react";
import type { Folder } from "../../../../packages/domain/src/library";

export function MoveLocationPicker({
  currentFolderId,
  folderId,
  folders,
  disabled,
  onChange,
}: {
  currentFolderId: string | null | undefined;
  folderId: string;
  folders: Folder[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const group = useId();
  const path = (id: string) =>
    id
      ? "Workspace / " +
        (folders.find((f) => f.id === id)?.name || "Unavailable folder")
      : "Workspace";
  const locations = [
    { id: "", name: "Workspace" },
    ...[...folders].sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return (
    <div className="move-location-picker">
      <div className="move-current-location">
        <span>Current location</span>
        <strong>{path(currentFolderId || "")}</strong>
      </div>
      <fieldset disabled={disabled}>
        <legend>Move to</legend>
        <div className="move-location-list">
          {locations.map((location) => {
            const Icon = location.id ? FolderIcon : House;
            return (
              <label key={location.id} className="move-location-row">
                <input
                  type="radio"
                  name={group}
                  value={location.id}
                  checked={folderId === location.id}
                  onChange={() => onChange(location.id)}
                />
                <Icon size={19} aria-hidden="true" />
                <span>{location.name}</span>
                {location.id === (currentFolderId || "") && (
                  <small>Current</small>
                )}
                <Check
                  className="move-location-check"
                  size={17}
                  aria-hidden="true"
                />
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="move-destination" aria-live="polite">
        <span>Destination</span>
        <strong>{path(folderId)}</strong>
      </div>
    </div>
  );
}
