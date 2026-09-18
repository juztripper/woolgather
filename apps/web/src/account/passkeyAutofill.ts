import type { SupabaseClient } from "@supabase/supabase-js";

type PasskeyApi = SupabaseClient["auth"]["passkey"];
type Options = NonNullable<
  Awaited<ReturnType<PasskeyApi["startAuthentication"]>>["data"]
>["options"];

const decode = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  ).buffer;
const encode = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function requestOptions(
  options: Options,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: decode(options.challenge),
    allowCredentials: options.allowCredentials?.map((item) => ({
      ...item,
      id: decode(item.id),
      transports: item.transports as AuthenticatorTransport[] | undefined,
    })),
  };
}

export function assertionJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: "public-key" as const,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle: response.userHandle ? encode(response.userHandle) : undefined,
    },
  };
}

/** Only collects an assertion. The caller must claim the sign-in operation and
 * recheck the account slot before submitting it to Auth for a session. */
export async function collectPasskey(
  api: PasskeyApi,
  signal: AbortSignal,
  conditional: boolean,
  getCredential = (options: CredentialRequestOptions) =>
    navigator.credentials.get(options),
) {
  const { data, error } = await api.startAuthentication();
  signal.throwIfAborted();
  if (error) throw error;
  if (!data) throw new Error("Missing passkey challenge");
  const credential = await getCredential({
    publicKey: requestOptions(data.options),
    mediation: conditional ? "conditional" : "optional",
    signal,
  });
  signal.throwIfAborted();
  if (!credential)
    throw new DOMException("No credential selected", "NotAllowedError");
  return {
    challengeId: data.challenge_id,
    credential: assertionJSON(credential as PublicKeyCredential),
  };
}
