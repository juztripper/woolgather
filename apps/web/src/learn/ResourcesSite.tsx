import { useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Brand } from "../ui/Brand";
import { buttonVariants } from "../components/ui/button";
import { LearnLink, LearnPage, type Navigate } from "./LearnPage";

const currentPath = () => location.pathname + location.search + location.hash;

function revealFragment() {
  if (!location.hash) return;
  let id: string;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}

/** Public editorial resources. This shell never mounts the account workspace. */
export function ResourcesSite() {
  const [path, setPath] = useState(currentPath);
  const navigate: Navigate = useCallback((next, options) => {
    if (next === currentPath()) {
      revealFragment();
      return;
    }
    const destination = new URL(next, location.href);
    if (options?.replace) history.replaceState(history.state, "", next);
    else history.pushState(null, "", next);
    setPath(currentPath());
    if (!options?.replace && !destination.hash) window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const restore = () => setPath(currentPath());
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);
  useEffect(revealFragment, [path]);
  const faq = new URL(path, location.origin).pathname === "/learn/faq";
  return (
    <div className="resources-site">
      <a className="skip-link" href="#resources-main">
        Skip to content
      </a>
      <header className="resources-header">
        <a className="resources-brand" href="/" aria-label="woolgather home">
          <Brand />
        </a>
        <nav aria-label="Resources" className="resources-nav">
          <LearnLink href="/learn" onNavigate={navigate} current={!faq}>
            Guides
          </LearnLink>
          <LearnLink href="/learn/faq" onNavigate={navigate} current={faq}>
            FAQ
          </LearnLink>
        </nav>
        <a
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "resources-open",
          })}
          href="/recent"
          aria-label="Open woolgather"
        >
          <span className="resources-open-label">Open woolgather</span>
          <span className="resources-open-short">Open app</span>
          <ArrowRight aria-hidden="true" />
        </a>
      </header>
      <main id="resources-main" tabIndex={-1}>
        <LearnPage path={path} onNavigate={navigate} />
      </main>
      <footer className="resources-footer">
        <div>
          <Brand />
          <p>
            A workspace for software, games,
            <br />
            and the ideas in between.
          </p>
        </div>
        <nav aria-label="More resources">
          <a href="/pricing">Pricing</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/support">Support</a>
          <LearnLink href="/learn" onNavigate={navigate}>
            Browse guides
          </LearnLink>
          <LearnLink href="/learn/faq" onNavigate={navigate}>
            Frequently asked questions
          </LearnLink>
        </nav>
      </footer>
    </div>
  );
}
