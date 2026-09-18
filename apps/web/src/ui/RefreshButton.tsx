import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { IconButton } from "./Button";

/** Reusable async refresh action; animation lasts exactly as long as the request. */
export function RefreshButton({
  label,
  onRefresh,
  disabled = false,
}: {
  label: string;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <IconButton
      aria-label={refreshing ? `${label}…` : label}
      aria-busy={refreshing}
      disabled={disabled || refreshing}
      onClick={async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }}
    >
      <RefreshCw className={refreshing ? "refresh-icon-spinning" : undefined} />
    </IconButton>
  );
}
