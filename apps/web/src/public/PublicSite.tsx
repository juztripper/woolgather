import { Brand } from "../ui/Brand";
import { buttonVariants } from "../components/ui/button";
import "../learn/learn.css";
import "./public.css";
import { policies, policyUpdatedAt } from "./policies";
import { MarketingPage } from "./MarketingPage";

export function PublicSite() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  if (path === "/" || path === "/pricing")
    return <MarketingPage pricing={path === "/pricing"} />;
  const policyKey = location.pathname.replace(/^\/|\/$/g, "");
  const policy =
    policyKey === "privacy" || policyKey === "terms"
      ? policies[policyKey]
      : null;
  return (
    <div className="resources-site">
      <a className="skip-link" href="#public-main">
        Skip to content
      </a>
      <header className="resources-header">
        <a className="resources-brand" href="/" aria-label="woolgather home">
          <Brand />
        </a>
        <nav className="resources-nav" aria-label="Main navigation">
          <a href="/learn">Learn</a>
          <a href="/support">Support</a>
        </nav>
        <a
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "resources-open",
          })}
          href="/recent"
        >
          Open app
        </a>
      </header>
      <main id="public-main" tabIndex={-1} className="public-main">
        {policy ? (
          <article className="public-support">
            <h1>{policy.title}</h1>
            <p>Updated {policyUpdatedAt}</p>
            {policy.sections.map((section) => (
              <section key={section.title}>
                <h2>{section.title}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
          </article>
        ) : (
          <article className="public-support">
            <h1>How can we help?</h1>
            <p>
              Contact Ripper’s Games at{" "}
              <a href="mailto:support@rippersgames.com">
                support@rippersgames.com
              </a>{" "}
              for account, payment or product questions.
            </p>
            <p>
              Tell us what you were trying to do, what happened, and the browser
              you use. Please don’t send passwords, sign-in codes, payment card
              details or private project content.
            </p>
            <p>
              For writing, Projects, recovery and exports, start with the{" "}
              <a href="/learn">guides</a> or{" "}
              <a href="/learn/faq">frequently asked questions</a>.
            </p>
          </article>
        )}
      </main>
      <footer className="resources-footer">
        <div>
          <Brand />
          <p>By Ripper’s Games</p>
        </div>
        <nav aria-label="More information">
          <a href="/pricing">Pricing</a>
          <a href="/learn">Learn</a>
          <a href="/support">Support</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="https://rippersgames.com">Ripper’s Games</a>
        </nav>
      </footer>
    </div>
  );
}
