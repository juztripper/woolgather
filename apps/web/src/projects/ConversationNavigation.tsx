import { AgentAvatar, agentAvatarNames, agentAvatars } from "./AgentAvatar";
import type { AgentActivity } from "./useAgentAvatarMotion";
import {
  agentAvatar,
  type AgentAvatarId,
} from "../../../../packages/domain/src/agentIdentity";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowLeft,
  FileText,
  GitBranch,
  LayoutList,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Palette,
  Lightbulb,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import type { Project } from "../../../../packages/domain/src";
import {
  agentsOf,
  conversationTurns,
  conversationsOf,
} from "../../../../packages/domain/src/projectConversations";
import { Input } from "../components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Textarea } from "../components/ui/textarea";
import { Button, IconButton } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Modal, ModalPresence } from "../ui/Modal";
import { Disclosure } from "../ui/Disclosure";
import { useToast } from "../ui/Toast";
import "./conversation-navigation.css";

type NavigationPage = "rename" | "agent" | "group" | null;
type SpaceTab = "chats" | "agents" | "sources";
export type ProjectSourcesSlot =
  ReactNode | ((close: () => void, query: string) => ReactNode);

type AgentDraft = {
  editingId: string | null;
  name: string;
  instructions: string;
  scopeIds: string[];
  avatar?: AgentAvatarId;
};

type PendingConversationCreate = {
  id: string;
  title: string;
  agentIds: string[];
};

type PendingConversationDelete = {
  id: string;
  title: string;
};

function agentDraftKey(owner: string, projectId: string) {
  return `woolgather:conversation-agent-draft:${owner}:${projectId}`;
}

function pendingConversationKey(owner: string, projectId: string) {
  return `woolgather:conversation-create-pending:${owner}:${projectId}`;
}

function readAgentDraft(owner: string, projectId: string): AgentDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      agentDraftKey(owner, projectId),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AgentDraft>;
    if (
      (value.editingId !== null && typeof value.editingId !== "string") ||
      typeof value.name !== "string" ||
      typeof value.instructions !== "string" ||
      !Array.isArray(value.scopeIds) ||
      !value.scopeIds.every((id) => typeof id === "string")
    )
      return null;
    return {
      editingId: value.editingId ?? null,
      name: value.name.slice(0, 80),
      instructions: value.instructions.slice(0, 2000),
      scopeIds: value.scopeIds.slice(0, 12) as string[],
      avatar: agentAvatar(value.editingId || "", value.avatar),
    };
  } catch {
    return null;
  }
}

function writeAgentDraft(owner: string, projectId: string, draft: AgentDraft) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(agentDraftKey(owner, projectId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

function clearAgentDraft(owner: string, projectId: string) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.removeItem(agentDraftKey(owner, projectId));
    return true;
  } catch {
    return false;
  }
}

function readPendingConversation(
  owner: string,
  projectId: string,
): PendingConversationCreate | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      pendingConversationKey(owner, projectId),
    );
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingConversationCreate>;
    if (
      typeof value.id !== "string" ||
      typeof value.title !== "string" ||
      !Array.isArray(value.agentIds) ||
      !value.agentIds.every((id) => typeof id === "string")
    )
      return null;
    return {
      id: value.id,
      title: value.title.slice(0, 120),
      agentIds: value.agentIds.slice(0, 2) as string[],
    };
  } catch {
    return null;
  }
}

function writePendingConversation(
  owner: string,
  projectId: string,
  pending: PendingConversationCreate,
) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(
      pendingConversationKey(owner, projectId),
      JSON.stringify(pending),
    );
    return true;
  } catch {
    return false;
  }
}

function clearPendingConversation(owner: string, projectId: string) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.removeItem(pendingConversationKey(owner, projectId));
    return true;
  } catch {
    return false;
  }
}

function sameAgentIds(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function conversationUpdatedAt(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function conversationDate(value: string) {
  const timestamp = conversationUpdatedAt(value);
  if (!timestamp) return "No recent activity";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function conversationPreview(project: Project, conversationId: string) {
  const turns = conversationTurns(project, conversationId);
  const latest = turns.at(-1);
  if (!latest) return "No messages yet";
  const text = latest.reply?.trim() || latest.text.trim();
  return text.replace(/\s+/g, " ").slice(0, 120) || "No messages yet";
}

export type ConversationNavigationProps = {
  project: Project;
  owner: string;
  activeId: string;
  home: boolean;
  navigationHost: HTMLElement | null;
  spaceTab: SpaceTab;
  onSpaceTab: (tab: SpaceTab) => void;
  onHome: (tab?: SpaceTab) => void;
  onNewChat: () => void;
  disabled: boolean;
  agentActivity?: AgentActivity;
  onSelect: (id: string) => void;
  onCommand: (value: Record<string, unknown>) => Promise<void>;
  /** Root-owned source presentation; navigation only provides the tab surface. */
  sources?: ProjectSourcesSlot;
  onSourcesOpen?: () => void;
  inspectAgentId?: string | null;
  onAgentInspected?: () => void;
};

export function ConversationNavigation({
  project,
  owner,
  activeId,
  home,
  navigationHost,
  spaceTab,
  onSpaceTab: setSpaceTab,
  onHome,
  onNewChat,
  disabled,
  agentActivity = "idle",
  onSelect,
  onCommand,
  sources,
  onSourcesOpen,
  inspectAgentId,
  onAgentInspected,
}: ConversationNavigationProps) {
  const { notify } = useToast();
  const readOnly = !!project.lifecycle && project.lifecycle !== "active";
  const conversations = conversationsOf(project);
  const agents = agentsOf(project);
  const active =
    conversations.find((conversation) => conversation.id === activeId) ||
    conversations[0];
  const activeConversations = conversations
    .filter((conversation) => !conversation.archived)
    .reverse()
    .sort((left, right) => {
      if (left.id === "main") return -1;
      if (right.id === "main") return 1;
      return (
        conversationUpdatedAt(right.updatedAt) -
        conversationUpdatedAt(left.updatedAt)
      );
    });
  const visibleAgents = agents.filter((agent) => !agent.archived);
  const [page, setPage] = useState<NavigationPage>(null);
  const [spaceQuery, setSpaceQuery] = useState("");
  const [renameId, setRenameId] = useState(activeId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [avatar, setAvatar] = useState<AgentAvatarId>("sprout");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingCreate, setPendingCreate] =
    useState<PendingConversationCreate | null>(() =>
      readPendingConversation(owner, project.id),
    );
  const [deleteTarget, setDeleteTarget] =
    useState<PendingConversationDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const storageFailureNotified = useRef(false);
  const savingRef = useRef(false);

  const normalizedSpaceQuery = spaceQuery.trim().toLocaleLowerCase();
  const filteredConversations = normalizedSpaceQuery
    ? activeConversations.filter((conversation) => {
        const agentNames = conversation.agentIds
          .map((id) => agents.find((agent) => agent.id === id)?.name || "")
          .join(" ");
        return [
          conversation.title,
          conversationPreview(project, conversation.id),
          agentNames,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedSpaceQuery);
      })
    : activeConversations;
  const filteredAgents = normalizedSpaceQuery
    ? visibleAgents.filter((agent) =>
        `${agent.name} ${agent.instructions}`
          .toLocaleLowerCase()
          .includes(normalizedSpaceQuery),
      )
    : visibleAgents;
  const archivedConversations = conversations
    .filter((conversation) => conversation.archived)
    .sort(
      (left, right) =>
        conversationUpdatedAt(right.updatedAt) -
        conversationUpdatedAt(left.updatedAt),
    );

  const reportStorageFailure = () => {
    setStorageUnavailable(true);
    if (storageFailureNotified.current) return;
    storageFailureNotified.current = true;
    notify(
      "Draft recovery storage is unavailable. Keep this form open until you save or cancel.",
      { tone: "error", duration: 8000 },
    );
  };

  const reportStorageSuccess = () => {
    setStorageUnavailable(false);
  };

  const mutate = async (value: Record<string, unknown>) => {
    if (readOnly || disabled || saving || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      await onCommand(value);
      return true;
    } catch {
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const deleteConversation = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const deleted = await mutate({
        action: "delete_conversation",
        conversationId: deleteTarget.id,
      });
      if (deleted) {
        const title = deleteTarget.title;
        setDeleteTarget(null);
        onHome("chats");
        notify(`Deleted “${title}”.`);
      }
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    setPendingCreate(readPendingConversation(owner, project.id));
  }, [owner, project.id]);

  useEffect(() => {
    if (!pendingCreate) return;
    const canonical = conversations.find(
      (conversation) =>
        conversation.id === pendingCreate.id &&
        conversation.title === pendingCreate.title &&
        conversation.branch === null &&
        sameAgentIds(conversation.agentIds, pendingCreate.agentIds),
    );
    if (!canonical) return;
    if (!clearPendingConversation(owner, project.id)) reportStorageFailure();
    setPendingCreate(null);
  }, [conversations, owner, pendingCreate, project.id]);

  const createConversation = async (
    title: string,
    selectedAgentIds: string[],
  ) => {
    const requested = {
      title: title.slice(0, 120),
      agentIds: selectedAgentIds.slice(0, 2),
    };
    let storedPending =
      pendingCreate || readPendingConversation(owner, project.id);
    const canonicalPending = storedPending
      ? conversations.find(
          (conversation) =>
            conversation.id === storedPending?.id &&
            conversation.title === storedPending?.title &&
            conversation.branch === null &&
            sameAgentIds(conversation.agentIds, storedPending.agentIds),
        )
      : undefined;
    if (canonicalPending) {
      if (!clearPendingConversation(owner, project.id)) reportStorageFailure();
      setPendingCreate(null);
      storedPending = null;
      if (
        canonicalPending.title === requested.title &&
        sameAgentIds(canonicalPending.agentIds, requested.agentIds)
      ) {
        setPage(null);

        onSelect(canonicalPending.id);
        return;
      }
    }
    if (
      storedPending &&
      (storedPending.title !== requested.title ||
        !sameAgentIds(storedPending.agentIds, requested.agentIds))
    ) {
      notify(
        "Another conversation is still waiting to be confirmed. Retry that action first.",
        { tone: "error", duration: 8000 },
      );
      return;
    }
    const id = storedPending?.id || crypto.randomUUID();
    if (!storedPending) {
      const pending = { id, ...requested };
      if (!writePendingConversation(owner, project.id, pending)) {
        reportStorageFailure();
        return;
      }
      reportStorageSuccess();
      setPendingCreate(pending);
    }
    if (
      await mutate({
        action: "create_conversation",
        conversationId: id,
        title: requested.title,
        agentIds: requested.agentIds,
        branch: null,
      })
    ) {
      if (!clearPendingConversation(owner, project.id)) reportStorageFailure();
      setPendingCreate(null);
      setPage(null);

      onSelect(id);
    }
  };

  const openGroupConversation = () => {
    if (readOnly || disabled || saving || visibleAgents.length === 0) return;
    setName("");
    setAgentIds([]);

    setPage("group");
  };

  const newChat = () => {
    if (readOnly || disabled || saving) return;
    onNewChat();
  };

  const openAgentDraft = (draft: AgentDraft) => {
    const draftId = draft.editingId || crypto.randomUUID();
    if (!draft.editingId) {
      const nextDraft = { ...draft, editingId: draftId };
      if (writeAgentDraft(owner, project.id, nextDraft)) reportStorageSuccess();
      else reportStorageFailure();
    }
    setEditingId(draftId);
    setName(draft.name);
    setInstructions(draft.instructions);
    setAvatar(agentAvatar(draft.editingId || "", draft.avatar));
    setScopeIds(draft.scopeIds);

    setPage("agent");
  };

  const beginAgent = (id?: string) => {
    if (readOnly || disabled || saving) return;
    const draft = readAgentDraft(owner, project.id);
    if (draft) {
      openAgentDraft(draft);
      return;
    }
    const agent = id ? agents.find((candidate) => candidate.id === id) : null;
    setEditingId(id || crypto.randomUUID());
    setName(agent?.name || "");
    setInstructions(agent?.instructions || "");
    setAvatar(agentAvatar(agent?.id || "new", agent?.avatar));
    setScopeIds(agent?.scopeIds || []);

    setPage("agent");
  };

  const persistAgentDraft = (draft: AgentDraft) => {
    if (writeAgentDraft(owner, project.id, draft)) reportStorageSuccess();
    else reportStorageFailure();
  };

  const updateAgentName = (value: string) => {
    setName(value);
    const draftId = editingId || crypto.randomUUID();
    if (!editingId) setEditingId(draftId);
    persistAgentDraft({
      editingId: draftId,
      name: value,
      instructions,
      scopeIds,
      avatar,
    });
  };

  const updateAgentInstructions = (value: string) => {
    setInstructions(value);
    const draftId = editingId || crypto.randomUUID();
    if (!editingId) setEditingId(draftId);
    persistAgentDraft({
      editingId: draftId,
      name,
      instructions: value,
      scopeIds,
      avatar,
    });
  };

  const updateAgentAvatar = (next: AgentAvatarId) => {
    setAvatar(next);
    const draftId = editingId || crypto.randomUUID();
    if (!editingId) setEditingId(draftId);
    persistAgentDraft({
      editingId: draftId,
      name,
      instructions,
      scopeIds,
      avatar: next,
    });
  };
  const startAgentRole = (title: string, focus: string) => {
    const draftId = editingId || crypto.randomUUID();
    setEditingId(draftId);
    setName(title);
    setInstructions(focus);
    persistAgentDraft({
      editingId: draftId,
      name: title,
      instructions: focus,
      scopeIds: [],
      avatar,
    });
  };

  const cancelAgent = () => {
    if (!clearAgentDraft(owner, project.id)) {
      reportStorageFailure();
      return;
    }
    setEditingId(null);
    setName("");
    setInstructions("");
    setScopeIds([]);
    setPage(null);
    setSpaceTab("agents");
  };

  const talkToAgent = (id: string) => {
    const agent = visibleAgents.find((candidate) => candidate.id === id);
    if (!agent || readOnly || disabled || saving) return;
    void createConversation(agent.name.slice(0, 120), [id]);
  };

  const editingExistingAgent = Boolean(
    editingId && agents.some((agent) => agent.id === editingId),
  );

  const submit = async () => {
    if (!active) return;
    if (page === "rename") {
      const title = name.trim();
      if (!title) return;
      if (
        await mutate({
          action: "update_conversation",
          conversationId: renameId,
          title,
          agentIds,
        })
      )
        setPage(null);
      return;
    }
    if (page === "group") {
      const title = name.trim();
      if (!title || agentIds.length < 1 || agentIds.length > 2) return;
      await createConversation(title, agentIds);
      return;
    }
    if (page === "agent") {
      const agentName = name.trim();
      const focus = instructions.trim();
      if (!agentName || !focus) return;
      const agentId = editingId || crypto.randomUUID();
      if (!editingId) {
        setEditingId(agentId);
        persistAgentDraft({
          editingId: agentId,
          name,
          instructions,
          scopeIds,
          avatar,
        });
      }
      if (
        await mutate({
          action: "upsert_agent",
          agentId,
          name: agentName,
          instructions: focus,
          scopeIds,
          avatar,
        })
      ) {
        if (!clearAgentDraft(owner, project.id)) {
          reportStorageFailure();
          return;
        }
        setPage(null);
        setSpaceTab("agents");
      }
    }
  };

  const renderConversation = (
    conversation: (typeof conversations)[number],
    archived = false,
  ) => {
    const agentNames = conversation.agentIds
      .map((id) => agents.find((agent) => agent.id === id)?.name)
      .filter((value): value is string => !!value);
    const preview = conversationPreview(project, conversation.id);
    const isActive = !home && conversation.id === activeId;
    return (
      <div
        key={conversation.id}
        className="conversation-preview-row"
        data-active={isActive ? "true" : "false"}
        data-archived={archived ? "true" : "false"}
      >
        <Button
          variant="surface"
          className="conversation-preview-select grid items-center gap-4 px-3 py-3 rounded-none"
          aria-current={isActive ? "page" : undefined}
          disabled={disabled || saving || archived}
          onClick={() => {
            onSelect(conversation.id);
          }}
        >
          <span className="conversation-preview-icon" aria-hidden="true">
            {conversation.agentIds.length === 1 ? (
              <AgentAvatar
                id={conversation.agentIds[0]}
                avatar={
                  agents.find((agent) => agent.id === conversation.agentIds[0])
                    ?.avatar
                }
              />
            ) : conversation.agentIds.length ? (
              <Users />
            ) : (
              <MessageCircle />
            )}
          </span>
          <span className="conversation-preview-copy">
            <span className="conversation-preview-heading">
              <strong>{conversation.title}</strong>{" "}
              <time
                className="conversation-preview-date"
                dateTime={conversation.updatedAt}
              >
                {conversationDate(conversation.updatedAt)}
              </time>
            </span>
            <span>{preview}</span>
            <small>
              {conversation.branch && (
                <>
                  <GitBranch aria-hidden="true" />
                  <span>Branch</span>
                </>
              )}
              {agentNames.length > 0 && <span>{agentNames.join(" · ")}</span>}
            </small>
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                size="icon-sm"
                aria-label={`Actions for ${conversation.title}`}
                title={`Actions for ${conversation.title}`}
                disabled={readOnly || disabled || saving}
              />
            }
          >
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!archived && (
              <DropdownMenuItem
                onClick={() => {
                  setRenameId(conversation.id);
                  setName(conversation.title);
                  setAgentIds(
                    conversation.agentIds.filter((id) =>
                      visibleAgents.some((agent) => agent.id === id),
                    ),
                  );

                  setPage("rename");
                }}
              >
                <Pencil />
                Rename and participants
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onClick={() =>
                setDeleteTarget({
                  id: conversation.id,
                  title: conversation.title,
                })
              }
            >
              <Trash2 />
              Delete chat permanently
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const renderAgent = (agent: (typeof agents)[number]) => (
    <div key={agent.id} className="conversation-agent-row">
      <Button
        variant="surface"
        className="conversation-agent-open"
        aria-label={`Talk to ${agent.name}`}
        disabled={readOnly || disabled || saving}
        onClick={() => talkToAgent(agent.id)}
      />
      <span className="conversation-agent-icon" aria-hidden="true">
        <AgentAvatar id={agent.id} avatar={agent.avatar} />
      </span>
      <span className="conversation-agent-copy">
        <span className="conversation-agent-heading">
          <strong>{agent.name}</strong>
          <IconButton
            size="icon-xs"
            className="conversation-agent-edit"
            aria-label={`Edit ${agent.name}`}
            title={`Edit ${agent.name}`}
            disabled={readOnly || disabled || saving}
            onClick={() => beginAgent(agent.id)}
          >
            <Pencil aria-hidden="true" />
          </IconButton>
        </span>
        <span>{agent.instructions}</span>
      </span>
    </div>
  );

  useEffect(() => {
    if (!inspectAgentId) return;
    onHome("agents");
    onAgentInspected?.();
  }, [inspectAgentId, onAgentInspected]);

  const renderSources = () =>
    typeof sources === "function"
      ? sources(() => {
          setSpaceQuery("");
          setSpaceTab("chats");
        }, spaceQuery)
      : sources;

  return (
    <>
      {!home &&
        navigationHost &&
        createPortal(
          <div className="conversation-navigation">
            <Button
              variant="quiet"
              size="sm"
              className="conversation-space-trigger"
              aria-label="Open project space"
              disabled={disabled}
              onClick={() => onHome("chats")}
            >
              {active?.agentIds.length === 1 ? (
                <AgentAvatar
                  id={active.agentIds[0]}
                  avatar={
                    agents.find((agent) => agent.id === active.agentIds[0])
                      ?.avatar
                  }
                  className="agent-avatar--inline"
                  activity={agentActivity}
                />
              ) : (
                <LayoutList aria-hidden="true" />
              )}
              <span>{active?.title || "Project space"}</span>
            </Button>
            <IconButton
              size="icon-sm"
              aria-label="Start new conversation"
              disabled={readOnly || disabled || saving}
              onClick={newChat}
            >
              <Plus aria-hidden="true" />
            </IconButton>
          </div>,
          navigationHost,
        )}
      {home && (
        <Tabs
          className="conversation-space gap-3"
          value={spaceTab}
          onValueChange={(value) => {
            setSpaceTab(value as SpaceTab);
            setSpaceQuery("");
          }}
        >
          <div className="project-space-toolbar">
            <TabsList aria-label="Project space sections">
              {(
                [
                  ["chats", "Chats"],
                  ["agents", "Agents"],
                  ["sources", "Sources"],
                ] as const
              ).map(([tab, label]) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="min-w-0 flex-none px-control-padding-sm"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="project-space-tools">
              <div className="conversation-space-search">
                <Search aria-hidden="true" />
                <Input
                  className="pl-8"
                  value={spaceQuery}
                  onChange={(event) => setSpaceQuery(event.target.value)}
                  placeholder={
                    spaceTab === "chats"
                      ? "Search chats"
                      : spaceTab === "agents"
                        ? "Search agents"
                        : "Search sources"
                  }
                  aria-label={`Search project ${spaceTab}`}
                />
              </div>
              {spaceTab === "agents" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => beginAgent()}
                  disabled={readOnly || disabled || saving}
                >
                  <Plus aria-hidden="true" />
                  New agent
                </Button>
              )}
              {spaceTab === "chats" && visibleAgents.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={openGroupConversation}
                  disabled={readOnly || disabled || saving}
                >
                  <Users aria-hidden="true" />
                  With agents
                </Button>
              )}
            </div>
          </div>
          {spaceTab === "chats" && (
            <TabsContent value="chats" className="conversation-space-pane">
              <div
                className="conversation-preview-list"
                aria-label="Project chats"
              >
                {filteredConversations.length ? (
                  filteredConversations.map((conversation) =>
                    renderConversation(conversation),
                  )
                ) : (
                  <p className="conversation-space-empty-line">
                    {normalizedSpaceQuery
                      ? "No chats match this search."
                      : "No chats yet. Start one from the composer above."}
                  </p>
                )}
              </div>
              {archivedConversations.length > 0 && (
                <Disclosure
                  title={`Older chats · ${archivedConversations.length}`}
                  variant="plain"
                  className="conversation-archived"
                >
                  <div className="conversation-preview-list conversation-preview-list--archived">
                    {archivedConversations.map((conversation) =>
                      renderConversation(conversation, true),
                    )}
                  </div>
                </Disclosure>
              )}
            </TabsContent>
          )}
          {spaceTab === "agents" && (
            <TabsContent value="agents" className="conversation-space-pane">
              <div
                className="conversation-agent-list"
                aria-label="Project agents"
              >
                {filteredAgents.length ? (
                  filteredAgents.map(renderAgent)
                ) : (
                  <p className="conversation-space-empty-line">
                    {visibleAgents.length
                      ? "No agents match this search."
                      : "No agents yet. Create one with a clear job."}
                  </p>
                )}
              </div>
              {agents.some((agent) => agent.archived) && (
                <Disclosure
                  title={`Archived agents · ${agents.filter((agent) => agent.archived).length}`}
                  variant="plain"
                  className="conversation-archived"
                >
                  <div className="conversation-archived-actions">
                    {agents
                      .filter((agent) => agent.archived)
                      .map((agent) => (
                        <Button
                          key={agent.id}
                          size="sm"
                          variant="quiet"
                          onClick={() =>
                            void mutate({
                              action: "archive_agent",
                              agentId: agent.id,
                              archived: false,
                            })
                          }
                        >
                          Restore {agent.name}
                        </Button>
                      ))}
                  </div>
                </Disclosure>
              )}
            </TabsContent>
          )}
          {spaceTab === "sources" && (
            <TabsContent
              value="sources"
              className="conversation-space-pane conversation-space-sources"
            >
              {onSourcesOpen && (
                <div className="conversation-space-pane-header">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      onSourcesOpen();
                    }}
                  >
                    <FileText aria-hidden="true" />
                    Open library
                  </Button>
                </div>
              )}
              {sources ? (
                <div className="conversation-sources-slot">
                  {renderSources()}
                </div>
              ) : (
                <div className="conversation-space-empty">
                  <FileText aria-hidden="true" />
                  <p>
                    Sources added to this project will be available to every
                    conversation.
                  </p>
                  {onSourcesOpen && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        onSourcesOpen();
                      }}
                    >
                      Open sources
                    </Button>
                  )}
                </div>
              )}
            </TabsContent>
          )}
        </Tabs>
      )}
      <ModalPresence>
        {page && (
          <Modal
            title={
              page === "agent"
                ? editingExistingAgent
                  ? "Edit agent"
                  : "New agent"
                : page === "rename"
                  ? "Conversation settings"
                  : "Conversation with agents"
            }
            className="conversation-settings-modal"
            onClose={() => {
              if (!saving && !(page === "agent" && storageUnavailable))
                setPage(null);
            }}
            footer={
              <>
                <Button
                  variant="quiet"
                  disabled={saving}
                  onClick={page === "agent" ? cancelAgent : () => setPage(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  form="conversation-settings"
                  disabled={
                    saving ||
                    (page === "agent" &&
                      (!name.trim() || !instructions.trim())) ||
                    (page === "rename" && !name.trim()) ||
                    (page === "group" &&
                      (!name.trim() || agentIds.length === 0))
                  }
                >
                  {saving
                    ? "Saving…"
                    : page === "group"
                      ? "Create conversation"
                      : page === "agent" && !editingExistingAgent
                        ? "Create agent"
                        : "Save"}
                </Button>
              </>
            }
          >
            <form
              id="conversation-settings"
              inert={saving}
              className="conversation-settings"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {page === "agent" && (
                <>
                  <div className="agent-identity-preview">
                    <Button
                      variant="quiet"
                      className="size-20 rounded-full p-0"
                      aria-label="Change agent avatar"
                      title="Change avatar"
                      onClick={() =>
                        updateAgentAvatar(
                          agentAvatars[
                            (agentAvatars.indexOf(avatar) + 1) %
                              agentAvatars.length
                          ],
                        )
                      }
                    >
                      <AgentAvatar
                        id={editingId || "new"}
                        avatar={avatar}
                        interactive
                      />
                    </Button>
                    <div>
                      <strong>{name.trim() || "Your new agent"}</strong>
                      <p>A little personality. A clear purpose.</p>
                    </div>
                  </div>
                  <div className="agent-creation-field">
                    <span>Choose a face · {agentAvatarNames[avatar]}</span>
                    <div
                      className="agent-avatar-options"
                      role="group"
                      aria-label="Agent avatar"
                    >
                      {agentAvatars.map((option) => (
                        <Button
                          key={option}
                          variant="quiet"
                          size="icon"
                          className="agent-avatar-choice"
                          aria-label={agentAvatarNames[option]}
                          title={agentAvatarNames[option]}
                          aria-pressed={option === avatar}
                          onClick={() => updateAgentAvatar(option)}
                        >
                          <AgentAvatar id={option} avatar={option} />
                        </Button>
                      ))}
                    </div>
                  </div>
                  {!editingExistingAgent && (
                    <div className="agent-creation-field">
                      <span>Start with a role, or make your own</span>
                      <div className="agent-role-starters">
                        {(
                          [
                            [
                              "Design partner",
                              Palette,
                              "Help me shape clear, thoughtful user experiences. Explore alternatives, explain tradeoffs and keep the design consistent.",
                            ],
                            [
                              "Research partner",
                              Search,
                              "Help me investigate questions, compare evidence and find useful references. Be clear about what is known and what still needs checking.",
                            ],
                            [
                              "Creative partner",
                              Lightbulb,
                              "Help me explore ideas, develop the details and make unexpected connections. Preserve my intent and keep suggestions open until I decide.",
                            ],
                          ] as const
                        ).map(([title, Icon, focus]) => (
                          <Button
                            key={title}
                            variant="secondary"
                            size="sm"
                            className="h-auto min-h-control-sm min-w-0 flex-wrap gap-1 px-2 py-2"
                            onClick={() => startAgentRole(title, focus)}
                          >
                            <Icon aria-hidden="true" />
                            <span>{title.replace(" partner", "")}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <label>
                {page === "agent" ? "Name" : "Conversation name"}
                <Input
                  value={name}
                  maxLength={page === "agent" ? 80 : 120}
                  onChange={(event) =>
                    page === "agent"
                      ? updateAgentName(event.target.value)
                      : setName(event.target.value)
                  }
                  placeholder={
                    page === "agent" ? "e.g. Design partner" : "A new direction"
                  }
                  autoFocus={page !== "agent"}
                />
              </label>
              {page === "agent" ? (
                <>
                  <label>
                    Instructions
                    <Textarea
                      value={instructions}
                      maxLength={2000}
                      rows={4}
                      onChange={(event) =>
                        updateAgentInstructions(event.target.value)
                      }
                      placeholder="Describe what this agent should help with and how you want it to work."
                    />
                  </label>
                  {editingExistingAgent && editingId && (
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={saving}
                      onClick={() =>
                        void mutate({
                          action: "archive_agent",
                          agentId: editingId,
                          archived: true,
                        }).then((ok) => {
                          if (ok) {
                            if (!clearAgentDraft(owner, project.id)) {
                              reportStorageFailure();
                              return;
                            }
                            setPage(null);
                            setSpaceTab("agents");
                          }
                        })
                      }
                    >
                      <Archive />
                      Archive agent
                    </Button>
                  )}
                </>
              ) : (
                <fieldset>
                  <legend>Participants</legend>
                  <p className="muted">
                    {page === "group"
                      ? "Choose up to two agents."
                      : "Choose up to two agents, or leave empty for woolgather."}
                  </p>
                  <div className="conversation-choice-list">
                    {visibleAgents.map((agent) => (
                      <label
                        key={agent.id}
                        data-selected={agentIds.includes(agent.id)}
                      >
                        <Checkbox
                          checked={agentIds.includes(agent.id)}
                          disabled={
                            !agentIds.includes(agent.id) && agentIds.length >= 2
                          }
                          onCheckedChange={(checked) =>
                            setAgentIds((current) =>
                              checked
                                ? [...current, agent.id].slice(0, 2)
                                : current.filter((id) => id !== agent.id),
                            )
                          }
                        />
                        <AgentAvatar id={agent.id} avatar={agent.avatar} />
                        <span className="conversation-choice-copy">
                          <strong>{agent.name}</strong>
                          <span>{agent.instructions}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </form>
          </Modal>
        )}
      </ModalPresence>
      <ModalPresence>
        {deleteTarget && (
          <Modal
            confirmation
            title="Delete chat permanently?"
            onClose={() => {
              if (!deleting) setDeleteTarget(null);
            }}
            footer={
              <>
                <Button
                  variant="quiet"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger-primary"
                  disabled={deleting}
                  onClick={() => void deleteConversation()}
                >
                  {deleting ? "Deleting…" : "Delete permanently"}
                </Button>
              </>
            }
          >
            <p>
              Delete “{deleteTarget.title}” and all of its messages forever?
              Saved thoughts in your project plan will stay.
            </p>
          </Modal>
        )}
      </ModalPresence>
    </>
  );
}
