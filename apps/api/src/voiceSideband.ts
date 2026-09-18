/** The deadline covers the HTTP upgrade only, never the live WebSocket. */
export async function openVoiceSideband(
  url: string,
  headers: HeadersInit,
  send: typeof fetch = fetch,
  timeoutMs = 8_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await send(url, { headers, signal: controller.signal });
  } finally {
    // Aborting an upgraded fetch also closes its WebSocket in workerd.
    clearTimeout(timer);
  }
}
