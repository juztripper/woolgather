import { DurableObject } from "cloudflare:workers";
import type { ConsentTicket } from "./mcpAuthorization";

type Choice = { decision: "allow" | "deny"; projectId?: string };
type Completion = { redirectTo: string };

/** One short-lived authorization attempt, never an account or global lock. */
export class McpConsentState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS ticket (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS completion (id INTEGER PRIMARY KEY CHECK(id = 1), owner_id TEXT NOT NULL, choice TEXT NOT NULL, result TEXT NOT NULL)",
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
  complete(
    browserHash: string,
    ownerId: string,
    choice: Choice,
    result: Completion,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT INTO completion (id, owner_id, choice, result) SELECT id, ?, ?, ? FROM ticket WHERE id = 1 AND browser_hash = ? AND claimed = 1 AND expires_at > ?",
      ownerId,
      JSON.stringify(choice),
      JSON.stringify(result),
      browserHash,
      Date.now(),
    );
  }
  result(
    browserHash: string,
    ownerId: string,
    choice: Choice,
  ): Completion | null {
    const row = this.ctx.storage.sql
      .exec<{ result: string }>(
        "SELECT c.result FROM completion c JOIN ticket t ON c.id = t.id WHERE t.browser_hash = ? AND t.expires_at > ? AND c.owner_id = ? AND c.choice = ?",
        browserHash,
        Date.now(),
        ownerId,
        JSON.stringify(choice),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.result) as Completion) : null;
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
