import {
  readProjectLocation,
  projectChatPath,
  projectViewPath,
} from "./projects/projectLocation";
import { MorphText } from "./ui/MorphText";
import { transitionView } from "./ui/viewTransition";
import { Brand as Mark } from "./ui/Brand";
import { AuthEntry } from "./account/AuthEntry";
import { McpAuthorization } from "./account/McpAuthorization";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";
import { ModalPresence, useSurfacePresence } from "@/ui/Modal";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ProjectStudio } from "./projects/ProjectStudio";
import "./projects/project-entry.css";
import { useSidebarPreferences } from "./library/useSidebarPreferences";
import { SidebarPersonalization } from "./library/SidebarPersonalization";
import { IdeaEditor } from "./library/IdeaEditor";
import {
  pinKey,
  resolvePins,
  setPin,
  movePin,
  setShortcut,
  type SidebarPin,
} from "./library/sidebarPreferences";
import { DeleteFolderDialog } from "./library/DeleteFolderDialog";
import {
  LibraryNav,
  LibraryPage,
  FolderEditor,
  type LibraryView,
} from "./library/Library";
import { ProjectSettings } from "./library/ProjectSettings";
import type {
  Library,
  Idea,
  Folder as LibraryFolder,
} from "../../../packages/domain/src/library";
import { libraryEntries } from "../../../packages/domain/src/library";
import { AccountWelcome } from "./onboarding/FirstRunWelcome";
import {
  GuideActionError,
  WelcomeModal,
  type GuideDestination,
} from "./onboarding/WelcomeModal";
import {
  blankIdeaRequest,
  createBlankIdea,
  restoreBlankIdeaRequest,
} from "./library/createIdea";
import { pendingDeletionLink } from "./account/deletion";
import { AccountDeletionPage } from "./account/AccountDeletionPage";
import { AccountMenu } from "./account/AccountMenu";
import { AccountSettings } from "./account/AccountSettings";
import { PlanProvider } from "./account/PlanProvider";
import { AccountAccess } from "./account/AccountAccess";
import {
  finishAccountSignIn,
  getAccountCallbackChoices,
} from "./account/sessionPool";
import { CallbackAccountPicker } from "./account/CallbackAccountPicker";
import { AccountReturn } from "./account/AccountReturn";
import {
  applyPreferences,
  returningToSettings,
  type SettingsSection,
} from "./account/model";
import { Feedback, useToast } from "./ui/Toast";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { AccountForm } from "./AccountForm";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight, ChevronRight, RotateCcw } from "lucide-react";
import {
  type Command,
  type Project,
  type ProjectSummary,
} from "../../../packages/domain/src";
import {
  api,
  ApiError,
  connect,
  isPasswordRecovery,
  setPasswordRecovery,
  makeCommand,
  sendCommand,
} from "./client";

const readDraft = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};
function storeDraft(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* The current state still remains available. */
  }
}
export function LoadingScreen() {
  // Keep the logo in phase as auth, access and workspace loading hand off.
  const [animationDelay] = useState(() => `${-(performance.now() % 2600)}ms`);
  const stroke =
    "M8 18c-3-7 4-13 10-9 9 6 5 22-2 23-7 1-9-7-4-13 5-7 15-10 20-4 6 7-1 20-8 20-7 0-7-8-2-14 5-6 13-8 17-3 5 6-1 15-7 16";
  return (
    <main className="loading" role="status">
      <div className="loading-content">
        <svg
          className="loading-symbol"
          viewBox="4 4 40 36"
          fill="none"
          aria-hidden="true"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path className="loading-symbol-track" d={stroke} />
          <path
            className="loading-symbol-ink"
            d={stroke}
            pathLength="1"
            style={{ animationDelay }}
          />
        </svg>
        <p>Loading your workspace...</p>
      </div>
    </main>
  );
}

export function App() {
  const [auth, setAuth] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>();
  const [failure, setFailure] = useState("");
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    applyPreferences(session?.user);
  }, [session?.user]);
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    connect()
      .then(async (client) => {
        if (!active) return;
        setAuth(client);
        const { data } = await client.auth.getSession();
        if (!(await finishAccountSignIn(data.session))) return;
        if (active) {
          setRecovering(
            !!data.session && isPasswordRecovery(data.session.user.id),
          );
          setSession(data.session);
        }
        const listener = client.auth.onAuthStateChange((event, next) => {
          if (active) {
            if (event === "PASSWORD_RECOVERY" && next) {
              setPasswordRecovery(next.user.id);
              setRecovering(true);
            }
            if (!next) {
              setPasswordRecovery("");
              setRecovering(false);
            }
            // SDK callbacks run inside Auth's lifecycle. Finish cross-account
            // bookkeeping outside that callback before revealing a workspace.
            setTimeout(() => {
              void finishAccountSignIn(next)
                .then((ready) => {
                  if (active && ready) setSession(next);
                })
                .catch((e) => {
                  if (active) setFailure(e.message);
                });
            }, 0);
          }
        });
        unsubscribe = () => listener.data.subscription.unsubscribe();
      })
      .catch((e) => {
        if (active) setFailure(e.message);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  if (failure && getAccountCallbackChoices().length)
    return <CallbackAccountPicker />;
  if (failure)
    return (
      <div className="entry-page">
        <Mark />
        <section className="entry">
          <h1>A little room to reconnect.</h1>
          <p role="alert">{failure}</p>
          <Button variant="primary" onClick={() => location.reload()}>
            Try again <RotateCcw size={16} />
          </Button>
        </section>
      </div>
    );
  if (session === undefined || !auth) return <LoadingScreen />;
  if (
    !recovering &&
    (location.pathname === "/account/delete" || pendingDeletionLink())
  )
    return (
      <AccountDeletionPage
        auth={auth}
        session={session}
        signIn={
          <SignIn auth={auth} recovering={false} onRecovered={() => {}} />
        }
      />
    );
  const content =
    session && !recovering ? (
      location.pathname === "/connect/authorize" ? (
        <McpAuthorization key={session.user.id} session={session} />
      ) : (
        <PlanProvider key={session.user.id}>
          <Workspace auth={auth} session={session} />
        </PlanProvider>
      )
    ) : (
      <SignIn
        auth={auth}
        recovering={recovering && !!session}
        onRecovered={() => {
          setPasswordRecovery("");
          setRecovering(false);
        }}
      />
    );
  return session ? (
    <AccountAccess
      key={session.user.id}
      auth={auth}
      session={session}
      fallback={<LoadingScreen />}
    >
      {content}
    </AccountAccess>
  ) : (
    content
  );
}
function SignIn({
  auth,
  recovering,
  onRecovered,
}: {
  auth: SupabaseClient;
  recovering: boolean;
  onRecovered: () => void;
}) {
  return (
    <AuthEntry>
      <AccountForm
        auth={auth}
        recovering={recovering}
        onRecovered={onRecovered}
      />
      {!recovering && <AccountReturn />}
    </AuthEntry>
  );
}
function Workspace({
  auth,
  session,
}: {
  auth: SupabaseClient;
  session: Session;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const sidebar = useSidebarPreferences(auth, session);
  const [personalizingSidebar, setPersonalizingSidebar] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const ideaCreationKey = "woolgather:welcome-idea-create:" + session.user.id;
  const pendingGuideIdea = useRef<ReturnType<typeof blankIdeaRequest> | null>(
    restoreBlankIdeaRequest(readDraft(ideaCreationKey)),
  );
  const [ideaId, setIdeaId] = useState<string | null>(null);
  const [ideaReview, setIdeaReview] = useState(false);
  const beforeIdeaLeave = useRef<(() => Promise<boolean>) | null>(null);
  const routeAttempt = useRef(0);
  const routePosition = useRef({
    index: Number(window.history.state?.workspaceIndex || 0),
    path: location.pathname + location.search,
  });
  const revertingRoute = useRef(false);
  const withIdeaSaved = async (action: () => void | Promise<void>) => {
    const attempt = ++routeAttempt.current;
    if (beforeIdeaLeave.current && !(await beforeIdeaLeave.current())) return;
    if (attempt === routeAttempt.current) await action();
  };
  const isPinned = (pin: SidebarPin) =>
    sidebar.preferences.pins.some((p) => pinKey(p) === pinKey(pin));
  const changePin = (pin: SidebarPin, pinned: boolean) => {
    void sidebar.change((current) => setPin(current, pin, pinned));
  };

  const [library, setLibrary] = useState<Library>({ folders: [], ideas: [] });
  const activeIdea = library.ideas.find((idea) => idea.id === ideaId);
  const [libraryView, setLibraryView] = useState<LibraryView>("projects");
  const [folderEditor, setFolderEditor] = useState<
    LibraryFolder | null | undefined
  >();
  const [deletedFolder, setDeletedFolder] = useState<LibraryFolder | null>(
    null,
  );
  const [projectSettingsInitial, setProjectSettingsInitial] =
    useState("general");
  const [draggedProject, setDraggedProject] = useState<ProjectSummary | null>(
    null,
  );
  const [draggedIdea, setDraggedIdea] = useState<Idea | null>(null);
  const [movingProject, setMovingProject] = useState(false);
  const [projectSettings, setProjectSettings] = useState<
    ProjectSummary | Project | null
  >(null);
  const [recent, setRecent] = useState<string[]>(
    () => readDraft("woolgather:recent:" + session.user.id) || [],
  );
  const landingData = useRef({
    projects,
    recent,
    ideas: library.ideas,
    hidden: sidebar.preferences.hidden,
  });
  landingData.current = {
    projects,
    recent,
    ideas: library.ideas,
    hidden: sidebar.preferences.hidden,
  };
  const defaultLibraryView = (): LibraryView =>
    !landingData.current.hidden.includes("recent") &&
    libraryEntries(
      "recent",
      landingData.current.projects,
      landingData.current.ideas,
      landingData.current.recent,
    ).length
      ? "recent"
      : !landingData.current.hidden.includes("ideas")
        ? "ideas"
        : "workspace";
  const recordOpen = (id: string) =>
    setRecent((previous) => {
      const next = [id, ...previous.filter((x) => x !== id)].slice(0, 50);
      storeDraft("woolgather:recent:" + session.user.id, next);
      return next;
    });
  const libraryChanged = (data: Library) => {
    setLibrary(data);
    void load().catch((e) => setError(e.message));
  };
  const [project, setProject] = useState<Project | null>(null);
  const [projectStart, setProjectStart] = useState<{
    id: string;
    mode: "assist" | "note";
  }>();
  const [screen, setScreenState] = useState<
    "library" | "new" | "project" | "idea"
  >("library");
  const [view, setView] = useState("overview");
  const [conversationId, setConversationId] = useState("main");
  const navigation = useRef(0);
  useEffect(
    () => () => {
      navigation.current++;
    },
    [],
  );
  const navigate = (path: string) => {
    if (path === location.pathname + location.search) return;
    const index = routePosition.current.index + 1;
    window.history.pushState({ workspaceIndex: index }, "", path);
    routePosition.current = { index, path };
    window.scrollTo(0, 0);
  };
  const showLibrary = (next: LibraryView) => {
    void withIdeaSaved(() =>
      transitionView(() => {
        navigation.current++;
        setScreenState("library");
        setLibraryView(next);
        navigate(
          next.startsWith("folder:") ? "/folders/" + next.slice(7) : "/" + next,
        );
      }),
    );
  };
  const openIdea = (idea: Idea) => {
    void withIdeaSaved(() => {
      navigation.current++;
      setIdeaId(idea.id);
      setIdeaReview(false);
      recordOpen(idea.id);
      setScreenState("idea");
      navigate("/ideas/" + idea.id);
      setError("");
    });
  };
  const setScreen = (next: "library" | "new" | "project") => {
    void withIdeaSaved(() => {
      navigation.current += 1;
      setScreenState(next);
      if (next === "library") setLibraryView(defaultLibraryView());
      if (next !== "project") navigate(next === "new" ? "/new" : "/");
      window.scrollTo(0, 0);
    });
  };
  async function startFromGuide(
    destination: GuideDestination,
    beforeOpen?: () => Promise<void>,
  ) {
    const attempt = ++navigation.current;
    const requireCurrentPage = () => {
      if (attempt !== navigation.current)
        throw new GuideActionError(
          "Your page changed before this could open. Try again from where you are.",
        );
    };
    if (beforeIdeaLeave.current && !(await beforeIdeaLeave.current()))
      throw new GuideActionError("Save your current idea before continuing.");
    requireCurrentPage();
    if (destination === "project") {
      await beforeOpen?.();
      requireCurrentPage();
      setScreenState("new");
      navigate("/new");
      setGuideOpen(false);
      return;
    }
    const command = pendingGuideIdea.current ?? blankIdeaRequest();
    pendingGuideIdea.current = command;
    if (!storeDraft(ideaCreationKey, command))
      throw new GuideActionError(
        "This browser couldn’t keep a recovery copy. Try again, or close this guide and create an Idea from the library.",
      );
    const { library: next, idea } = await createBlankIdea(command);
    requireCurrentPage();
    await beforeOpen?.();
    requireCurrentPage();
    pendingGuideIdea.current = null;
    clearDraft(ideaCreationKey);
    setLibrary(next);
    setIdeaId(idea.id);
    setIdeaReview(false);
    recordOpen(idea.id);
    setScreenState("idea");
    navigate("/ideas/" + idea.id);
    setError("");
    setGuideOpen(false);
  }
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!loading && screen === "library" && location.pathname === "/") {
      setLibraryView(defaultLibraryView());
    }
  }, [loading, screen, sidebar.preferences.hidden]);

  const [settings, setSettings] = useState<SettingsSection | null>(() =>
    ["/account/plan", "/account/billing"].includes(location.pathname)
      ? "billing"
      : location.pathname === "/account/usage"
        ? "usage"
        : location.pathname === "/account/security" ||
            returningToSettings(session.user.id)
          ? "security"
          : null,
  );
  useEffect(() => {
    const showPlan = () => setSettings("billing");
    window.addEventListener("woolgather:open-plan", showPlan);
    return () => window.removeEventListener("woolgather:open-plan", showPlan);
  }, []);
  const [signOutPrompt, setSignOutPrompt] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const { notify: setToast } = useToast();
  const load = useCallback(async () => {
    const [next, details] = await Promise.all([
      api<ProjectSummary[]>("/projects"),
      api<Library>("/library"),
    ]);
    landingData.current.projects = next;
    landingData.current.ideas = details.ideas;
    setProjects(next);
    setLibrary(details);
  }, []);
  useEffect(() => {
    let alive = true;
    async function restoreRoute() {
      const turn = ++navigation.current;
      const match = location.pathname.match(/^\/projects\/([0-9a-f-]{36})$/i);
      const ideaMatch = location.pathname.match(/^\/ideas\/([0-9a-f-]{36})$/i);
      setError("");
      try {
        if (ideaMatch) {
          setIdeaId(ideaMatch[1]);
          setScreenState("idea");
          await load();
          if (!alive || turn !== navigation.current) return;
          const idea = landingData.current.ideas.find(
            (item) => item.id === ideaMatch[1],
          );
          setIdeaReview(
            !idea?.projectId &&
              !idea?.archived &&
              !idea?.trashed &&
              new URLSearchParams(location.search).get("stage") === "review",
          );
          if (idea) recordOpen(idea.id);
          setScreenState("idea");
        } else if (match) {
          const p = await api<Project>("/projects/" + match[1]);
          if (!alive || turn !== navigation.current) return;
          setProject(p);
          recordOpen(p.id);
          setScreenState("project");
          const destination = readProjectLocation(location.search);
          setConversationId(destination.conversationId);
          setView(destination.view);
        } else {
          setScreenState(location.pathname === "/new" ? "new" : "library");
          const folder = location.pathname.match(
            /^\/folders\/([0-9a-f-]{36})$/i,
          );
          const route = location.pathname.slice(1);
          setLibraryView(
            folder
              ? `folder:${folder[1]}`
              : [
                    "workspace",
                    "projects",
                    "ideas",
                    "recent",
                    "archive",
                    "trash",
                  ].includes(route)
                ? (route as LibraryView)
                : defaultLibraryView(),
          );
        }
        window.scrollTo(0, 0);
      } catch (e) {
        if (alive && turn === navigation.current)
          setError((e as Error).message);
      }
    }
    void load()
      .then(() => {
        if (alive) return restoreRoute();
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    window.history.replaceState(
      { ...window.history.state, workspaceIndex: routePosition.current.index },
      "",
    );
    const restoreAfterSaving = async () => {
      if (revertingRoute.current) {
        revertingRoute.current = false;
        return;
      }
      const attempt = ++routeAttempt.current;
      const target = {
        index: Number(window.history.state?.workspaceIndex || 0),
        path: location.pathname + location.search,
      };
      const previous = routePosition.current;
      const ready =
        !beforeIdeaLeave.current || (await beforeIdeaLeave.current());
      if (!alive || attempt !== routeAttempt.current) return;
      if (!ready) {
        revertingRoute.current = true;
        window.history.go(previous.index - target.index);
        return;
      }
      routePosition.current = target;
      await restoreRoute();
    };
    window.addEventListener("popstate", restoreAfterSaving);
    return () => {
      alive = false;
      window.removeEventListener("popstate", restoreAfterSaving);
    };
  }, [load]);
  const dropItem = (folderId: string | null) => {
    const p = draggedProject,
      i = draggedIdea;
    setDraggedProject(null);
    setDraggedIdea(null);
    if (
      movingProject ||
      (!p && !i) ||
      (p?.folderId ?? i?.folderId ?? null) === folderId
    )
      return;
    setMovingProject(true);
    const moving = p
      ? sendCommand(
          makeCommand(p.id, p.revision, {
            type: "update_project",
            name: p.name,
            description: p.description,
            folderId,
          }),
        )
      : api("/library", {
          id: crypto.randomUUID(),
          targetId: i!.id,
          expectedRevision: i!.revision,
          type: "move_idea",
          folderId,
        });
    void moving
      .then(async () => {
        await load();
        setToast(p ? "Project moved." : "Idea moved.");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setMovingProject(false));
  };
  const open = async (
    id: string,
    savedIdea = false,
    startMode?: "assist" | "note",
  ): Promise<void> => {
    if (!savedIdea) return withIdeaSaved(() => open(id, true, startMode));
    setError("");
    const turn = ++navigation.current;
    try {
      const next = await api<Project>("/projects/" + id);
      if (turn !== navigation.current) return;
      setProject(next);
      setProjectStart(startMode ? { id, mode: startMode } : undefined);
      recordOpen(next.id);
      setScreenState("project");
      navigate("/projects/" + id + (startMode ? "?chat=main" : ""));
      setView(startMode ? "overview" : "home");
      setConversationId("main");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saved = (p: Project, quiet = false) => {
    setProject((previous) =>
      previous?.id === p.id && previous.revision > p.revision ? previous : p,
    );
    if (!quiet) setToast("Saved to your workspace");
    if (!quiet) void load().catch((e) => setError(e.message));
  };
  function showConversation(id: string) {
    setConversationId(id);
    setView("overview");
    if (project) navigate(projectChatPath(project.id, id, location.search));
  }
  function showView(next: string) {
    setView(next);
    if (project) navigate(projectViewPath(project.id, next, location.search));
  }

  if (loading) return <LoadingScreen />;
  return (
    <SidebarProvider
      className={`app-shell${screen === "idea" ? " app-shell--idea" : screen === "project" ? " app-shell--project" : ""}`}
    >
      <ModalPresence>
        {screen === "new" && (
          <NewProject
            folderId={
              libraryView.startsWith("folder:") ? libraryView.slice(7) : null
            }
            owner={session.user.id}
            onBack={() => showLibrary(libraryView)}
            onCreated={(p) => {
              saved(p);
              setProjectStart(
                p.description.trim() ? { id: p.id, mode: "note" } : undefined,
              );
              setScreenState("project");
              navigate(
                "/projects/" +
                  p.id +
                  (p.description.trim() ? "?chat=main" : ""),
              );
              setView(p.description.trim() ? "overview" : "home");
              setConversationId("main");
            }}
          />
        )}
      </ModalPresence>
      <SidebarRouteSync route={`${screen}:${libraryView}:${project?.id}`} />
      <a className="skip-link" href="#main">
        {screen === "idea"
          ? "Skip to idea"
          : screen === "project"
            ? "Skip to project"
            : "Skip to content"}
      </a>
      <Sidebar className="woolgather-sidebar">
        <SidebarHeader>
          <Button
            variant="surface"
            className="brand-button w-fit p-2 rounded-sm border-0 hover:bg-transparent focus-visible:ring-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-0"
            onClick={() => {
              setScreen("library");
            }}
          >
            <Mark />
          </Button>
        </SidebarHeader>
        <SidebarContent className="px-2">
          <LibraryNav
            preferences={sidebar.preferences}
            pins={resolvePins(sidebar.preferences, library, projects)}
            preferencesBusy={sidebar.busy}
            onPin={changePin}
            onOpenPin={(pin) => {
              if (pin.kind === "project") void open(pin.id);
              else if (pin.kind === "idea") {
                const idea = library.ideas.find((i) => i.id === pin.id);
                if (idea) openIdea(idea);
              } else {
                showLibrary(`folder:${pin.id}`);
              }
            }}
            onReorderPins={(key, target) => {
              void sidebar.change((current) => movePin(current, key, target));
            }}
            onPersonalize={() => setSettings("preferences")}
            onHideShortcut={(key) => {
              void sidebar.change((current) =>
                setShortcut(current, key, false),
              );
            }}
            showRecent={
              libraryEntries("recent", projects, library.ideas, recent).length >
              0
            }
            view={
              screen === "library"
                ? libraryView
                : screen === "idea"
                  ? activeIdea?.folderId
                    ? `folder:${activeIdea.folderId}`
                    : "ideas"
                  : project?.folderId
                    ? `folder:${project.folderId}`
                    : "projects"
            }
            folders={library.folders}
            draggingProject={
              !!(draggedProject || draggedIdea) && !movingProject
            }
            onDropProject={dropItem}
            onFolder={() => setFolderEditor(null)}
            onFolderAction={(f, action) =>
              action === "rename" ? setFolderEditor(f) : setDeletedFolder(f)
            }
            onView={showLibrary}
          />
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu
            user={session.user}
            onGuide={() => setGuideOpen(true)}
            onSettings={setSettings}
            onSignOut={() => {
              setSignOutError("");
              setSignOutPrompt(true);
            }}
          />
        </SidebarFooter>
      </Sidebar>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <SidebarTrigger />
            {screen === "idea" ? (
              <Button
                variant="quiet"
                onClick={() =>
                  showLibrary(
                    activeIdea?.folderId
                      ? `folder:${activeIdea.folderId}`
                      : "ideas",
                  )
                }
              >
                {library.folders.find(
                  (folder) => folder.id === activeIdea?.folderId,
                )?.name || "Ideas"}
              </Button>
            ) : screen === "library" && libraryView.startsWith("folder:") ? (
              <Button
                variant="quiet"
                onClick={() => {
                  navigation.current += 1;
                  setLibraryView("workspace");
                  navigate("/workspace");
                }}
              >
                Workspace
              </Button>
            ) : (
              <span>woolgather</span>
            )}
            {((screen !== "library" && screen !== "new") ||
              libraryView.startsWith("folder:")) && (
              <>
                <ChevronRight size={14} />
                <strong>
                  {screen === "library"
                    ? libraryView.startsWith("folder:")
                      ? library.folders.find(
                          (f) => f.id === libraryView.slice(7),
                        )?.name
                      : (
                          {
                            workspace: "Workspace",
                            projects: "Projects",
                            ideas: "Ideas",
                            recent: "Recently opened",
                            archive: "Archive",
                            trash: "Trash",
                          } as Record<string, string>
                        )[libraryView]
                    : screen === "idea"
                      ? activeIdea?.document?.title || "Untitled idea"
                      : project?.name}
                </strong>
              </>
            )}
          </div>
          <AccountMenu
            compact
            user={session.user}
            onGuide={() => setGuideOpen(true)}
            onSettings={setSettings}
            onSignOut={() => {
              setSignOutError("");
              setSignOutPrompt(true);
            }}
          />
        </header>
        {error && (
          <Feedback
            message={error}
            tone="error"
            action={{
              label: "Reload latest",
              onClick: () => {
                setError("");
                void (project && screen === "project"
                  ? open(project.id)
                  : load());
              },
            }}
          />
        )}
        {sidebar.error && !personalizingSidebar && (
          <Feedback
            tone="error"
            message={sidebar.error}
            action={{
              label: "Personalize sidebar",
              onClick: () => setSettings("preferences"),
            }}
          />
        )}
        <main id="main" tabIndex={-1}>
          {screen === "idea" ? (
            activeIdea ? (
              <IdeaEditor
                navigation={<SidebarTrigger />}
                key={session.user.id + ":" + activeIdea.id}
                idea={activeIdea}
                owner={session.user.id}
                folders={library.folders}
                onSaved={libraryChanged}
                beforeLeave={beforeIdeaLeave}
                reviewRequested={ideaReview}
                onReviewChange={(review) => {
                  setIdeaReview(review);
                  navigate(
                    "/ideas/" + activeIdea.id + (review ? "?stage=review" : ""),
                  );
                }}
                onClose={() => showLibrary("ideas")}
                onOpen={(id, startMode) => void open(id, true, startMode)}
              />
            ) : (
              <section className="library">
                <h1>Idea unavailable</h1>
                <p>
                  This idea may have been deleted or belong to another account.
                </p>
                <Button onClick={() => showLibrary("ideas")}>
                  Back to ideas
                </Button>
              </section>
            )
          ) : screen === "library" || screen === "new" ? (
            <LibraryPage
              onPin={changePin}
              isPinned={isPinned}
              preferencesBusy={sidebar.busy}
              key={libraryView}
              view={libraryView}
              data={library}
              projects={projects}
              owner={session.user.id}
              recent={recent}
              onData={libraryChanged}
              onRefresh={load}
              onOpen={(id) => void open(id)}
              onNew={() => setScreen("new")}
              onGuide={() => setGuideOpen(true)}
              onNewFolder={() => setFolderEditor(null)}
              onOpenFolder={(f) => {
                navigation.current += 1;
                setLibraryView(`folder:${f.id}`);
                navigate("/folders/" + f.id);
              }}
              onDragProject={(p) => {
                if (!movingProject) {
                  setDraggedProject(p);
                  if (p) setDraggedIdea(null);
                }
              }}
              onDragIdea={(i) => {
                if (!movingProject) {
                  setDraggedIdea(i);
                  if (i) setDraggedProject(null);
                }
              }}
              onOpenIdea={openIdea}
              draggingItem={!!(draggedProject || draggedIdea) && !movingProject}
              onDropItem={dropItem}
              onSettings={(p, initial) => {
                setProjectSettingsInitial(initial || "general");
                setProjectSettings(p);
              }}
              onRenameFolder={setFolderEditor}
              onDeleteFolder={setDeletedFolder}
            />
          ) : (
            project && (
              <ProjectStudio
                navigation={<SidebarTrigger />}
                key={project.id}
                project={project}
                startMode={
                  projectStart?.id === project.id
                    ? projectStart.mode
                    : undefined
                }
                onStartHandled={() => setProjectStart(undefined)}
                owner={session.user.id}
                conversationId={conversationId}
                onConversation={showConversation}
                view={view}
                onView={showView}
                onSaved={(p) => saved(p, true)}
                onSettings={() => setProjectSettings(project)}
                folderName={
                  library.folders.find((f) => f.id === project.folderId)?.name
                }
                onBack={() =>
                  showLibrary(
                    project.folderId
                      ? `folder:${project.folderId}`
                      : "projects",
                  )
                }
              />
            )
          )}
        </main>
      </div>
      <ModalPresence>
        {deletedFolder && (
          <DeleteFolderDialog
            folder={deletedFolder}
            onClose={() => setDeletedFolder(null)}
            onDeleted={async () => {
              await load();
              if (project)
                setProject(await api<Project>("/projects/" + project.id));
              if (libraryView === `folder:${deletedFolder.id}`) {
                setScreen("library");
                setLibraryView("workspace");
                navigate("/workspace");
              }
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    ".expanding-search > [data-slot='button']",
                  )
                  ?.focus({ preventScroll: true }),
              );
            }}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {folderEditor !== undefined && (
          <FolderEditor
            folder={folderEditor || undefined}
            onClose={() => setFolderEditor(undefined)}
            onSaved={libraryChanged}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {personalizingSidebar && (
          <SidebarPersonalization
            preferences={sidebar.preferences}
            pins={resolvePins(sidebar.preferences, library, projects)}
            busy={sidebar.busy}
            error={sidebar.error}
            onSave={sidebar.change}
            onClose={() => setPersonalizingSidebar(false)}
          />
        )}
      </ModalPresence>

      <ModalPresence>
        {projectSettings && (
          <ProjectSettings
            key={projectSettings.id}
            project={projectSettings}
            initial={projectSettingsInitial}
            owner={session.user.id}
            onDeleted={async () => {
              await load();
              if (project?.id === projectSettings.id) {
                setProject(null);
                setScreen("library");
                setLibraryView("trash");
                navigate("/trash");
              }
            }}
            folders={library.folders}
            onClose={() => {
              setProjectSettings(null);
              setProjectSettingsInitial("general");
            }}
            onSaved={async (p) => {
              if (project?.id === p.id) setProject(p);
              await load();
            }}
          />
        )}
      </ModalPresence>
      {!loading &&
        !error &&
        screen === "library" &&
        !settings &&
        !guideOpen &&
        folderEditor === undefined &&
        !deletedFolder &&
        !projectSettings &&
        !signOutPrompt && (
          <AccountWelcome
            key={session.user.id}
            auth={auth}
            owner={session.user.id}
            projectCount={projects.length}
            ideaCount={library.ideas.length}
            dismissedForSession={welcomeDismissed}
            onDismissForSession={() => setWelcomeDismissed(true)}
            onStart={startFromGuide}
          />
        )}
      <ModalPresence>
        {guideOpen && (
          <WelcomeModal
            onStart={startFromGuide}
            onClose={async () => setGuideOpen(false)}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {settings && (
          <AccountSettings
            auth={auth}
            user={session.user}
            initialSection={settings}
            onSidebarCustomize={() => setPersonalizingSidebar(true)}
            onClose={() => {
              setSettings(null);
              setPersonalizingSidebar(false);
              if (
                [
                  "/account/plan",
                  "/account/billing",
                  "/account/usage",
                  "/account/security",
                ].includes(location.pathname)
              ) {
                const path = libraryView.startsWith("folder:")
                  ? "/folders/" + libraryView.slice(7)
                  : "/" + libraryView;
                window.history.replaceState(window.history.state, "", path);
                routePosition.current = { ...routePosition.current, path };
              }
            }}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {signOutPrompt && (
          <Modal
            title="Sign out?"
            onClose={() => {
              if (!signingOut) setSignOutPrompt(false);
            }}
            footer={
              <>
                <Button
                  disabled={signingOut}
                  onClick={() => setSignOutPrompt(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={signingOut}
                  onClick={async () => {
                    setSigningOut(true);
                    try {
                      const result = await auth.auth.signOut({
                        scope: "local",
                      });
                      if (result.error) throw result.error;
                    } catch {
                      setSignOutError("Unable to sign out. Please try again.");
                    } finally {
                      setSigningOut(false);
                    }
                  }}
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </Button>
              </>
            }
          >
            <p>
              You’ll sign out of this account on this browser. Your other
              accounts and devices will stay signed in. Your saved projects and
              account-specific drafts will be kept.
            </p>
            {signOutError && <p role="alert">{signOutError}</p>}
          </Modal>
        )}
      </ModalPresence>
    </SidebarProvider>
  );
}
function SidebarRouteSync({ route }: { route: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [route, setOpenMobile]);
  return null;
}
function NewProject({
  folderId,
  owner,
  onBack,
  onCreated,
}: {
  folderId?: string | null;
  owner: string;
  onBack: () => void;
  onCreated: (p: Project) => void;
}) {
  const surface = useSurfacePresence();
  const stillOpen = useRef(true);
  stillOpen.current = surface?.open ?? true;
  const key = `wg:${owner}:new`;
  const initial = useRef(readDraft(key));
  const [name, setName] = useState(initial.current?.name || "");
  const [description, setDescription] = useState(
    initial.current?.description || "",
  );
  const [pending, setPending] = useState<Command | null>(
    initial.current?.pending || null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draftSafe, setDraftSafe] = useState(true);
  const mounted = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setDraftSafe(storeDraft(key, { name, description, pending }));
  }, [key, name, description, pending]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height =
        Math.min(260, input.current.scrollHeight) + "px";
    }
  }, [description]);
  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const cmd =
      pending ||
      makeCommand(crypto.randomUUID(), 0, {
        type: "create_project",
        folderId,
        name,
        description,
      });
    setPending(cmd);
    storeDraft(key, { name, description, pending: cmd });
    try {
      const p = await sendCommand(cmd);
      clearDraft(key);
      if (mounted.current && stillOpen.current) onCreated(p);
    } catch (e) {
      if (!mounted.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && [400, 422].includes(e.status))
        setPending(null);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="New project"
      className="new-project-dialog sm:max-w-lg"
      onClose={() => {
        if (!busy && draftSafe) onBack();
      }}
      footer={
        <>
          <Button
            variant="quiet"
            disabled={busy || !draftSafe}
            onClick={onBack}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-project-form"
            disabled={busy}
            aria-busy={busy}
          >
            <MorphText>
              {busy ? "Creating…" : pending ? "Retry saving" : "Create project"}
            </MorphText>
            <ArrowRight size={16} />
          </Button>
        </>
      }
    >
      <p className="project-entry-intro">
        Describe what you have in mind, or start with a blank page.
      </p>
      <form
        id="new-project-form"
        className="project-entry-form"
        onSubmit={create}
      >
        <label htmlFor="project-name">
          Project name <span className="optional">Optional</span>
        </label>
        <Input
          id="project-name"
          value={name}
          disabled={!!pending}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="Untitled Project"
        />
        <label htmlFor="idea">
          Your starting point <span className="optional">Optional</span>
        </label>
        <Textarea
          id="idea"
          className="min-h-32 max-h-64 resize-none"
          ref={input}
          value={description}
          disabled={!!pending}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={12000}
          placeholder="I’ve been thinking about…"
          rows={4}
        />
        {error && <Feedback message={error} tone="error" />}
        {!draftSafe && (
          <Feedback
            tone="error"
            message="Your browser couldn’t keep a recovery copy. Keep this page open until the project is saved."
          />
        )}
      </form>
    </Modal>
  );
}
