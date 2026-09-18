# Account emails

Password notifications use the conditional `passwordEmailSubject` from the renderer module, not a fixed subject. The body and subject distinguish adding a password in Account settings from changing an existing password. The client stages `password_email_kind` before the password write and clears it in that write; this metadata selects copy only and never grants access. Recovery explicitly selects changed wording. Keep every app password write on the shared `updatePassword` helper. Supabase's dashboard preview does not execute Go conditionals.

The confirmation and recovery templates retain the accepted woolgather design. Other Auth/security templates are rendered from `packages/emails/src/index.ts` with:

```sh
node --import tsx scripts/render-auth-emails.ts
```

Apply their HTML and matching descriptive subjects in Supabase Authentication → Emails. File names map to dashboard labels: `magic-link` → Magic link or OTP; `change-email` → Change email address; `email-changed` → Email address changed; `phone-changed` → Phone number changed; `identity-linked` / `identity-unlinked` → Sign-in method linked / removed; `mfa-factor-enrolled` / `mfa-factor-unenrolled` → MFA method added / removed. All seven security notifications are enabled on the development project. Do not put a verification token in its email subject.

Deletion uses `deletionEmail()` directly in the Worker. Configure a Resend sending-only, domain-restricted `RESEND_API_KEY` and a random 32-byte base64url `ACCOUNT_ACTION_SECRET`. Provision that same secret into the private `account_private.action_secrets` row with purpose `account_deletion` through trusted operator tooling. Keep both out of source, migrations and logs. Local development reads ignored `.dev.vars`; hosted deployment will require its own secret provisioning. Rotating the signing secret invalidates pending deletion links.

The deletion email uses the allowed origin of the app that requested it; Auth/security email links use the configured Site URL. Qualify every template, redirect and action link against the exact deployed origin before changing production email configuration.
