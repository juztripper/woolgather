import { Input } from "@/components/ui/input";
import { MorphText } from "../ui/MorphText";
import { ModalPresence } from "@/ui/Modal";
import {
  lazy,
  Suspense,
  useEffect,
  useContext,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { Download, ArrowRight, ArrowLeft } from "lucide-react";
import type {
  Folder,
  Idea,
  Library,
  LibraryCommand,
} from "../../../../packages/domain/src/library";
import { libraryCommandSchema } from "../../../../packages/domain/src/library";
import {
  buildIdeaBrief,
  buildProjectBrief,
  materializeIdea,
  updateIdeaContext,
  withIdeaBlocks,
  hasIdeaContent,
  pendingIdeaQuestions,
  type IdeaDocument,
} from "../../../../packages/domain/src/ideaDocument";
import { IdeaLibraryTransport } from "./IdeaLibraryTransport";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { Button } from "../ui/Button";
import { Feedback, useToast } from "../ui/Toast";
import { blocksText } from "../../../../packages/domain/src/ideaBlocks";
const IdeaBlockEditor = lazy(() => import("./IdeaBlockEditor"));
import { useIdeaDraft } from "./useIdeaDraft";
import "./idea-document.css";

export function IdeaEditor({
  navigation,
  idea,
  owner,
  folders,
  onClose,
  onSaved,
  onOpen,
  beforeLeave,
  reviewRequested,
  onReviewChange,
}: {
  navigation?: ReactNode;
  idea: Idea;
  owner: string;
  folders: Folder[];
  onClose: () => void;
  onSaved: (data: Library) => void;
  onOpen: (id: string, startMode?: "assist" | "note") => void;
  beforeLeave: RefObject<(() => Promise<boolean>) | null>;
  reviewRequested: boolean;
  onReviewChange: (review: boolean) => void;
}) {
  const api = useContext(IdeaLibraryTransport);
  const { notify } = useToast();
  const draft = useIdeaDraft(idea, owner, onSaved);
  const { body, document: doc } = draft.value;
  const [uploading, setUploading] = useState(false),
    [converting, setConverting] = useState(false),
    [documentInvalid, setDocumentInvalid] = useState(false);
  const [question, setQuestion] = useState(() => {
    try {
      return (localStorage.getItem(draft.key + ":question") || "").slice(
        0,
        200,
      );
    } catch {
      return "";
    }
  });
  const [initialConversion] = useState(() => {
    try {
      const parsed = libraryCommandSchema.safeParse(
        JSON.parse(localStorage.getItem(draft.key + ":conversion") || "null"),
      );
      return parsed.success &&
        parsed.data.type === "convert_idea" &&
        parsed.data.targetId === idea.id &&
        !idea.projectId
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const conversionCommand = useRef<LibraryCommand | null>(initialConversion);
  const [review, setReviewState] = useState(false);
  function setReview(next: boolean) {
    setReviewState(next);
    onReviewChange(next);
  }
  const [name, setName] = useState(initialConversion?.name || ""),
    [folder, setFolder] = useState(
      initialConversion
        ? initialConversion.folderId || ""
        : idea.folderId || "",
    );
  const [conversionError, setConversionError] = useState("");
  const [startMode, setStartMode] = useState<"assist" | "note">(() => {
    try {
      return localStorage.getItem(draft.key + ":conversion-mode") === "note"
        ? "note"
        : "assist";
    } catch {
      return "assist";
    }
  });
  const [hasPendingConversion, setHasPendingConversion] =
    useState(!!initialConversion);

  const edit = (next: IdeaDocument) => {
    const document = updateIdeaContext(
      materializeIdea(body, doc).document,
      next,
    );
    draft.edit({ body: blocksText(document.blocks), document });
  };
  const locked = draft.readOnly || hasPendingConversion || converting;
  const busy = draft.busy || uploading || converting;
  const blocked = uploading || converting || documentInvalid;
  useEffect(() => {
    try {
      question
        ? localStorage.setItem(draft.key + ":question", question)
        : localStorage.removeItem(draft.key + ":question");
    } catch {}
    const warn = (e: BeforeUnloadEvent) => {
      if (question.trim()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [question]);
  // Keep only creation choices. The source always comes from the latest saved idea.
  useEffect(() => {
    if (initialConversion || draft.readOnly) return;
    try {
      const stored = JSON.parse(
        localStorage.getItem(draft.key + ":review") || "null",
      );
      if (stored) {
        setName(
          typeof stored.name === "string" ? stored.name.slice(0, 120) : "",
        );
        if (
          typeof stored.folder === "string" &&
          (!stored.folder || folders.some((f) => f.id === stored.folder))
        )
          setFolder(stored.folder);
      }
    } catch {}
  }, []);
  function reviewEdit(next: { name?: string; folder?: string }) {
    const data = { name, folder, ...next };
    setName(data.name);
    setFolder(data.folder);
    try {
      localStorage.setItem(draft.key + ":review", JSON.stringify(data));
    } catch {
      setConversionError(
        "Keep this dialog open until the project is created; this browser could not keep a recovery copy.",
      );
    }
  }
  async function prepareToLeave() {
    if (blocked) return false;
    keepQuestion();
    return hasPendingConversion || draft.readOnly || (await draft.flush());
  }
  useEffect(() => {
    beforeLeave.current = prepareToLeave;
    return () => {
      beforeLeave.current = null;
    };
  });
  useEffect(() => {
    if (reviewRequested && !draft.readOnly) {
      if (!review) startReview();
    } else setReviewState(false);
  }, [reviewRequested]);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(".idea-page-heading")
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  async function close() {
    if (await prepareToLeave()) onClose();
  }
  function keepQuestion() {
    if (!locked && question.trim() && doc.questions.length < 12) {
      edit({
        ...doc,
        questions: [
          ...doc.questions,
          { id: crypto.randomUUID(), text: question.trim(), important: false },
        ],
      });
      setQuestion("");
    }
  }
  function startReview() {
    if (blocked || draft.readOnly) return;
    keepQuestion();
    setConversionError("");
    setReview(true);
  }
  const conversionFlight = useRef(false);
  async function convert() {
    if (conversionFlight.current) return;
    conversionFlight.current = true;
    setConverting(true);
    setConversionError("");
    try {
      if (!conversionCommand.current && !(await draft.flush())) {
        setReview(false);
        return;
      }
      const saved = draft.acknowledged.current;
      const source = saved.document || doc;
      const cmd = conversionCommand.current || {
        id: crypto.randomUUID(),
        targetId: idea.id,
        expectedRevision: saved.revision,
        type: "convert_idea" as const,
        projectId: crypto.randomUUID(),
        name,
        folderId: folder || null,
        brief: buildProjectBrief(saved.body, source),
        questions: pendingIdeaQuestions(saved.body, source).map((q) => q.text),
      };
      conversionCommand.current = cmd;
      setHasPendingConversion(true);
      try {
        localStorage.setItem(draft.key + ":conversion", JSON.stringify(cmd));
        localStorage.setItem(draft.key + ":conversion-mode", startMode);
      } catch {}
      await api<Library>("/library", cmd);
      const library = await api<Library>("/library");
      const projectId = library.ideas.find((i) => i.id === idea.id)?.projectId;
      if (!projectId)
        throw new Error(
          "The project could not be found yet. Check creation to continue safely.",
        );
      for (const suffix of [
        "",
        ":conversion",
        ":conversion-mode",
        ":pending",
        ":review",
      ]) {
        try {
          localStorage.removeItem(draft.key + suffix);
        } catch {}
      }
      onSaved(library);
      onOpen(projectId, startMode);
    } catch (e) {
      setConversionError((e as Error).message);
      if ([409, 422, 404].includes((e as { status?: number }).status || 0)) {
        conversionCommand.current = null;
        setHasPendingConversion(false);
        try {
          localStorage.removeItem(draft.key + ":conversion");
          localStorage.removeItem(draft.key + ":conversion-mode");
        } catch {}
        if ((e as { status?: number }).status === 409) {
          try {
            const data = await api<Library>("/library");
            const latest = data.ideas.find((i) => i.id === idea.id);
            if (latest) {
              draft.setLatest(latest);
              draft.setError(
                "This idea changed before project creation. Compare the saved version, then create your project.",
              );
              setReview(false);
            }
          } catch {}
        }
      }
    } finally {
      conversionFlight.current = false;
      setConverting(false);
    }
  }
  const saveState = draft.readOnly
    ? "Saved original"
    : documentInvalid
      ? "Needs attention"
      : uploading
        ? "Adding image…"
        : draft.busy
          ? "Saving…"
          : draft.dirty || question.trim()
            ? "Unsaved changes"
            : "Saved";
  return (
    <section className="idea-page idea-studio" aria-label="Develop an idea">
      <header className="idea-page-toolbar">
        <div className="idea-page-navigation">
          {navigation}
          <Button
            variant="quiet"
            size="icon"
            aria-label="Back to Ideas"
            disabled={blocked}
            onClick={() => void close()}
          >
            <ArrowLeft size={16} />
          </Button>
          <h1 className="idea-page-heading sr-only" tabIndex={-1}>
            {draft.saved.projectId
              ? "Original idea"
              : doc.title || "Untitled idea"}
          </h1>
          <span className="idea-save-state ml-auto shrink-0" role="status">
            <MorphText>{saveState}</MorphText>
          </span>
        </div>
        <div className="idea-page-actions">
          <Button
            variant="quiet"
            disabled={busy || documentInvalid}
            onClick={async () => {
              try {
                const { ideaArchive, downloadBlob } =
                  await import("./exportIdea");
                downloadBlob(
                  await ideaArchive(body, doc),
                  "woolgather-idea.zip",
                );
              } catch (e) {
                notify(
                  (e as Error).message ||
                    "Couldn’t export this idea. Try again.",
                  {
                    tone: "error",
                  },
                );
              }
            }}
          >
            <Download size={15} /> Export
          </Button>
          {draft.saved.projectId ? (
            <Button
              variant="primary"
              onClick={() => onOpen(draft.saved.projectId!)}
            >
              Open project <ArrowRight size={14} />
            </Button>
          ) : (
            !draft.readOnly && (
              <Button
                variant="primary"
                disabled={
                  busy ||
                  documentInvalid ||
                  (!hasIdeaContent(body, doc) && !question.trim()) ||
                  !!draft.latest
                }
                onClick={() =>
                  hasPendingConversion ? setReview(true) : startReview()
                }
              >
                {hasPendingConversion ? "Check creation" : "Create project"}
                <ArrowRight size={14} />
              </Button>
            )
          )}
        </div>
      </header>
      <div className="idea-workspace-content">
        {draft.error && (
          <Feedback
            tone="error"
            message={draft.error}
            action={
              !draft.latest
                ? { label: "Retry save", onClick: () => void draft.save() }
                : undefined
            }
          />
        )}
        <div className="idea-studio-layout">
          <section className="idea-paper" aria-label="Idea document">
            <div className="idea-paper-inner">
              <label className="idea-title-label">
                <span className="sr-only">Idea title</span>
                <Input
                  className="idea-title-input mt-0 h-auto rounded-none border-transparent bg-transparent px-0 py-2 text-[length:var(--text-title)] font-medium tracking-tight shadow-none focus-visible:border-transparent focus-visible:border-b-ring focus-visible:ring-0 md:text-[length:var(--text-heading)]"
                  value={doc.title}
                  placeholder="Untitled idea"
                  maxLength={120}
                  readOnly={locked}
                  onChange={(e) => edit({ ...doc, title: e.target.value })}
                />
              </label>
              <Suspense fallback={<p role="status">Opening your document…</p>}>
                <IdeaBlockEditor
                  blocks={materializeIdea(body, doc).document.blocks}
                  readOnly={locked}
                  onBusy={setUploading}
                  onInvalid={setDocumentInvalid}
                  onChange={(blocks) =>
                    draft.edit({
                      body: blocksText(blocks),
                      document: withIdeaBlocks(doc, blocks),
                    })
                  }
                />
              </Suspense>
              {!!question && (
                <div className="idea-inline-actions">
                  <span>Recovered question: {question}</span>
                  <Button onClick={keepQuestion}>Keep in document</Button>
                  <Button onClick={() => setQuestion("")}>Discard</Button>
                </div>
              )}
              {draft.latest && (
                <section className="idea-conflict">
                  <h2>Saved version</h2>
                  <p className="original-idea">
                    {buildIdeaBrief(
                      draft.latest.body,
                      draft.latest.document || doc,
                    )}
                  </p>
                  <div className="idea-inline-actions">
                    <Button onClick={() => draft.resolve(false)}>
                      Use saved version
                    </Button>
                    {!draft.latest.projectId &&
                      !draft.latest.trashed &&
                      !draft.latest.archived && (
                        <Button onClick={() => draft.resolve(true)}>
                          Keep my document
                        </Button>
                      )}
                  </div>
                </section>
              )}
            </div>
          </section>
        </div>
      </div>
      <ModalPresence>
        {review && (
          <CreateProjectDialog
            ideaTitle={doc.title}
            name={name}
            folder={folder}
            folders={folders}
            busy={converting}
            pending={hasPendingConversion}
            error={conversionError}
            startMode={startMode}
            onStartModeChange={setStartMode}
            onChange={reviewEdit}
            onCreate={() => void convert()}
            onClose={() => setReview(false)}
          />
        )}
      </ModalPresence>
    </section>
  );
}
