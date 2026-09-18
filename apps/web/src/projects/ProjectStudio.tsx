import { usePlan, openPlan } from "../account/PlanProvider";
import {
  actionCreditLimit,
  planRoute,
} from "../../../../packages/domain/src/plans";
import { resolveReasoning } from "../../../../packages/domain/src/planningComposer";
import {
  updatePlanningLive,
  type PlanningLiveState,
} from "../../../../packages/domain/src/planningStream";
import { VoiceCallCard } from "./VoiceCallCard";
import { failureWorkReason, visibleWorkActivity } from "./conversationWork";
import type { ProjectVoiceHistoryEntry } from "./ProjectVoice";
import { useConversationScroll } from "./useConversationScroll";
import { AgentAvatar } from "./AgentAvatar";
import { AgentGroupReplies, AgentReadReceipt } from "./AgentGroupReplies";
import { transitionView } from "../ui/viewTransition";
import { onMotionReduction, reducedMotion } from "../ui/motion";
import { readProjectLocation, projectChatPath } from "./projectLocation";
import { ComposerEditor, type ComposerEditorElement } from "./ComposerEditor";
import { ConversationNavigation } from "./ConversationNavigation";
import { stableJson } from "../../../../packages/domain/src/stableJson";
import {
  ConversationMessageActions,
  TurnWorkSummary,
} from "./ConversationMessageActions";
import {
  conversationsOf,
  agentsOf,
  turnConversationId,
} from "../../../../packages/domain/src/projectConversations";
import { MorphText } from "../ui/MorphText";
import { useMediaQuery } from "../hooks/use-media-query";
import { formatModelName } from "./modelName";
import {
  ComposerControls,
  ConversationFile,
  composerToolIcons,
} from "./ComposerControls";
import { useComposerCommands } from "./useComposerCommands";
import { useComposerContext } from "./useComposerContext";
import { ComposerContextPicker } from "./ComposerContextPicker";
import {
  ProjectFilePreview,
  type ProjectPreviewFile,
} from "./ProjectFilePreview";
import { ModalPresence } from "../ui/Modal";
import { ProjectSourcesLibrary } from "../library/ProjectSourcesLibrary";
import { ProjectSourceThumbnail } from "./ProjectSourceThumbnail";
import { ProjectSourceEditor } from "./ProjectSourceEditor";
import { useSourceUploads } from "./useSourceUploads";
import { VoiceDictation } from "./VoiceDictation";
import {
  ConversationContextText,
  ConversationReferences,
  type ConversationReference,
} from "./ConversationContextText";
import type {
  ProjectSource,
  ProjectSourceMeaning,
} from "../../../../packages/domain/src/projectSources";
import { composerToolDetails } from "./composerCommands";
import { CommandSuggestions } from "../components/ui/command-suggestions";
import {
  composerSchema,
  defaultComposer,
  planningModes,
  type ComposerOptions,
} from "../../../../packages/domain/src/planningComposer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelPage } from "@/components/ui/panel-page";
import { PlanThoughtDetails } from "./PlanThoughtDetails";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownLeft,
  FileText,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  History,
  Settings,
  Archive,
  Search,
  Square,
  X,
} from "lucide-react";
import type { Item, ItemInput, Project } from "../../../../packages/domain/src";
import {
  planningSource,
  projectOpeningText,
  thinkingOf,
  type PlanningTurn,
} from "../../../../packages/domain/src/projectPlanning";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import { makeCommand } from "../client";
import { ProjectTransport } from "./ProjectTransport";
import { ProjectVoice } from "./ProjectVoice";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectItemEditor } from "./ProjectItemEditor";
import { ProjectText } from "./ProjectText";
import { PlanningMap, visualConcepts } from "./PlanningMap";
import { clearDraft, readDraft, storeDraft } from "./model";
import "./project-studio.css";
import "./plan-panel.css";
import "./project-home.css";

type Props = {
  project: Project;
  owner: string;
  view: string;
  folderName?: string;
  navigation?: ReactNode;
  startMode?: "assist" | "note";
  conversationId?: string;
  onConversation?: (id: string) => void;
  onStartHandled?: () => void;
  onView: (view: string) => void;
  onBack: () => void;
  onSaved: (project: Project) => void;
  onSettings: () => void;
};
type PlanningReply = {
  project: Project;
  enabled: boolean;
  notice?: string;
  pending?: boolean;
};
type PendingSend = {
  maxCredits?: number;
  composer?: ComposerOptions;
  conversationId?: string;
  action: "start" | "send" | "retry";
  id: string;
  projectId: string;
  revision: number;
  turnId: string;
  text: string;
  mode: "assist" | "note";
  focusId: string | null;
};

function metadataIsSaved(project: Project, command: Record<string, unknown>) {
  const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
  const conversation = conversationsOf(project).find(
    (c) => c.id === command.conversationId,
  );
  const agent = agentsOf(project).find((a) => a.id === command.agentId);
  switch (command.action) {
    case "create_conversation":
      return (
        !!conversation &&
        conversation.title === command.title &&
        same(conversation.agentIds, command.agentIds) &&
        same(conversation.branch, command.branch ?? null)
      );
    case "update_conversation":
      return (
        !!conversation &&
        (command.title === undefined || conversation.title === command.title) &&
        (command.agentIds === undefined ||
          same(conversation.agentIds, command.agentIds))
      );
    case "archive_conversation":
      return !!conversation && conversation.archived === command.archived;
    case "delete_conversation":
      return !conversation;
    case "upsert_agent":
      return (
        !!agent &&
        agent.name === command.name &&
        agent.instructions === command.instructions &&
        (command.avatar === undefined || agent.avatar === command.avatar) &&
        same(agent.scopeIds, command.scopeIds) &&
        !agent.archived
      );
    case "archive_agent":
      return !!agent && agent.archived === command.archived;
    case "react": {
      const turn = thinkingOf(project).turns.find(
        (t) => t.id === command.turnId,
      );
      return (
        !!turn &&
        (turn.reaction?.[command.message as "user" | "assistant"] || null) ===
          (command.reaction || null)
      );
    }
    default:
      return false;
  }
}

function clearConversationLocalState(
  owner: string,
  projectId: string,
  conversationId: string,
) {
  const suffix = conversationId === "main" ? "" : `:${conversationId}`;
  const prefix = `woolgather:thinking-`;
  const exact = new Set([
    `${prefix}draft:${owner}:${projectId}${suffix}`,
    `${prefix}draft:${owner}:${projectId}${suffix}:context`,
    `${prefix}draft:${owner}:${projectId}${suffix}:inline`,
    `${prefix}send:${owner}:${projectId}${suffix}`,
    `${prefix}draft:${owner}:${projectId}${suffix}:manual`,
    `${prefix}draft:${owner}:${projectId}${suffix}:manual:send`,
    `woolgather:project-voice-pending:${owner}:${projectId}:${conversationId}`,
  ]);
  const delegationPrefix = `woolgather:project-voice-delegation:${owner}:${projectId}:${conversationId}:`;
  try {
    const storage = globalThis.localStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key && (exact.has(key) || key.startsWith(delegationPrefix)))
        storage.removeItem(key);
    }
  } catch {
    /* Draft cleanup is best effort; the saved deletion remains authoritative. */
  }
}

export function ProjectStudio(props: Props) {
  const transport = useContext(ProjectTransport);
  // Availability belongs to the project, not the keyed per-chat draft. Keep
  // settled controls visible while each opened conversation refreshes status.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void transport
      .request<{ voice?: boolean }>("/config")
      .then((config) => {
        if (alive) setVoiceEnabled(config.voice === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [transport]);
  const home = props.view === "home";
  const homeKey = `woolgather:new-conversation:${props.owner}:${props.project.id}`;
  const [homeId, setHomeId] = useState<string>(
    () => readDraft(homeKey) || crypto.randomUUID(),
  );
  const [homeTab, setHomeTab] = useState<"chats" | "agents" | "sources">(
    "chats",
  );
  const [selectedId, setSelectedId] = useState(
    props.conversationId || readProjectLocation(location.search).conversationId,
  );
  useEffect(() => {
    if (props.conversationId) setSelectedId(props.conversationId);
  }, [props.conversationId]);
  useEffect(() => {
    if (home) storeDraft(homeKey, homeId);
  }, [home, homeKey, homeId]);
  useEffect(() => {
    if (!home && selectedId === homeId) {
      clearDraft(homeKey);
      setHomeId(crypto.randomUUID());
    }
  }, [home, selectedId, homeId, homeKey]);
  const missingChat =
    !home &&
    props.view === "overview" &&
    !conversationsOf(props.project).some((chat) => chat.id === selectedId);
  useEffect(() => {
    if (missingChat) props.onView("home");
  }, [missingChat, props.onView]);
  const activeId =
    home || missingChat
      ? homeId
      : conversationsOf(props.project).some(
            (c) =>
              c.id === selectedId &&
              (!c.archived ||
                (!!props.project.lifecycle &&
                  props.project.lifecycle !== "active")),
          )
        ? selectedId
        : "main";
  const selectConversation = (id: string) => {
    const select = () => {
      setSelectedId(id);
      if (props.onConversation) props.onConversation(id);
      else {
        props.onView("overview");
        history.replaceState(
          history.state,
          "",
          projectChatPath(props.project.id, id, location.search),
        );
      }
    };
    // First send/voice promotes the mounted home composer into its new chat.
    // Keep that handoff synchronous; only switching workspaces dissolves.
    if (id === activeId) select();
    else transitionView(select);
  };
  const openHome = (tab: "chats" | "agents" | "sources" = "chats") => {
    transitionView(() => {
      setHomeTab(tab);
      props.onView("home");
    });
  };
  const secondaryViews = ["source", "references", "history", "removed"];
  const navigateView = (next: string) => {
    if (secondaryViews.includes(next) || secondaryViews.includes(props.view)) {
      transitionView(() => props.onView(next));
    } else props.onView(next);
  };
  if (secondaryViews.includes(props.view))
    return <ProjectWorkspace {...props} onView={navigateView} secondary />;
  return (
    <ThinkingWorkspace
      key={activeId}
      {...props}
      enabled={enabled}
      onEnabled={setEnabled}
      voiceEnabled={voiceEnabled}
      onView={navigateView}
      home={home || missingChat}
      homeTab={homeTab}
      onHomeTab={setHomeTab}
      onHome={openHome}
      conversationId={activeId}
      onConversation={selectConversation}
    />
  );
}

function ThinkingWorkspace({
  project,
  owner,
  view,
  folderName,
  navigation,
  startMode,
  onStartHandled,
  onView,
  onBack,
  onSaved,
  onSettings,
  conversationId,
  onConversation,
  home,
  homeTab,
  onHomeTab,
  onHome,
  enabled,
  onEnabled,
  voiceEnabled,
}: Props & {
  enabled: boolean | null;
  onEnabled: (enabled: boolean) => void;
  voiceEnabled: boolean;
  conversationId: string;
  onConversation: (id: string) => void;
  home: boolean;
  homeTab: "chats" | "agents" | "sources";
  onHomeTab: (tab: "chats" | "agents" | "sources") => void;
  onHome: (tab?: "chats" | "agents" | "sources") => void;
}) {
  const { plan, refresh: refreshPlan } = usePlan();
  const transport = useContext(ProjectTransport),
    { notify } = useToast();
  const state = thinkingOf(project),
    current = useRef(project);
  current.current = project;
  const alive = useRef(true),
    sendLock = useRef(false),
    sendGeneration = useRef(0);
  const openingHandled = useRef(false);
  const [live, setLive] = useState<PlanningLiveState | null>(null);
  const [interruptedReplies, setInterruptedReplies] = useState<
    Record<string, PlanningLiveState>
  >({});
  const liveForTurn = (id: string) =>
    live?.turnId === id ? live : interruptedReplies[id];
  const chatSuffix = conversationId === "main" ? "" : `:${conversationId}`;
  const draftKey = `woolgather:thinking-draft:${owner}:${project.id}${chatSuffix}`;
  const pendingKey = `woolgather:thinking-send:${owner}:${project.id}${chatSuffix}`;
  const editKey = `woolgather:thinking-edit:${owner}:${project.id}`;
  const conversation = conversationsOf(project).find(
    (c) => c.id === conversationId,
  ) || {
    id: conversationId,
    title: "New conversation",
    agentIds: [] as string[],
    branch: null,
  };
  const turns = state.turns.filter(
    (t) => turnConversationId(t) === conversationId,
  );
  const assigned = agentsOf(project).filter((a) =>
    conversation.agentIds.includes(a.id),
  );
  const speaker = assigned.length === 1 ? assigned[0].name : "woolgather";
  const [text, setText] = useState<string>(() => readDraft(draftKey) || "");
  const composerKey = draftKey + ":context";
  const [options, setOptions] = useState<ComposerOptions>(() => {
    const saved = composerSchema.safeParse(readDraft(composerKey));
    return saved.success ? saved.data : defaultComposer();
  });
  const [uploading, setUploading] = useState(false);
  const fileAdder = useRef<((files: File[]) => void) | null>(null);
  const changeOptions = (next: ComposerOptions) => {
    setOptions(next);
    const saved = storeDraft(composerKey, next);
    if (!saved)
      setNotice(
        "This browser could not save your draft. Keep this page open until your message is sent.",
      );
    return saved;
  };

  const [pending, setPending] = useState<PendingSend | null>(() =>
    readDraft(pendingKey),
  );
  const [voiceActive, setVoiceActive] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [voiceCaption, setVoiceCaption] = useState("");
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [inspectAgentId, setInspectAgentId] = useState<string | null>(null);
  const [conversationNavigationHost, setConversationNavigationHost] =
    useState<HTMLDivElement | null>(null);
  const [sourcesBusy, setSourcesBusy] = useState(false);
  const sourceQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [previewFile, setPreviewFile] = useState<ProjectPreviewFile | null>(
    null,
  );
  const closeSourceSpace = useRef<(() => void) | undefined>(undefined);
  const voiceWasActive = useRef(false);
  useEffect(() => {
    if (voiceWasActive.current && !voiceActive)
      composer.current?.focus({ preventScroll: true });
    voiceWasActive.current = voiceActive;
  }, [voiceActive]);
  const voicePanel = useRef<HTMLDivElement>(null);
  const [voiceHistory, setVoiceHistory] = useState<ProjectVoiceHistoryEntry[]>(
    [],
  );
  const noteKey = draftKey + ":manual";
  const [noteText, setNoteText] = useState<string>(
    () => readDraft(noteKey) || "",
  );
  const noteRequest = useRef<PendingSend | null>(readDraft(noteKey + ":send"));
  const [noteOpen, setNoteOpen] = useState(() => !!readDraft(noteKey));
  const [noteDraftSafe, setNoteDraftSafe] = useState(true);
  useEffect(() => {
    setNoteDraftSafe(storeDraft(noteKey, noteText));
  }, [noteKey, noteText]);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    if (notice) {
      notify(notice, { tone: "error" });
      setNotice("");
    }
  }, [notice, notify]);
  const [focus, setFocus] = useState<string | null>(
    () => readDraft(editKey)?.id || state.focusId,
  );
  const [detailOpen, setDetailOpen] = useState(() => !!readDraft(editKey));
  const [planOpen, setPlanOpen] = useState(
    () => !home && (view !== "overview" || !!readDraft(editKey)),
  );
  const previousLocation = useRef({ home, view });
  useEffect(() => {
    const routeChanged =
      previousLocation.current.home !== home ||
      previousLocation.current.view !== view;
    previousLocation.current = { home, view };
    if (home) {
      setPlanOpen(false);
    } else if (view !== "overview") {
      setPlanOpen(true);
    } else if (routeChanged) {
      setPlanOpen(false);
    }
  }, [home, view]);
  const conversationPane = useRef<HTMLElement>(null);
  const previousPaneWidth = useRef<number | null>(null);
  const paneAnimation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const pane = conversationPane.current;
    if (!pane) return;
    const width = pane.getBoundingClientRect().width;
    const previous = previousPaneWidth.current;
    previousPaneWidth.current = width;
    const duration = parseFloat(
      getComputedStyle(pane).getPropertyValue("--motion-layout"),
    );
    if (previous === null || previous === width || !duration || reducedMotion())
      return;
    const runningOffset = new DOMMatrixReadOnly(
      getComputedStyle(pane).transform,
    ).m41;
    paneAnimation.current?.cancel();
    paneAnimation.current = null;
    pane.getAnimations().forEach((animation) => animation.cancel());
    const animation = pane.animate(
      [
        {
          transform: `translateX(${(previous - width) / 2 + runningOffset}px)`,
        },
        { transform: "translateX(0)" },
      ],
      {
        duration: duration < 10 ? duration * 1000 : duration,
        easing: "cubic-bezier(.2,.8,.2,1)",
      },
    );
    paneAnimation.current = animation;
    const clearAnimation = () => {
      if (paneAnimation.current === animation) paneAnimation.current = null;
    };
    animation.finished.then(clearAnimation, clearAnimation);
  }, [planOpen]);
  useEffect(() => {
    const cancelPaneAnimation = () => {
      paneAnimation.current?.cancel();
      paneAnimation.current = null;
    };
    const removeMotionListener = onMotionReduction(cancelPaneAnimation);
    return () => {
      removeMotionListener();
      cancelPaneAnimation();
    };
  }, []);
  const narrowWorkspace = useMediaQuery("(max-width: 1000px)");
  const [mapView, setMapView] = useState<"map" | "flow" | "outline">(
    view === "flow" ? "flow" : view === "map" ? "map" : "outline",
  );
  useEffect(() => {
    if (view === "map" || view === "flow" || view === "outline")
      setMapView(view);
  }, [view]);
  const [planQuery, setPlanQuery] = useState("");
  const [editFocus, setEditFocus] = useState<"title" | "answer">("title");
  const planReturnFocus = useRef<HTMLElement | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState({
    to: "",
    kind: "affects",
    reason: "",
  });
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState<
    | {
        id: string;
        title: string;
        body: string;
        certainty: ItemInput["certainty"];
        base: number;
      }
    | undefined
  >(() => readDraft(editKey) || undefined);
  const [exporting, setExporting] = useState(false);
  const planTrigger = useRef<HTMLButtonElement>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  const composer = useRef<ComposerEditorElement>(null);
  const {
    viewport: discussion,
    content: discussionContent,
    following: stickToBottom,
    away: awayFromLatest,
    toLatest,
  } = useConversationScroll(
    `${project.id}:${conversationId}`,
    !home,
    voiceHistory.map((call) => call.runId).join(":"),
  );
  const openFilePicker = useRef<(() => void) | null>(null);
  const readOnly = !!project.lifecycle && project.lifecycle !== "active";
  const concepts = visualConcepts(project),
    chosen = concepts.find((c) => c.id === focus);
  const waiting = state.turns.find((t) => t.status === "pending");
  const commands = useComposerCommands({
    text,
    onTextChange: setText,
    inputRef: composer,
    disabled:
      enabled !== true ||
      voiceActive ||
      dictating ||
      uploading ||
      busy ||
      !!waiting ||
      !!pending ||
      readOnly,
    onChoose: (tool) => changeOptions({ ...options, tool }),
  });
  const contextPicker = useComposerContext({
    text,
    onTextChange: setText,
    inputRef: composer,
    disabled:
      uploading ||
      sourcesBusy ||
      busy ||
      !!waiting ||
      !!pending ||
      readOnly ||
      voiceActive ||
      dictating,
    onOpen: commands.dismiss,
    catalog: {
      agent: agentsOf(project)
        .filter((agent) => !agent.archived)
        .map((agent) => ({
          id: `agent-${agent.id}`,
          targetId: agent.id,
          kind: "agent",
          avatar: agent.avatar,
          label: agent.name,
          description: agent.instructions.slice(0, 110),
          disabled:
            options.agentIds.includes(agent.id) ||
            options.agentIds.length >= 2 ||
            enabled !== true,
        })),
      thought: project.items
        .filter((item) => !item.removed)
        .map((item) => ({
          id: `thought-${item.id}`,
          targetId: item.id,
          kind: "thought",
          label: item.title,
          description: item.body?.slice(0, 110) || "In your plan",
          disabled:
            options.references.includes(item.id) ||
            options.references.length >= 8,
        })),
      source: (project.sources || [])
        .filter((file) => !file.archived)
        .map((file) => ({
          id: `source-${file.id}`,
          targetId: file.id,
          kind: "source",
          label: file.name,
          description: file.note.slice(0, 110) || "Saved in this project",
          disabled:
            options.sourceIds.includes(file.id) ||
            options.sourceIds.length + options.attachments.length >= 6 ||
            options.attachments.some(
              (attachment) => attachment.id === file.attachmentId,
            ),
        })),
    },
    onChoose(choice) {
      if (choice.kind === "upload") {
        openFilePicker.current?.();
        return true;
      }
      if (!choice.targetId) return false;
      const key =
        choice.kind === "agent"
          ? "agentIds"
          : choice.kind === "source"
            ? "sourceIds"
            : "references";
      return changeOptions({
        ...options,
        [key]: [...new Set([...options[key], choice.targetId])],
      });
    },
  });
  const waitingId = waiting?.id || (busy ? pending?.turnId : undefined);
  const latestReplyId = useRef(
    turns.filter((t) => t.status === "complete").at(-1)?.id,
  );
  const followReply = useRef(true);
  const source = planningSource(project);
  const opening = projectOpeningText(project);
  const sourcePreview = opening
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function turnReferences(
    turn: Pick<PlanningTurn, "composer" | "sourceReferences">,
    reply = false,
  ): ConversationReference[] {
    const sources = reply
      ? (turn.sourceReferences || []).map((reference) => reference.sourceId)
      : turn.composer?.sourceIds || [];
    return [
      ...sources.flatMap((id) => {
        const source = project.sources?.find((item) => item.id === id);
        return source
          ? [
              {
                id: `source-${id}`,
                label: source.name,
                kind: "source" as const,
                image: source.mime.startsWith("image/"),
                attachmentId: source.attachmentId,
                onOpen: () => previewSource(source),
              },
            ]
          : [];
      }),
      ...(reply ? [] : turn.composer?.references || []).flatMap((id) => {
        const thought = project.items.find((item) => item.id === id);
        return thought
          ? [
              {
                id: `thought-${id}`,
                label: thought.title,
                kind: "thought" as const,
                onOpen: () => {
                  setPlanOpen(true);
                  if (!home) onView(mapView);
                  selectConcept(id);
                },
              },
            ]
          : [];
      }),
      ...(reply ? [] : turn.composer?.agentIds || []).flatMap((id) => {
        const agent = agentsOf(project).find((item) => item.id === id);
        return agent
          ? [
              {
                id: `agent-${id}`,
                label: agent.name,
                kind: "agent" as const,
                avatar: agent.avatar,
                onOpen: () => setInspectAgentId(id),
              },
            ]
          : [];
      }),
    ];
  }
  function accept(value: PlanningReply) {
    void refreshPlan();
    if (!alive.current) return;
    onEnabled(value.enabled);
    if (
      value.project.id === current.current.id &&
      value.project.revision > current.current.revision
    ) {
      current.current = value.project;
      onSaved(value.project);
    }
    if (value.notice) setNotice(value.notice);
  }
  async function refresh(beforeAccept?: (value: PlanningReply) => void) {
    const p = current.current;
    const value = await transport.request<PlanningReply>("/project-planning", {
      action: "status",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
    });
    beforeAccept?.(value);
    accept(value);
    return value;
  }
  function sourceCommand(extra: {
    action:
      "register_source" | "update_source" | "archive_source" | "delete_source";
    sourceId: string;
    attachmentId?: string;
    note?: string;
    meaning?: ProjectSourceMeaning;
    archived?: boolean;
  }) {
    const work = sourceQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (readOnly)
          throw new Error("Restore this project before changing sources.");
        setSourcesBusy(true);
        const p = current.current;
        const request = {
          id: crypto.randomUUID(),
          projectId: p.id,
          revision: p.revision,
          ...extra,
        };
        try {
          const saved = await transport.request<Project>(
            "/project-sources",
            request,
          );
          if (extra.action === "delete_source")
            composer.current?.removeReference(`source-${extra.sourceId}`);
          current.current = saved;
          if (alive.current) onSaved(saved);
          return saved;
        } catch (cause) {
          const saved = await refresh((value) => {
            if (
              extra.action === "delete_source" &&
              !value.project.sources?.some(
                (source) => source.id === extra.sourceId,
              )
            )
              composer.current?.removeReference(`source-${extra.sourceId}`);
          }).catch(() => undefined);
          const source = saved?.project.sources?.find(
            (item) => item.id === extra.sourceId,
          );
          const confirmed =
            !!saved &&
            (extra.action === "delete_source"
              ? !source
              : source &&
                (extra.action === "register_source"
                  ? source.attachmentId === extra.attachmentId
                  : extra.action === "archive_source"
                    ? source.archived === extra.archived
                    : (extra.note === undefined ||
                        source.note === extra.note) &&
                      (extra.meaning === undefined ||
                        source.meaning === extra.meaning)));
          if (confirmed) return saved.project;
          throw cause;
        } finally {
          if (alive.current) setSourcesBusy(false);
        }
      });
    sourceQueue.current = work;
    return work;
  }
  async function registerAttachment(file: ProjectPreviewFile) {
    const existing = current.current.sources?.find(
      (source) => source.attachmentId === file.id,
    );
    if (existing && !existing.archived) return;
    if (existing)
      await sourceCommand({
        action: "archive_source",
        sourceId: existing.id,
        archived: false,
      });
    else
      await sourceCommand({
        action: "register_source",
        sourceId: crypto.randomUUID(),
        attachmentId: file.id,
        note: "",
        meaning: "undecided",
      });
  }
  function useSource(source: ProjectSource) {
    if (
      options.sourceIds.includes(source.id) ||
      options.attachments.some((file) => file.id === source.attachmentId)
    ) {
      composer.current?.focus({ preventScroll: !home });
      return;
    }
    if (options.sourceIds.length + options.attachments.length >= 6) {
      notify("Use up to 6 files per message.", { tone: "error" });
      return;
    }
    if (
      changeOptions({
        ...options,
        sourceIds: [...options.sourceIds, source.id],
      })
    )
      composer.current?.focus({ preventScroll: !home });
  }
  function previewSource(source: ProjectSource, closeSpace?: () => void) {
    closeSourceSpace.current = closeSpace;
    setPreviewFile({
      id: source.attachmentId,
      name: source.name,
      mime: source.mime,
      size: source.size,
    });
  }
  const sourceUploads = useSourceUploads(
    `woolgather:source-uploads:${owner}:${project.id}`,
    registerAttachment,
  );
  useEffect(() => {
    if (sourceUploads.error) {
      notify(sourceUploads.error, {
        tone: "error",
        id: "project-source-upload",
        duration: 8_000,
      });
      sourceUploads.clearError();
    }
  }, [sourceUploads.error, notify]);
  const hasMessage = !!(
    text.trim() ||
    options.attachments.length ||
    options.references.length ||
    options.quotes.length ||
    options.agentIds.length ||
    options.sourceIds.length
  );
  const editingSource = project.sources?.find(
    (source) => source.id === editingSourceId && !source.archived,
  );
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {
      if (alive.current)
        setNotice(
          "The conversation could not be loaded. Your project and draft are kept.",
        );
    });
    return () => {
      alive.current = false;
    };
  }, [project.id, transport]);
  useEffect(() => {
    if (!waitingId) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [waitingId, transport]);
  useEffect(() => {
    storeDraft(draftKey, text);
  }, [draftKey, text]);
  useEffect(() => {
    if (editing) storeDraft(editKey, editing);
  }, [editKey, editing]);
  useEffect(() => {
    const latest = turns.filter((t) => t.status === "complete").at(-1);
    if (latest && latest.id !== latestReplyId.current) {
      latestReplyId.current = latest.id;
      if (followReply.current && !editing) {
        setFocus(state.focusId);
        setDetailOpen(false);
      }
    }
  }, [project.revision]);
  useEffect(() => {
    if (!pending) return;
    const acknowledged = state.turns.find((t) => t.id === pending.turnId);
    if (
      acknowledged &&
      acknowledged.status !== "pending" &&
      project.revision > pending.revision
    ) {
      setPending(null);
      clearDraft(pendingKey);
    }
  }, [project.revision, pending]);
  function editThought(field: "title" | "answer" = "title") {
    if (!chosen) return;
    setEditFocus(field);
    setEditing(
      readDraft(editKey)?.id === chosen.id
        ? readDraft(editKey)
        : {
            id: chosen.id,
            title: chosen.title,
            body: chosen.body,
            certainty: chosen.certainty as ItemInput["certainty"],
            base: project.revision,
          },
    );
  }
  function closePlan() {
    setPlanOpen(false);
    if (!home) onView("overview");
    planTrigger.current?.focus({ preventScroll: true });
  }
  function backToPlan() {
    setNoteOpen(false);
    setDetailOpen(false);
    setEditing(undefined);
    setConnecting(false);
    requestAnimationFrame(() =>
      planReturnFocus.current?.focus({ preventScroll: true }),
    );
  }
  function selectConcept(id: string | null) {
    if (!detailOpen && document.activeElement instanceof HTMLElement)
      planReturnFocus.current = document.activeElement;
    followReply.current = false;
    setFocus(id);
    setDetailOpen(!!id);
    setEditing(undefined);
    setConnecting(false);
  }
  const quoteLevel = resolveReasoning(options, text);
  const quoteRoute = planRoute(
    quoteLevel,
    plan?.tier || "free",
    options.modelPreference,
  );
  const quote = plan?.enabled
    ? actionCreditLimit(
        quoteLevel,
        quoteRoute.model,
        plan.credits,
        conversation?.agentIds.length > 1,
      )
    : undefined;
  const canVoice =
    voiceEnabled &&
    (!plan?.enabled || (plan.tier === "paid" && plan.voiceSeconds >= 1));
  async function sendThought(
    value = text,
    forcedMode?: "assist" | "note",
    retry?: PendingSend,
  ) {
    if (
      sendLock.current ||
      (voiceActive && !retry) ||
      dictating ||
      sourcesBusy ||
      uploading ||
      readOnly ||
      (!retry && waiting) ||
      (!value.trim() &&
        !options.attachments.length &&
        !options.sourceIds.length &&
        !options.agentIds.length &&
        !options.references.length &&
        !options.quotes.length)
    )
      return;
    if (
      plan?.enabled &&
      plan.credits < 1 &&
      forcedMode !== "note" &&
      enabled !== false
    ) {
      setNotice(
        "Your credit allowance has been reached. Your draft is kept, and you can still add thoughts in Plan.",
      );
      return;
    }
    sendLock.current = true;
    try {
      if (home && !retry) await prepareConversation();
    } catch {
      sendLock.current = false;
      return;
    }
    if (!alive.current) {
      sendLock.current = false;
      return;
    }
    const p = current.current;
    const chosenMode = forcedMode || (enabled === false ? "note" : "assist");
    const request: PendingSend = retry
      ? {
          ...retry,
          ...(retry.action !== "start" && plan?.enabled
            ? { maxCredits: Math.min(retry.maxCredits ?? 500, quote || 1) }
            : {}),
        }
      : {
          action: "send" as const,
          id: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          projectId: p.id,
          conversationId,
          revision: p.revision,
          text: value.trim() || "Please consider the attached context.",
          composer: options,
          maxCredits: quote,
          mode: chosenMode,
          focusId:
            options.references.length === 1 ? options.references[0] : null,
        };
    sendLock.current = true;
    const generation = ++sendGeneration.current;
    setBusy(true);
    setNotice("");
    if (live?.interrupted) {
      const keptIds = new Set(turns.map((turn) => turn.id));
      setInterruptedReplies((previous) =>
        Object.fromEntries(
          Object.entries({ ...previous, [live.turnId]: live }).filter(([id]) =>
            keptIds.has(id),
          ),
        ),
      );
    }
    setLive(
      chosenMode === "assist"
        ? {
            turnId: request.turnId,
            startedAt: new Date().toISOString(),
            activity: [],
            messages: [],
          }
        : null,
    );
    setPending(request);
    storeDraft(pendingKey, request);
    stickToBottom.current = true;
    followReply.current = true;
    if (!retry) {
      setText("");
      clearDraft(draftKey);
      changeOptions({
        ...options,
        attachments: [],
        agentIds: [],
        sourceIds: [],
        references: [],
        quotes: [],
        tool: "discuss",
      });
    }
    try {
      const result = await transport.request<PlanningReply>(
        "/project-planning",
        request,
        chosenMode === "assist"
          ? (event) => {
              if (!alive.current || generation !== sendGeneration.current)
                return;
              setLive((previous) =>
                previous?.turnId === request.turnId
                  ? updatePlanningLive(previous, event)
                  : previous,
              );
            }
          : undefined,
      );
      if (!alive.current || generation !== sendGeneration.current) return;
      accept(result);
      const outcome = thinkingOf(result.project).turns.find(
        (turn) => turn.id === request.turnId,
      );
      if (outcome && ["failed", "stale", "cancelled"].includes(outcome.status))
        setLive((previous) =>
          previous ? { ...previous, interrupted: true } : previous,
        );
      if (!result.pending) {
        setPending(null);
        clearDraft(pendingKey);
      }
      if (
        result.project.items.some((item) => item.id === request.turnId) &&
        thinkingOf(result.project).turns.some(
          (turn) => turn.id === request.turnId && turn.status === "saved",
        )
      ) {
        selectConcept(request.turnId);
        if (request.action === "start") setDetailOpen(false);
        setPlanOpen(true);
        if (!home) onView(mapView);
        notify("Thought added");
      }
      return thinkingOf(result.project).turns.find(
        (t) => t.id === request.turnId,
      )?.reply;
    } catch (e) {
      if (alive.current && generation === sendGeneration.current)
        setLive((previous) =>
          previous ? { ...previous, interrupted: true } : previous,
        );
      if (alive.current)
        setNotice(
          e instanceof Error
            ? e.message
            : "The send could not be confirmed. Your thought is kept below.",
        );
    } finally {
      if (generation === sendGeneration.current) {
        sendLock.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  function startProject(chosenMode: "assist" | "note") {
    const p = current.current;
    const openingText = projectOpeningText(p);
    if (thinkingOf(p).turns.length || !openingText || readOnly) return;
    void sendThought(openingText, chosenMode, {
      action: "start",
      conversationId: "main",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
      turnId: p.id,
      text: openingText,
      mode: chosenMode,
      focusId: null,
    });
  }
  useEffect(() => {
    // Consume only an explicit creation handoff. Opening a saved project merely
    // reads its conversation, including after refresh or a failed first reply.
    if (!startMode || openingHandled.current) return;
    openingHandled.current = true;
    onStartHandled?.();
    startProject(startMode);
  }, [startMode]);
  async function action(
    kind: "adopt" | "dismiss" | "undo" | "cancel" | "connect" | "disconnect",
    extra: Record<string, unknown> = {},
  ) {
    if ((busy && kind !== "cancel") || stopping || readOnly) return;
    if (kind === "cancel") setStopping(true);
    else setBusy(true);
    setNotice("");
    try {
      if (kind === "cancel") {
        for (let attempt = 0; attempt < 12; attempt++) {
          await refresh();
          if (
            thinkingOf(current.current).turns.some((t) => t.id === extra.turnId)
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (
          !thinkingOf(current.current).turns.some((t) => t.id === extra.turnId)
        )
          throw new Error(
            "The send is still being confirmed. Your writing is kept; check the saved conversation before trying again.",
          );
      }
      const p = current.current;
      accept(
        await transport.request<PlanningReply>("/project-planning", {
          action: kind,
          id: crypto.randomUUID(),
          projectId: p.id,
          revision: p.revision,
          ...extra,
        }),
      );
      if (kind === "dismiss") setFocus(null);
      if (kind === "cancel") {
        sendGeneration.current++;
        setLive((previous) =>
          previous ? { ...previous, interrupted: true } : previous,
        );
        sendLock.current = false;
        setBusy(false);
        setPending(null);
        clearDraft(pendingKey);
      }
      if (kind === "connect") setConnecting(false);
    } catch (e) {
      if (alive.current) notify((e as Error).message, { tone: "error" });
    } finally {
      if (alive.current) {
        if (kind === "cancel") setStopping(false);
        else setBusy(false);
      }
    }
  }
  function retryTurn(turn: PlanningTurn) {
    const p = current.current;
    void sendThought(turn.text, "assist", {
      action: "retry",
      conversationId: turnConversationId(turn),
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
      turnId: turn.id,
      text: turn.text,
      mode: "assist",
      focusId: turn.focusId,
    });
  }
  async function conversationCommand(extra: Record<string, unknown>) {
    if (busy || waiting || readOnly)
      throw new Error(
        "Wait for the current reply before changing conversations.",
      );
    setBusy(true);
    try {
      const p = current.current;
      const value = await transport.request<PlanningReply>(
        "/project-planning",
        {
          id: crypto.randomUUID(),
          projectId: p.id,
          revision: p.revision,
          ...extra,
        },
      );
      accept(value);
      if (extra.action === "delete_conversation" && extra.conversationId) {
        clearConversationLocalState(owner, p.id, String(extra.conversationId));
      }
    } catch (error) {
      // A lost HTTP acknowledgement must not create duplicate conversations or
      // agents. Confirm the intended metadata against the owned saved snapshot.
      const recovered = await refresh().catch(() => undefined);
      if (recovered && metadataIsSaved(recovered.project, extra)) {
        if (extra.action === "delete_conversation" && extra.conversationId)
          clearConversationLocalState(
            owner,
            current.current.id,
            String(extra.conversationId),
          );
        return;
      }
      notify((error as Error).message, { tone: "error" });
      throw error;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function prepareConversation() {
    if (
      !conversationsOf(current.current).some(
        (chat) => chat.id === conversationId,
      )
    ) {
      await conversationCommand({
        action: "create_conversation",
        conversationId,
        title: "New conversation",
        agentIds: [],
        branch: null,
      });
    }
    if (alive.current && home) onConversation(conversationId);
    return current.current.revision;
  }
  async function branchMessage(
    turn: PlanningTurn,
    message: "user" | "assistant",
  ) {
    const id = crypto.randomUUID();
    try {
      await conversationCommand({
        action: "create_conversation",
        conversationId: id,
        title: `${conversation.title.slice(0, 60)} · branch`,
        agentIds: conversation.agentIds.filter((id) =>
          assigned.some((a) => a.id === id && !a.archived),
        ),
        branch: {
          conversationId,
          turnId: turn.id,
          message,
          revision: current.current.revision,
        },
      });
      onConversation(id);
    } catch {
      /* The shared command already shows its error. */
    }
  }
  async function saveNote() {
    if (readOnly || !noteText.trim() || busy || waiting) return;
    setBusy(true);
    setNotice("");
    try {
      const p = current.current;
      const request = noteRequest.current || {
        action: "send" as const,
        conversationId: home ? "main" : conversationId,
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: p.id,
        revision: p.revision,
        text: noteText.trim(),
        mode: "note" as const,
        composer: defaultComposer(),
        focusId: focus,
      };
      noteRequest.current = request;
      storeDraft(noteKey + ":send", request);
      const saved = await transport.request<PlanningReply>(
        "/project-planning",
        request,
      );
      noteRequest.current = null;
      clearDraft(noteKey + ":send");
      accept(saved);
      if (noteText.trim() === request.text) {
        setNoteText("");
        clearDraft(noteKey);
        setNoteOpen(false);
        selectConcept(request.turnId);
        notify("Thought added");
      }
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
      if ((e as { status?: number }).status === 409) {
        noteRequest.current = null;
        clearDraft(noteKey + ":send");
        await refresh().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Item) {
    const p = current.current;
    if (busy || readOnly) return;
    setBusy(true);
    try {
      const next = await transport.command(
        makeCommand(p.id, p.revision, { type: "remove_item", itemId: item.id }),
      );
      onSaved(next);
      setFocus(null);
      notify("Thought removed", {
        action: {
          label: "Undo",
          onClick: async () => {
            const fresh = current.current;
            try {
              onSaved(
                await transport.command(
                  makeCommand(fresh.id, fresh.revision, {
                    type: "restore_item",
                    itemId: item.id,
                  }),
                ),
              );
              setFocus(item.id);
            } catch (e) {
              notify((e as Error).message, { tone: "error" });
            }
          },
        },
      });
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function exportPlan() {
    setExporting(true);
    try {
      const markdown = await transport.export(project.id);
      const { projectArchive, downloadBlob } =
        await import("../library/exportIdea");
      const blob = await projectArchive(project, markdown);
      const filename =
        blob.type === "application/zip"
          ? "woolgather-project.zip"
          : "woolgather-plan.md";
      downloadBlob(blob, filename);
      notify("Export ready", {
        action: {
          label: "Download again",
          onClick: () => downloadBlob(blob, filename),
        },
      });
    } catch (e) {
      notify((e as Error).message, { tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  const savedTurns: PlanningTurn[] =
    pending && !state.turns.some((t) => t.id === pending.turnId)
      ? [
          ...turns,
          {
            id: pending.turnId,
            conversationId,
            text: pending.text,
            reply: "",
            status: "pending",
            focusId: pending.focusId,
            createdAt: new Date().toISOString(),
            changedIds: [],
          },
        ]
      : turns;
  const displayedTurns: PlanningTurn[] = savedTurns.map((turn) => {
    const live = liveForTurn(turn.id);
    if (
      !live ||
      live.turnId !== turn.id ||
      turn.status === "complete" ||
      (turn.status !== "pending" && !live.interrupted)
    )
      return turn;
    const responses = [...(turn.agentResponses || [])];
    if (assigned.length > 1)
      for (const message of live.messages) {
        if (message.speaker)
          responses[message.index] = {
            agentId: message.speaker.id,
            name: message.speaker.name,
            avatar: message.speaker.avatar,
            text: message.text,
            replyToAgentId: responses[message.index]?.replyToAgentId || null,
            createdAt: live.startedAt,
          };
      }
    const streamedWork = {
      startedAt: live.startedAt,
      activity: live.activity,
      ...(live.workCompletedAt ? { completedAt: live.workCompletedAt } : {}),
    };
    // A terminal response can arrive alongside an interrupted stream. Keep
    // the server's durable failure/stale/cancelled activity so its reason is
    // not replaced by the last local progress snapshot.
    const terminal = ["failed", "stale", "cancelled"].includes(turn.status);
    return {
      ...turn,
      reply:
        assigned.length > 1
          ? turn.reply
          : live.messages.at(-1)?.text || turn.reply,
      ...(responses.length ? { agentResponses: responses } : {}),
      work: terminal && turn.work ? turn.work : streamedWork,
    };
  });
  const remainingCalls = [...voiceHistory].sort((a, b) =>
    (a.createdAt || a.closedAt || "").localeCompare(
      b.createdAt || b.closedAt || "",
    ),
  );
  const latestTurnId = displayedTurns.at(-1)?.id;
  const timeline: Array<{
    id: string;
    turn?: PlanningTurn;
    call?: ProjectVoiceHistoryEntry;
  }> = [];
  for (const turn of displayedTurns) {
    while (
      remainingCalls.length &&
      (remainingCalls[0].createdAt || remainingCalls[0].closedAt || "") <=
        turn.createdAt
    ) {
      const call = remainingCalls.shift()!;
      timeline.push({ id: call.runId, call });
    }
    timeline.push({ id: turn.id, turn });
  }
  timeline.push(...remainingCalls.map((call) => ({ id: call.runId, call })));
  const workspaceParts = {
    heading: home && (
      <div className="project-home-heading">
        <h1>{project.name}</h1>
      </div>
    ),
    navigation: (
      <div className="thinking-conversation-heading" hidden={!home}>
        <ConversationNavigation
          project={project}
          owner={owner}
          activeId={conversationId}
          agentActivity={
            displayedTurns.some(
              (turn) =>
                turn.status === "pending" &&
                pending?.mode !== "note" &&
                (busy || waiting?.id === turn.id),
            )
              ? "working"
              : displayedTurns.at(-1)?.status === "complete"
                ? "done"
                : "idle"
          }
          home={home}
          navigationHost={conversationNavigationHost}
          spaceTab={homeTab}
          onSpaceTab={onHomeTab}
          onHome={onHome}
          onNewChat={() => {
            onHome("chats");
            composer.current?.focus({ preventScroll: true });
          }}
          disabled={
            voiceActive ||
            busy ||
            !!waiting ||
            !!pending ||
            uploading ||
            sourceUploads.working.length > 0
          }
          onSelect={onConversation}
          onCommand={conversationCommand}
          inspectAgentId={inspectAgentId}
          onAgentInspected={() => setInspectAgentId(null)}
          sources={(close, query) => (
            <ProjectSourcesLibrary
              searchQuery={query}
              disabled={sourcesBusy || busy || !!waiting}
              sources={[
                ...(project.sources || []).map((source) => ({
                  id: source.id,
                  title: source.name,
                  kind: source.mime.startsWith("image/")
                    ? ("image" as const)
                    : ("file" as const),
                  detail:
                    [
                      source.meaning === "use"
                        ? "Use as a reference"
                        : source.meaning === "avoid"
                          ? "Avoid"
                          : "",
                      source.note,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Saved in this project",
                  thumbnail: source.mime.startsWith("image/") ? (
                    <ProjectSourceThumbnail
                      attachmentId={source.attachmentId}
                    />
                  ) : undefined,
                  archived: source.archived,
                  removable: true,
                })),
                ...sourceUploads.entries
                  .filter(
                    (entry) =>
                      !project.sources?.some(
                        (source) =>
                          source.attachmentId === entry.id && !source.archived,
                      ),
                  )
                  .map((entry) => ({
                    id: entry.id,
                    title: entry.file.name,
                    kind: entry.file.type.startsWith("image/")
                      ? ("image" as const)
                      : ("file" as const),
                    status: sourceUploads.working.includes(entry.id)
                      ? ("uploading" as const)
                      : ("failed" as const),
                    detail: entry.error || "Ready to retry",
                    error: entry.error,
                    removable: true,
                  })),
              ]}
              onUpload={readOnly ? undefined : sourceUploads.add}
              onOpen={(entry) => {
                const source = project.sources?.find(
                  (item) => item.id === entry.id,
                );
                if (source) previewSource(source, close);
              }}
              onUse={
                readOnly
                  ? undefined
                  : (entry) => {
                      const source = project.sources?.find(
                        (item) => item.id === entry.id,
                      );
                      if (source) {
                        close();
                        useSource(source);
                      }
                    }
              }
              onEdit={
                readOnly ? undefined : (entry) => setEditingSourceId(entry.id)
              }
              onRetry={
                readOnly ? undefined : (entry) => sourceUploads.retry(entry.id)
              }
              onRemove={
                readOnly
                  ? undefined
                  : async (entry) => {
                      if (
                        sourceUploads.entries.some(
                          (item) => item.id === entry.id,
                        )
                      ) {
                        await sourceUploads.remove(entry.id);
                        notify("Source deleted.");
                        return;
                      }
                      const source = current.current.sources?.find(
                        (item) => item.id === entry.id,
                      );
                      await sourceCommand({
                        action: "delete_source",
                        sourceId: entry.id,
                      });
                      composer.current?.removeReference(`source-${entry.id}`);
                      changeOptions({
                        ...options,
                        sourceIds: options.sourceIds.filter(
                          (id) => id !== entry.id,
                        ),
                      });
                      if (editingSourceId === entry.id)
                        setEditingSourceId(null);
                      if (source && previewFile?.id === source.attachmentId)
                        setPreviewFile(null);
                      notify("Source deleted.");
                    }
              }
            />
          )}
        />
      </div>
    ),
    messages: (
      <div
        className="thinking-messages"
        tabIndex={0}
        aria-label="Messages"
        hidden={home}
        ref={discussion}
      >
        <div ref={discussionContent}>
          {conversation.branch && (
            <Button
              variant="quiet"
              size="sm"
              className="conversation-branch-source"
              disabled={voiceActive}
              onClick={() =>
                onConversation(conversation.branch!.conversationId)
              }
            >
              {" "}
              <ArrowLeft />
              Branched from{" "}
              {conversationsOf(project).find(
                (c) => c.id === conversation.branch!.conversationId,
              )?.title || "another conversation"}
            </Button>
          )}
          {!displayedTurns.length && !voiceHistory.length && (
            <div className="thinking-conversation-start">
              <h1>
                {conversationId !== "main"
                  ? "What would you like to explore?"
                  : opening
                    ? "Build on your idea"
                    : "What’s on your mind?"}
              </h1>
              <p>
                {conversationId !== "main"
                  ? "A fresh conversation. Your saved thoughts and project context are already here."
                  : opening
                    ? "Your starting idea, answers and references are here. Continue from them or add a new thought."
                    : "Talk through the project in your own way. You can explore an idea, work something out, or just leave a thought."}
              </p>
              {source && conversationId === "main" && (
                <div className="thinking-starting-context">
                  <span>Your starting point</span>
                  <p>
                    {sourcePreview.length > 330
                      ? sourcePreview.slice(0, 327).trimEnd() + "…"
                      : sourcePreview}
                  </p>
                  {opening && !readOnly && !state.turns.length && (
                    <Button
                      variant="quiet"
                      disabled={uploading || busy || enabled === null}
                      onClick={() =>
                        startProject(enabled === false ? "note" : "assist")
                      }
                    >
                      <CornerDownLeft size={14} />
                      {enabled === false
                        ? "Add idea to the plan"
                        : "Start from this idea"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {timeline.map(({ id, turn, call }) =>
            call ? (
              <VoiceCallCard key={id} entry={call} />
            ) : turn ? (
              <article
                className="thinking-turn"
                key={turn.id}
                data-turn={turn.id}
              >
                <div className="conversation-authored">
                  {turn.composer?.attachments.length ? (
                    <div className="conversation-files">
                      {turn.composer.attachments.map((file) => (
                        <ConversationFile
                          key={file.id}
                          file={file}
                          onPreview={() => setPreviewFile(file)}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="thinking-user-message">
                    <span className="text-muted-foreground">
                      {turn.id === project.id ? "Your starting idea" : "You"}
                    </span>
                    {turn.id === project.id && turn.text.length > 900 ? (
                      <details className="thinking-opening">
                        <summary>Read the opening brief</summary>
                        <ProjectText text={turn.text} />
                      </details>
                    ) : turn.id === project.id ? (
                      <ProjectText text={turn.text} />
                    ) : (
                      <ConversationContextText
                        text={turn.text}
                        references={turnReferences(turn)}
                      />
                    )}
                  </div>
                  <ConversationMessageActions
                    persistent={
                      turn.id === latestTurnId &&
                      !turn.reply &&
                      !turn.agentResponses?.some((response) => response.text)
                    }
                    text={turn.text}
                    createdAt={turn.createdAt}
                    disabled={
                      voiceActive || busy || !!waiting || !!pending || readOnly
                    }
                  />
                  {turn.agentResponses && (
                    <AgentReadReceipt responses={turn.agentResponses} />
                  )}
                </div>
                {(turn.reply ||
                  turn.agentResponses?.length ||
                  visibleWorkActivity(turn.work?.activity).length > 0 ||
                  turn.changedIds.length > 0) && (
                  <div
                    className={
                      turn.agentResponses?.length
                        ? "agent-group-turn"
                        : "thinking-reply"
                    }
                  >
                    {(turn.work || turn.changedIds.length > 0) &&
                      (!turn.agentResponses ||
                        turn.agentResponses.some((r) => r.text) ||
                        turn.changedIds.length > 0) && (
                        <TurnWorkSummary
                          createdAt={turn.work?.startedAt || turn.createdAt}
                          completedAt={turn.work?.completedAt}
                          activity={turn.work?.activity}
                          status={turn.status}
                          interrupted={Boolean(
                            (turn.status === "pending" ||
                              turn.status === undefined) &&
                            liveForTurn(turn.id)?.interrupted,
                          )}
                          pending={
                            turn.status === "pending" &&
                            !turn.work?.completedAt &&
                            !liveForTurn(turn.id)?.interrupted
                          }
                          replying={Boolean(
                            turn.reply ||
                            turn.agentResponses?.some((r) => r.text),
                          )}
                          changedItems={turn.changedIds.flatMap((id) => {
                            const c = concepts.find((c) => c.id === id);
                            return c ? [{ id, title: c.title }] : [];
                          })}
                          onSelect={(id) => {
                            selectConcept(id);
                            setPlanOpen(true);
                            if (!home) onView(mapView);
                          }}
                        />
                      )}
                    {turn.agentResponses?.length ? (
                      <AgentGroupReplies
                        latest={turn.id === latestTurnId}
                        turnId={turn.id}
                        responses={turn.agentResponses}
                        streaming={turn.status === "pending"}
                        disabled={
                          turn.status !== "complete" ||
                          voiceActive ||
                          busy ||
                          !!waiting ||
                          !!pending ||
                          readOnly
                        }
                        onBranch={() => void branchMessage(turn, "assistant")}
                        replyDetails={
                          turn.routing
                            ? `${planningModes[turn.routing.level].label} · ${formatModelName(turn.routing.model)}`
                            : undefined
                        }
                      />
                    ) : turn.reply ? (
                      <>
                        <span className="agent-speaker">
                          {assigned.length === 1 && (
                            <AgentAvatar
                              id={assigned[0].id}
                              avatar={assigned[0].avatar}
                              className="agent-avatar--message"
                              quiet
                            />
                          )}
                          {speaker}
                        </span>
                        <ProjectText
                          text={turn.reply}
                          streaming={turn.status === "pending"}
                        />
                        <ConversationReferences
                          references={turnReferences(turn, true)}
                        />
                        <ConversationMessageActions
                          persistent={turn.id === latestTurnId}
                          text={turn.reply}
                          replyDetails={
                            turn.routing
                              ? `${turn.composer?.reasoning === "auto" ? "Auto · " : ""}${planningModes[turn.routing.level].label} · ${formatModelName(turn.routing.model)}`
                              : undefined
                          }
                          createdAt={turn.work?.completedAt || turn.createdAt}
                          disabled={
                            turn.status !== "complete" ||
                            voiceActive ||
                            busy ||
                            !!waiting ||
                            !!pending ||
                            readOnly
                          }
                          onBranch={() => void branchMessage(turn, "assistant")}
                        />
                      </>
                    ) : null}
                    {liveForTurn(turn.id)?.interrupted &&
                      liveForTurn(turn.id)?.messages.some(
                        (message) => message.text,
                      ) &&
                      turn.status !== "complete" &&
                      !turn.reply && (
                        <p className="thinking-turn-note">
                          Reply interrupted. The text shown so far may be
                          incomplete.
                        </p>
                      )}
                    {turn.agentResponses?.length ? (
                      <ConversationReferences
                        references={turnReferences(turn, true)}
                      />
                    ) : null}
                    {turn.status === "stale" && (
                      <p className="thinking-turn-note">
                        The project changed while replying. This response is
                        kept; its project changes were not applied.
                      </p>
                    )}
                  </div>
                )}
                {turn.status === "pending" &&
                  !visibleWorkActivity(turn.work?.activity).length &&
                  !turn.reply &&
                  !turn.agentResponses?.some((response) => response.text) &&
                  !liveForTurn(turn.id)?.interrupted &&
                  !(pending?.turnId === turn.id && !busy && !waiting) && (
                    <div className="thinking-wait" role="status">
                      {assigned.length === 1 && pending?.mode !== "note" ? (
                        <AgentAvatar
                          id={assigned[0].id}
                          avatar={assigned[0].avatar}
                          className="agent-avatar--message"
                          activity={
                            busy || waiting?.id === turn.id ? "working" : "idle"
                          }
                        />
                      ) : (
                        <LoaderCircle
                          aria-hidden="true"
                          className="thinking-wait-spinner"
                        />
                      )}
                      <span className="sr-only">
                        {pending?.turnId === turn.id && pending.mode === "note"
                          ? "Saving your thought…"
                          : "Preparing a reply"}
                      </span>
                    </div>
                  )}
                {turn.status === "failed" && (
                  <p className="thinking-turn-note">
                    {failureWorkReason(turn.work?.activity) ||
                      (turn.reply
                        ? "The reply is kept; its project changes weren’t applied."
                        : "The reply couldn’t be completed. Your thought is saved.")}
                  </p>
                )}
                {["failed", "stale", "cancelled"].includes(turn.status) &&
                  !readOnly &&
                  enabled && (
                    <Button
                      variant="quiet"
                      disabled={voiceActive || uploading || busy || !!waiting}
                      onClick={() => retryTurn(turn)}
                    >
                      <RotateCcw size={13} /> Try this thought again
                    </Button>
                  )}
                {turn.status === "saved" && !turn.reply && (
                  <span className="thinking-note-saved">
                    <Check size={12} />
                    Saved
                  </span>
                )}
                {turn.status === "cancelled" && (
                  <p className="thinking-turn-note">
                    Stopped. Your thought is kept.
                  </p>
                )}
              </article>
            ) : null,
          )}
        </div>
      </div>
    ),
    recovery: pending && !busy && !waiting && (
      <div className="thinking-recovery" role="status">
        <p>We couldn’t confirm your message was sent.</p>
        <div className="thinking-recovery-actions">
          <Button
            size="sm"
            variant="quiet"
            onClick={() =>
              void sendThought(pending.text, pending.mode, pending)
            }
          >
            Check again
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setText(pending.text);
              changeOptions(pending.composer || defaultComposer());
              setPending(null);
              clearDraft(pendingKey);
            }}
          >
            Back to draft
          </Button>
        </div>
      </div>
    ),
    voice: <div ref={voicePanel} className="thinking-voice-panel" />,
    composer: !readOnly ? (
      <form
        ref={composerForm}
        className="thinking-composer"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            fileAdder.current?.(Array.from(e.dataTransfer.files));
          }
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            fileAdder.current?.(Array.from(e.clipboardData.files));
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!commands.open && !contextPicker.open) void sendThought();
        }}
      >
        {dictating && (
          <div className="composer-dictation-caption" role="status">
            <span>{voiceCaption || "Listening…"}</span>
          </div>
        )}
        <ComposerEditor
          key={draftKey}
          draftKey={draftKey}
          fileSlots={6 - options.attachments.length}
          references={turnReferences({
            composer: {
              ...options,
              references: project.items.map((item) => item.id),
              agentIds: agentsOf(project).map((agent) => agent.id),
              sourceIds: (project.sources || []).map((source) => source.id),
            },
          })}
          selectedIds={[
            ...options.references.map((id) => `thought-${id}`),
            ...options.agentIds.map((id) => `agent-${id}`),
            ...options.sourceIds.map((id) => `source-${id}`),
          ]}
          onReferencesChange={(ids) => {
            const next = {
              ...options,
              references: ids
                .filter((id) => id.startsWith("thought-"))
                .map((id) => id.slice(8)),
              agentIds: ids
                .filter((id) => id.startsWith("agent-"))
                .map((id) => id.slice(6)),
              sourceIds: ids
                .filter((id) => id.startsWith("source-"))
                .map((id) => id.slice(7)),
            };
            if (
              ["references", "agentIds", "sourceIds"].some(
                (key) =>
                  JSON.stringify(next[key as "references"]) !==
                  JSON.stringify(options[key as "references"]),
              )
            )
              changeOptions(next);
          }}
          ref={composer}
          aria-label="Your thought"
          {...commands.inputProps}
          aria-controls={
            contextPicker.open
              ? contextPicker.id
              : commands.open
                ? commands.id
                : undefined
          }
          aria-activedescendant={
            contextPicker.open && contextPicker.activeId
              ? `${contextPicker.id}-${contextPicker.activeId}`
              : commands.inputProps["aria-activedescendant"]
          }
          onChange={(event) => {
            commands.inputProps.onChange?.(event);
            contextPicker.inputProps.onChange?.(event);
          }}
          onSelect={(event) => {
            commands.inputProps.onSelect?.(event);
            contextPicker.inputProps.onSelect?.(event);
          }}
          onCompositionStart={(event) => {
            commands.inputProps.onCompositionStart?.(event);
            contextPicker.inputProps.onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            commands.inputProps.onCompositionEnd?.(event);
            contextPicker.inputProps.onCompositionEnd?.(event);
          }}
          placeholder={
            (enabled !== false && options.tool !== "discuss"
              ? composerToolDetails[options.tool].placeholder
              : home
                ? "Start a new chat…"
                : "Write whatever’s on your mind…") +
            (enabled === false || options.tool !== "discuss"
              ? ""
              : " / for tools, @ for context.")
          }
          value={text}
          onKeyDown={(e) => {
            if (contextPicker.open) contextPicker.inputProps.onKeyDown?.(e);
            else {
              commands.inputProps.onKeyDown?.(e);
              if (!e.defaultPrevented) contextPicker.inputProps.onKeyDown?.(e);
            }
            if (e.defaultPrevented) return;
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void sendThought();
            }
          }}
        />
        <ComposerContextPicker
          picker={contextPicker}
          anchorRef={composerForm}
          inputRef={composer}
        />
        <CommandSuggestions
          id={commands.id}
          open={commands.open}
          anchorRef={composerForm}
          inputRef={composer}
          items={commands.items.map((tool) => {
            const Icon = composerToolIcons[tool.id];
            return { ...tool, icon: <Icon aria-hidden="true" /> };
          })}
          activeId={commands.activeId}
          onHighlight={(tool) => commands.highlight(tool.id)}
          onChoose={(tool) => commands.choose(tool.id)}
          onDismiss={commands.dismiss}
        />
        {plan?.enabled && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span>
              {plan.tier === "free"
                ? "Free includes Luna · Subscribe to unlock Sol"
                : `Luna and Sol · ${Math.floor(plan.voiceSeconds / 60)}m ${Math.floor(plan.voiceSeconds % 60)}s voice left`}
            </span>
            <Button
              variant="inline"
              onClick={openPlan}
              aria-label="View plan and usage"
            >
              {quote === 0
                ? "No credits left"
                : `${plan.credits.toLocaleString()} credits · up to ${quote} for this reply`}
            </Button>
          </div>
        )}
        <ComposerControls
          queueKey={composerKey}
          value={options}
          onChange={changeOptions}
          items={project.items}
          disabled={
            uploading ||
            sourcesBusy ||
            busy ||
            !!waiting ||
            voiceActive ||
            dictating
          }
          manual={enabled === false}
          addFiles={fileAdder}
          onUploading={setUploading}
          composerRef={composer}
          onAdd={contextPicker.toggle}
          addOpen={contextPicker.open}
          openFilePicker={openFilePicker}
          agents={agentsOf(project)}
          sources={project.sources || []}
          onAttachmentSaved={registerAttachment}
        >
          <div className="thinking-composer-bottom">
            <span className="thinking-enter-hint">Shift ↵ for a new line</span>
            <VoiceDictation
              value={text}
              onChange={setText}
              onActiveChange={setDictating}
              onInterimChange={setVoiceCaption}
              disabled={
                voiceActive ||
                uploading ||
                busy ||
                !!waiting ||
                !!pending ||
                readOnly
              }
            />
            {voiceEnabled && (
              <ProjectVoice
                showTrigger={(!hasMessage && canVoice) || voiceActive}
                owner={owner}
                project={project}
                conversationId={conversationId}
                onPrepare={home ? prepareConversation : undefined}
                disabled={
                  dictating ||
                  uploading ||
                  busy ||
                  !!waiting ||
                  !!pending ||
                  enabled !== true
                }
                panelRef={voicePanel}
                onHistoryChange={setVoiceHistory}
                onActiveChange={setVoiceActive}
                onDiscuss={async (value, identity) => {
                  const p = current.current;
                  const request: PendingSend = {
                    action: "send",
                    id: identity?.requestId || crypto.randomUUID(),
                    turnId: identity?.turnId || crypto.randomUUID(),
                    projectId: p.id,
                    conversationId,
                    revision: p.revision,
                    text: value,
                    maxCredits: quote,
                    composer: {
                      ...defaultComposer(),
                      reasoning: options.reasoning,
                      modelPreference: options.modelPreference,
                    },
                    mode: "assist",
                    focusId: null,
                  };
                  return sendThought(value, "assist", request);
                }}
                onCancel={async (turnId) => {
                  if (turnId) await action("cancel", { turnId });
                }}
                onSaved={async () => {
                  await Promise.all([refresh(), refreshPlan()]);
                }}
              />
            )}
            {waitingId ? (
              <IconButton
                aria-label="Stop reply"
                disabled={stopping}
                onClick={() => void action("cancel", { turnId: waitingId })}
              >
                <Square size={15} />
              </IconButton>
            ) : (!canVoice || hasMessage) && !voiceActive ? (
              <Button
                type="button"
                size="icon"
                onClick={() => void sendThought()}
                variant="primary"
                className="thinking-send"
                aria-label={enabled === false ? "Add thought" : "Send thought"}
                disabled={
                  voiceActive ||
                  dictating ||
                  sourcesBusy ||
                  uploading ||
                  busy ||
                  commands.open ||
                  contextPicker.open ||
                  !!pending ||
                  !hasMessage ||
                  enabled === null
                }
              >
                <ArrowUp size={17} />
              </Button>
            ) : null}
          </div>
        </ComposerControls>
      </form>
    ) : (
      <p className="thinking-readonly">
        This project is {project.lifecycle}. Restore it in project settings to
        continue.
      </p>
    ),
  };
  return (
    <section
      className="project-studio"
      data-home={home}
      aria-label="Project workspace"
    >
      <header className="thinking-toolbar">
        <div className="thinking-project-identity flex-1">
          {navigation}
          <Button
            variant="quiet"
            onClick={home ? onBack : () => onHome()}
            disabled={busy || voiceActive || uploading}
            className="thinking-back"
            size="icon-sm"
            aria-label={
              home ? `Back to ${folderName || "Projects"}` : "Back to project"
            }
          >
            <ArrowLeft size={16} />
          </Button>
          <div className="thinking-title-stack" hidden={home}>
            <Button
              variant="quiet"
              className="thinking-project-name h-auto min-w-0 justify-start gap-2 px-1 py-0 shrink"
              onClick={() => onHome()}
              disabled={busy || voiceActive || uploading}
            >
              <span className="truncate">{project.name}</span>
            </Button>
            <span className="thinking-saved">
              <MorphText>
                {busy || waiting
                  ? waitingId && liveForTurn(waitingId)?.phase === "answering"
                    ? "Replying…"
                    : "Working…"
                  : "Saved"}
              </MorphText>
            </span>
          </div>
        </div>
        <div className="thinking-toolbar-tools">
          <Button
            ref={planTrigger}
            variant="quiet"
            aria-expanded={planOpen}
            aria-label="Plan"
            aria-controls="project-plan-panel"
            disabled={home && (busy || voiceActive || uploading)}
            onClick={() => {
              setPlanOpen(!planOpen);
              if (!home) onView(planOpen ? "overview" : mapView);
            }}
          >
            <PanelRight /> <span className="thinking-plan-label">Plan</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<IconButton aria-label="Project options" />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-52"
              aria-label="Project options"
            >
              <DropdownMenuItem onClick={() => onView("source")}>
                <FileText />
                Starting idea
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={exporting}
                onClick={() => void exportPlan()}
              >
                <ArrowDownToLine /> Export project
              </DropdownMenuItem>
              {state.undo &&
                state.undo.revision === project.revision &&
                !readOnly && (
                  <DropdownMenuItem
                    disabled={busy || !!waiting}
                    onClick={() => void action("undo")}
                  >
                    <RotateCcw />
                    Undo last plan update
                  </DropdownMenuItem>
                )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSettings}>
                <Settings />
                Project settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="thinking-split" data-plan-open={planOpen}>
        <section
          ref={conversationPane}
          className="thinking-conversation"
          aria-label={home ? "Project space" : "Project conversation"}
          inert={narrowWorkspace && planOpen}
        >
          {workspaceParts.heading}
          <div
            ref={setConversationNavigationHost}
            className="thinking-conversation-heading"
            hidden={home}
          />
          <div className="conversation-scroll-region" hidden={home}>
            {workspaceParts.messages}
            {awayFromLatest && (
              <Button
                size="icon"
                className="conversation-latest"
                aria-label="Back to latest messages"
                title="Back to latest messages"
                onClick={() => toLatest()}
              >
                <ArrowDown />
              </Button>
            )}
          </div>
          {workspaceParts.recovery}
          {workspaceParts.voice}
          {workspaceParts.composer}
          {workspaceParts.navigation}
        </section>
        <section
          id="project-plan-panel"
          className="thinking-project-pane"
          aria-label="Project plan"
          inert={!planOpen}
          aria-hidden={!planOpen}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            if (editing) setEditing(undefined);
            else if (connecting) setConnecting(false);
            else if (noteOpen) backToPlan();
            else if (detailOpen) backToPlan();
            else closePlan();
          }}
        >
          {noteOpen && !readOnly ? (
            <PanelPage
              title="New thought"
              backLabel="Back to plan"
              onBack={backToPlan}
              onClose={closePlan}
              footer={
                <>
                  <span className="plan-caption">
                    {!noteText
                      ? ""
                      : noteDraftSafe
                        ? "Draft kept on this device"
                        : "Recovery copy unavailable"}
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    type="submit"
                    form="plan-new-thought"
                    disabled={busy || !!waiting || !noteText.trim()}
                  >
                    {busy ? "Saving…" : "Add to plan"}
                  </Button>
                </>
              }
            >
              <form
                id="plan-new-thought"
                className="plan-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveNote();
                }}
              >
                <Textarea
                  autoFocus
                  disabled={busy}
                  aria-label="New plan thought"
                  placeholder="Write a thought for your plan…"
                  rows={7}
                  maxLength={12000}
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                />
              </form>
            </PanelPage>
          ) : chosen && detailOpen ? (
            editing?.id === chosen.id && chosen.item ? (
              <ProjectItemEditor
                key={chosen.id}
                project={project}
                item={chosen.item}
                owner={owner}
                embedded
                readOnly={readOnly}
                focusField={editFocus}
                initial={{
                  title: editing.title,
                  body: editing.body,
                  certainty: editing.certainty,
                }}
                initialRevision={editing.base}
                onClose={() => {
                  setEditing(undefined);
                  clearDraft(editKey);
                }}
                onExit={closePlan}
                onSaved={(next, id) => {
                  onSaved(next);
                  setEditing(undefined);
                  clearDraft(editKey);
                  selectConcept(id);
                  notify("Thought saved");
                }}
              />
            ) : connecting && chosen.item ? (
              <PanelPage
                title="Add connection"
                focusOnMount
                backLabel="Back to thought"
                onBack={() => setConnecting(false)}
                onClose={closePlan}
                footer={
                  <>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={busy}
                      onClick={() => setConnecting(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      type="submit"
                      form="plan-connect"
                      disabled={busy || !connection.to}
                    >
                      Add connection
                    </Button>
                  </>
                }
              >
                <p className="plan-caption">
                  Give the connection a meaning, so it's clear how these
                  thoughts relate.
                </p>
                <form
                  id="plan-connect"
                  className="plan-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action("connect", { from: chosen.id, ...connection });
                  }}
                >
                  <div>
                    <span className="plan-field-label">From</span>
                    <p className="plan-connection-from">{chosen.title}</p>
                  </div>
                  <label>
                    Relationship
                    <Select
                      className="w-full"
                      label="Relationship"
                      value={connection.kind}
                      onValueChange={(kind) =>
                        setConnection({ ...connection, kind })
                      }
                      disabled={busy}
                      options={[
                        { value: "affects", label: "Affects" },
                        { value: "requires", label: "Needs" },
                        { value: "enables", label: "Makes possible" },
                        { value: "part_of", label: "Is part of" },
                        {
                          value: "alternative_to",
                          label: "Is an alternative to",
                        },
                        { value: "sequence", label: "Followed by" },
                      ]}
                    />
                  </label>
                  <label>
                    To
                    <Select
                      className="w-full"
                      label="Connect to"
                      value={connection.to}
                      onValueChange={(to) =>
                        setConnection({ ...connection, to })
                      }
                      disabled={busy}
                      options={[
                        {
                          value: "",
                          label: "Choose a thought",
                          disabled: true,
                        },
                        ...project.items
                          .filter((i) => !i.removed && i.id !== chosen.id)
                          .map((i) => ({ value: i.id, label: i.title })),
                      ]}
                    />
                  </label>
                  <label>
                    Why they're connected{" "}
                    <span className="plan-caption">Optional</span>
                    <Textarea
                      aria-label="Why these are connected"
                      placeholder="Add a little context…"
                      rows={3}
                      maxLength={1000}
                      value={connection.reason}
                      disabled={busy}
                      onChange={(event) =>
                        setConnection({
                          ...connection,
                          reason: event.target.value,
                        })
                      }
                    />
                  </label>
                  {project.items.filter((i) => !i.removed && i.id !== chosen.id)
                    .length === 0 && (
                    <p className="plan-caption">
                      Add another thought before creating a connection.
                    </p>
                  )}
                </form>
              </PanelPage>
            ) : (
              <PlanThoughtDetails
                key={chosen.id}
                project={project}
                chosen={chosen}
                busy={busy || !!waiting}
                readOnly={readOnly}
                onBack={backToPlan}
                onClose={closePlan}
                onSelect={selectConcept}
                onEdit={() => editThought()}
                onAnswer={() => editThought("answer")}
                onDiscuss={() => {
                  if (!options.references.includes(chosen.id)) {
                    if (options.references.length >= 8) {
                      notify(
                        "You can reference up to 8 thoughts per message.",
                        {
                          tone: "error",
                        },
                      );
                      return;
                    }
                    changeOptions({
                      ...options,
                      references: [...options.references, chosen.id],
                    });
                  }
                  if (narrowWorkspace) closePlan();
                  composer.current?.focus({ preventScroll: true });
                }}
                onConnect={() => {
                  setConnecting(true);
                  setConnection({ to: "", kind: "affects", reason: "" });
                }}
                onDisconnect={(id) =>
                  void action("disconnect", { relationId: id })
                }
                onRemove={() => chosen.item && void remove(chosen.item)}
                onAdopt={() =>
                  void action("adopt", { proposalId: chosen.proposal!.id })
                }
                onDismiss={() =>
                  void action("dismiss", { proposalId: chosen.proposal!.id })
                }
              />
            )
          ) : null}
          <div
            className="plan-browser"
            hidden={(noteOpen && !readOnly) || !!(chosen && detailOpen)}
          >
            <PanelPage
              title="Plan"
              onClose={closePlan}
              actions={
                <>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || !!waiting}
                      onClick={(event) => {
                        planReturnFocus.current = event.currentTarget;
                        setNoteOpen(true);
                      }}
                    >
                      <Plus /> Add a thought
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-label="Plan options"
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" aria-label="Plan options">
                      <DropdownMenuItem onClick={() => onView("history")}>
                        <History /> Activity
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onView("removed")}>
                        <Archive /> Removed thoughts
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            >
              <Tabs
                value={mapView}
                onValueChange={(next) => {
                  setMapView(next as typeof mapView);
                  if (!home) onView(String(next));
                }}
                className="plan-view-tabs"
              >
                <TabsList className="w-full" aria-label="Plan view">
                  <TabsTrigger value="outline">Thoughts</TabsTrigger>
                  <TabsTrigger value="map">Connections</TabsTrigger>
                  <TabsTrigger value="flow">Sequence</TabsTrigger>
                </TabsList>
                <p className="plan-view-description">
                  {mapView === "outline"
                    ? "What you're keeping in your project. Open a thought to read or refine it."
                    : mapView === "map"
                      ? "How your thoughts relate. Open either thought to explore or change a connection."
                      : "What happens next. Arrows show the steps you've connected, including branches and returns."}
                </p>
                <TabsContent
                  value={mapView}
                  className="plan-view-content"
                  key={mapView}
                >
                  {mapView === "outline" && concepts.length > 0 && (
                    <div className="plan-search">
                      <Search aria-hidden="true" />
                      <Input
                        aria-label="Search plan thoughts"
                        placeholder={`Search ${concepts.length} ${concepts.length === 1 ? "thought" : "thoughts"}…`}
                        value={planQuery}
                        onChange={(event) => setPlanQuery(event.target.value)}
                        className="pl-9"
                      />
                      {planQuery && (
                        <IconButton
                          size="icon-xs"
                          aria-label="Clear thought search"
                          onClick={() => setPlanQuery("")}
                        >
                          <X />
                        </IconButton>
                      )}
                    </div>
                  )}
                  {!concepts.length && opening ? (
                    <div className="plan-empty">
                      <h3>Your plan starts here</h3>
                      <p>
                        Talk through your idea in chat. Thoughts will appear
                        here as you work.
                      </p>
                      <Button
                        size="sm"
                        variant="inline"
                        className="h-auto justify-start p-0"
                        onClick={() => onView("source")}
                      >
                        <FileText /> Starting idea
                      </Button>
                    </div>
                  ) : (
                    <PlanningMap
                      project={project}
                      focus={focus}
                      onFocus={selectConcept}
                      view={mapView}
                      query={planQuery}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </PanelPage>
          </div>
        </section>
      </div>
      <ModalPresence>
        {editingSource && (
          <ProjectSourceEditor
            key={editingSource.id}
            source={editingSource}
            owner={owner}
            projectId={project.id}
            onClose={() => setEditingSourceId(null)}
            onSave={async (value) => {
              await sourceCommand({
                action: "update_source",
                sourceId: editingSource.id,
                ...value,
              });
            }}
          />
        )}
      </ModalPresence>
      <ModalPresence>
        {previewFile && (
          <ProjectFilePreview
            file={previewFile}
            onClose={() => setPreviewFile(null)}
            onUse={(() => {
              const source = project.sources?.find(
                (entry) =>
                  entry.attachmentId === previewFile.id && !entry.archived,
              );
              return source && !readOnly && !busy && !waiting
                ? () => {
                    closeSourceSpace.current?.();
                    useSource(source);
                    setPreviewFile(null);
                  }
                : undefined;
            })()}
          />
        )}
      </ModalPresence>
    </section>
  );
}
