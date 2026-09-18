import { ToastProvider } from "./ui/Toast";
import { isPublicSitePath } from "./public/routes";
import { canonicalLearnPath } from "./learn/routes";
import { PageEntry, renderPage } from "./PageEntry";
import React from "react";
import { createRoot } from "react-dom/client";
import "./ui/tokens.css";
import "./ui/streaming-text.css";
import "./ui/controls.css";
import "./styles.css";
import "./ui/workspace.css";
import "./ui/materials.css";
// Track actual input modality: Safari can retain :focus-visible after scripted focus.
document.documentElement.dataset.inputMode = "pointer";
document.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.inputMode = "pointer";
  },
  true,
);
document.addEventListener(
  "keydown",
  (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey)
      document.documentElement.dataset.inputMode = "keyboard";
  },
  true,
);
const root = createRoot(document.getElementById("root")!);
if (import.meta.env.DEV && location.pathname === "/preview/page-error") {
  root.render(<PageEntry failed />);
} else if (isPublicSitePath(location.pathname)) {
  renderPage(root, () =>
    import("./public/PublicSite").then(({ PublicSite }) => (
      <React.StrictMode>
        <PublicSite />
      </React.StrictMode>
    )),
  );
} else if (/^\/(?:learn|resources)(?:\/|$)/.test(location.pathname)) {
  const path = location.pathname + location.search + location.hash;
  const canonicalPath = canonicalLearnPath(path);
  if (path !== canonicalPath)
    window.history.replaceState(window.history.state, "", canonicalPath);
  // Public resources never mount App or its authentication/data providers.
  renderPage(root, () =>
    import("./learn/ResourcesSite").then(({ ResourcesSite }) => (
      <React.StrictMode>
        <ToastProvider>
          <ResourcesSite />
        </ToastProvider>
      </React.StrictMode>
    )),
  );
} else if (import.meta.env.DEV && location.pathname === "/preview/mascot-art") {
  renderPage(root, () =>
    import("./mascot/MascotArtPreview").then(({ MascotArtPreview }) => (
      <React.StrictMode>
        <MascotArtPreview />
      </React.StrictMode>
    )),
  );
} else if (import.meta.env.DEV && location.pathname === "/preview/mascot") {
  renderPage(root, () =>
    import("./mascot/MascotPreview").then(({ MascotPreview }) => (
      <React.StrictMode>
        <MascotPreview />
      </React.StrictMode>
    )),
  );
} else if (import.meta.env.DEV && location.pathname === "/preview/onboarding") {
  renderPage(root, () =>
    import("./onboarding/OnboardingPreview").then(({ OnboardingPreview }) => (
      <React.StrictMode>
        <OnboardingPreview />
      </React.StrictMode>
    )),
  );
} else if (import.meta.env.DEV && location.pathname === "/design-system") {
  renderPage(root, () =>
    import("./ui/DesignSystem").then(({ DesignSystem }) => (
      <React.StrictMode>
        <ToastProvider>
          <DesignSystem />
        </ToastProvider>
      </React.StrictMode>
    )),
  );
} else if (
  import.meta.env.DEV &&
  location.pathname === "/preview/authenticator"
) {
  renderPage(root, () =>
    import("./account/MfaPreview").then(({ MfaPreview }) => (
      <React.StrictMode>
        <ToastProvider>
          <MfaPreview />
        </ToastProvider>
      </React.StrictMode>
    )),
  );
} else if (import.meta.env.DEV && location.pathname === "/preview/loading") {
  renderPage(root, () =>
    import("./App").then(({ LoadingScreen }) => <LoadingScreen />),
  );
} else {
  renderPage(root, () =>
    import("./App").then(({ App }) => (
      <React.StrictMode>
        <ToastProvider>
          <App />
        </ToastProvider>
      </React.StrictMode>
    )),
  );
}

if (import.meta.env.DEV) {
  import("./accessibility").then(({ auditAccessibility }) => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void auditAccessibility(), 1800);
    });
    // Base UI portals mount beside #root. Include open menus and dialogs in QA.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}
