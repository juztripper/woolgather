/** Public resource aliases keep search filters and article fragments intact. */
export function canonicalLearnPath(path: string): string {
  const url = new URL(path, "https://woolgather.invalid");
  if (!/^\/(?:learn|resources)(?:\/|$)/.test(url.pathname)) return path;
  const pathname = url.pathname
    .replace(/^\/resources(?=\/|$)/, "/learn")
    .replace(/\/+$/, "");
  return pathname + url.search + url.hash;
}
