import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("public page preparation makes pricing discoverable while keeping workspace URLs private", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "woolgather-public-pages-"));
  const output = join(temporary, "dist/web/client");
  try {
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "index.html"),
      '<!doctype html><html lang="en"><head><title>App</title><meta name="description" content="App" /></head><body><div id="root"></div></body></html>',
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(
          new URL("../scripts/prepare-public-pages.ts", import.meta.url),
        ),
      ],
      { cwd: temporary, stdio: "pipe" },
    );
    const pricing = await readFile(join(output, "pricing.html"), "utf8");
    assert.match(
      pricing,
      /rel="canonical" href="https:\/\/woolgathering\.app\/pricing"/,
    );
    assert.doesNotMatch(pricing, /noindex/);
    const privatePage = await readFile(join(output, "recent.html"), "utf8");
    assert.match(privatePage, /name="robots" content="noindex, nofollow"/);
    const headers = await readFile(join(output, "_headers"), "utf8");
    for (const path of ["/auth/*", "/account/*", "/projects/*", "/ideas/*"])
      assert.ok(
        headers.includes(
          `${path}\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store`,
        ),
      );
    const sitemap = await readFile(join(output, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("<loc>https://woolgathering.app/pricing</loc>"));
    assert.doesNotMatch(
      sitemap,
      /<loc>[^<]*\/(?:recent|account|auth|projects|ideas)(?:\/|<)/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
