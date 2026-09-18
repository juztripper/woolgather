// Keep disconnected journeys together and retain return paths. The ordering is
// only a reading layout: callers must draw the original edges, never adjacency.
export function planningFlow<T extends { id: string }>(
  nodes: readonly T[],
  edges: readonly { from: string; to: string }[],
): T[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = edges.filter(
    (edge) => byId.has(edge.from) && byId.has(edge.to),
  );
  const encountered = [
    ...new Set(links.flatMap((edge) => [edge.from, edge.to])),
  ];
  const remaining = new Set(encountered);
  const groups: T[][] = [];
  while (remaining.size) {
    const connected = new Set<string>();
    const pending = [remaining.values().next().value!];
    while (pending.length) {
      const id = pending.pop()!;
      if (connected.has(id)) continue;
      connected.add(id);
      remaining.delete(id);
      for (const edge of links) {
        if (edge.from === id && !connected.has(edge.to)) pending.push(edge.to);
        if (edge.to === id && !connected.has(edge.from))
          pending.push(edge.from);
      }
    }
    const unplaced = encountered.filter((id) => connected.has(id));
    const ordered: T[] = [];
    while (unplaced.length) {
      const ready = unplaced.findIndex(
        (id) =>
          !links.some((edge) => edge.to === id && unplaced.includes(edge.from)),
      );
      // A cycle has no root. Start at its first recorded step and keep every
      // actual edge so the renderer can show the return path explicitly.
      const [id] = unplaced.splice(ready < 0 ? 0 : ready, 1);
      ordered.push(byId.get(id)!);
    }
    groups.push(ordered);
  }
  return groups.sort((a, b) => b.length - a.length);
}
