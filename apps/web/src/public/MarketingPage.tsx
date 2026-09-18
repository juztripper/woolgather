import {
  Component,
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  Leaf,
  Menu,
  MessageCircle,
  Paperclip,
} from "lucide-react";
import { planOffer } from "../../../../packages/domain/src/plans";
import { Brand } from "../ui/Brand";
import { Button, IconButton } from "../ui/Button";
import { AgentAvatar } from "../projects/AgentAvatar";
import { ProductDemo } from "./ProductDemo";
import { buttonVariants } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import "./marketing.css";

export const MarketingSession = createContext<boolean | null>(null);
function useEntryAction() {
  const signedIn = useContext(MarketingSession);
  return {
    signedIn,
    href: signedIn === false ? "/recent?auth=create" : "/recent",
    label: signedIn === false ? "Start for free" : "Open workspace",
  };
}

class DemoBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="marketing-demo-loading" role="alert">
        <div>
          <p>The example couldn’t load.</p>
          <Button onClick={() => location.reload()}>Reload example</Button>
          <a href="/learn/start-here">Read the getting started guide</a>
        </div>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function MarketingHeader({ pricing = false }: { pricing?: boolean }) {
  const entry = useEntryAction();
  return (
    <header className="marketing-header">
      <a href="/" aria-label="woolgather home">
        <Brand />
      </a>
      <nav className="marketing-nav" aria-label="Main navigation">
        <a href="/#how-it-works">The experience</a>
        <a href="/pricing" aria-current={pricing ? "page" : undefined}>
          Pricing
        </a>
        <a href="/learn">Learn</a>
      </nav>
      <div className="marketing-account">
        {entry.signedIn === false && (
          <a className="marketing-sign-in" href="/recent">
            Log in
          </a>
        )}
        <a className={buttonVariants({ size: "sm" })} href={entry.href}>
          {entry.label} <ArrowUpRight aria-hidden="true" />
        </a>
        <div className="marketing-mobile-nav">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton aria-label="Open navigation" size="icon-sm" />
              }
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<a href="/#how-it-works" />}>
                The experience
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href="/pricing" />}>
                Pricing
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href="/learn" />}>
                Learn
              </DropdownMenuItem>
              <DropdownMenuItem render={<a href="/recent" />}>
                {entry.signedIn === false ? "Log in" : "Open workspace"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="marketing-footer marketing-container">
      <div>
        <a href="/" aria-label="woolgather home">
          <Brand />
        </a>
        <p>Room to think. Space to make.</p>
      </div>
      <nav aria-label="More information">
        <a href="/pricing">Pricing</a>
        <a href="/learn">Learn</a>
        <a href="/support">Support</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
      <p className="marketing-maker">
        Made by <a href="https://rippersgames.com">Ripper’s Games</a>
      </p>
    </footer>
  );
}

function Hero() {
  const entry = useEntryAction();
  return (
    <section className="marketing-hero" aria-labelledby="hero-heading">
      <div className="marketing-hero-copy">
        <h1 id="hero-heading">
          Your ideas.
          <br />
          <span>Coming together.</span>
        </h1>
        <p>A place to write, think it through, and make a plan.</p>
        <div className="marketing-hero-actions">
          <a href={entry.href} className={buttonVariants({ size: "lg" })}>
            {entry.label} <ArrowUpRight aria-hidden="true" />
          </a>
          <a href="#how-it-works" className="marketing-watch">
            Explore woolgather <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="marketing-hero-scene">
        <aside className="marketing-floating-note" aria-label="Example idea">
          <span className="marketing-object-label">
            <Leaf aria-hidden="true" /> An idea
          </span>
          <p>
            A small game
            <br />
            about wandering.
          </p>
        </aside>
        <a className="marketing-floating-source" href="#sources">
          <FileText aria-hidden="true" />
          <span>
            <span>Field notes.pdf</span>
            <small>A source for this project</small>
          </span>
        </a>
        <div id="how-it-works" className="marketing-hero-product" tabIndex={-1}>
          <DemoBoundary>
            <ProductDemo />
          </DemoBoundary>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section
      className="marketing-features marketing-container"
      aria-label="More ways to make it yours"
    >
      <article className="marketing-feature" id="sources">
        <div className="marketing-feature-copy">
          <h2>
            Everything that
            <br />
            got you thinking.
          </h2>
          <p>
            A reference image. That useful PDF. A note you don’t want to lose.
            Keep them with your project, then bring the right sources into a
            conversation.
          </p>
          <a className="marketing-text-link" href="/learn/add-project-sources">
            Explore Sources <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
        <div
          className="marketing-source-scene"
          aria-label="An example source with instructions"
        >
          <div className="marketing-source-file">
            <FileText aria-hidden="true" />
            <span>Field notes.pdf</span>
            <Paperclip aria-hidden="true" />
          </div>
          <div className="marketing-source-paper">
            <span className="marketing-object-label">
              A source for Little paths
            </span>
            <h3>Notice the small things.</h3>
            <p>
              “A feather on the path. The sound of a stream. Something worth
              remembering.”
            </p>
            <div>
              <span>Use</span>
              <p>The quiet pace and sense of discovery.</p>
            </div>
            <div>
              <span>Avoid</span>
              <p>Collection quotas or a race to the finish.</p>
            </div>
          </div>
        </div>
      </article>
      <article className="marketing-feature marketing-feature--agents">
        <div
          className="marketing-perspectives"
          aria-label="Example agent perspectives"
        >
          <div className="marketing-perspective">
            <AgentAvatar id="marketing-story" avatar="sprout" quiet />
            <div>
              <span>Story & world</span>
              <p>What makes this place worth exploring?</p>
            </div>
          </div>
          <div className="marketing-perspective">
            <AgentAvatar id="marketing-gameplay" avatar="orbit" quiet />
            <div>
              <span>Game design</span>
              <p>What does the player get to choose?</p>
            </div>
          </div>
          <div className="marketing-perspective">
            <AgentAvatar id="marketing-build" avatar="spark" quiet />
            <div>
              <span>A first version</span>
              <p>What’s the smallest thing we can make?</p>
            </div>
          </div>
          <span className="marketing-perspectives-caption">
            <MessageCircle aria-hidden="true" /> Different perspectives. One
            project.
          </span>
        </div>
        <div className="marketing-feature-copy">
          <h2>
            Think it through.
            <br />
            From another angle.
          </h2>
          <p>
            Give an agent a role in your project. Explore a possibility
            together, or branch a conversation when another direction is worth a
            look.
          </p>
          <a
            className="marketing-text-link"
            href="/learn/work-with-chats-and-agents"
          >
            Meet chats & agents <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </article>
      <div className="marketing-ownership">
        <h2>
          Your ideas.
          <br />
          <span>Always yours.</span>
        </h2>
        <div>
          <p>
            Write without interruptions. Decide when to use AI. Keep editing,
            planning and exporting even when your credits run out.
          </p>
          <a
            className="marketing-text-link"
            href="/learn/save-recover-and-export"
          >
            Saving, recovery & export <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}
const questions = [
  {
    title: "What can I use woolgather for?",
    answer:
      "A game you want to make, an app you keep imagining, or a project that is still taking shape. Capture the idea, explore how it could work, and keep decisions and questions together as you go.",
  },
  {
    title: "Does AI change my writing?",
    answer:
      "Ideas is your own writing space. Opening, editing or saving an Idea does not start AI work. In Projects, you choose when to ask for help. Your own decisions stay distinct from suggestions and open questions.",
  },
  {
    title: "How do credits work?",
    answer:
      "Credits pay for AI assistance in Projects. The cost varies with the work and reasoning level; a maximum is shown before you send. Only completed work uses customer credits, and unused reserved credits return to your balance. Writing and manual planning do not use credits.",
  },
  {
    title: "What happens when I run out?",
    answer:
      "You can keep writing, edit your Plan, read your chats and export your work. AI assistance needs enough credits and available service capacity. There are no automatic overage charges or credit purchases.",
  },
  {
    title: "How do I choose Plus?",
    answer:
      "Sign in and open Settings → Billing to see availability for your account and choose Plus. It is €24 a month, including tax. Checkout and subscription management happen through Stripe; exploring this page never starts a subscription.",
  },
  {
    title: "Do my credits roll over?",
    answer:
      "Your 200 welcome credits have no expiry. Monthly credits expire at the end of their period and do not roll over. Plus voice minutes reset each paid period. Unused welcome credits stay with you when your plan changes.",
  },
  {
    title: "Can I take my work with me?",
    answer:
      "Yes. Export an Idea with its attachments or export a Project’s saved work. Export and access to your existing writing remain available when you have no AI credits.",
  },
];

function Questions({ pricing = false }: { pricing?: boolean }) {
  const items = pricing
    ? questions.slice(2)
    : [questions[0], questions[1], questions[2], questions[6]];
  return (
    <section
      className="marketing-faq marketing-container"
      aria-labelledby="questions-heading"
    >
      <div>
        <h2 id="questions-heading">A few things you might be wondering.</h2>
        <a href="/learn/faq" className="marketing-text-link">
          More answers <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
      <div className="marketing-questions">
        {items.map((item) => (
          <Collapsible key={item.title} className="marketing-question">
            <h3>
              <CollapsibleTrigger render={<Button variant="quiet" />}>
                <span>{item.title}</span>
                <ChevronDown aria-hidden="true" />
              </CollapsibleTrigger>
            </h3>
            <CollapsibleContent>
              <p>{item.answer}</p>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </section>
  );
}

export function PricingCards({ compact = false }: { compact?: boolean }) {
  const entry = useEntryAction();
  return (
    <div
      className={`marketing-plans${compact ? " marketing-plans--compact" : ""}`}
    >
      <article className="marketing-plan marketing-plan--free">
        <div className="marketing-plan-heading">
          <h3>{planOffer.free.name}</h3>
          <span>Yours to begin</span>
        </div>
        <p className="marketing-price">
          €0<span>/ month</span>
        </p>
        <p>A home for your ideas, with room to try AI.</p>
        <a
          className={buttonVariants({
            variant: "outline",
            className: "w-full",
          })}
          href={entry.href}
        >
          {entry.label}
        </a>
        <ul>
          <li>
            <Check />
            Ideas, project chats and manual planning
          </li>
          <li>
            <Check />
            {planOffer.free.welcomeCredits} welcome credits, yours to keep
          </li>
          <li>
            <Check />
            {planOffer.free.monthlyCredits} AI credits each month
          </li>
          <li>
            <Check />
            Every reasoning level
          </li>
          <li>
            <Check />
            100 MiB of attachment storage
          </li>
        </ul>
      </article>
      <article className="marketing-plan marketing-plan--plus">
        <div className="marketing-plan-heading">
          <h3>{planOffer.paid.name}</h3>
          <span>Room to grow</span>
        </div>
        <p className="marketing-price">
          €{planOffer.paid.priceMinor / 100}
          <span>/ month, tax included</span>
        </p>
        <p>More room for the projects you keep coming back to.</p>
        <a
          className={buttonVariants({ className: "w-full" })}
          href="/account/billing"
        >
          Explore Plus
        </a>
        <ul>
          <li>
            <Check />
            Everything in Free
          </li>
          <li>
            <Check />
            {planOffer.paid.monthlyCredits.toLocaleString("en")} AI credits each
            month
          </li>
          <li>
            <Check />
            Access to more capable AI
          </li>
          <li>
            <Check />
            {planOffer.paid.voiceSeconds / 60} minutes of live voice per month
          </li>
          <li>
            <Check />1 GiB of attachment storage
          </li>
        </ul>
      </article>
    </div>
  );
}

function Closing() {
  const entry = useEntryAction();
  return (
    <section className="marketing-closing marketing-container">
      <p className="marketing-closing-intro">
        It doesn’t have to be figured out yet.
      </p>
      <h2>
        Let’s see where
        <br />
        that thought goes.
      </h2>
      <a href={entry.href} className={buttonVariants({ size: "lg" })}>
        {entry.signedIn === false
          ? "Make room for your idea"
          : "Open workspace"}{" "}
        <ArrowUpRight aria-hidden="true" />
      </a>
      {entry.signedIn === false && <p>Free to start. No card needed.</p>}
    </section>
  );
}

/** Public content remains available while the existing session resolves. */
export function MarketingPage({ pricing = false }: { pricing?: boolean }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void import("../client")
      .then(({ connect }) => connect())
      .then((client) => {
        if (disposed) return;
        const { data } = client.auth.onAuthStateChange((_event, session) => {
          if (!disposed) setSignedIn(Boolean(session));
        });
        unsubscribe = () => data.subscription.unsubscribe();
      })
      .catch(() => {
        // Keep a neutral workspace link when session lookup is unavailable.
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    document.title = pricing
      ? "Pricing | woolgather"
      : "woolgather — room to think";
  }, [pricing]);
  return (
    <MarketingSession.Provider value={signedIn}>
      <div className="marketing-site">
        <a className="skip-link" href="#marketing-main">
          Skip to content
        </a>
        <MarketingHeader pricing={pricing} />
        <main id="marketing-main" tabIndex={-1}>
          {pricing ? (
            <>
              <section className="marketing-pricing-intro marketing-container">
                <h1>
                  Start freely.
                  <br />
                  <span>Go from there.</span>
                </h1>
                <p>
                  Writing, thinking and planning belong in both plans.
                  <br className="marketing-desktop-break" /> Choose more AI when
                  you need it.
                </p>
              </section>
              <section
                className="marketing-container marketing-pricing-full"
                aria-label="Compare plans"
              >
                <PricingCards />
                <p className="marketing-plan-note">
                  No card needed for Free. Explore Plus in your account before
                  choosing a subscription.
                </p>
              </section>
              <section className="marketing-credit-story marketing-container">
                <div>
                  <h2>
                    Your work
                    <br />
                    stays with you.
                  </h2>
                  <p>
                    Use your credits for a fresh perspective. Keep writing,
                    planning and exporting even when they run out.
                  </p>
                  <a
                    href="/learn/choose-reasoning"
                    className="marketing-text-link"
                  >
                    How reasoning and credits work{" "}
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                </div>
                <div className="marketing-credit-details">
                  <article>
                    <h3>You choose when to use AI</h3>
                    <p>
                      Opening your workspace, saving an Idea and adding a
                      thought manually never start paid work.
                    </p>
                  </article>
                  <article>
                    <h3>A limit before you send</h3>
                    <p>
                      See the maximum credits for your request. Unused reserved
                      credits come back. No automatic overages.
                    </p>
                  </article>
                  <article>
                    <h3>Space for your references</h3>
                    <p>
                      Keep files and images beside your work. Changing plans
                      preserves existing files; new uploads need available
                      space.
                    </p>
                  </article>
                </div>
              </section>
              <Questions pricing />
            </>
          ) : (
            <>
              <Hero />
              <Features />
              <section
                className="marketing-pricing-section marketing-container"
                aria-labelledby="pricing-heading"
              >
                <div className="marketing-section-heading">
                  <h2 id="pricing-heading">
                    Good ideas start small.
                    <br />
                    Your plan can, too.
                  </h2>
                  <p>
                    Start with Free. Choose Plus for more AI and live voice.
                  </p>
                </div>
                <PricingCards compact />
                <div className="marketing-pricing-foot">
                  <p>
                    No card needed. Writing and manual planning use no credits.
                  </p>
                  <a href="/pricing" className="marketing-text-link">
                    Compare plans <ArrowUpRight aria-hidden="true" />
                  </a>
                </div>
              </section>
              <Questions />
            </>
          )}
          <Closing />
        </main>
        <MarketingFooter />
      </div>
    </MarketingSession.Provider>
  );
}
