import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Search,
} from "lucide-react";
import { buttonVariants } from "../components/ui/button";
import { Button } from "../ui/Button";
import { InlineText } from "../ui/InlineText";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { categories, faqs, guides, type Guide } from "./content";
import "../library/library.css";
import "./learn.css";

export type Navigate = (path: string, options?: { replace?: boolean }) => void;
export function LearnLink({
  href,
  onNavigate,
  children,
  className = "",
  current,
}: {
  href: string;
  onNavigate: Navigate;
  children: ReactNode;
  className?: string;
  current?: boolean;
}) {
  return (
    <a
      className={className}
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onNavigate(href);
      }}
    >
      {children}
    </a>
  );
}

function GuideCard({
  guide,
  href,
  onNavigate,
}: {
  guide: Guide;
  href: string;
  onNavigate: Navigate;
}) {
  return (
    <li className="library-card learn-card">
      <LearnLink
        className="library-card-open"
        href={href}
        onNavigate={onNavigate}
      >
        <img
          className="learn-card-cover"
          src={guide.cover}
          alt=""
          width="1536"
          height="1024"
          loading="lazy"
          decoding="async"
        />
        <div className="learn-card-copy">
          <span className="library-card-kind">
            <span>{guide.category}</span>
            <ArrowRight className="library-card-arrow" aria-hidden="true" />
          </span>
          <h3 className="library-card-title">{guide.title}</h3>
          <p className="library-card-excerpt">{guide.description}</p>
          <span className="library-card-meta">{guide.minutes} min read</span>
        </div>
      </LearnLink>
    </li>
  );
}

export function LearnPage({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: Navigate;
}) {
  const url = new URL(path, "https://woolgather.invalid");
  const query = url.searchParams.get("q") || "";
  const topic =
    categories.find((category) => category === url.searchParams.get("topic")) ||
    "All guides";
  const isFaq = url.pathname === "/learn/faq";
  const isIndex =
    url.pathname === "/learn" || url.pathname === "/learn/" || isFaq;
  const guide = guides.find((item) => url.pathname === `/learn/${item.slug}`);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPath = useRef(url.pathname);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${isIndex ? (isFaq ? "FAQ" : "Learn") : guide?.title || "Guide not found"} · woolgather`;
    return () => {
      document.title = previousTitle;
    };
  }, [isIndex, isFaq, guide]);
  useEffect(() => {
    if (previousPath.current !== url.pathname) {
      heading.current?.focus({ preventScroll: true });
    }
    previousPath.current = url.pathname;
  }, [url.pathname, isIndex]);
  const filteredPath = (
    pathname: string,
    changes: Record<string, string | null> = {},
  ) => {
    const params = new URLSearchParams(url.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    return pathname + (params.size ? `?${params}` : "");
  };
  const articlePath = (slug: string) =>
    filteredPath(`/learn/${slug}`, { from: isFaq ? "faq" : null });
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) =>
    terms.every((term) =>
      text
        .replace(/\*\*|`/g, "")
        .toLocaleLowerCase()
        .includes(term),
    );
  const filteredGuides = guides.filter(
    (item) =>
      (topic === "All guides" || item.category === topic) &&
      matches(
        [
          item.title,
          item.description,
          item.category,
          ...item.sections.flatMap((section) => [
            section.title,
            ...section.paragraphs,
            ...(section.bullets || []),
            ...(section.steps || []),
            section.tip || "",
          ]),
        ].join(" "),
      ),
  );
  const filteredFaqs = faqs.filter((item) =>
    matches(
      [
        item.question,
        ...item.answer,
        ...(item.bullets || []),
        ...(item.steps || []),
      ].join(" "),
    ),
  );
  const featured =
    !query.trim() && topic === "All guides" ? guides[0] : undefined;
  const backPath = filteredPath(
    url.searchParams.get("from") === "faq" ? "/learn/faq" : "/learn",
    { from: null },
  );

  if (!isIndex)
    return (
      <section className="library-workspace learn-page learn-reader">
        <LearnLink
          className={buttonVariants({
            variant: "ghost",
            className: "w-fit mb-8",
          })}
          href={backPath}
          onNavigate={onNavigate}
        >
          <ArrowLeft />
          {url.searchParams.get("from") === "faq"
            ? "Back to FAQ"
            : "All guides"}
        </LearnLink>
        {guide ? (
          <>
            <header className="learn-article-header">
              <div className="learn-meta">
                <span>{guide.category}</span>
                <span>{guide.minutes} min read</span>
              </div>
              <h1 ref={heading} tabIndex={-1}>
                {guide.title}
              </h1>
              <p>{guide.description}</p>
            </header>
            <div className="learn-article-layout">
              <nav className="learn-outline" aria-label="In this guide">
                <h2>In this guide</h2>
                {guide.sections.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      onNavigate(url.pathname + url.search + "#" + section.id);
                    }}
                  >
                    {section.title}
                  </a>
                ))}
              </nav>
              <article className="learn-prose" aria-label={guide.title}>
                <div className="learn-article-cover">
                  <img
                    src={guide.cover}
                    alt=""
                    width="1536"
                    height="1024"
                    decoding="async"
                  />
                </div>
                {guide.sections.map((section) => (
                  <section key={section.id} aria-labelledby={section.id}>
                    <h2 id={section.id} tabIndex={-1}>
                      {section.title}
                    </h2>
                    {section.paragraphs.map((paragraph) => (
                      <p key={paragraph}>
                        <InlineText text={paragraph} />
                      </p>
                    ))}
                    {section.bullets && (
                      <ul>
                        {section.bullets.map((bullet) => (
                          <li key={bullet}>
                            <InlineText text={bullet} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {section.steps && (
                      <ol>
                        {section.steps.map((step) => (
                          <li key={step}>
                            <InlineText text={step} />
                          </li>
                        ))}
                      </ol>
                    )}
                    {section.tip && (
                      <aside className="learn-tip">
                        <InlineText text={section.tip} />
                      </aside>
                    )}
                  </section>
                ))}
              </article>
            </div>
            <section className="learn-related" aria-labelledby="related-guides">
              <h2 id="related-guides">Keep exploring</h2>
              <ul className="learn-related-links">
                {guide.related
                  .map((slug) => guides.find((item) => item.slug === slug))
                  .filter((item): item is Guide => !!item)
                  .map((item) => (
                    <li key={item.slug}>
                      <LearnLink
                        href={filteredPath(`/learn/${item.slug}`)}
                        onNavigate={onNavigate}
                      >
                        {item.title}
                        <ArrowRight aria-hidden="true" />
                      </LearnLink>
                    </li>
                  ))}
              </ul>
            </section>
          </>
        ) : (
          <div className="learn-empty">
            <BookOpen aria-hidden="true" />
            <h1 ref={heading} tabIndex={-1}>
              Guide not found
            </h1>
            <p>
              This link doesn’t match a guide. Browse the library to find what
              you need.
            </p>
            <Button onClick={() => onNavigate("/learn")}>Browse guides</Button>
          </div>
        )}
      </section>
    );

  return (
    <section className="library-workspace learn-page">
      <header className="learn-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {isFaq ? "Frequently asked questions" : "Learn woolgather"}
          </h1>
          <p>
            {isFaq
              ? "Quick answers about your ideas, projects and the work you keep."
              : "Practical guides, from your first idea to a clearer plan."}
          </p>
        </div>
        <div className="learn-search" role="search">
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={isFaq ? "Search questions" : "Search guides"}
              placeholder={isFaq ? "Search questions" : "Search guides"}
              value={query}
              onChange={(event) =>
                onNavigate(
                  filteredPath(url.pathname, { q: event.target.value }),
                  { replace: true },
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onNavigate(filteredPath(url.pathname, { q: null }), {
                    replace: true,
                  });
                }
              }}
            />
          </InputGroup>
        </div>
      </header>
      {!isFaq ? (
        <>
          {featured && (
            <div className="learn-feature library-card">
              <LearnLink
                className="learn-feature-link"
                href={articlePath(featured.slug)}
                onNavigate={onNavigate}
              >
                <div className="learn-feature-copy">
                  <span className="learn-meta">Start here</span>
                  <h2>{featured.title}</h2>
                  <p>{featured.description}</p>
                  <span className="learn-feature-action">
                    Read the guide <ArrowRight aria-hidden="true" />
                    <span>{featured.minutes} min</span>
                  </span>
                </div>
                <div className="learn-feature-art">
                  <img
                    src={featured.cover}
                    alt=""
                    width="1536"
                    height="1024"
                    loading="eager"
                    fetchPriority="high"
                  />
                </div>
              </LearnLink>
            </div>
          )}
          <div className="learn-browse-heading">
            <h2>{query.trim() ? "Search results" : "Browse guides"}</h2>
            <span className="learn-meta" role="status">
              {filteredGuides.length - (featured ? 1 : 0)}{" "}
              {filteredGuides.length - (featured ? 1 : 0) === 1
                ? "guide"
                : "guides"}
            </span>
          </div>
          <div className="learn-topics" role="group" aria-label="Guide topics">
            {["All guides", ...categories].map((category) => (
              <Button
                key={category}
                size="sm"
                variant={topic === category ? "secondary" : "quiet"}
                aria-pressed={topic === category}
                onClick={() =>
                  onNavigate(
                    filteredPath("/learn", {
                      topic: category === "All guides" ? null : category,
                    }),
                    { replace: true },
                  )
                }
              >
                {category}
              </Button>
            ))}
          </div>
          {filteredGuides.length ? (
            <ul className="library-cards learn-cards">
              {filteredGuides
                .filter((item) => item !== featured)
                .map((item) => (
                  <GuideCard
                    key={item.slug}
                    guide={item}
                    href={articlePath(item.slug)}
                    onNavigate={onNavigate}
                  />
                ))}
            </ul>
          ) : (
            <NoResults
              onClear={() => {
                onNavigate("/learn", { replace: true });
                heading.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className="learn-browse-heading">
            <span className="learn-meta" role="status">
              {filteredFaqs.length}{" "}
              {filteredFaqs.length === 1 ? "answer" : "answers"}
            </span>
          </div>
          {filteredFaqs.length ? (
            <div className="learn-faq">
              {filteredFaqs.map((item) => (
                <Collapsible key={item.id} className="learn-question">
                  <h2>
                    <CollapsibleTrigger className="learn-question-trigger">
                      <span>{item.question}</span>
                      <ChevronDown aria-hidden="true" />
                    </CollapsibleTrigger>
                  </h2>
                  <CollapsibleContent className="learn-answer">
                    {item.answer.map((paragraph) => (
                      <p key={paragraph}>
                        <InlineText text={paragraph} />
                      </p>
                    ))}
                    {item.bullets && (
                      <ul>
                        {item.bullets.map((bullet) => (
                          <li key={bullet}>
                            <InlineText text={bullet} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.steps && (
                      <ol>
                        {item.steps.map((step) => (
                          <li key={step}>
                            <InlineText text={step} />
                          </li>
                        ))}
                      </ol>
                    )}
                    <LearnLink
                      href={articlePath(item.guide)}
                      onNavigate={onNavigate}
                    >
                      Read the guide <ArrowRight aria-hidden="true" />
                    </LearnLink>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          ) : (
            <NoResults
              onClear={() => {
                onNavigate("/learn/faq", { replace: true });
                heading.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="learn-empty">
      <BookOpen aria-hidden="true" />
      <h3>No matches yet</h3>
      <p>
        Try a topic like “sources”, “Plan” or “saving”, or clear your filters.
      </p>
      <Button onClick={onClear}>Clear filters</Button>
    </div>
  );
}
