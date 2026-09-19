import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/** Read-only deployment check. Does not register clients or start sign-in. */
export async function checkMcp(address, fetchImpl = fetch) {
  const url = new URL(address);
  assert.ok(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Supply the canonical origin, without credentials or a path",
  );
  assert.ok(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)),
    "HTTPS is required outside loopback",
  );
  const origin = url.origin;
  const get = async (path) => {
    const response = await fetchImpl(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    return response;
  };
  const json = async (path) => {
    const response = await get(path);
    assert.equal(response.status, 200, `${path} must return 200`);
    assert.match(
      response.headers.get("content-type") || "",
      /application\/json/,
      `${path} must return JSON, not an app preview`,
    );
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) {
          await reader.cancel();
          throw new Error("Discovery response too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const setup = await json("/api/mcp/setup");
  assert.equal(
    setup.enabled,
    true,
    "Account connections are disabled or missing bindings",
  );
  assert.equal(
    setup.url,
    `${origin}/mcp`,
    "Setup must advertise this exact origin",
  );
  const metadata = await json("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.resource, `${origin}/mcp`);
  assert.deepEqual(metadata.authorization_servers, [origin]);
  const authorization = await json("/.well-known/oauth-authorization-server");
  assert.equal(authorization.issuer, origin);
  for (const [key, path] of Object.entries({
    authorization_endpoint: "/oauth/authorize",
    token_endpoint: "/oauth/token",
    registration_endpoint: "/oauth/register",
  }))
    assert.equal(authorization[key], `${origin}${path}`, `Unexpected ${key}`);
  assert.ok(authorization.code_challenge_methods_supported.includes("S256"));
  assert.ok(authorization.scopes_supported.includes("project:build"));
  const challenge = await get("/mcp");
  await challenge.body?.cancel();
  assert.equal(
    challenge.status,
    401,
    "Unauthenticated MCP requests must be challenged",
  );
  assert.ok(
    challenge.headers
      .get("www-authenticate")
      ?.includes(`${origin}/.well-known/oauth-protected-resource/mcp`),
  );
  const consent = await get("/connect/authorize");
  await consent.body?.cancel();
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get("x-frame-options"), "DENY");
  assert.match(
    consent.headers.get("content-security-policy") || "",
    /frame-ancestors 'none'/,
  );
  assert.equal(consent.headers.get("referrer-policy"), "no-referrer");
  assert.equal(consent.headers.get("cache-control"), "no-store");
  return {
    origin,
    discovery: "passed",
    authenticationChallenge: "passed",
    consentHeaders: "passed",
    accountLoginAndTools: "requires authenticated qualification",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await checkMcp(process.argv[2] || "");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`MCP deployment check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
