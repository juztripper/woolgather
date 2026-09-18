import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLearnPath } from "../apps/web/src/learn/routes";

test("public guide aliases and trailing slashes preserve filters and fragments", () => {
  for (const prefix of ["/learn", "/resources"]) {
    assert.equal(canonicalLearnPath(`${prefix}/`), "/learn");
    assert.equal(
      canonicalLearnPath(`${prefix}/faq/?q=credits`),
      "/learn/faq?q=credits",
    );
    assert.equal(
      canonicalLearnPath(`${prefix}/start-here/?topic=Ideas#start`),
      "/learn/start-here?topic=Ideas#start",
    );
  }
});

test("resource normalization does not reinterpret unrelated or private routes", () => {
  for (const path of [
    "/account/security/",
    "/projects/123/",
    "/learning/",
    "/resources-private/",
  ])
    assert.equal(canonicalLearnPath(path), path);
});
