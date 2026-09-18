import type { ReactNode } from "react";
import { Brand } from "../ui/Brand";
import "./auth-entry.css";

/** Public entry framing only; AccountForm remains the owner of authentication. */
export function AuthEntry({ children }: { children: ReactNode }) {
  return (
    <div className="entry-page auth-page auth-entry">
      <header className="entry-header">
        <a className="auth-entry-brand" href="/" aria-label="woolgather home">
          <Brand />
        </a>
        <nav className="auth-entry-nav" aria-label="About woolgather">
          <a href="/learn">Learn</a>
          <a href="/pricing">Pricing</a>
        </nav>
      </header>
      <main className="auth-layout">
        <div className="auth-column">{children}</div>
        <figure className="auth-image-space">
          <img
            src="/art/reverie-v1.webp"
            alt="Soft blue sky with sunlit clouds"
            width="1672"
            height="941"
            fetchPriority="high"
          />
          <figcaption className="auth-entry-caption">
            <p>
              Room to think.
              <br />
              Space to make.
            </p>
          </figcaption>
        </figure>
      </main>
      <footer className="entry-footer">
        <nav aria-label="Legal and support">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/support">Support</a>
        </nav>
      </footer>
    </div>
  );
}
