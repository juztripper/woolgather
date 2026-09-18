import type { LoginProvider } from "./oauth";
export type SignInMethod = LoginProvider | "email" | "passkey";
const key = "woolgather:last-sign-in";
const pendingKey = "woolgather:pending-sign-in";
const valid = (value: unknown): value is SignInMethod =>
  value === "google" ||
  value === "github" ||
  value === "email" ||
  value === "passkey";
export function lastSignIn(): SignInMethod | null {
  try {
    const value = localStorage.getItem(key);
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}
export function rememberSignIn(method: SignInMethod) {
  try {
    localStorage.setItem(key, method);
  } catch {
    /* Optional browser hint. */
  }
}
export function pendingSignIn(provider: LoginProvider | null) {
  try {
    if (provider)
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({ provider, at: Date.now() }),
      );
    else sessionStorage.removeItem(pendingKey);
  } catch {
    /* Sign-in remains available without storage. */
  }
}
export function finishSignInHistory(success: boolean) {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    if (
      success &&
      pending &&
      valid(pending.provider) &&
      pending.provider !== "email" &&
      Date.now() - pending.at < 30 * 60_000 &&
      Date.now() >= pending.at
    )
      rememberSignIn(pending.provider);
  } catch {
    /* Ignore unavailable or malformed storage. */
  }
  pendingSignIn(null);
}
