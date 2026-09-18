import { voiceTranscriptTurns } from "./voiceTranscript";
import { AudioLines } from "lucide-react";
import { Disclosure } from "../ui/Disclosure";
import type { ProjectVoiceHistoryEntry } from "./ProjectVoice";

export function voiceCallCaption(entry: ProjectVoiceHistoryEntry) {
  const opening = voiceTranscriptTurns(entry.transcript)
    .find((part) => part.speaker === "user" && part.text.trim())
    ?.text.replace(/\s+/g, " ")
    .trim();
  if (!opening) return undefined;
  return opening.length > 96 ? `${opening.slice(0, 93).trimEnd()}…` : opening;
}

export function VoiceCallCard({ entry }: { entry: ProjectVoiceHistoryEntry }) {
  const seconds = Math.max(0, Math.floor(entry.durationSeconds || 0));
  const duration =
    entry.durationSeconds === undefined
      ? undefined
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const caption = voiceCallCaption(entry);
  const transcript = voiceTranscriptTurns(entry.transcript);
  const title =
    entry.status === "failed" ? "Voice call interrupted" : "Voice call";
  return (
    <article className="conversation-voice-call" aria-label={title}>
      <Disclosure
        variant="inline"
        title={
          <>
            <AudioLines aria-hidden="true" />
            <span>{title}</span>
            {duration && (
              <span className="conversation-call-duration">{duration}</span>
            )}
          </>
        }
      >
        <div className="conversation-call-transcript">
          {transcript.length ? (
            transcript.map((part, index) => (
              <p key={index}>
                <span>{part.speaker === "user" ? "You" : "woolgather"}</span>
                {part.text}
              </p>
            ))
          ) : (
            <p>No transcript was captured.</p>
          )}
        </div>
      </Disclosure>
      {caption && <p className="conversation-call-caption">{caption}</p>}
    </article>
  );
}
