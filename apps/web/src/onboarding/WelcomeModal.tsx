import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lightbulb, PanelsTopLeft } from "lucide-react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Disclosure } from "../ui/Disclosure";
import "./onboarding.css";

export type GuideTopic = "start" | "ideas" | "projects";
export type GuideDestination = "idea" | "project";
export class GuideActionError extends Error {}

/** The same optional introduction serves first entry and on-demand help. */
export function WelcomeModal({
  initialTopic = "start",
  firstRun = false,
  onStart,
  onClose,
  onDismissForSession,
}: {
  initialTopic?: GuideTopic;
  firstRun?: boolean;
  onStart: (destination: GuideDestination) => Promise<void>;
  onClose: () => Promise<void>;
  onDismissForSession?: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const pending = useRef(false);
  const alive = useRef(true);
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (error) {
      if (alive.current)
        setFailure(
          error instanceof GuideActionError
            ? error.message
            : "That didn’t finish. Please try again. Your place is kept.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    tabs.current
      ?.closest(".modal-body")
      ?.scrollTo({ top: 0, behavior: "instant" });
  }, [topic]);
  return (
    <Modal
      title={firstRun ? "Welcome to woolgather" : "Getting started"}
      className="welcome-modal sm:max-w-[620px]"
      onClose={() => void run(onClose)}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void run(onClose)}
          >
            {firstRun ? "Skip for now" : "Done"}
          </Button>
          {topic !== "start" && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void run(() => onStart(topic === "ideas" ? "idea" : "project"))
              }
            >
              {busy
                ? "Opening…"
                : topic === "ideas"
                  ? "New idea"
                  : "New project"}
              <ArrowRight aria-hidden="true" />
            </Button>
          )}
        </div>
      }
    >
      <div ref={tabs}>
        <Tabs
          value={topic}
          onValueChange={(value) => setTopic(value as GuideTopic)}
        >
          <TabsList aria-label="Getting started topics">
            <TabsTrigger data-topic="start" value="start" disabled={busy}>
              Start here
            </TabsTrigger>
            <TabsTrigger data-topic="ideas" value="ideas" disabled={busy}>
              Ideas
            </TabsTrigger>
            <TabsTrigger data-topic="projects" value="projects" disabled={busy}>
              Projects
            </TabsTrigger>
          </TabsList>
          <TabsContent value="start" className="welcome-topic">
            <h2>What’s on your mind?</h2>
            <p className="welcome-description">
              A passing thought or something you want to build. There’s a place
              for both.
            </p>
            <div className="welcome-paths">
              <Button
                variant="surface"
                className="welcome-path grid w-full grid-cols-[24px_minmax(0,1fr)_16px] items-start gap-3.5 rounded-xl border border-border bg-card p-4.5 hover:bg-accent"
                onClick={() => void run(() => onStart("idea"))}
                disabled={busy}
              >
                <Lightbulb aria-hidden="true" />
                <span>
                  <strong>New idea</strong>
                  <span>Write freely and collect references, without AI.</span>
                </span>
                <ArrowRight aria-hidden="true" />
              </Button>
              <Button
                variant="surface"
                className="welcome-path grid w-full grid-cols-[24px_minmax(0,1fr)_16px] items-start gap-3.5 rounded-xl border border-border bg-card p-4.5 hover:bg-accent"
                onClick={() => void run(() => onStart("project"))}
                disabled={busy}
              >
                <PanelsTopLeft aria-hidden="true" />
                <span>
                  <strong>New project</strong>
                  <span>
                    Develop a game or app. Talk with AI or plan on your own.
                  </span>
                </span>
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
            <p className="welcome-note">
              You can start a Project straight away. An Idea can become one
              later, or simply stay an Idea.
            </p>
          </TabsContent>
          <TabsContent value="ideas" className="welcome-topic">
            <h2>A space to think on your own.</h2>
            <p className="welcome-description">
              Use an Idea to get something down without needing a conversation
              or a project plan.
            </p>
            <figure className="welcome-example">
              <figcaption>A thought worth keeping</figcaption>
              <blockquote>
                “A quiet gardening game. Rain on the greenhouse roof. Maybe the
                plants grow while you’re away.”
              </blockquote>
            </figure>
            <p>
              Write freely, add images or files, and rearrange things as you go.
              Your writing saves automatically, with recovery if a save needs
              attention. AI doesn’t develop it in the background.
            </p>
            <Disclosure
              title="When you want to take it further"
              variant="inline"
            >
              <p>
                Choose <strong>Create project</strong> inside the Idea. Your
                saved writing and attachments come with you.{" "}
                <strong>Discuss the idea</strong> starts an AI conversation;{" "}
                <strong>Plan on my own</strong> keeps the handoff manual.
              </p>
            </Disclosure>
            <p className="welcome-note">
              New idea opens your own blank page. This example stays here.
            </p>
          </TabsContent>
          <TabsContent value="projects" className="welcome-topic">
            <h2>Start with what you want to make.</h2>
            <p className="welcome-description">
              Discuss a game or app and shape a plan. A rough direction is
              enough.
            </p>
            <figure className="welcome-example">
              <figcaption>For example, start a chat with</figcaption>
              <blockquote>
                “I’m making a gardening game. What should happen when the player
                returns?”
              </blockquote>
            </figure>
            <div className="welcome-project-basics">
              <p>
                <strong>Chat to explore.</strong> Ask questions and try
                possibilities. Project home brings your Chats, Agents and
                Sources together.
              </p>
              <p>
                <strong>Open Plan to see what’s kept.</strong> Your chats share
                thoughts, decisions and open questions. You choose which
                suggestions to accept. <strong>Add a thought</strong> lets you
                write directly.
              </p>
            </div>
            <Disclosure
              title="Sources, agents and ways to talk"
              variant="inline"
            >
              <dl className="welcome-features">
                <div>
                  <dt>Sources</dt>
                  <dd>
                    Keep reference files across chats. Use <strong>+</strong> or{" "}
                    <strong>@</strong> to add context. Mark sources Use, Avoid
                    or Undecided.
                  </dd>
                </div>
                <div>
                  <dt>Agents</dt>
                  <dd>
                    Add a specialist perspective, such as a game designer. Give
                    it instructions, then mention it or open a chat.
                  </dd>
                </div>
                <div>
                  <dt>Voice</dt>
                  <dd>
                    The microphone dictates into your draft when your browser
                    supports it. The waveform starts live voice when it is
                    enabled and available on your account.
                  </dd>
                </div>
                <div>
                  <dt>Reasoning</dt>
                  <dd>
                    Leave it on Auto, or choose Quick, Thoughtful or Deep for
                    the discussion.
                  </dd>
                </div>
              </dl>
            </Disclosure>
            <p className="welcome-note">
              New project opens setup without AI work. Assisted replies and live
              voice use your allowance when available. Add a thought stays
              manual.
            </p>
          </TabsContent>
        </Tabs>
      </div>
      {failure && (
        <div>
          <p role="alert" className="welcome-error">
            {failure}
          </p>
          {onDismissForSession && (
            <>
              <Button variant="inline" onClick={onDismissForSession}>
                Close for now
              </Button>
              <p className="welcome-note">
                This welcome may return until your choice can be saved.
              </p>
            </>
          )}
        </div>
      )}
      <p className="welcome-replay">
        Find this guide again in your account menu → Getting started.
      </p>
    </Modal>
  );
}
