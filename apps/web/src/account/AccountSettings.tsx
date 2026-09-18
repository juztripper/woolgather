import { Input } from "@/components/ui/input";
import { ModalPresence } from "@/ui/Modal";
import { VerificationCode } from "../ui/VerificationCode";
import { PasskeySettings } from "./PasskeySettings";
import { PlanSettings } from "./PlanSettings";
import { DeleteAccount } from "./DeleteAccount";
import { changePassword, updatePassword } from "./passwordChange";
import { ProfileEditor, PreferencesEditor } from "./Personalization";
import { recordAccountRedirect, clearAccountRedirect } from "./sessionPool";
import { Feedback, useToast } from "../ui/Toast";
import { RefreshButton } from "../ui/RefreshButton";
import { Disclosure } from "../ui/Disclosure";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Factor,
  SupabaseClient,
  User,
  UserIdentity,
} from "@supabase/supabase-js";
import {
  Check,
  Monitor,
  Settings2,
  ShieldCheck,
  UserRound,
  ContactRound,
  ChevronRight,
  ArrowLeft,
  Plus,
  CreditCard,
  ChartNoAxesCombined,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { getSignInNotice } from "../client";
import { callbackPath, loginOptions, type LoginProvider } from "../oauth";
import { pendingSignIn } from "../signInHistory";
import {
  applyPreferences,
  displayName,
  deviceName,
  rememberSettingsReturn,
  clearSettingsReturn,
  type AccountOverview,
  type AccountSession,
  type SettingsSection,
} from "./model";
import "./account.css";

type Enrollment = { id: string; qr: string; secret: string };
type Pane =
  "password" | "email" | "enroll" | "remove-factor" | "disconnect" | null;
function SectionRow({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="account-setting-row">
      <div className="account-setting-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="account-setting-control">{children}</div>
    </div>
  );
}
function authMessage(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === "reauthentication_needed")
    return "Check your email for a verification code before changing your password. Enter the code below to finish.";
  if (code === "reauthentication_not_valid")
    return "That email verification code is invalid or expired. Request a new code.";
  if (
    code === "current_password_mismatch" ||
    code === "current_password_invalid" ||
    code === "invalid_credentials"
  )
    return "Your current password is incorrect.";
  if (code === "current_password_required")
    return "Enter your current password to make this change.";
  if (code === "same_password")
    return "Choose a password that is different from your current password.";
  if (code === "weak_password")
    return "Use a stronger password with at least 8 characters.";
  if (code === "email_exists" || code === "identity_already_exists")
    return "That sign-in identity belongs to another account. It cannot be connected here.";
  if (code === "manual_linking_disabled")
    return "Connecting another sign-in method is not enabled yet. Your existing sign-in methods still work.";
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit"
  )
    return "Please wait a little before trying again.";
  return "This change could not be completed. Please try again.";
}
export function AccountSettings({
  auth,
  user: initialUser,
  initialSection = "profile",
  onSidebarCustomize,
  onClose,
}: {
  auth: SupabaseClient;
  user: User;
  initialSection?: SettingsSection;
  onSidebarCustomize?: () => void;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<SettingsSection | "close" | null>(
    null,
  );
  const [section, setSection] = useState(initialSection);
  const [comparingPlans, setComparingPlans] = useState(false);
  const comparisonTitle = useRef<HTMLHeadingElement>(null);
  const compared = useRef(false);
  const contentRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section, comparingPlans]);
  useLayoutEffect(() => {
    if (comparingPlans) {
      compared.current = true;
      comparisonTitle.current?.focus({ preventScroll: true });
    } else if (compared.current) {
      contentRef.current
        ?.querySelector<HTMLButtonElement>("[data-compare-plans]")
        ?.focus({ preventScroll: true });
    }
  }, [comparingPlans]);
  const [user, setUser] = useState(initialUser);
  const [overview, setOverview] = useState<AccountOverview>();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(getSignInNotice);
  const [pane, setPane] = useState<Pane>(null);
  const paneTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (pane) paneTitle.current?.focus();
  }, [pane]);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [factor, setFactor] = useState<Factor>();
  const [identity, setIdentity] = useState<UserIdentity>();
  const [code, setCode] = useState("");
  const [nonceSent, setNonceSent] = useState(false);
  const nonceInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (nonceSent) nonceInput.current?.focus();
  }, [nonceSent]);
  async function refresh() {
    const [profile, details, mfa] = await Promise.all([
      auth.auth.getUser(),
      auth.rpc("account_overview"),
      auth.auth.mfa.listFactors(),
    ]);
    if (profile.error) throw profile.error;
    if (details.error) throw details.error;
    if (mfa.error) throw mfa.error;
    setUser(profile.data.user);
    setOverview(details.data as AccountOverview);
    setFactors(mfa.data.all);
  }
  async function load() {
    setLoading(true);
    setError("");
    try {
      await refresh();
    } catch {
      setError("We couldn’t load your account settings. Please try again.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    clearSettingsReturn();
    void load();
  }, [auth]);
  const verified = factors.filter((f) => f.status === "verified");
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(authMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function signOutSession(session: AccountSession) {
    if (session.current) return;
    await run(async () => {
      const result = await auth.rpc("revoke_account_session", {
        session_id: session.id,
      });
      if (result.error) throw result.error;
      setOverview(
        (current) =>
          current && {
            ...current,
            sessions: current.sessions.filter((item) => item.id !== session.id),
          },
      );
      setNotice("Session signed out.");
    });
  }
  function openPane(next: Pane) {
    setPane(next);
    setCode("");
    setError("");
    setNotice("");
    setNonceSent(false);
  }
  async function cancelPane() {
    if (enrollment) {
      await run(async () => {
        const result = await auth.auth.mfa.unenroll({
          factorId: enrollment.id,
        });
        if (result.error) throw result.error;
        setEnrollment(null);
        setPane(null);
        await refresh();
      });
    } else {
      setPane(null);
      setCode("");
      setError("");
    }
  }
  async function close() {
    if (busy) return;
    if (dirty) {
      setLeaving("close");
      return;
    }
    if (enrollment) {
      await run(async () => {
        const result = await auth.auth.mfa.unenroll({
          factorId: enrollment.id,
        });
        if (result.error) throw result.error;
        setEnrollment(null);
        onClose();
      });
    } else onClose();
  }
  async function beginEnrollment() {
    await run(async () => {
      let index = 1;
      while (factors.some((f) => f.friendly_name === `Authenticator ${index}`))
        index++;
      const result = await auth.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${index}`,
        issuer: "woolgather",
      });
      if (result.error) throw result.error;
      setEnrollment({
        id: result.data.id,
        qr: result.data.totp.qr_code,
        secret: result.data.totp.secret,
      });
      setPane("enroll");
      setCode("");
    });
  }
  async function link(provider: LoginProvider) {
    await run(async () => {
      pendingSignIn(null);
      rememberSettingsReturn(user.id);
      recordAccountRedirect("link", user.email);
      const result = await auth.auth.linkIdentity(
        loginOptions(provider, location.origin),
      );
      if (result.error) {
        clearSettingsReturn();
        clearAccountRedirect();
        throw result.error;
      }
    });
  }
  async function submitSecurity(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await run(async () => {
      if (pane === "password") {
        const password = String(data.get("password"));
        if (password !== data.get("confirm")) {
          setError("Your new passwords don’t match.");
          return;
        }
        const outcome = await changePassword(
          () =>
            updatePassword(
              auth,
              {
                password,
                ...(overview?.hasPassword
                  ? { current_password: String(data.get("current")) }
                  : {}),
                ...(data.get("nonce")
                  ? { nonce: String(data.get("nonce")) }
                  : {}),
              },
              overview?.hasPassword ? "changed" : "added",
            ),
          () => auth.auth.reauthenticate(),
          () => setNonceSent(true),
        );
        if (outcome === "code-sent") {
          setNotice(
            "A verification code has been sent to your account email. Enter it to finish saving your password.",
          );
          return;
        }
        setPane(null);
        setNotice(
          overview?.hasPassword
            ? "Your password has been updated."
            : "A password has been added. You can now sign in with your email and password.",
        );
        await refresh();
      } else if (pane === "email") {
        const email = String(data.get("email")).trim();
        if (email === user.email) {
          setError("Enter a different email address.");
          return;
        }
        recordAccountRedirect("email", user.email);
        const result = await auth.auth.updateUser(
          { email },
          { emailRedirectTo: new URL(callbackPath, location.origin).href },
        );
        if (result.error) throw result.error;
        setPane(null);
        setNotice(
          "Check both your current and new email inboxes to confirm the change. Your email stays the same until confirmation is complete.",
        );
        await refresh();
      } else if (pane === "enroll" && enrollment) {
        const result = await auth.auth.mfa.challengeAndVerify({
          factorId: enrollment.id,
          code,
        });
        if (result.error) {
          setError(
            "That code could not be verified. Use the latest six-digit code from your authenticator.",
          );
          return;
        }
        setEnrollment(null);
        setPane(null);
        setCode("");
        setNotice(
          "Your authenticator is connected. You’ll use it the next time you sign in.",
        );
        await refresh();
      } else if (pane === "remove-factor" && factor) {
        const verified = await auth.auth.mfa.challengeAndVerify({
          factorId: factor.id,
          code,
        });
        if (verified.error) {
          setError("Enter a valid code from this authenticator to remove it.");
          return;
        }
        const result = await auth.auth.mfa.unenroll({ factorId: factor.id });
        if (result.error) throw result.error;
        setPane(null);
        setCode("");
        setNotice("Authenticator removed.");
        await refresh();
      } else if (pane === "disconnect" && identity) {
        const result = await auth.auth.unlinkIdentity(identity);
        if (result.error) throw result.error;
        setPane(null);
        setNotice("Sign-in method disconnected.");
        await refresh();
      }
    });
  }
  function switchSection(next: SettingsSection) {
    if (busy || enrollment || next === section) return;
    if (dirty) {
      setLeaving(next);
      return;
    }
    setSection(next);
    setPane(null);
    setError("");
    setNotice("");
  }
  const title =
    pane === "password"
      ? overview?.hasPassword
        ? "Change password"
        : "Add a password"
      : pane === "email"
        ? "Change email"
        : pane === "enroll"
          ? "Connect an authenticator"
          : pane === "remove-factor"
            ? "Remove authenticator"
            : pane === "disconnect"
              ? "Disconnect sign-in method"
              : "";
  return (
    <>
      <Modal
        title={comparingPlans ? "Choose your plan" : "Settings"}
        className={`account-settings account-settings-reference${comparingPlans ? " account-plan-picker" : ""}`}
        layout="account"
        wide
        onClose={() =>
          comparingPlans ? setComparingPlans(false) : void close()
        }
      >
        <div className="settings-layout">
          {!comparingPlans && (
            <aside className="settings-navigation">
              <nav aria-label="Settings sections">
                {(
                  [
                    { id: "preferences", label: "General", Icon: Settings2 },
                    {
                      id: "profile",
                      label: "Personalization",
                      Icon: UserRound,
                    },
                    { id: "billing", label: "Billing", Icon: CreditCard },
                    { id: "usage", label: "Usage", Icon: ChartNoAxesCombined },
                    {
                      id: "security",
                      label: "Security and login",
                      Icon: ShieldCheck,
                    },
                    { id: "account", label: "Account", Icon: ContactRound },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <Button
                    key={id}
                    variant="navigation"
                    size="sm"
                    className="min-w-0 rounded-xl active:not-disabled:scale-100 max-sm:justify-center max-sm:px-2"
                    aria-label={label}
                    aria-current={section === id ? "page" : undefined}
                    disabled={busy || !!enrollment}
                    onClick={() => switchSection(id)}
                  >
                    <Icon size={18} />
                    <span className="settings-nav-full">{label}</span>
                    <span className="settings-nav-short" aria-hidden="true">
                      {id === "profile"
                        ? "Personalize"
                        : id === "security"
                          ? "Security"
                          : label}
                    </span>
                  </Button>
                ))}
              </nav>
            </aside>
          )}
          <section
            ref={contentRef}
            tabIndex={0}
            className="settings-content account-settings-content"
            aria-label={
              comparingPlans
                ? "Choose your plan"
                : section === "security"
                  ? "Security and login"
                  : section === "profile"
                    ? "Personalization"
                    : section === "account"
                      ? "Account"
                      : section === "billing"
                        ? "Billing"
                        : section === "usage"
                          ? "Usage"
                          : "General"
            }
          >
            {loading ? (
              <p role="status">Loading your settings…</p>
            ) : !overview ? (
              <>
                <p role="alert">{error}</p>
                <Button onClick={() => void load()}>Try again</Button>
              </>
            ) : (
              <>
                {pane ? (
                  <>
                    <Button
                      variant="inline"
                      disabled={busy}
                      onClick={() => void cancelPane()}
                    >
                      <ArrowLeft size={16} />
                      Back to security
                    </Button>
                    <h2
                      ref={paneTitle}
                      tabIndex={-1}
                      className="settings-title"
                    >
                      {title}
                    </h2>
                    <form className="security-form" onSubmit={submitSecurity}>
                      {pane === "password" && (
                        <>
                          <p>
                            Use a unique password with at least 8 characters. A
                            password manager can help you create and keep it.
                          </p>
                          {overview.hasPassword && (
                            <label>
                              Current password
                              <Input
                                name="current"
                                type="password"
                                autoComplete="current-password"
                                required
                              />
                            </label>
                          )}
                          <label>
                            New password
                            <Input
                              name="password"
                              type="password"
                              minLength={8}
                              autoComplete="new-password"
                              required
                            />
                          </label>
                          <label>
                            Confirm new password
                            <Input
                              name="confirm"
                              type="password"
                              minLength={8}
                              autoComplete="new-password"
                              required
                            />
                          </label>
                          {nonceSent && (
                            <label>
                              Email verification code
                              <Input
                                ref={nonceInput}
                                name="nonce"
                                autoComplete="one-time-code"
                                inputMode="numeric"
                                required
                              />
                            </label>
                          )}
                          {nonceSent && (
                            <Button
                              variant="inline"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const result =
                                    await auth.auth.reauthenticate();
                                  if (result.error) throw result.error;
                                  setNonceSent(true);
                                  setNotice(
                                    "A verification code has been sent to your account email.",
                                  );
                                })
                              }
                            >
                              Resend code
                            </Button>
                          )}
                        </>
                      )}
                      {pane === "email" && (
                        <>
                          <p>
                            We’ll ask you to confirm the change from both email
                            addresses.
                          </p>
                          <label>
                            Current email
                            <Input
                              type="email"
                              value={user.email || ""}
                              readOnly
                            />
                          </label>
                          <label>
                            New email
                            <Input
                              name="email"
                              type="email"
                              autoComplete="email"
                              required
                            />
                          </label>
                        </>
                      )}
                      {pane === "enroll" && enrollment && (
                        <>
                          <p>
                            Scan this code with your authenticator app, then
                            enter the six-digit code it shows.
                          </p>
                          <img
                            className="mfa-qr"
                            src={
                              enrollment.qr.startsWith("data:image/")
                                ? enrollment.qr
                                : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.qr)}`
                            }
                            alt="Authenticator setup QR code"
                          />
                          <Disclosure title="Can’t scan the code?">
                            <p>
                              Enter this setup key in your authenticator. Keep
                              it private.
                            </p>
                            <code className="mfa-secret">
                              {enrollment.secret}
                            </code>
                          </Disclosure>
                          <p className="settings-hint">
                            Save your authenticator’s backup securely. You can
                            add a second authenticator here as a backup;
                            woolgather does not issue recovery codes yet.
                          </p>
                        </>
                      )}
                      {pane === "remove-factor" && (
                        <p>
                          Enter a code from{" "}
                          {factor?.friendly_name || "this authenticator"} to
                          remove it.{" "}
                          {verified.length === 1
                            ? "This turns off multi-factor authentication for your account."
                            : "Your other authenticators will stay connected."}
                        </p>
                      )}
                      {(pane === "enroll" || pane === "remove-factor") && (
                        <VerificationCode
                          value={code}
                          onChange={setCode}
                          disabled={busy}
                        />
                      )}
                      {pane === "disconnect" && (
                        <p>
                          You’ll no longer be able to sign in with{" "}
                          {identity?.provider === "google"
                            ? "Google"
                            : "GitHub"}
                          . Your projects stay in this account. Make sure you
                          can use another connected sign-in method.
                        </p>
                      )}
                      {error && <Feedback message={error} tone="error" />}
                      {notice && <Feedback message={notice} tone="info" />}
                      <div className="settings-form-actions">
                        <Button
                          disabled={busy}
                          onClick={() => void cancelPane()}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant={
                            pane === "disconnect" || pane === "remove-factor"
                              ? "danger"
                              : "primary"
                          }
                          type="submit"
                          disabled={busy}
                        >
                          {busy
                            ? "Saving…"
                            : pane === "enroll"
                              ? "Verify and enable"
                              : pane === "disconnect"
                                ? "Disconnect"
                                : pane === "remove-factor"
                                  ? "Remove authenticator"
                                  : pane === "email"
                                    ? "Send confirmation"
                                    : "Save password"}
                        </Button>
                      </div>
                    </form>
                  </>
                ) : (
                  <>
                    {comparingPlans ? (
                      <h2
                        ref={comparisonTitle}
                        tabIndex={-1}
                        className="plan-picker-title"
                      >
                        Choose your plan
                      </h2>
                    ) : (
                      <h2 className="settings-title">
                        {section === "profile"
                          ? "Personalization"
                          : section === "preferences"
                            ? "General"
                            : section === "account"
                              ? "Account"
                              : section === "billing"
                                ? "Billing"
                                : section === "usage"
                                  ? "Usage"
                                  : "Security and login"}
                      </h2>
                    )}
                    {section !== "billing" && section !== "usage" && (
                      <p className="settings-intro">
                        {section === "profile"
                          ? "Make your profile your own."
                          : section === "preferences"
                            ? "Make the workspace comfortable for you."
                            : section === "account"
                              ? "Your account details."
                              : "Choose how you sign in and keep your account protected."}
                      </p>
                    )}
                    {error && <Feedback message={error} tone="error" />}
                    {notice && <Feedback message={notice} tone="info" />}
                    {(section === "billing" || section === "usage") && (
                      <PlanSettings
                        key={section}
                        section={section}
                        comparison={comparingPlans}
                        onCompare={() => setComparingPlans(true)}
                      />
                    )}
                    {(section === "profile" || section === "preferences") &&
                      (() => {
                        const Editor =
                          section === "profile"
                            ? ProfileEditor
                            : PreferencesEditor;
                        return (
                          <Editor
                            key={section}
                            user={user}
                            busy={busy}
                            onDirty={setDirty}
                            onSave={(data) =>
                              void run(async () => {
                                const result = await auth.auth.updateUser({
                                  data,
                                });
                                if (result.error) throw result.error;
                                setUser(result.data.user);
                                applyPreferences(result.data.user);
                                setDirty(false);
                                notify("Saved");
                              })
                            }
                          />
                        );
                      })()}
                    {section === "preferences" && onSidebarCustomize && (
                      <SectionRow
                        title="Sidebar"
                        description="Choose shortcuts and arrange your pinned items."
                      >
                        <Button
                          variant="quiet"
                          onClick={onSidebarCustomize}
                          disabled={busy}
                        >
                          Customize <ChevronRight />
                        </Button>
                      </SectionRow>
                    )}
                    {section === "account" && (
                      <>
                        <SectionRow
                          title="Name"
                          description={displayName(user)}
                        >
                          <Button
                            variant="quiet"
                            onClick={() => switchSection("profile")}
                          >
                            Edit <ChevronRight />
                          </Button>
                        </SectionRow>
                        <SectionRow
                          title="Email address"
                          description={
                            <>
                              {user.email}
                              {user.new_email && (
                                <span className="pending-email">
                                  Awaiting confirmation: {user.new_email}
                                </span>
                              )}
                            </>
                          }
                        >
                          <Button
                            disabled={busy}
                            onClick={() => openPane("email")}
                          >
                            Change <ChevronRight />
                          </Button>
                        </SectionRow>
                        <SectionRow
                          title="Delete account"
                          description="Permanently delete your account and all its projects."
                        >
                          <Button
                            variant="danger-primary"
                            onClick={() => setDeleting(true)}
                          >
                            Delete account
                          </Button>
                        </SectionRow>
                      </>
                    )}
                    {section === "security" && (
                      <>
                        <SectionRow
                          title="Password"
                          description={
                            overview.hasPassword
                              ? "A password is set for this account."
                              : "Add a password to also sign in with your email."
                          }
                        >
                          <Button
                            disabled={busy}
                            onClick={() => openPane("password")}
                          >
                            {overview.hasPassword ? "Change" : "Add"}
                            <ChevronRight size={15} />
                          </Button>
                        </SectionRow>
                        <div className="settings-section-heading">
                          <h3>Sign-in methods</h3>
                          <p>
                            These providers identify your account. They do not
                            get access to your projects.
                          </p>
                        </div>
                        {(["google", "github"] as const).map((provider) => {
                          const linked = user.identities?.find(
                            (i) => i.provider === provider,
                          );
                          const canRemove = !!user.identities?.some(
                            (i) =>
                              i.id !== linked?.id &&
                              (i.provider !== "email" || overview.hasPassword),
                          );
                          return (
                            <div className="account-setting-row" key={provider}>
                              <div className="linked-provider">
                                <img
                                  src={`/brand/${provider === "google" ? "google-gradient.png" : "github.svg"}`}
                                  alt=""
                                />
                                <div>
                                  <h3>
                                    {provider === "google"
                                      ? "Google"
                                      : "GitHub"}
                                  </h3>
                                  <p>
                                    {linked
                                      ? linked.identity_data?.email ||
                                        "Connected"
                                      : "Not connected"}
                                  </p>
                                </div>
                              </div>
                              {linked ? (
                                <div className="account-setting-control">
                                  <Badge tone="accent">Connected</Badge>
                                  <Button
                                    variant="inline"
                                    disabled={busy || !canRemove}
                                    title={
                                      !canRemove
                                        ? "Keep at least one working sign-in method"
                                        : undefined
                                    }
                                    onClick={() => {
                                      setIdentity(linked);
                                      openPane("disconnect");
                                    }}
                                  >
                                    Disconnect
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  disabled={busy}
                                  onClick={() => void link(provider)}
                                >
                                  Connect
                                  <Plus size={15} />
                                </Button>
                              )}
                            </div>
                          );
                        })}
                        <PasskeySettings
                          auth={auth}
                          busy={busy}
                          setBusy={setBusy}
                          hasAlternative={
                            overview.hasPassword ||
                            !!user.identities?.some(
                              (i) =>
                                i.provider === "google" ||
                                i.provider === "github",
                            )
                          }
                        />
                        <div className="settings-section-heading">
                          <h3>Multi-factor authentication</h3>
                          <p>
                            Add a code from your authenticator after signing in.
                          </p>
                        </div>
                        <SectionRow
                          title="Authenticator app"
                          description={
                            verified.length
                              ? `${verified.length} authenticator${verified.length === 1 ? "" : "s"} connected. An extra code protects your workspace.`
                              : "Use a six-digit code from an authenticator app."
                          }
                        >
                          <Badge tone={verified.length ? "accent" : "neutral"}>
                            {verified.length ? "On" : "Off"}
                          </Badge>
                          <Button
                            disabled={busy}
                            onClick={() => void beginEnrollment()}
                          >
                            {verified.length ? "Add backup" : "Set up"}
                          </Button>
                        </SectionRow>
                        {factors.map((f) => (
                          <div className="account-setting-row" key={f.id}>
                            <div className="account-setting-copy">
                              <h3>{f.friendly_name || "Authenticator"}</h3>
                              <p>
                                {f.status === "verified"
                                  ? "Verified authenticator"
                                  : "Setup not completed"}
                              </p>
                            </div>
                            <Button
                              variant="inline"
                              disabled={busy}
                              onClick={() => {
                                if (f.status === "verified") {
                                  setFactor(f);
                                  openPane("remove-factor");
                                } else
                                  void run(async () => {
                                    const result = await auth.auth.mfa.unenroll(
                                      {
                                        factorId: f.id,
                                      },
                                    );
                                    if (result.error) throw result.error;
                                    await refresh();
                                    setNotice("Incomplete setup removed.");
                                  });
                              }}
                            >
                              {f.status === "verified"
                                ? "Remove"
                                : "Discard setup"}
                            </Button>
                          </div>
                        ))}
                        <div className="settings-section-heading settings-heading-actions">
                          <div>
                            <h3>Active sessions</h3>
                            <p>
                              Devices signed in to your account. Dates show the
                              last session refresh.
                            </p>
                          </div>
                          <RefreshButton
                            label="Refresh active sessions"
                            disabled={busy}
                            onRefresh={() => run(refresh)}
                          />
                        </div>
                        <div className="account-session-list">
                          {overview.sessions.map((s) => (
                            <div className="account-setting-row" key={s.id}>
                              <Monitor size={20} className="session-icon" />
                              <div className="account-setting-copy">
                                <h3>{deviceName(s.userAgent)}</h3>
                                <p>
                                  Last refreshed{" "}
                                  {new Date(s.lastActiveAt).toLocaleString(
                                    undefined,
                                    { dateStyle: "medium", timeStyle: "short" },
                                  )}
                                </p>
                              </div>
                              {s.current ? (
                                <Badge tone="accent">This device</Badge>
                              ) : (
                                <Button
                                  disabled={busy}
                                  onClick={() => void signOutSession(s)}
                                >
                                  Sign out
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                        <p className="settings-hint">
                          Sign out of this device from the account menu. Signing
                          out another device blocks its next request to your
                          projects.
                        </p>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </Modal>
      <ModalPresence>
        {deleting && overview && (
          <DeleteAccount
            auth={auth}
            user={user}
            onClose={() => setDeleting(false)}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {leaving && (
          <Modal
            confirmation
            title="Discard unsaved changes?"
            onClose={() => setLeaving(null)}
            footer={
              <>
                <Button onClick={() => setLeaving(null)}>Keep editing</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const destination = leaving;
                    setLeaving(null);
                    setDirty(false);
                    if (destination === "close") onClose();
                    else {
                      setSection(destination);
                      setNotice("");
                      setError("");
                    }
                  }}
                >
                  Discard changes
                </Button>
              </>
            }
          >
            <p>Your profile and preferences haven’t been saved yet.</p>
          </Modal>
        )}
      </ModalPresence>
    </>
  );
}
