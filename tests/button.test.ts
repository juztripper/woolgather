import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, IconButton, ProviderButton } from "../apps/web/src/ui/Button";

test("ordinary actions cannot submit their containing form by default", () => {
  const html = renderToStaticMarkup(createElement(Button, {}, "Cancel"));
  assert.match(html, /type="button"/);
});

test("explicit submit buttons retain their external form and disabled state", () => {
  const html = renderToStaticMarkup(
    createElement(
      Button,
      {
        type: "submit",
        form: "editor",
        disabled: true,
        "aria-busy": true,
      },
      "Save",
    ),
  );
  assert.match(html, /type="submit"/);
  assert.match(html, /form="editor"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
});

test("icon and provider controls retain accessible action names", () => {
  assert.match(
    renderToStaticMarkup(
      createElement(IconButton, {
        "aria-label": "Close editor",
      }),
    ),
    /aria-label="Close editor"/,
  );
  for (const provider of ["google", "github"] as const) {
    const html = renderToStaticMarkup(
      createElement(ProviderButton, { provider }),
    );
    assert.match(html, /alt=""/);
    assert.match(
      html,
      provider === "google" ? /Continue with Google/ : /Continue with GitHub/,
    );
    assert.match(html, /type="button"/);
  }
});
