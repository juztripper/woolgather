/** A login identity and a project workspace are separate concepts.
 * Team entries must eventually come from authorized server membership queries,
 * never from editable profile metadata or the browser's saved account list.
 */
export type WorkspaceReference = {
  id: string;
  kind: "personal" | "team";
  name: string;
};
export type AccountWorkspace = {
  accountId: string;
  workspace: WorkspaceReference;
  membership: "owner" | "admin" | "member" | "viewer";
};
export function personalWorkspace(accountId: string): AccountWorkspace {
  return {
    accountId,
    workspace: {
      id: `personal:${accountId}`,
      kind: "personal",
      name: "Personal workspace",
    },
    membership: "owner",
  };
}
