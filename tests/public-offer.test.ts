import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { planOffer } from "../packages/domain/src/plans";

// Node has no CSS loader. Render the actual components with styling omitted;
// layout and interactive controls receive their separate browser walkthrough.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css"))
      return { url: "test:public-style", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:public-style")
      return { format: "module", shortCircuit: true, source: "export {};" };
    return next(url, context);
  },
});
const { PricingCards, MarketingHeader, MarketingSession } =
  await import("../apps/web/src/public/MarketingPage");
hooks.deregister();

function card(html: string, plan: "free" | "plus") {
  const name = plan === "free" ? planOffer.free.name : planOffer.paid.name;
  const article = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)]
    .map((match) => match[1])
    .find((entry) => entry.includes(`<h3>${name}</h3>`));
  assert.ok(article, `The ${plan} plan has its own comparison entry`);
  return article;
}

test("landing and full comparison preserve the actual Free and Plus allowances", () => {
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(
        MarketingSession.Provider,
        { value: false },
        createElement(PricingCards, { compact }),
      ),
    );
    const free = card(html, "free").replace(/<[^>]+>/g, " ");
    const plus = card(html, "plus").replace(/<[^>]+>/g, " ");
    assert.match(
      free,
      new RegExp(`${planOffer.free.monthlyCredits} AI credits`),
    );
    assert.match(
      free,
      new RegExp(`${planOffer.free.welcomeCredits} welcome credits`),
    );
    assert.match(
      free,
      new RegExp(`${planOffer.free.storageBytes / 1024 ** 2} MiB`),
    );
    assert.match(plus, new RegExp(`€${planOffer.paid.priceMinor / 100}`));
    assert.match(
      plus,
      new RegExp(
        `${planOffer.paid.monthlyCredits.toLocaleString("en")} AI credits`,
      ),
    );
    assert.match(
      plus,
      new RegExp(`${planOffer.paid.voiceSeconds / 60} minutes`),
    );
    assert.match(
      plus,
      new RegExp(`${planOffer.paid.storageBytes / 1024 ** 3} GiB`),
    );
  }
});

test("Plus opens account billing without starting a payment and Free opens account creation", () => {
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(
        MarketingSession.Provider,
        { value: false },
        createElement(PricingCards, { compact }),
      ),
    );
    const free = card(html, "free");
    const plus = card(html, "plus");
    assert.match(free, /href="\/recent\?auth=create"/);
    assert.match(plus, /href="\/account\/billing"/);
    assert.doesNotMatch(plus, /<form\b/);
    assert.doesNotMatch(
      html,
      /href="[^"]*(?:\/api\/billing|checkout\.stripe\.com)/,
    );
  }
});

test("signed-in and resolving visitors get workspace actions without signup prompts", () => {
  for (const value of [true, null]) {
    const html = renderToStaticMarkup(
      createElement(
        MarketingSession.Provider,
        { value },
        createElement(MarketingHeader),
        createElement(PricingCards),
      ),
    );
    assert.match(html, /Open workspace/);
    assert.match(html, /href="\/recent"/);
    assert.doesNotMatch(html, /Log in|Start for free|auth=create/);
  }
  const guest = renderToStaticMarkup(
    createElement(
      MarketingSession.Provider,
      { value: false },
      createElement(MarketingHeader),
    ),
  );
  assert.match(guest, /Log in/);
  assert.match(guest, /Start for free/);
});
