import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { ProjectSummary } from "../../../../packages/domain/src";
import { AuthEntry } from "./AuthEntry";
import { Button } from "../ui/Button";
import { Input } from "../components/ui/input";
import { Select } from "../ui/Select";
import { api } from "../client";
import { consumeMcpReturn, mcpReturnPath } from "./mcpReturn";
import "./mcp-authorization.css";

type Authorization = {
  clientName: string;
  redirectHost: string;
  expiresAt: number;
};
export function McpAuthorization({ session }: { session: Session }) {
  const request = new URLSearchParams(location.search).get("request");
  const path = `/mcp/authorization?request=${encodeURIComponent(request || "")}`;
  const [details, setDetails] = useState<Authorization | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [finished, setFinished] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let alive = true;
    setError("");
    setDetails(null);
    if (!mcpReturnPath(request)) {
      setError("Start the connection from your coding agent.");
      return;
    }
    void Promise.all([
      api<Authorization>(path),
      api<ProjectSummary[]>("/projects"),
    ])
      .then(([authorization, all]) => {
        if (!alive) return;
        const available = all.filter(
          (project) => !project.lifecycle || project.lifecycle === "active",
        );
        setDetails(authorization);
        setProjects(available);
        if (available.length === 1) setProjectId(available[0].id);
      })
      .catch((failure) => {
        if (alive)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to load this request.",
          );
      });
    return () => {
      alive = false;
    };
  }, [path, request, session.user.id, attempt]);
  async function decide(decision: "allow" | "deny") {
    if (submitting.current || !details || (decision === "allow" && !projectId))
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ redirectTo: string }>(path, {
        decision,
        ...(decision === "allow" ? { projectId } : {}),
      });
      consumeMcpReturn();
      setFinished(true);
      window.location.assign(result.redirectTo);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection could not be confirmed. Check Project access before starting again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const selected = projects.find((project) => project.id === projectId);
  const matching = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const options = [
    { value: "", label: "Choose a project" },
    ...matching.map((project) => ({
      value: project.id,
      label: project.name || "Untitled project",
    })),
  ];
  if (selected && !matching.some((project) => project.id === selected.id))
    options.push({ value: selected.id, label: selected.name });
  return (
    <AuthEntry>
      <section
        className="auth-card mcp-authorization"
        aria-labelledby="mcp-authorization-title"
      >
        <h1 id="mcp-authorization-title">
          {finished ? "Return to your agent" : "Connect to woolgather"}
        </h1>
        {finished ? (
          <p>Your choice has been saved. Continue in your coding agent.</p>
        ) : (
          <>
            <p>
              {details ? (
                <>
                  <strong>{details.clientName}</strong> wants access to a
                  project.
                </>
              ) : (
                "Review the connection before allowing access."
              )}
            </p>
            <p className="mcp-account">Signed in as {session.user.email}</p>
            {error && (
              <div role="alert">
                <p>{error}</p>
                <Button
                  size="sm"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Reload request
                </Button>
              </div>
            )}
            {!details && !error && <p role="status">Loading connection…</p>}
            {details && (
              <>
                {projects.length ? (
                  <div className="mcp-project-choice">
                    {projects.length > 8 && (
                      <Input
                        aria-label="Find a project"
                        placeholder="Find a project…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        disabled={busy}
                      />
                    )}
                    <span>Project</span>
                    <Select
                      label="Project to connect"
                      value={projectId}
                      options={options}
                      onValueChange={setProjectId}
                      disabled={busy}
                    />
                    {search && !matching.length && (
                      <p role="status">No projects match that search.</p>
                    )}
                  </div>
                ) : (
                  <p>
                    Create a project in woolgather, then start the connection
                    again.
                  </p>
                )}
                <ul>
                  <li>Read the selected project’s plan and build versions.</li>
                  <li>Connect a repository and report build progress.</li>
                </ul>
                <p>
                  You keep control of the plan and verification. Access lasts 30
                  days and can be revoked in Build → Project access.
                </p>
                <p className="mcp-return-host">
                  Returns to {details.redirectHost || "your agent’s callback"}.
                </p>
                <div className="mcp-authorization-actions">
                  <Button disabled={busy} onClick={() => void decide("deny")}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || !projectId}
                    onClick={() => void decide("allow")}
                  >
                    {busy ? "Connecting…" : "Allow access"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </AuthEntry>
  );
}
