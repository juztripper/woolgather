/** Keep marketing entry points explicit so private paths still mount App. */
export function isPublicSitePath(pathname: string): boolean {
  const path = pathname === "/" ? pathname : pathname.replace(/\/$/, "");
  return ["/", "/pricing", "/support", "/privacy", "/terms"].includes(path);
}
