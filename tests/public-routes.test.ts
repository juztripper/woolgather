import test from "node:test";
import assert from "node:assert/strict";
import { isPublicSitePath } from "../apps/web/src/public/routes";

test("public landing, plan and policy URLs open without the authenticated app", () => {
  assert.equal(isPublicSitePath("/"), true);
  for (const path of ["/pricing", "/support", "/privacy", "/terms"]) {
    assert.equal(isPublicSitePath(path), true, path);
    assert.equal(isPublicSitePath(`${path}/`), true, `${path}/`);
  }
});

test("public routing cannot swallow workspace, account, callback or unknown paths", () => {
  for (const path of [
    "/recent",
    "/recent/",
    "/workspace",
    "/ideas",
    "/ideas/00000000-0000-4000-8000-000000000001",
    "/projects/00000000-0000-4000-8000-000000000001/chats/main",
    "/account/billing",
    "/account/delete",
    "/auth/callback",
    "/api/billing/checkout",
    "/pricing/unrecognized",
    "/pricing-plans",
    "/Privacy",
    "/unknown",
    "/learn/start-here",
  ]) {
    assert.equal(isPublicSitePath(path), false, path);
  }
});
