import test from "node:test";
import assert from "node:assert/strict";
import { cn } from "../apps/web/src/lib/utils";

test("a table row can override shared button geometry without competing classes", () => {
  assert.equal(
    cn("h-control px-control-padding gap-control-gap", "h-auto px-2 gap-3"),
    "h-auto px-2 gap-3",
  );
});

test("surface and icon buttons fully replace the default button padding", () => {
  assert.equal(cn("px-control-padding py-0", "p-0"), "p-0");
  assert.equal(cn("size-control", "size-14"), "size-14");
});

test("shared compact variants override defaults and ordinary spacing in either order", () => {
  assert.equal(
    cn("h-control px-control-padding", "h-control-sm px-control-padding-sm"),
    "h-control-sm px-control-padding-sm",
  );
  assert.equal(cn("px-3", "px-field-padding"), "px-field-padding");
});
