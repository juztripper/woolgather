import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  ideaArchive,
  projectArchive,
} from "../apps/web/src/library/exportIdea";
import {
  attachmentScheme,
  blocksText,
  textBlock,
  type IdeaBlock,
} from "../packages/domain/src/ideaBlocks";
import {
  emptyIdeaDocument,
  withIdeaBlocks,
  type IdeaDocument,
} from "../packages/domain/src/ideaDocument";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import { exportMarkdown, type Project } from "../packages/domain/src";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function installBrowserFixtures(
  attachments: Map<string, { bytes: Uint8Array; mime: string }>,
  denied: Set<string>,
  requests: string[],
) {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const owner = crypto.randomUUID();
  localStorage.setItem(
    "sb-test-auth-token",
    JSON.stringify({
      access_token: "synthetic-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "synthetic-refresh",
      user: {
        id: owner,
        aud: "authenticated",
        role: "authenticated",
        email: "export-qa@example.test",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        identities: [],
      },
    }),
  );
  const saved = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    sessionStorage: Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    ),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    fetch: globalThis.fetch,
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: sessionStorage,
  });
  const location = {
    href: "https://app.test/projects/synthetic",
    pathname: "/projects/synthetic",
    assign() {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location, history: { replaceState() {} } },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: location,
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/config")
      return new Response(
        JSON.stringify({ url: "https://test.supabase.co", key: "synthetic" }),
        { headers: { "content-type": "application/json" } },
      );
    const attachment = url.match(/^\/api\/attachments\/([^/?]+)$/)?.[1];
    if (attachment) {
      requests.push(attachment);
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer synthetic-token",
      );
      if (denied.has(attachment))
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      const file = attachments.get(attachment);
      return file
        ? new Response(Buffer.from(file.bytes), {
            headers: { "content-type": file.mime },
          })
        : new Response(JSON.stringify({ error: "Attachment not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
    }
    const reference = url.match(/^\/api\/images\/([^/?]+)$/)?.[1];
    if (reference) {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer synthetic-token",
      );
      const file = attachments.get(reference);
      if (!file)
        return new Response(JSON.stringify({ error: "Image not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      const dataUrl = `data:${file.mime};base64,${Buffer.from(file.bytes).toString("base64")}`;
      return new Response(JSON.stringify({ id: reference, dataUrl }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const encoded = url.slice(comma + 1);
      return new Response(Buffer.from(encoded, "base64"));
    }
    throw new Error(`Unexpected export fixture request: ${url}`);
  };
  return () => {
    const restore = (
      key: "localStorage" | "sessionStorage" | "window" | "location",
      descriptor?: PropertyDescriptor,
    ) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    };
    restore("localStorage", saved.localStorage);
    restore("sessionStorage", saved.sessionStorage);
    restore("window", saved.window);
    restore("location", saved.location);
    globalThis.fetch = saved.fetch;
  };
}

function baseLegacyDocument(): Extract<IdeaDocument, { version: 1 }> {
  return {
    ...emptyIdeaDocument(),
    version: 1,
  };
}

function fileBlock(id: string, name: string, attachment: string): IdeaBlock {
  return {
    id,
    type: "file",
    props: {
      name,
      url: attachmentScheme + attachment,
      caption: "Private source bytes",
    },
    children: [],
  };
}

function binaryFixture(size: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length: size },
    (_, index) => (index * 31 + seed) % 256,
  );
}

async function entriesOf(blob: Blob) {
  assert.equal(blob.type, "application/zip");
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

function textEntry(entries: Record<string, Uint8Array>, name: string) {
  const bytes = entries[name];
  assert.ok(bytes, `ZIP is missing ${name}`);
  return new TextDecoder().decode(bytes);
}

test("actual Idea and Project ZIPs preserve structure, private bytes and safe filenames", async () => {
  const attachments = new Map<string, { bytes: Uint8Array; mime: string }>();
  const denied = new Set<string>();
  const requests: string[] = [];
  const restore = installBrowserFixtures(attachments, denied, requests);
  try {
    const ideaAttachmentId = crypto.randomUUID();
    const ideaBytes = binaryFixture(768 * 1024, 17);
    attachments.set(ideaAttachmentId, {
      bytes: ideaBytes,
      mime: "application/octet-stream",
    });
    const longUnicodeText = Array.from(
      { length: 5000 },
      (_, index) =>
        `Linha ${index}: ação pública — café, naïve, 東京, Ελληνικά, 🚀\n`,
    ).join("");
    const ideaName = "../../receitas/Δ orçamento — versão 1.bin";
    const ideaBlocks: IdeaBlock[] = [
      textBlock("intro", "Uma ideia privada: café, 東京 e 🚀."),
      textBlock("large", longUnicodeText),
      fileBlock("idea-file", ideaName, ideaAttachmentId),
    ];
    const ideaDocument = withIdeaBlocks(baseLegacyDocument(), ideaBlocks);
    const ideaBody = blocksText(ideaBlocks);

    const ideaEntries = await entriesOf(
      await ideaArchive(ideaBody, ideaDocument),
    );
    const ideaManifest = JSON.parse(
      textEntry(ideaEntries, "attachments.json"),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(ideaManifest), [ideaAttachmentId]);
    const ideaPath = ideaManifest[ideaAttachmentId];
    assert.match(ideaPath, new RegExp(`^attachments/${ideaAttachmentId}-`));
    assert.equal(ideaPath.split("/").length, 2);
    assert.equal(ideaPath.includes("\\"), false);
    assert.ok(ideaPath.length <= "attachments/".length + 36 + 1 + 120);
    assert.deepEqual([...ideaEntries[ideaPath]], [...ideaBytes]);
    const ideaJson = JSON.parse(textEntry(ideaEntries, "idea.json")) as {
      body: string;
      document: IdeaDocument;
    };
    assert.equal(ideaJson.body, ideaBody);
    assert.deepEqual(ideaJson.document, ideaDocument);
    assert.match(textEntry(ideaEntries, "idea.md"), /東京/);
    assert.match(textEntry(ideaEntries, "idea.md"), new RegExp(ideaPath));
    assert.deepEqual(
      Object.keys(ideaEntries).sort(),
      ["attachments.json", "idea.json", "idea.md", ideaPath].sort(),
    );

    const conversationAttachmentId = crypto.randomUUID();
    const sourceAttachmentId = crypto.randomUUID();
    const conversationBytes = binaryFixture(128 * 1024 + 19, 43);
    const sourceBytes = binaryFixture(96 * 1024 + 7, 71);
    attachments.set(conversationAttachmentId, {
      bytes: conversationBytes,
      mime: "text/plain",
    });
    attachments.set(sourceAttachmentId, {
      bytes: sourceBytes,
      mime: "application/pdf",
    });
    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      name: "Projeto privado — 東京",
      description: "Planeamento confidencial com ação e 🚀.",
      revision: 7,
      updatedAt: now,
      originalIdea: ideaBody,
      ideaDocument,
      references: [],
      ideaQuestions: [],
      sources: [
        {
          id: crypto.randomUUID(),
          attachmentId: sourceAttachmentId,
          name: "brief — design/β.pdf",
          mime: "application/pdf",
          size: sourceBytes.length,
          note: "Use this retained source",
          meaning: "use" as const,
          archived: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      items: [],
      thinking: {
        version: 1 as const,
        turns: [
          {
            id: crypto.randomUUID(),
            conversationId: "main",
            composer: {
              ...defaultComposer(),
              attachments: [
                {
                  id: conversationAttachmentId,
                  name: "chat notes — β.txt",
                  mime: "text/plain",
                  size: conversationBytes.length,
                },
              ],
            },
            text: "Discussar os bytes preservados.",
            reply: "A resposta privada permanece aqui.",
            status: "complete" as const,
            focusId: null,
            createdAt: now,
            changedIds: [],
          },
        ],
        conversations: [],
        agents: [],
        relations: [],
        proposals: [],
        focusId: null,
        view: "map" as const,
        undo: null,
      },
    } satisfies Project;
    const projectMarkdown =
      "# Projeto privado — 東京\n\nConteúdo confidencial 🚀\n";
    const projectEntries = await entriesOf(
      await projectArchive(project, projectMarkdown),
    );
    const projectManifest = JSON.parse(
      textEntry(projectEntries, "attachments.json"),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(projectManifest), [
      ideaAttachmentId,
      conversationAttachmentId,
      sourceAttachmentId,
    ]);
    assert.deepEqual(
      [...projectEntries[projectManifest[ideaAttachmentId]]],
      [...ideaBytes],
    );
    assert.deepEqual(
      [...projectEntries[projectManifest[conversationAttachmentId]]],
      [...conversationBytes],
    );
    assert.deepEqual(
      [...projectEntries[projectManifest[sourceAttachmentId]]],
      [...sourceBytes],
    );
    assert.equal(textEntry(projectEntries, "project.md"), projectMarkdown);
    assert.deepEqual(
      JSON.parse(textEntry(projectEntries, "project.json")),
      project,
    );
    assert.match(textEntry(projectEntries, "idea.json"), /東京/);
    assert.equal(
      new Set(
        Object.values(projectManifest).map((path) => path.split("/").pop()),
      ).size,
      3,
      "stable IDs keep same-looking Unicode filenames distinct",
    );
    for (const path of Object.values(projectManifest)) {
      assert.equal(path.split("/").length, 2);
      assert.equal(path.includes("\\"), false);
      assert.ok(path.length <= "attachments/".length + 36 + 1 + 120);
    }

    const legacyImageId = crypto.randomUUID();
    const legacyBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5,
    ]);
    attachments.set(legacyImageId, { bytes: legacyBytes, mime: "image/png" });
    const legacyReference = {
      id: legacyImageId,
      name: "referência visual — 東京.png",
      caption: "Imagem legada retida",
    };
    const legacyDocument: Extract<IdeaDocument, { version: 1 }> = {
      ...baseLegacyDocument(),
      title: "Legado visual",
      references: [legacyReference],
    };
    const legacyProject = {
      id: crypto.randomUUID(),
      name: "Projeto legado",
      description: "Projeto com referência antiga",
      revision: 1,
      updatedAt: now,
      originalIdea: "Fonte antiga",
      ideaDocument: legacyDocument,
      references: [legacyReference],
      items: [],
    } satisfies Project;
    const legacyDataUrl = `data:image/png;base64,${Buffer.from(legacyBytes).toString("base64")}`;
    const legacyMarkdownSource = exportMarkdown(legacyProject, {
      [legacyImageId]: legacyDataUrl,
    });
    const legacyMarkdown = await projectArchive(
      legacyProject,
      legacyMarkdownSource,
    );
    assert.equal(legacyMarkdown.type, "text/markdown");
    const legacyMarkdownText = await legacyMarkdown.text();
    assert.equal(legacyMarkdownText, legacyMarkdownSource);
    const legacyEncoded = legacyMarkdownText.match(
      /\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/,
    )?.[1];
    assert.ok(legacyEncoded, "legacy reference remains embedded in Markdown");
    assert.deepEqual(
      [...Buffer.from(legacyEncoded, "base64")],
      [...legacyBytes],
      "legacy-only project references preserve bytes in the existing Markdown format",
    );

    const referenceOnlyId = crypto.randomUUID();
    const referenceOnlyBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 1, 3, 5, 7, 9, 11,
    ]);
    attachments.set(referenceOnlyId, {
      bytes: referenceOnlyBytes,
      mime: "image/png",
    });
    const referenceOnlyDataUrl = `data:image/png;base64,${Buffer.from(referenceOnlyBytes).toString("base64")}`;
    const referenceOnlyProject = {
      id: crypto.randomUUID(),
      name: "Referência sem documento",
      description: "A project-level image reference from an older project.",
      revision: 2,
      updatedAt: now,
      originalIdea: null,
      ideaDocument: null,
      references: [
        {
          id: referenceOnlyId,
          name: "referência sem documento.png",
          caption: "Retained project reference",
        },
      ],
      items: [],
    } satisfies Project;
    const referenceOnlyMarkdown = exportMarkdown(referenceOnlyProject, {
      [referenceOnlyId]: referenceOnlyDataUrl,
    });
    const referenceOnlyExport = await projectArchive(
      referenceOnlyProject,
      referenceOnlyMarkdown,
    );
    assert.equal(referenceOnlyExport.type, "text/markdown");
    const referenceOnlyExportText = await referenceOnlyExport.text();
    assert.equal(referenceOnlyExportText, referenceOnlyMarkdown);
    const embeddedDataUrl = referenceOnlyExportText.match(
      /\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/,
    )?.[1];
    assert.ok(
      embeddedDataUrl,
      "project reference bytes remain embedded in Markdown",
    );
    assert.deepEqual(
      [...Buffer.from(embeddedDataUrl, "base64")],
      [...referenceOnlyBytes],
    );

    const richReferenceProject = {
      ...referenceOnlyProject,
      sources: [project.sources[0]],
    } satisfies Project;
    const richReferenceMarkdown = exportMarkdown(richReferenceProject, {
      [referenceOnlyId]: referenceOnlyDataUrl,
    });
    const richReferenceEntries = await entriesOf(
      await projectArchive(richReferenceProject, richReferenceMarkdown),
    );
    const richReferenceManifest = JSON.parse(
      textEntry(richReferenceEntries, "attachments.json"),
    ) as Record<string, string>;
    assert.deepEqual(Object.keys(richReferenceManifest), [
      referenceOnlyId,
      sourceAttachmentId,
    ]);
    assert.deepEqual(
      [...richReferenceEntries[richReferenceManifest[referenceOnlyId]]],
      [...referenceOnlyBytes],
      "rich projects retain legacy reference bytes in the ZIP",
    );
    assert.deepEqual(
      [...richReferenceEntries[richReferenceManifest[sourceAttachmentId]]],
      [...sourceBytes],
    );

    const plainProject = {
      id: crypto.randomUUID(),
      name: "Plain project",
      description: "No structured source or private files.",
      revision: 1,
      updatedAt: now,
      items: [],
    } satisfies Project;
    const plainMarkdown = "# Plain project\n";
    const plainExport = await projectArchive(plainProject, plainMarkdown);
    assert.equal(plainExport.type, "text/markdown");
    assert.equal(await plainExport.text(), plainMarkdown);

    const foreignId = crypto.randomUUID();
    denied.add(foreignId);
    const foreignProject = {
      ...project,
      sources: [
        ...project.sources,
        {
          ...project.sources[0],
          id: crypto.randomUUID(),
          attachmentId: foreignId,
          name: "foreign-private.bin",
          size: 12,
        },
      ],
    } satisfies Project;
    await assert.rejects(
      projectArchive(foreignProject, projectMarkdown),
      /File not found/,
      "a denied private attachment must abort the whole archive",
    );
    assert.ok(requests.includes(foreignId));
  } finally {
    restore();
  }
});
