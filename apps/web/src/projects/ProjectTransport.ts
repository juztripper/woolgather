import { createContext } from "react";
import { api, sendCommand, exportProject } from "../client";

// Fixtures replace the authenticated transport, never the product components.
export const ProjectTransport = createContext({
  request: api,
  command: sendCommand,
  export: exportProject,
});
