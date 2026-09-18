import type { ProjectVoiceTranscriptEntry } from "./ProjectVoice";

/** Provider deltas already contain their whitespace and punctuation. Join them
 * verbatim, only breaking when the speaker changes; never rewrite saved speech. */
export function voiceTranscriptTurns(
  fragments: readonly ProjectVoiceTranscriptEntry[],
): ProjectVoiceTranscriptEntry[] {
  const turns: ProjectVoiceTranscriptEntry[] = [];
  for (const fragment of fragments) {
    const previous = turns.at(-1);
    if (previous?.speaker === fragment.speaker) {
      previous.text += fragment.text;
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      turns.push({ ...fragment });
    }
  }
  return turns.filter((turn) => turn.text.trim());
}
