// Development-only audit, never included by production builds.
import axe from "axe-core";
export async function auditAccessibility() {
  const { violations } = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
  });
  console.info(
    "Accessibility audit",
    JSON.stringify(
      violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ),
  );
}
