/** Capability detection only. Auth verifies every credential and session. */
export function passkeySupport() {
  if (import.meta.env.PROD && import.meta.env.VITE_PASSKEYS_ENABLED !== "true")
    return "Passkeys aren’t available at this address yet. Use email or GitHub to sign in.";
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !window.PublicKeyCredential ||
    !navigator.credentials
  )
    return "Passkeys aren’t supported in this browser. Use another sign-in method.";
  // Browser WebAuthn requires a domain RP ID; the local server also accepts an IP.
  if (location.hostname === "127.0.0.1" || location.hostname === "[::1]")
    return "Open woolgather at localhost to use passkeys during local testing.";
  return "";
}

export function passkeyMessage(error: unknown) {
  const e = error as {
    code?: string;
    name?: string;
    cause?: { name?: string };
  } | null;
  if (
    e?.name === "NotAllowedError" ||
    e?.cause?.name === "NotAllowedError" ||
    e?.code === "ERROR_CEREMONY_ABORTED"
  )
    return "The passkey request was cancelled or timed out. You can try again or use another sign-in method.";
  if (e?.code === "passkey_disabled")
    return "Passkeys aren’t available yet. Your other sign-in methods still work.";
  if (
    e?.code === "webauthn_credential_exists" ||
    e?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
  )
    return "This passkey is already connected to your account.";
  if (e?.code === "too_many_passkeys")
    return "You’ve reached the passkey limit. Remove an unused passkey before adding another.";
  if (e?.code === "ERROR_INVALID_DOMAIN" || e?.code === "ERROR_INVALID_RP_ID")
    return "This passkey can’t be used at this web address. Open woolgather at its usual address and try again.";
  if (
    e?.code === "webauthn_challenge_expired" ||
    e?.code === "webauthn_challenge_not_found"
  )
    return "That passkey request has expired. Please try again.";
  return "We couldn’t complete the passkey request. Try again or use another sign-in method.";
}
