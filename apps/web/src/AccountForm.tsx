import { Input } from "@/components/ui/input";
import { Feedback } from "./ui/Toast";
import { updatePassword } from "./account/passwordChange";
import { Badge } from "./ui/Badge";
import { lastSignIn, pendingSignIn, rememberSignIn } from "./signInHistory";
import { useEffect, useState, useRef, type FormEvent } from "react";
import { collectPasskey } from "./account/passkeyAutofill";
import { passkeySupport, passkeyMessage } from "./account/passkeys";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight } from "lucide-react";
import { Button, ProviderButton } from "./ui/Button";
import { loginOptions, callbackPath, type LoginProvider } from "./oauth";
import { getSignInNotice } from "./client";
import {
  prepareAccountSignIn,
  recordAccountRedirect,
  clearAccountRedirect,
} from "./account/sessionPool";

export function AccountForm({
  auth,
  recovering,
  onRecovered,
}: {
  auth: SupabaseClient;
  recovering: boolean;
  onRecovered: () => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(() =>
    new URLSearchParams(location.search).get("auth") === "create"
      ? "signup"
      : "signin",
  );
  const [busy, updateBusy] = useState(false);
  const busyRef = useRef(false);
  function setBusy(value: boolean) {
    busyRef.current = value;
    updateBusy(value);
  }
  const mounted = useRef(true);
  const [notice, setNotice] = useState(getSignInNotice);
  const [updated, setUpdated] = useState(false);
  const [email, setEmail] = useState("");
  const [lastUsed] = useState(lastSignIn);
  const passkeyRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      passkeyRequest.current?.abort();
    };
  }, []);
  function stopPasskey() {
    passkeyRequest.current?.abort();
    passkeyRequest.current = null;
  }
  async function passkeySignIn(
    conditional = false,
    request = new AbortController(),
  ) {
    if (busyRef.current) return;
    stopPasskey();
    passkeyRequest.current = request;
    let claimed = !conditional;
    if (claimed) {
      setBusy(true);
      setNotice("");
    }
    try {
      if (conditional) {
        const available =
          await PublicKeyCredential.isConditionalMediationAvailable?.();
        if (!available || request.signal.aborted) return;
      }
      const assertion = await collectPasskey(
        auth.auth.passkey,
        request.signal,
        conditional,
      );
      if (
        request.signal.aborted ||
        !mounted.current ||
        (conditional && busyRef.current)
      )
        return;
      // The browser has finished. Busy-state effect cleanup must not cancel verification.
      passkeyRequest.current = null;
      claimed = true;
      setBusy(true);
      setNotice("");
      pendingSignIn(null);
      await prepareAccountSignIn();
      if (!mounted.current) return;
      const { data, error } =
        await auth.auth.passkey.verifyAuthentication(assertion);
      if (error) throw error;
      if (data?.session) rememberSignIn("passkey");
    } catch (error) {
      // Background capability/network/cancellation failures never interrupt typing.
      if (mounted.current && claimed && !request.signal.aborted)
        setNotice(passkeyMessage(error));
    } finally {
      if (passkeyRequest.current === request) passkeyRequest.current = null;
      if (mounted.current && claimed) {
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (recovering || mode !== "signin" || busy || passkeySupport()) return;
    const request = new AbortController();
    void passkeySignIn(true, request);
    return () => {
      if (passkeyRequest.current === request) stopPasskey();
    };
  }, [auth, mode, recovering, busy]);
  const signup = mode === "signup";
  const forgot = !recovering && mode === "forgot";
  useEffect(() => {
    const restore = () => setBusy(false);
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  function switchMode(next: typeof mode) {
    stopPasskey();
    setMode(next);
    setNotice("");
  }
  async function socialSignIn(provider: LoginProvider) {
    if (busyRef.current) return;
    stopPasskey();
    pendingSignIn(provider);
    setBusy(true);
    setNotice("");
    try {
      await prepareAccountSignIn();
      recordAccountRedirect(
        "signin",
        `Sign in with ${provider === "google" ? "Google" : "GitHub"}`,
      );
      const { error } = await auth.auth.signInWithOAuth(
        loginOptions(provider, location.origin),
      );
      if (error) throw error;
    } catch {
      clearAccountRedirect();
      pendingSignIn(null);
      setNotice(
        "Unable to open sign-in. Please check your connection and try again.",
      );
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current) return;
    stopPasskey();
    pendingSignIn(null);
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") || "");
    if (recovering && password !== data.get("confirmPassword")) {
      setNotice("Your passwords don’t match. Please enter them again.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      if (!recovering) await prepareAccountSignIn();
      if (recovering) {
        const { error } = await updatePassword(auth, { password }, "changed");
        if (error) throw error;
        setUpdated(true);
        setNotice("Your password has been updated.");
      } else if (forgot) {
        recordAccountRedirect("recovery", email.trim());
        const { error } = await auth.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: new URL(callbackPath, location.origin).href,
        });
        if (error) throw error;
        setNotice(
          "If an account uses that email, you’ll receive a password reset link. Open it in this browser to choose a new password.",
        );
      } else {
        if (signup) recordAccountRedirect("confirmation", email.trim());
        const credentials = { email: email.trim(), password };
        const result = signup
          ? await auth.auth.signUp({
              ...credentials,
              options: {
                emailRedirectTo: new URL(callbackPath, location.origin).href,
              },
            })
          : await auth.auth.signInWithPassword(credentials);
        if (result.error) throw result.error;
        if (!signup && result.data.session) rememberSignIn("email");
        if (signup && !result.data.session)
          setNotice(
            "Check your email to confirm your account, then come back to sign in.",
          );
      }
    } catch (error) {
      setNotice(
        forgot
          ? "We couldn’t send the reset link. Please try again shortly."
          : recovering
            ? "We couldn’t update your password. Use at least 8 characters and a different password, or request a fresh reset link if this one has expired."
            : error instanceof Error
              ? error.message
              : "Unable to sign in.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function leaveRecovery() {
    setBusy(true);
    try {
      const { error } = await auth.auth.signOut({ scope: "local" });
      if (error) throw error;
      onRecovered();
    } catch {
      setNotice("Unable to return to sign-in. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="auth-card" onSubmit={submit} aria-labelledby="auth-title">
      <h1 id="auth-title">
        {recovering
          ? "A fresh start."
          : forgot
            ? "Forgot your password?"
            : signup
              ? "Make yourself at home."
              : "Welcome back."}
      </h1>
      <p>
        {recovering
          ? "Choose a new password for your account."
          : forgot
            ? "We’ll email you a link to reset it."
            : signup
              ? "Keep your ideas, talk them through, and build a plan. Start free."
              : "Pick up where your thoughts left off."}
      </p>
      {!recovering && !forgot && (
        <>
          <div
            role="group"
            className="social-signin"
            aria-label="Other sign-in options"
          >
            {(["google", "github"] as const)
              .filter(
                (provider) =>
                  provider !== "google" ||
                  import.meta.env.DEV ||
                  import.meta.env.VITE_GOOGLE_AUTH_ENABLED === "true",
              )
              .map((provider) => (
                <div className="signin-method" key={provider}>
                  <ProviderButton
                    provider={provider}
                    disabled={busy}
                    onClick={() => socialSignIn(provider)}
                    aria-describedby={
                      !signup && lastUsed === provider
                        ? `last-used-${provider}`
                        : undefined
                    }
                  />
                  {!signup && lastUsed === provider && (
                    <Badge
                      tone="accent"
                      className="signin-method-badge"
                      id={`last-used-${provider}`}
                      title="Most recent successful sign-in on this browser"
                    >
                      Last used
                    </Badge>
                  )}
                </div>
              ))}
          </div>
          <div className="auth-divider">
            <span>or use email</span>
            {!signup && lastUsed === "email" && (
              <Badge
                tone="accent"
                title="Most recent successful sign-in on this browser"
              >
                Last used
              </Badge>
            )}
          </div>
        </>
      )}
      {!recovering && (
        <label>
          Email
          <Input
            name="email"
            type="email"
            autoComplete={
              !signup && !forgot && !passkeySupport()
                ? "username webauthn"
                : "email"
            }
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
      )}
      {!forgot && !updated && (
        <label>
          {recovering ? "New password" : "Password"}
          <Input
            key={`${mode}-${recovering}`}
            name="password"
            type="password"
            minLength={signup || recovering ? 8 : undefined}
            autoComplete={
              signup || recovering ? "new-password" : "current-password"
            }
            required
            placeholder={
              signup || recovering
                ? "At least 8 characters"
                : "Enter your password"
            }
          />
        </label>
      )}
      {recovering && !updated && (
        <label>
          Confirm new password
          <Input
            name="confirmPassword"
            type="password"
            minLength={8}
            autoComplete="new-password"
            required
            placeholder="Enter it once more"
          />
        </label>
      )}
      {!recovering && !forgot && !signup && (
        <div className="auth-help">
          {!passkeySupport() && (
            <Button
              variant="inline"
              disabled={busy}
              onClick={() => void passkeySignIn()}
            >
              Use a passkey
            </Button>
          )}
          <Button
            variant="inline"
            disabled={busy}
            onClick={() => switchMode("forgot")}
          >
            Forgot password?
          </Button>
        </div>
      )}
      {notice && <Feedback message={notice} tone="info" />}
      {updated ? (
        <Button variant="primary" onClick={onRecovered}>
          Continue to workspace <ArrowRight />
        </Button>
      ) : (
        <Button variant="primary" type="submit" disabled={busy}>
          {busy
            ? "One moment…"
            : recovering
              ? "Update password"
              : forgot
                ? "Send reset link"
                : signup
                  ? "Create account"
                  : "Sign in"}
          <ArrowRight />
        </Button>
      )}
      <div className="auth-switch">
        {recovering ? (
          !updated && (
            <Button variant="inline" disabled={busy} onClick={leaveRecovery}>
              Back to sign in
            </Button>
          )
        ) : forgot ? (
          <Button
            variant="inline"
            disabled={busy}
            onClick={() => switchMode("signin")}
          >
            Back to sign in
          </Button>
        ) : (
          <>
            {signup ? "Already have an account?" : "New here?"}{" "}
            <Button
              variant="inline"
              disabled={busy}
              onClick={() => switchMode(signup ? "signin" : "signup")}
            >
              {signup ? "Sign in" : "Create an account"}
            </Button>
          </>
        )}
      </div>
      {signup && !recovering && (
        <p className="muted auth-terms">
          By creating an account, you agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer">
            Terms
          </a>
          . Read how we handle your data in{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer">
            Privacy
          </a>
          .
        </p>
      )}
    </form>
  );
}
