import { planOffer } from "../../../../packages/domain/src/plans";
import { usePlan } from "./PlanProvider";
import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  Check,
  ChevronsUpDown,
  LogOut,
  Settings,
  UserRound,
  UsersRound,
  Plus,
  BookOpen,
} from "lucide-react";
import { Button } from "../ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import { Avatar } from "./Avatar";
import { displayName, type SettingsSection } from "./model";
import {
  ACCOUNT_LIMIT,
  addAccount,
  savedAccounts,
  switchAccount,
  type SavedAccount,
} from "./sessionPool";
import "./account.css";
export function AccountMenu({
  user,
  onSettings,
  onSignOut,
  onGuide,
  compact = false,
}: {
  user: User;
  onSettings: (section: SettingsSection) => void;
  onSignOut: () => void;
  onGuide?: () => void;
  compact?: boolean;
}) {
  const { plan } = usePlan();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setAccounts(await savedAccounts());
    } catch {
      setError("Your accounts couldn’t be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`account-menu-anchor${compact ? " account-menu-compact" : ""}`}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) void load();
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="quiet"
              size={compact ? "icon" : "default"}
              className={
                compact
                  ? "account-mobile-trigger rounded-full p-0"
                  : "flex h-auto w-full justify-start gap-2 p-2 text-left"
              }
              aria-label={
                compact ? "Account menu" : `${displayName(user)}. Account menu`
              }
            />
          }
        >
          <Avatar user={user} />
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm font-medium">
                  {displayName(user)}
                </strong>
                <small className="block text-xs text-muted-foreground">
                  {plan?.testing
                    ? "Testing"
                    : plan?.tier === "paid"
                      ? planOffer.paid.name
                      : plan
                        ? "Free"
                        : "Workspace"}
                </small>
              </span>
              <ChevronsUpDown className="size-4" />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={compact ? "bottom" : "top"}
          align="start"
          className="min-w-60"
          aria-label="Your account"
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UsersRound />
              Switch account
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="min-w-64"
              aria-label="Switch account"
            >
              {loading && (
                <p
                  className="px-2 py-1 text-sm text-muted-foreground"
                  role="status"
                >
                  Loading accounts…
                </p>
              )}
              {accounts.map((account) => (
                <DropdownMenuItem
                  key={account.slot}
                  disabled={busy}
                  closeOnClick={false}
                  onClick={() =>
                    account.active
                      ? setOpen(false)
                      : void run(() => switchAccount(account.slot))
                  }
                >
                  <Avatar user={account.user} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {displayName(account.user)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {account.user.email}
                    </span>
                  </span>
                  {account.active && <Check aria-label="Current account" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={
                  busy || loading || !!error || accounts.length >= ACCOUNT_LIMIT
                }
                closeOnClick={false}
                onClick={() => void run(addAccount)}
              >
                <Plus />
                Add account
              </DropdownMenuItem>
              {accounts.length >= ACCOUNT_LIMIT && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Sign out of an account to make room for another.
                </p>
              )}
              {error && (
                <>
                  <p
                    className="px-2 py-1 text-sm text-destructive"
                    role="alert"
                  >
                    {error}
                  </p>
                  <DropdownMenuItem
                    closeOnClick={false}
                    onClick={() => void load()}
                  >
                    Try again
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onSettings("profile")}>
            <UserRound />
            Personalization
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSettings("preferences")}>
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {onGuide && (
            <DropdownMenuItem onClick={onGuide}>
              <BookOpen />
              Getting started
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onSignOut}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
