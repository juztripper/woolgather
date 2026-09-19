// Keep Cloudflare runtime exports at the deployment entry so HTTP route tests
// can exercise the application without importing platform-only modules.
import app from "./index";
import { fetchMcp } from "./mcpWorker";
export default {
  fetch: fetchMcp,
  scheduled: app.scheduled,
} satisfies ExportedHandler<Env>;
export { ProjectVoiceSession } from "./projectVoiceSession";
export { McpConsentState } from "./mcpConsentState";
