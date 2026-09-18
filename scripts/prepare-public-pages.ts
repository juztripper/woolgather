import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guides } from "../apps/web/src/learn/content";

const origin = "https://woolgathering.app";
const directory = "dist/web/client";
const template = await readFile(join(directory, "index.html"), "utf8");
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const pages = [
  {
    path: "/pricing",
    title: "Pricing | woolgather",
    description:
      "Start with Free: 200 welcome credits and 100 credits a month. Explore woolgather Plus at €24 a month including tax; account-specific availability is shown in Billing.",
  },
  {
    path: "/privacy",
    title: "Privacy — woolgather",
    description:
      "How woolgather handles your account, writing, AI requests and personal data.",
  },
  {
    path: "/terms",
    title: "Terms of use — woolgather",
    description:
      "Terms for using woolgather, including accounts, AI assistance and subscriptions.",
  },
  {
    path: "/",
    title: "woolgather — room to think",
    description:
      "Write freely, talk an idea through, and shape it into a project you understand. A workspace for software, games and the ideas in between.",
  },
  {
    path: "/support",
    title: "Support — woolgather",
    description:
      "Contact Ripper’s Games for help with woolgather accounts, payments and projects.",
  },
  {
    path: "/learn",
    title: "Learn — woolgather",
    description:
      "Simple guides to writing in Ideas, developing Projects, shaping your Plan and keeping your work safe.",
  },
  {
    path: "/learn/faq",
    title: "Frequently asked questions — woolgather",
    description:
      "Answers about Ideas, Projects, AI assistance, credits, recovery and exporting your work.",
  },
  ...guides.map((guide) => ({
    path: `/learn/${guide.slug}`,
    title: `${guide.title} — woolgather`,
    description: guide.description,
  })),
];
// Public routes receive HTML metadata without requiring JavaScript. Known
// workspace entries use a private shell; dynamic paths get noindex headers.
const fallback = template.replace(
  "</head>",
  '<meta name="robots" content="noindex, nofollow" /></head>',
);
const privateRoutes = [
  "recent",
  "workspace",
  "ideas",
  "projects",
  "archive",
  "trash",
  "new",
];
for (const route of privateRoutes)
  await writeFile(join(directory, route + ".html"), fallback);
await writeFile(
  join(directory, "_headers"),
  [
    "/auth/*",
    "/account/*",
    "/projects/*",
    "/ideas/*",
    "/folders/*",
    ...privateRoutes.map((p) => "/" + p),
  ]
    .map(
      (p) =>
        `${p}\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n`,
    )
    .join("\n"),
);
for (const page of pages) {
  const meta = `<link rel="canonical" href="${origin}${page.path}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="woolgather" />
<meta property="og:title" content="${escape(page.title)}" />
<meta property="og:description" content="${escape(page.description)}" />
<meta property="og:url" content="${origin}${page.path}" />
<meta property="og:image" content="${origin}/art/learn/start-here-v1.webp" />
<meta name="twitter:card" content="summary_large_image" />`;
  const html = template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escape(page.title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${escape(page.description)}" />`,
    )
    .replace("</head>", `${meta}\n</head>`);
  const file =
    page.path === "/"
      ? join(directory, "index.html")
      : join(directory, page.path.slice(1) + ".html");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, html);
}
await writeFile(
  join(directory, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /account/\nDisallow: /recent\nDisallow: /ideas\nDisallow: /projects\nDisallow: /archive\nDisallow: /trash\nSitemap: ${origin}/sitemap.xml\n`,
);
await writeFile(
  join(directory, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((p) => `<url><loc>${origin}${p.path}</loc></url>`).join("")}</urlset>\n`,
);
console.log(`Prepared metadata for ${pages.length} public routes and sitemap.`);
