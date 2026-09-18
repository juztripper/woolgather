import { StreamingText } from "./StreamingText";

// Shared inert inline formatting. Text is escaped by React; no HTML is accepted.
export function InlineText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return text
    .split(
      /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g,
    )
    .map((part, index) => {
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      return link ? (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer">
          <StreamingText text={link[1]} active={streaming} />
        </a>
      ) : part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>
          <StreamingText text={part.slice(2, -2)} active={streaming} />
        </strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={index}>
          <StreamingText text={part.slice(1, -1)} active={streaming} />
        </code>
      ) : part.startsWith("*") && part.endsWith("*") ? (
        <em key={index}>
          <StreamingText text={part.slice(1, -1)} active={streaming} />
        </em>
      ) : (
        <StreamingText
          key={index}
          text={part.replace(/\\([\\`*_{}\[\]<>#])/g, "$1")}
          active={streaming}
        />
      );
    });
}
