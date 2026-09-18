export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Message = {
  title: string;
  body: string;
  footer: string;
  button?: string;
  url?: string;
  code?: string;
  danger?: boolean;
};
/** All values are escaped, including URLs. Go template placeholders remain intact. */
export function brandedEmail(message: Message) {
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(message.title)}</title></head>
<body style="margin:0;padding:32px 16px;background:#edf1f2;color:#304a5b;font-family:'Avenir Next',Arial,sans-serif">
<table role="presentation" style="width:100%;max-width:520px;margin:0 auto;border-collapse:collapse"><tr><td style="padding:32px;background:#fafbf9;border:1px solid #dce3e4;border-radius:16px">
<p style="margin:0 0 28px;font-size:24px;font-weight:600;letter-spacing:-1px">woolgather</p>
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:500">${e(message.title)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6">${e(message.body)}</p>
${message.code ? `<p style="margin:0 0 24px;padding:18px;background:#edf1f2;border-radius:9px;font-size:28px;font-weight:600;letter-spacing:6px;text-align:center">${e(message.code)}</p>` : ""}
${message.button && message.url ? `<p style="margin:0 0 28px"><a href="${e(message.url)}" style="display:inline-block;padding:14px 22px;border-radius:9px;background:${message.danger ? "#963c33" : "#2d404e"};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600">${e(message.button)}</a></p>` : ""}
<p style="margin:0;font-size:13px;line-height:1.6;color:#667982">${e(message.footer)}</p>
</td></tr></table></body></html>`;
}
export function deletionEmail(email: string, url: string) {
  const title = "Confirm account deletion";
  const body = `You requested to permanently delete ${email} and all its projects. Open this link to confirm. If you use an authenticator, we’ll ask for its code first.`;
  const footer =
    "This link expires in 15 minutes. Open it in a browser where you’re signed in. If you didn’t request this, ignore this email; your account will stay as it is.";
  return {
    subject: "Confirm deletion of your woolgather account",
    html: brandedEmail({
      title,
      body,
      footer,
      button: "Delete my account",
      url,
      danger: true,
    }),
    text: `woolgather\n\n${title}\n\n${body}\n\nDelete my account: ${url}\n\n${footer}`,
  };
}
export const authEmailTemplates: Record<string, Message> = {
  "magic-link": {
    title: "Sign in to woolgather",
    body: "Use this link to sign in. Open it in the browser where you requested it.",
    button: "Sign in",
    url: "{{ .ConfirmationURL }}",
    footer:
      "If you didn’t request this, you can ignore this email. Do not share this link.",
  },
  "change-email": {
    title: "Confirm your email change",
    body: "Confirm this email address to finish updating your woolgather account. You may need to confirm from both your current and new inbox.",
    button: "Confirm email change",
    url: "{{ .ConfirmationURL }}",
    footer:
      "If you didn’t request this change, do not confirm it. Open woolgather and review Security and login in Account settings.",
  },
  reauthentication: {
    title: "Verify your account",
    body: "Enter this code in the woolgather form you have open to finish changing your password.",
    code: "{{ .Token }}",
    footer:
      "If you didn’t request this, do not share the code. Open woolgather and review your signed-in devices in Account settings.",
  },
  "invite-user": {
    title: "You’re invited to woolgather",
    body: "Use this link to accept your invitation and set up your account.",
    button: "Accept invitation",
    url: "{{ .ConfirmationURL }}",
    footer:
      "If you weren’t expecting this invitation, you can ignore this email.",
  },
};
// Go-template string literals must survive the HTML escaper unchanged.
export const passwordEmailSubject =
  "{{ if eq .Data.password_email_kind `added` }}A password was added to your woolgather account{{ else }}Your woolgather password was changed{{ end }}";
for (const [name, title, body] of [
  [
    "password-changed",
    "{{ if eq .Data.password_email_kind `added` }}A password was added{{ else }}Your password was changed{{ end }}",
    "{{ if eq .Data.password_email_kind `added` }}A password was added to your woolgather account. You can now sign in with your email address and password. Your connected sign-in methods remain available.{{ else }}The password for your woolgather account was updated.{{ end }}",
  ],
  [
    "email-changed",
    "Your email was changed",
    "The email address for your woolgather account was updated.",
  ],
  [
    "phone-changed",
    "Your phone number was changed",
    "The phone number for your woolgather account was updated.",
  ],
  [
    "identity-linked",
    "A sign-in method was added",
    "A new sign-in method was connected to your woolgather account.",
  ],
  [
    "identity-unlinked",
    "A sign-in method was removed",
    "A connected sign-in method was removed from your woolgather account.",
  ],
  [
    "mfa-factor-enrolled",
    "An authenticator was added",
    "An authenticator was added to protect your woolgather account.",
  ],
  [
    "mfa-factor-unenrolled",
    "An authenticator was removed",
    "An authenticator was removed from your woolgather account.",
  ],
])
  authEmailTemplates[name] = {
    title,
    body: `${body} If this was you, no action is needed.`,
    button: "Review account security",
    url: "{{ .SiteURL }}/account/security",
    footer:
      "Don’t recognize this change? Review your signed-in devices and remove any you don’t recognize. Change your password, or use Forgot password on the sign-in page if you can’t sign in.",
  };
