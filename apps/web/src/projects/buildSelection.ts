import type { Item } from "../../../../packages/domain/src";

export const buildSelectionLimit = 50;
export function selectBuildThoughts(
  criteria: Record<string, string>,
  thoughts: Pick<Item, "id" | "title" | "body">[],
) {
  const additions = thoughts.filter(
    (item) => !Object.hasOwn(criteria, item.id),
  );
  if (Object.keys(criteria).length + additions.length > buildSelectionLimit)
    return criteria;
  return {
    ...criteria,
    ...Object.fromEntries(
      additions.map((item) => [
        item.id,
        (item.body || item.title).slice(0, 2000),
      ]),
    ),
  };
}
