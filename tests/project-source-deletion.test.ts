import test from "node:test";
import assert from "node:assert/strict";
import { planningTestDatabase } from "../scripts/planning-test-database";
import type { Project } from "../packages/domain/src";

test("deleting an unshared source revokes file access and queues physical cleanup", async () => {
  const db = await planningTestDatabase(55487);
  try {
    let project = await db.createProject("Disposable source deletion proof.");
    const attachmentId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    await db.sql`insert into account_private.attachments
      (id,owner_id,name,mime_type,byte_size,sha256,state)
      values (${attachmentId},${db.owner},'private.txt','application/octet-stream',12,${"f".repeat(64)},'ready')`;
    const register = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "register_source",
      sourceId,
      attachmentId,
      note: "Disposable source note.",
      meaning: "undecided",
    };
    const registered = await db.rpc("project_source_command", {
      command: register,
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    project = registered.data as Project;
    const deleted = await db.rpc("project_source_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "delete_source",
        sourceId,
      },
    });
    assert.equal(deleted.error, null, deleted.error?.message ?? "");
    assert.equal(
      (
        await db.sql`select count(*)::int n from account_private.attachments where id=${attachmentId}`
      )[0].n,
      0,
    );
    const metadata = await db.rpc("attachment_metadata", {
      attachment_id: attachmentId,
    });
    assert.ok(
      metadata.error || !metadata.data,
      "deleted file must not be readable",
    );
    const path = `${db.owner}/${attachmentId}`;
    assert.equal(
      (
        await db.sql`select count(*)::int n from account_private.attachment_garbage where path=${path} and deleted_at is null`
      )[0].n,
      1,
    );
    const replay = await db.rpc("project_source_command", {
      command: register,
    });
    assert.ok(
      replay.error ||
        !(replay.data as Project).sources?.some(
          (source) => source.id === sourceId,
        ),
      "old registration cannot resurrect a deleted source",
    );
  } finally {
    await db.close();
  }
});
