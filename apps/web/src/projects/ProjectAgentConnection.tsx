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
import { Input } from "../components/ui/input";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Modal, ModalPresence } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ApiError } from "../client";
import { ProjectTransport } from "./ProjectTransport";
import {
  agentSetup,
  codingAgents,
  cursorInstallUrl,
  claudeSetupCommand,
  validConnectorFolder,
  type CodingAgent,
} from "./agentSetup";
import "./project-agent.css";

type TokenMetadata = {
  id: string;
  name: string;
  expiresAt: string;
  revokedAt?: string | null;
};
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to connect. Try again.";
}

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
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [secretTokenId, setSecretTokenId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknownCreation, setUnknownCreation] = useState(false);
  const [codingAgent, setCodingAgent] = useState<CodingAgent | null>(null);
  const [folder, setFolder] = useState("");
  const [otherFormat, setOtherFormat] = useState<"other" | "opencode" | "grok">(
    "other",
  );
  const [accessListReady, setAccessListReady] = useState(false);
  const [revoke, setRevoke] = useState<TokenMetadata | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAccessListReady(false);
    void transport
      .request<TokenMetadata[]>(`/projects/${projectId}/integration-tokens`)
      .then((value) => {
        if (alive) {
          setTokens(value);
          setError("");
          setAccessListReady(true);
        }
      })
      .catch((error) => {
        if (alive) setError(message(error));
      });
    return () => {
      alive = false;
    };
  }, [open, projectId, attempt, transport]);
  async function create() {
    if (busy || disabled || unknownCreation || !accessListReady) return;
    setBusy(true);
    setError("");
    try {
      const result = await transport.request<TokenMetadata & { token: string }>(
        `/projects/${projectId}/integration-tokens`,
        {
          action: "create",
          name:
            name.trim() ||
            codingAgents.find((agent) => agent.value === codingAgent)?.label ||
            "My coding agent",
        },
      );
      setSecret(result.token);
      setSecretTokenId(result.id);
      setName("");
      setAttempt((value) => value + 1);
    } catch (failure) {
      setError(message(failure));
      if (
        !(failure instanceof ApiError) ||
        ![400, 403, 404, 422].includes(failure.status)
      ) {
        setAccessListReady(false);
        setUnknownCreation(true);
      }
    } finally {
      setBusy(false);
    }
  }
  async function revokeToken(token: TokenMetadata) {
    setBusy(true);
    setError("");
    try {
      await transport.request(`/projects/${projectId}/integration-tokens`, {
        action: "revoke",
        tokenId: token.id,
      });
      setRevoke(null);
      if (secretTokenId === token.id) {
        setSecret("");
        setSecretTokenId("");
      }
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
  const format = codingAgent === "other" ? otherFormat : codingAgent || "codex";
  const serverName = "woolgather";
  const setup = agentSetup(format, folder, serverName);
  const installUrl = cursorInstallUrl(folder, serverName);
  const folderReady = validConnectorFolder(folder);
  const installation =
    "npm ci --prefix packages/agent-connector --ignore-scripts";
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
                Build in your coding agent, with your own account. woolgather
                shares your plan and receives progress reports.
              </p>
              {error && (
                <p className="project-build-notice" role="alert">
                  {error}
                </p>
              )}
              {unknownCreation && (
                <div className="project-build-notice">
                  <p>
                    The connection interrupted while creating access. Refresh
                    the list and revoke any new token you did not receive before
                    creating another.
                  </p>
                  <div className="project-build-actions">
                    <Button
                      size="sm"
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      Refresh access list
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={!accessListReady}
                      onClick={() => setUnknownCreation(false)}
                    >
                      I have checked the list
                    </Button>
                  </div>
                </div>
              )}
              {!agent ? (
                <div className="project-agent-choices">
                  {codingAgents.map((entry) => (
                    <Button
                      key={entry.value}
                      className="project-agent-choice h-auto justify-start rounded-xl whitespace-normal px-4 py-3 text-left"
                      disabled={busy}
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
                        {entry.label}
                        <small>
                          {entry.value === "other"
                            ? "Any agent with MCP support"
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
                      disabled={busy}
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
                  <section
                    className="project-agent-step"
                    aria-labelledby="agent-connector-title"
                  >
                    <h3 id="agent-connector-title">
                      <span>1</span> Prepare the connector
                    </h3>
                    <p>
                      With Node 24 installed, run this once from your woolgather
                      checkout.
                    </p>
                    <div className="project-agent-command">
                      <pre
                        tabIndex={0}
                        aria-label="Connector installation command"
                      >
                        <code>{installation}</code>
                      </pre>
                      <Button size="sm" onClick={() => void copy(installation)}>
                        <Copy /> Copy
                      </Button>
                    </div>
                    <label>
                      woolgather folder
                      <Input
                        value={folder}
                        onChange={(event) => setFolder(event.target.value)}
                        placeholder="/absolute/path/to/woolgather"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="agent-folder-help"
                      />
                    </label>
                    <p id="agent-folder-help" className="project-build-help">
                      The full path to the woolgather checkout on the computer
                      running your agent.
                    </p>
                  </section>
                  <section
                    className="project-agent-step"
                    aria-labelledby="agent-access-title"
                  >
                    <h3 id="agent-access-title">
                      <span>2</span> Give access to this project
                    </h3>
                    {secret ? (
                      <div className="project-build-secret">
                        <p>
                          Copy this token before leaving Build. It cannot be
                          shown again. It only grants access to this project.
                        </p>
                        <Input
                          aria-label="New project token"
                          value={secret}
                          readOnly
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <div className="project-build-actions">
                          <Button onClick={() => void copy(secret)}>
                            <Copy /> Copy token
                          </Button>
                          <Button variant="quiet" onClick={() => setSecret("")}>
                            I have saved it
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <form
                        className="project-build-token-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void create();
                        }}
                      >
                        <label>
                          Connection name
                          <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={`${agent.label === "Other" ? "My agent" : agent.label} on my computer`}
                            maxLength={80}
                            disabled={busy || disabled || unknownCreation}
                          />
                        </label>
                        <Button
                          type="submit"
                          disabled={
                            busy ||
                            disabled ||
                            unknownCreation ||
                            !accessListReady
                          }
                        >
                          Create project token
                        </Button>
                      </form>
                    )}
                    <p>
                      Set these environment variables for your agent, then
                      restart it. To switch projects, replace the token and
                      restart again. Keep the token out of prompts and
                      repository files.
                    </p>
                    <dl className="project-agent-environment">
                      <div>
                        <dt>WOOLGATHER_URL</dt>
                        <dd>{location.origin}</dd>
                      </div>
                      <div>
                        <dt>WOOLGATHER_TOKEN</dt>
                        <dd>Your project token</dd>
                      </div>
                    </dl>
                  </section>
                  <section
                    className="project-agent-step"
                    aria-labelledby="agent-install-title"
                  >
                    <h3 id="agent-install-title">
                      <span>3</span> Add to{" "}
                      {agent.label === "Other" ? "your agent" : agent.label}
                    </h3>
                    {codingAgent === "other" && (
                      <>
                        <Select
                          label="MCP configuration format"
                          value={otherFormat}
                          onValueChange={(value) =>
                            setOtherFormat(value as typeof otherFormat)
                          }
                          options={[
                            { value: "other", label: "Standard MCP" },
                            { value: "opencode", label: "OpenCode" },
                            { value: "grok", label: "Grok Build" },
                          ]}
                        />
                        <p>
                          Choose a local stdio MCP server. For other clients,
                          adapt the example below to their configuration format
                          and environment variable syntax.
                        </p>
                      </>
                    )}
                    {codingAgent === "cursor" ? (
                      <>
                        <Button
                          variant="primary"
                          disabled={!installUrl}
                          onClick={() => {
                            if (installUrl) window.location.href = installUrl;
                          }}
                        >
                          <ArrowUpRight /> Add to Cursor
                        </Button>
                        <p className="project-build-help">
                          Opens Cursor to review and install the connector.{" "}
                          {folderReady
                            ? "Set the environment variables before using the connector."
                            : "Enter your woolgather folder above to enable this."}
                        </p>
                      </>
                    ) : codingAgent === "claude" ? (
                      <>
                        <p>
                          Run the setup command in your terminal. It adds this
                          project’s connector to Claude Code.
                        </p>
                        <Button
                          disabled={!folderReady}
                          onClick={() =>
                            void copy(claudeSetupCommand(folder, serverName))
                          }
                        >
                          <Copy /> Copy setup command
                        </Button>
                      </>
                    ) : (
                      <>
                        <p>
                          Add the configuration to <code>{setup.file}</code>,
                          keeping your existing settings.
                        </p>
                        <Button
                          disabled={!folderReady}
                          onClick={() => void copy(setup.configuration)}
                        >
                          <Copy /> Copy configuration
                        </Button>
                      </>
                    )}
                    {!folderReady && codingAgent !== "cursor" && (
                      <p className="project-build-help">
                        Enter your woolgather folder above to prepare the
                        configuration.
                      </p>
                    )}
                    <Disclosure
                      title={
                        codingAgent === "cursor"
                          ? "Manual setup"
                          : "View configuration"
                      }
                      variant="plain"
                    >
                      <div className="project-agent-manual">
                        <p>
                          Add this entry to <code>{setup.file}</code>.
                        </p>
                        <pre
                          tabIndex={0}
                          aria-label={`${agent.label} configuration`}
                        >
                          <code>{setup.configuration}</code>
                        </pre>
                        {codingAgent === "claude" && (
                          <pre
                            tabIndex={0}
                            aria-label="Claude Code setup command"
                          >
                            <code>
                              {claudeSetupCommand(folder, serverName)}
                            </code>
                          </pre>
                        )}
                        {(codingAgent === "claude" ||
                          codingAgent === "cursor") && (
                          <Button
                            size="sm"
                            disabled={!folderReady}
                            onClick={() => void copy(setup.configuration)}
                          >
                            <Copy /> Copy configuration
                          </Button>
                        )}
                      </div>
                    </Disclosure>
                    <p className="project-build-help">
                      Then ask your agent to connect this woolgather project to
                      your repository. Full instructions are in{" "}
                      <code>packages/agent-connector/README.md</code>.
                    </p>
                  </section>
                </>
              )}
              <Disclosure
                title={`Project access${tokens.length ? ` (${tokens.filter((token) => !token.revokedAt).length} active)` : ""}`}
                variant="plain"
                defaultOpen={unknownCreation}
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
                            : `Expires ${new Date(token.expiresAt).toLocaleDateString()}`}
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
