// This function alone holds the Storage service credential. Every user request
// verifies the current account/session before looking up its private metadata.
const bucket = "idea-attachments";
const limit = 20 * 1024 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function mediaType(bytes: Uint8Array) {
  const starts = (pattern: number[]) => pattern.every((n, i) => bytes[i] === n);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.slice(start, end));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  return "application/octet-stream";
}
export async function readFile(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Choose a file no larger than 20 MB.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function sameSecret(a: string, b: string) {
  return (
    !!b &&
    (await hash(new TextEncoder().encode(a))) ===
      (await hash(new TextEncoder().encode(b)))
  );
}
type Environment = {
  url: string;
  key: string;
  serviceKey: string;
  createClient: (...args: any[]) => any;
};
async function rpc(client: any, name: string, args?: object) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
export async function handleAttachments(
  request: Request,
  env: Environment,
): Promise<Response> {
  try {
    if (!["GET", "POST"].includes(request.method))
      return reply({ error: "Method not allowed" }, 405);
    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer "))
      return reply({ error: "Sign in required" }, 401);
    const url = new URL(request.url),
      action = url.searchParams.get("action") || "file";
    const options = {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    };
    const admin = env.createClient(env.url, env.serviceKey, options);
    const privileged = await sameSecret(auth.slice(7), env.serviceKey);
    let user: any = null,
      client: any = null;
    if (!privileged) {
      client = env.createClient(env.url, env.key, {
        ...options,
        global: { headers: { Authorization: auth } },
      });
      const result = await client.auth.getUser(auth.slice(7));
      user = result.data?.user;
      if (result.error || !user || user.is_anonymous)
        return reply({ error: "Your session has ended. Sign in again." }, 401);
      const access = await rpc(client, "account_access");
      if (access !== "ok")
        return reply(
          {
            error:
              access === "mfa_required"
                ? "Verify your authenticator code to continue."
                : "Your session has ended. Sign in again.",
            accountAccess: access,
          },
          access === "mfa_required" ? 403 : 401,
        );
    }
    if (action === "configure" || action === "cleanup") {
      if (request.method !== "POST")
        return reply({ error: "Method not allowed" }, 405);
      if (!privileged && !(await rpc(client, "can_manage_attachments")))
        return reply({ error: "Not available" }, 403);
      if (action === "configure") {
        const existing = await admin.storage.getBucket(bucket);
        const config = {
          public: false,
          fileSizeLimit: limit,
          allowedMimeTypes: [
            "application/octet-stream",
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
          ],
        };
        const configured = existing.data
          ? await admin.storage.updateBucket(bucket, config)
          : await admin.storage.createBucket(bucket, config);
        if (configured.error)
          throw new Error("Unable to configure private storage.");
        await rpc(admin, "configure_attachment_maintenance", {
          endpoint: env.url + "/functions/v1/attachments?action=cleanup",
          service_token: env.serviceKey,
        });
        return reply({ configured: true });
      }
      const paths = await rpc(admin, "collect_attachment_garbage");
      if (paths.length) {
        const removed = await admin.storage.from(bucket).remove(paths);
        if (removed.error) throw new Error("Attachment cleanup will retry.");
        await rpc(admin, "ack_attachment_garbage", { paths });
      }
      return reply({ removed: paths.length });
    }
    // Service credentials never stand in for a user's ownership check.
    if (!user) return reply({ error: "User session required" }, 403);
    const id = url.searchParams.get("id") || "";
    if (!uuid.test(id)) return reply({ error: "Invalid attachment" }, 422);
    const path = user.id + "/" + id;
    if (request.method === "GET") {
      const metadata = await rpc(client, "attachment_metadata", {
        attachment_id: id,
      });
      if (!metadata) return reply({ error: "File not found" }, 404);
      const file = await admin.storage.from(bucket).download(path);
      if (file.error || !file.data)
        throw new Error("Unable to load this file. Please retry.");
      return new Response(file.data, {
        headers: {
          "Content-Type": metadata.mime,
          "Content-Length": String(metadata.size),
          "Content-Disposition":
            "attachment; filename*=UTF-8''" + encodeURIComponent(metadata.name),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    const name =
      (url.searchParams.get("name") || "File")
        .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
        .slice(0, 180) || "File";
    const bytes = await readFile(request),
      sha256 = await hash(bytes),
      mime = mediaType(bytes);
    const reserved = await rpc(client, "reserve_attachment", {
      command: { id, name, mime, size: bytes.length, sha256 },
    });
    if (reserved.state !== "ready") {
      const uploaded = await admin.storage
        .from(bucket)
        .upload(path, bytes, { contentType: mime, upsert: false });
      if (uploaded.error) {
        // A timed-out or concurrent retry may already have stored identical bytes.
        const previous = await admin.storage.from(bucket).download(path);
        if (
          previous.error ||
          !previous.data ||
          (await hash(new Uint8Array(await previous.data.arrayBuffer()))) !==
            sha256
        )
          throw new Error("Upload interrupted. Please retry the same file.");
      }
    }
    // Recheck the live session after a potentially slow transfer.
    if ((await rpc(client, "account_access")) !== "ok")
      return reply({ error: "Sign in again to finish adding this file." }, 401);
    return reply(
      await rpc(admin, "finish_attachment", {
        attachment_id: id,
        actor_id: user.id,
        content_hash: sha256,
      }),
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete this file action.";
    const expected =
      /20 MB|allowance|Upload interrupted|no longer available|Choose the file|Unable to load/.test(
        message,
      );
    return reply(
      {
        error: expected
          ? message
          : "Unable to complete this file action. Please retry.",
      },
      expected && /allowance/.test(message) ? 429 : 400,
    );
  }
}
