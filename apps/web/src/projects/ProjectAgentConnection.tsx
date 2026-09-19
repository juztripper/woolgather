import { useContext, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Copy,
  Link2,
  Plug,
  RefreshCw,
} from "lucide-react";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { Modal, ModalPresence } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ProjectTransport } from "./ProjectTransport";
import { codingAgents, type CodingAgent, remoteAgentSetup } from "./agentSetup";
import "./project-agent.css";

type TokenMetadata = {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt?: string | null;
};
type Setup = { enabled: boolean; url: string | null; preview?: boolean };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to connect. Try again.";

export function AgentConnection({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const transport = useContext(ProjectTransport);
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [codingAgent, setCodingAgent] = useState<CodingAgent | null>(null);
  const [accessListReady, setAccessListReady] = useState(false);
  const [revoke, setRevoke] = useState<TokenMetadata | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAccessListReady(false);
    setError("");
    void Promise.all([
      transport.request<TokenMetadata[]>(
        `/projects/${projectId}/integration-tokens`,
      ),
      transport.request<Setup>("/mcp/setup"),
    ])
      .then(([access, connection]) => {
        if (alive) {
          setTokens(access);
          setSetup(connection);
          setAccessListReady(true);
        }
      })
      .catch((error) => {
        if (alive) setError(message(error));
      });
    const refresh = () => {
      if (document.visibilityState === "visible")
        setAttempt((value) => value + 1);
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, projectId, attempt, transport]);
  async function revokeToken(token: TokenMetadata) {
    setBusy(true);
    setError("");
    try {
      await transport.request(`/projects/${projectId}/integration-tokens`, {
        action: "revoke",
        tokenId: token.id,
      });
      setRevoke(null);
      setAttempt((value) => value + 1);
      notify("Agent access revoked");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied");
    } catch {
      setError(
        "Select and copy the text below. Clipboard access is unavailable.",
      );
    }
  }
  const agent = codingAgents.find((entry) => entry.value === codingAgent);
  const remote =
    setup?.url && codingAgent ? remoteAgentSetup(codingAgent, setup.url) : null;
  const active = tokens.filter(
    (token) => !token.revokedAt && Date.parse(token.expiresAt) > Date.now(),
  );
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        <Link2 /> Connect agent
      </Button>
      <ModalPresence>
        {open && (
          <Modal
            title={
              agent
                ? `Connect ${agent.label === "Other" ? "your agent" : agent.label}`
                : "Connect an agent"
            }
            wide
            className="project-agent-dialog"
            onClose={() => !busy && setOpen(false)}
          >
            <div className="project-agent-content">
              <p className="project-agent-intro">
                Connect with your woolgather account. Build with your agent’s
                existing subscription.
              </p>
              {error && (
                <p className="project-build-notice" role="alert">
                  {error}{" "}
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Try again
                  </Button>
                </p>
              )}
              {!agent ? (
                <div className="project-agent-choices">
                  {codingAgents.map((entry) => (
                    <Button
                      key={entry.value}
                      className="project-agent-choice rounded-xl"
                      onClick={() => setCodingAgent(entry.value)}
                    >
                      {entry.logo ? (
                        <img
                          className="project-agent-logo"
                          data-agent={entry.value}
                          src={entry.logo}
                          alt=""
                        />
                      ) : (
                        <Plug className="size-7 p-1" />
                      )}
                      <span>
                        <strong>{entry.label}</strong>
                        <small>
                          {entry.value === "other"
                            ? "MCP with account sign-in"
                            : "Use your existing account"}
                        </small>
                      </span>
                      <ChevronRight />
                    </Button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="project-agent-selected">
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => setCodingAgent(null)}
                    >
                      <ArrowLeft /> All agents
                    </Button>
                    {agent.logo && (
                      <img
                        className="project-agent-logo"
                        data-agent={agent.value}
                        src={agent.logo}
                        alt=""
                      />
                    )}
                  </div>
                  {!setup ? (
                    <p role="status">Loading connection…</p>
                  ) : !setup.enabled || !remote ? (
                    <p className="project-build-notice">
                      {setup.preview
                        ? "This is a UI preview. Open your woolgather installation to connect an agent."
                        : "Account connections aren’t enabled on this installation yet."}
                    </p>
                  ) : (
                    <>
                      <section
                        className="project-agent-step"
                        aria-labelledby="agent-add-title"
                      >
                        <h3 id="agent-add-title">
                          <span>1</span> Add woolgather
                        </h3>
                        <p>
                          {codingAgent === "cursor"
                            ? "Open Cursor to add the connection."
                            : "Add this server address in your agent’s MCP settings."}
                        </p>
                        <div className="project-agent-command">
                          <pre tabIndex={0} aria-label="MCP server address">
                            <code>{setup.url}</code>
                          </pre>
                          <Button onClick={() => void copy(setup.url!)}>
                            <Copy /> Copy address
                          </Button>
                        </div>
                        {remote.installUrl && (
                          <Button
                            variant="primary"
                            onClick={() => {
                              window.location.href = remote.installUrl!;
                            }}
                          >
                            <ArrowUpRight /> Add to Cursor
                          </Button>
                        )}
                        <Disclosure
                          title="Setup command and configuration"
                          variant="plain"
                        >
                          <div className="project-agent-manual">
                            {remote.command && (
                              <>
                                <p>
                                  Run in your terminal, then sign in when your
                                  agent prompts you.
                                </p>
                                <pre
                                  tabIndex={0}
                                  aria-label="Agent setup command"
                                >
                                  <code>{remote.command}</code>
                                </pre>
                                <Button
                                  size="sm"
                                  onClick={() => void copy(remote.command!)}
                                >
                                  <Copy /> Copy command
                                </Button>
                              </>
                            )}
                            <pre tabIndex={0} aria-label="Agent configuration">
                              <code>{remote.configuration}</code>
                            </pre>
                            <Button
                              size="sm"
                              onClick={() => void copy(remote.configuration)}
                            >
                              <Copy /> Copy configuration
                            </Button>
                          </div>
                        </Disclosure>
                      </section>
                      <section
                        className="project-agent-step"
                        aria-labelledby="agent-sign-in-title"
                      >
                        <h3 id="agent-sign-in-title">
                          <span>2</span> Sign in and choose your project
                        </h3>
                        <p>
                          Choose Sign in or Authenticate in your agent.
                          woolgather opens in your browser so you can approve
                          access to a project.
                        </p>
                        <p className="project-build-help">
                          Already signed in to woolgather? Just choose the
                          project and allow access. Then return to your agent to
                          build.
                        </p>
                      </section>
                    </>
                  )}
                </>
              )}
              <Disclosure
                title={`Project access${active.length ? ` (${active.length} active)` : ""}`}
                variant="plain"
              >
                <div className="project-build-token-list">
                  <div>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={busy}
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      <RefreshCw /> Refresh access list
                    </Button>
                  </div>
                  {!tokens.length && (
                    <p className="project-build-help">
                      {accessListReady
                        ? "No agents have access yet."
                        : "Loading project access…"}
                    </p>
                  )}
                  {tokens.map((token) => (
                    <div className="project-build-token" key={token.id}>
                      <div>
                        <strong>{token.name}</strong>
                        <span>
                          {token.revokedAt
                            ? "Revoked"
                            : Date.parse(token.expiresAt) <= Date.now()
                              ? "Expired"
                              : `Access until ${new Date(token.expiresAt).toLocaleDateString()}`}
                        </span>
                      </div>
                      {!token.revokedAt && (
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={busy || disabled}
                          onClick={() => setRevoke(token)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </Disclosure>
            </div>
          </Modal>
        )}
      </ModalPresence>
      <ModalPresence>
        {revoke && (
          <Modal
            title={`Revoke ${revoke.name}?`}
            confirmation
            onClose={() => !busy && setRevoke(null)}
            footer={
              <>
                <Button disabled={busy} onClick={() => setRevoke(null)}>
                  Keep access
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void revokeToken(revoke)}
                >
                  Revoke access
                </Button>
              </>
            }
          >
            <p>
              This agent will lose access to this project. Saved plans and build
              reports stay available.
            </p>
            {error && <p role="alert">{error}</p>}
          </Modal>
        )}
      </ModalPresence>
    </>
  );
}
