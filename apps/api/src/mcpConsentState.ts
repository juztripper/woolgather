import { DurableObject } from "cloudflare:workers";
import type { ConsentTicket } from "./mcpAuthorization";

/** One short-lived authorization attempt, never an account or global lock. */
export class McpConsentState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ticket (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)",
    );
  }
  async create(ticket: ConsentTicket) {
    this.ctx.storage.sql.exec(
      "INSERT INTO ticket (id, body, browser_hash, expires_at) VALUES (1, ?, ?, ?)",
      JSON.stringify(ticket),
      ticket.browserHash,
      ticket.expiresAt,
    );
    await this.ctx.storage.setAlarm(ticket.expiresAt);
  }
  read(browserHash: string): ConsentTicket | null {
    const row = this.ctx.storage.sql
      .exec<{ body: string }>(
        "SELECT body FROM ticket WHERE id = 1 AND browser_hash = ? AND expires_at > ? AND claimed = 0",
        browserHash,
        Date.now(),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.body) as ConsentTicket) : null;
  }
  claim(browserHash: string) {
    return (
      this.ctx.storage.sql
        .exec(
          "UPDATE ticket SET claimed = 1 WHERE id = 1 AND browser_hash = ? AND expires_at > ? AND claimed = 0 RETURNING id",
          browserHash,
          Date.now(),
        )
        .toArray().length === 1
    );
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
