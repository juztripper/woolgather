const key = "woolgather:mcp-return";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mcpReturnPath(id: unknown) {
  return typeof id === "string" && uuid.test(id)
    ? `/connect/authorize?request=${id}`
    : null;
}
export function rememberMcpReturn(
  url: URL,
  storage: Pick<Storage, "setItem"> = sessionStorage,
) {
  const path =
    url.pathname === "/connect/authorize" &&
    mcpReturnPath(url.searchParams.get("request"));
  if (!path) return;
  try {
    storage.setItem(
      key,
      JSON.stringify({
        id: url.searchParams.get("request"),
        expiresAt: Date.now() + 15 * 60 * 1000,
      }),
    );
  } catch {
    /* Password sign-in still works in place. */
  }
}
export function consumeMcpReturn(
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
) {
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    storage.removeItem(key);
    return value && value.expiresAt > Date.now()
      ? mcpReturnPath(value.id)
      : null;
  } catch {
    return null;
  }
}
