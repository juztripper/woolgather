const projectViews = new Set([
  "home",
  "overview",
  "map",
  "flow",
  "outline",
  "plan",
  "questions",
  "connections",
  "history",
  "removed",
  "source",
  "references",
]);

/** Bare project links open its collections; explicit conversation/Plan links keep their destination. */
export function readProjectLocation(search: string) {
  const params = new URLSearchParams(search);
  const conversationId = params.get("chat") || "main";
  const fallback = params.has("chat") ? "overview" : "home";
  const requested = params.get("view") || fallback;
  return {
    conversationId,
    view: projectViews.has(requested) ? requested : fallback,
  };
}

export function projectChatPath(
  projectId: string,
  conversationId: string,
  search = "",
) {
  const params = new URLSearchParams(search);
  params.set("chat", conversationId);
  params.delete("view");
  return `/projects/${projectId}?${params}`;
}

export function projectViewPath(projectId: string, view: string, search = "") {
  const params = new URLSearchParams(search);
  if (view === "home") {
    params.delete("chat");
    params.delete("view");
  } else if (view === "overview") {
    params.delete("view");
    if (!params.has("chat")) params.set("chat", "main");
  } else params.set("view", view);
  return `/projects/${projectId}${params.size ? `?${params}` : ""}`;
}
