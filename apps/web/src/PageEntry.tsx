import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { Brand } from "./ui/Brand";
import { Button } from "./ui/Button";

export function PageEntry({ failed = false }: { failed?: boolean }) {
  return (
    <main className="loading" role={failed ? "alert" : "status"}>
      <div className="loading-content gap-3">
        <Brand />
        <p>{failed ? "This page couldn’t load." : "Opening woolgather…"}</p>
        {failed && (
          <>
            <Button onClick={() => location.reload()}>Reload page</Button>
            <a href="/support">Get help</a>
          </>
        )}
      </div>
    </main>
  );
}

/** Keep a failed page chunk recoverable without mounting account providers. */
export function renderPage(
  root: Pick<Root, "render">,
  load: () => Promise<ReactNode>,
) {
  root.render(<PageEntry />);
  return load().then(
    (page) => root.render(page),
    () => root.render(<PageEntry failed />),
  );
}
