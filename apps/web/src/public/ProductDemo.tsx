import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FileText, MessageCircle, PanelRight } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { ToastProvider } from "../ui/Toast";
import { ProjectText } from "../projects/ProjectText";
import { TurnWorkSummary } from "../projects/ConversationMessageActions";
import { PlanningMap, visualConcepts } from "../projects/PlanningMap";
import { PlanThoughtDetails } from "../projects/PlanThoughtDetails";
import {
  exampleConversation,
  exampleProject,
  exampleWriting,
} from "./productDemoContent";
import "../projects/plan-panel.css";
import "./product-demo.css";

const Writing = lazy(() => import("./ProductDemoWriting"));
const noop = () => {};
type Scene = "capture" | "explore" | "shape";
const sceneLabels: Record<Scene, string> = {
  capture: "Idea",
  explore: "Conversation",
  shape: "Plan",
};
const sceneIcons = {
  capture: FileText,
  explore: MessageCircle,
  shape: PanelRight,
};
const sidePlanQuery = "(min-width: 900px)";

function keepPlanTargetVisible(target: HTMLElement) {
  const navigation = target
    .closest(".marketing-site")
    ?.querySelector<HTMLElement>(".marketing-header");
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const safeTop = Math.max(
    viewportTop + 12,
    (navigation?.getBoundingClientRect().bottom ?? 0) + 12,
  );
  const safeBottom = viewportTop + viewportHeight - 12;
  const bounds = target.getBoundingClientRect();
  if (bounds.top >= safeTop && bounds.bottom <= safeBottom) return;

  target.style.setProperty("--product-demo-scroll-top", `${safeTop}px`);
  target.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
}

/** Real presentation components; authored examples never enter an account. */
export function ProductDemo() {
  return (
    <ToastProvider>
      <ProductTour />
    </ToastProvider>
  );
}

function ProductTour() {
  const [scene, setScene] = useState<Scene>("explore");
  const [wide, setWide] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(sidePlanQuery).matches,
  );
  const [project] = useState(exampleProject);
  const [writing] = useState(exampleWriting);
  const [focus, setFocus] = useState<string | null>(null);
  const planHost = useRef<HTMLDivElement>(null);
  const planTab = useRef<HTMLButtonElement>(null);
  const returnToThought = useRef<string | null>(null);
  const chosen = visualConcepts(project).find((item) => item.id === focus);
  const changedThought = project.items[0];
  const sidePlan = wide && scene === "explore";
  const planVisible = sidePlan || scene === "shape";
  const SceneIcon = sceneIcons[scene];

  useEffect(() => {
    const media = window.matchMedia(sidePlanQuery);
    const update = () => {
      setWide(media.matches);
      // Keep the active Plan control visible when a desktop pane becomes a
      // single-pane phone layout.
      if (!media.matches && planHost.current?.contains(document.activeElement))
        setScene("shape");
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!planVisible || (!focus && !returnToThought.current)) return;
    // Wait until the destination scene has lost its inert/hidden state.
    // Linked thoughts also move focus to their newly displayed detail heading.
    const frame = requestAnimationFrame(() => {
      const target = focus
        ? planHost.current?.querySelector<HTMLElement>(".panel-page-header h2")
        : planHost.current?.querySelector<HTMLElement>(
            `[data-plan-thought="${returnToThought.current}"]`,
          );
      returnToThought.current = null;
      if (target && !target.closest('[inert], [aria-hidden="true"]')) {
        target.focus({ preventScroll: true });
        // The detail's focus heading is visually hidden. Reveal its actual
        // header so Back and Close remain reachable below sticky navigation.
        keepPlanTargetVisible(
          target.closest<HTMLElement>(".panel-page-header") ?? target,
        );
      } else if (planTab.current) {
        planTab.current.focus({ preventScroll: true });
        keepPlanTargetVisible(planTab.current);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, planVisible]);

  function chooseScene(value: unknown) {
    returnToThought.current = null;
    setFocus(null);
    setScene(value as Scene);
  }
  function openThought(id: string | null) {
    returnToThought.current = null;
    if (!sidePlan) setScene("shape");
    setFocus(id);
  }
  function closeThought() {
    returnToThought.current = focus;
    setFocus(null);
  }

  return (
    <section className="product-demo" aria-label="A tour of woolgather">
      <Tabs
        value={scene}
        onValueChange={chooseScene}
        className="product-demo-tour"
      >
        <div className="product-demo-viewport">
          <header className="product-demo-header">
            <span className="product-demo-project">
              <img
                src="/brand/gather-symbol.svg"
                width="28"
                height="28"
                alt=""
              />
              <span>{project.name}</span>
            </span>
            <span className="product-demo-location">
              <SceneIcon aria-hidden="true" />
              {sceneLabels[scene]}
            </span>
          </header>
          <div
            className="product-demo-stage"
            data-side-plan={sidePlan || undefined}
          >
            {/* Keep scene surfaces rendered for the crossfade; inactive scenes
                remain inert and hidden from assistive technology. */}
            <TabsContent
              value="capture"
              keepMounted
              hidden={false}
              aria-hidden={scene !== "capture"}
              inert={scene !== "capture"}
              className="product-demo-scene product-demo-capture"
            >
              <div className="product-demo-document">
                <h3>Little paths</h3>
                <Suspense
                  fallback={
                    <p className="product-demo-opening" role="status">
                      Opening the idea…
                    </p>
                  }
                >
                  <Writing blocks={writing} />
                </Suspense>
              </div>
            </TabsContent>
            <TabsContent
              value="explore"
              keepMounted
              hidden={false}
              aria-hidden={scene !== "explore"}
              inert={scene !== "explore"}
              className="product-demo-scene product-demo-explore"
            >
              <article
                className="product-demo-conversation"
                aria-label="Example conversation"
              >
                <h3>{exampleConversation.title}</h3>
                <div className="product-demo-user-message">
                  <span>You</span>
                  <ProjectText text={exampleConversation.prompt} />
                </div>
                <div className="product-demo-reply">
                  <span className="product-demo-speaker">
                    <img
                      src="/brand/gather-symbol.svg"
                      width="24"
                      height="24"
                      alt=""
                    />
                    woolgather
                  </span>
                  <ProjectText text={exampleConversation.reply} />
                  <TurnWorkSummary
                    createdAt="2026-09-17T12:00:00Z"
                    status="complete"
                    replying
                    changedItems={[
                      { id: changedThought.id, title: changedThought.title },
                    ]}
                    onSelect={openThought}
                  />
                </div>
              </article>
            </TabsContent>
            <TabsContent
              value="shape"
              keepMounted
              hidden={false}
              role={sidePlan ? "region" : "tabpanel"}
              aria-hidden={!planVisible}
              inert={!planVisible}
              className="product-demo-scene product-demo-shape"
            >
              <div
                className="product-demo-plan"
                ref={planHost}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && chosen) {
                    event.preventDefault();
                    closeThought();
                  }
                }}
              >
                {chosen ? (
                  <PlanThoughtDetails
                    project={project}
                    chosen={chosen}
                    busy={false}
                    readOnly
                    onBack={closeThought}
                    onClose={closeThought}
                    onSelect={openThought}
                    onEdit={noop}
                    onAnswer={noop}
                    onDiscuss={noop}
                    onConnect={noop}
                    onDisconnect={noop}
                    onRemove={noop}
                    onAdopt={noop}
                    onDismiss={noop}
                  />
                ) : (
                  <>
                    <div className="product-demo-plan-heading">
                      <h3>Plan</h3>
                      <span>3 thoughts</span>
                    </div>
                    <PlanningMap
                      project={project}
                      focus={null}
                      onFocus={openThought}
                      view="outline"
                    />
                  </>
                )}
              </div>
            </TabsContent>
          </div>
        </div>
        <div className="product-demo-controls">
          <TabsList aria-label="Product tour" className="product-demo-steps">
            <TabsTrigger value="capture">Write</TabsTrigger>
            <TabsTrigger value="explore">Explore</TabsTrigger>
            <TabsTrigger value="shape" ref={planTab}>
              Plan
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      <p className="product-demo-caption">
        An example project, with a prewritten conversation.
      </p>
    </section>
  );
}
