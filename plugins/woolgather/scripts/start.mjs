#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const connector = process.env.WOOLGATHER_CONNECTOR_PATH;
  if (!connector || !isAbsolute(connector)) throw new Error();
  await import(pathToFileURL(connector).href);
} catch {
  process.stderr.write(
    "Set WOOLGATHER_CONNECTOR_PATH to the installed connector's absolute bin/woolgather-mcp.mjs path. See the woolgather connector installation guide.\n",
  );
  process.exitCode = 1;
}
