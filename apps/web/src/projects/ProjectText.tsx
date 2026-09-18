import type { ReactNode } from "react";
import { InlineText } from "../ui/InlineText";

// A small, inert reading view for the plain-text planning fields. Rich source
// documents continue to use their own renderer; no HTML is accepted here.
export function ProjectText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const elements: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const key = i,
      line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      i++;
      elements.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      elements.push(
        <h3 key={key}>
          <InlineText text={heading[1]} streaming={streaming} />
        </h3>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line),
        items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        items.push(
          <li key={i}>
            <InlineText
              text={lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, "")}
              streaming={streaming}
            />
          </li>,
        );
      }
      elements.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|[-*•]\s|\d+\.\s)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    elements.push(
      <p key={key}>
        <InlineText text={paragraph.join("\n")} streaming={streaming} />
      </p>,
    );
  }
  return <div className="project-prose">{elements}</div>;
}
