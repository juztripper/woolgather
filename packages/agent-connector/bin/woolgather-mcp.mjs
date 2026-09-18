#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConnectorServer, readConnectorConfig } from "../src/server.mjs";

try {
  const server = createConnectorServer(readConnectorConfig());
  await server.connect(new StdioServerTransport());
} catch {
  // Never print configuration values, raw exceptions or server responses to stderr.
  process.stderr.write(
    "woolgather could not start. Check Node 24, WOOLGATHER_URL and WOOLGATHER_TOKEN configuration.\n",
  );
  process.exitCode = 1;
}
