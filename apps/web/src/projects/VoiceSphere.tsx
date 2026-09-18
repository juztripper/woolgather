import { useEffect, useRef, useState, type CSSProperties } from "react";
import { mountVoiceOrb } from "./voice-orb.js";

export type VoiceSpherePhase =
  "idle" | "connecting" | "listening" | "speaking" | "muted" | "error";

export type VoiceSphereProps = {
  phase: VoiceSpherePhase;
  inputLevel?: number;
  outputLevel?: number;
  size?: "compact" | "panel";
};

function level(value: number | undefined) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value || 0 : 0));
}

function reducedMotion() {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.dataset.motion === "reduce" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The voice mark is intentionally a small glass material, rather than a
 * microphone glyph. The levels come from the WebRTC input/output analysers
 * in ProjectVoice, so its pulse reflects the live audio path.
 */
export function VoiceSphere({
  phase,
  inputLevel = 0,
  outputLevel = 0,
  size = "compact",
}: VoiceSphereProps) {
  const input = level(inputLevel);
  const output = level(outputLevel);
  const amplitude = Math.max(input * 0.82, output);
  const audioLevelRef = useRef(amplitude);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reduced, setReduced] = useState(reducedMotion);
  audioLevelRef.current = amplitude;
  const style = {
    "--voice-input": input,
    "--voice-output": output,
    "--voice-level": amplitude,
  } as CSSProperties;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(reducedMotion());
    media.addEventListener("change", sync);
    document.addEventListener("woolgather:preferences", sync);
    sync();
    return () => {
      media.removeEventListener("change", sync);
      document.removeEventListener("woolgather:preferences", sync);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduced) return;
    return mountVoiceOrb(canvas, () => audioLevelRef.current);
  }, [reduced]);

  return (
    <span
      className={`project-voice-sphere project-voice-sphere--${size}`}
      data-phase={phase}
      data-reduced={reduced ? "true" : "false"}
      style={style}
      aria-hidden="true"
    >
      <span className="project-voice-sphere-render" data-renderer="fallback">
        <canvas ref={canvasRef} />
        <span className="project-voice-sphere-fallback" />
      </span>
      <span className="project-voice-sphere-waves">
        <span />
        <span />
        <span />
      </span>
      <span className="project-voice-sphere-core">
        <span className="project-voice-sphere-sheen" />
        <span className="project-voice-sphere-fold" />
      </span>
    </span>
  );
}
