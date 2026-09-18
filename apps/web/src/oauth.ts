export type LoginProvider = "google" | "github";
export const callbackPath = "/auth/callback";

export function loginOptions(provider: LoginProvider, origin: string) {
  return {
    provider,
    options: {
      redirectTo: new URL(callbackPath, origin).href,
      scopes: provider === "google" ? "openid email profile" : "user:email",
    },
  };
}

/** Never render provider-supplied error descriptions or redirect destinations. */
export async function finishOAuth(
  url: URL,
  exchange: (code: string) => Promise<{ error: unknown }>,
) {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const error = url.searchParams.get("error") || fragment.get("error");
  const code = url.searchParams.get("code");
  const handled = url.pathname === callbackPath || !!error || !!code;
  if (!handled) return { handled: false, notice: "" };
  if (error)
    return {
      handled: true,
      notice:
        error === "access_denied"
          ? "Sign-in was cancelled. Choose a sign-in option to try again."
          : "We couldn’t complete sign-in. Please try again.",
    };
  if (code) {
    try {
      const result = await exchange(code);
      if (!result.error) return { handled: true, notice: "" };
    } catch {
      // Keep the form available after network failure or expired PKCE state.
    }
  }
  return {
    handled: true,
    notice:
      "This account link has expired or is incomplete. Please sign in or request a new password reset link.",
  };
}
