import { useId, type CSSProperties } from "react";
import {
  agentAvatar,
  agentAvatars,
  type AgentAvatarId,
} from "../../../../packages/domain/src/agentIdentity";
import {
  useAgentAvatarMotion,
  type AgentActivity,
} from "./useAgentAvatarMotion";
import "./agent-identity.css";

export { agentAvatars };
export const agentAvatarNames: Record<AgentAvatarId, string> = {
  sprout: "Sprout",
  orbit: "Orbit",
  moss: "Moss",
  spark: "Spark",
  pebble: "Pebble",
  ripple: "Ripple",
};
const colors: Record<AgentAvatarId, [string, string, string]> = {
  sprout: ["#d7e6df", "#85b0a1", "#385f59"],
  orbit: ["#dde2f1", "#a0acd6", "#535a82"],
  moss: ["#e0e8d4", "#a7bc87", "#5b7047"],
  spark: ["#f5e3cc", "#dcb07d", "#855e38"],
  pebble: ["#e9dde8", "#c5a6bc", "#78576f"],
  ripple: ["#d8e9ee", "#88b7ca", "#3d677b"],
};
/** Original, bundled characters; the same art is used in creation, chats and mentions. */
export function AgentAvatar({
  id,
  avatar,
  className = "",
  interactive = false,
  quiet = false,
  activity = "idle",
}: {
  id: string;
  avatar?: string;
  className?: string;
  interactive?: boolean;
  quiet?: boolean;
  activity?: AgentActivity;
}) {
  const kind = agentAvatar(id, avatar);
  const ref = useAgentAvatarMotion(kind, interactive, activity);
  const phase = agentAvatars.indexOf(kind);
  const [sky, tint, ink] = colors[kind];
  const key = useId().replace(/:/g, "");
  return (
    <span
      ref={ref}
      className={`agent-avatar ${className}`}
      data-character={kind}
      data-quiet={quiet}
      data-activity={activity}
      style={
        {
          "--agent-sky": sky,
          "--agent-idle-period": `${4.2 + phase * 0.37}s`,
          "--agent-blink-delay": `${-phase * 0.83}s`,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <svg className="size-full" viewBox="0 0 80 80" fill="none">
        <defs>
          <radialGradient id={`${key}-sky`} cx=".28" cy=".12" r="1">
            <stop stopColor="#fff" />
            <stop offset="1" stopColor={sky} />
          </radialGradient>
          <filter
            id={`${key}-edge`}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow
              dx="0"
              dy=".25"
              stdDeviation=".5"
              floodColor={ink}
              floodOpacity=".16"
            />
          </filter>
          <linearGradient
            id={`${key}-body`}
            x1="24"
            y1="24"
            x2="56"
            y2="70"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#fff" stopOpacity=".95" />
            <stop offset="1" stopColor={tint} />
          </linearGradient>
          <g id={`${key}-orbit-ring`}>
            <ellipse
              cx="40"
              cy="51"
              rx="31"
              ry="10"
              stroke="#fff"
              strokeWidth="6"
            />
            <ellipse
              cx="40"
              cy="51"
              rx="31"
              ry="10"
              stroke={tint}
              strokeWidth="3.5"
            />
          </g>
          <clipPath id={`${key}-orbit-front`}>
            <rect x="0" y="51" width="80" height="29" />
          </clipPath>
        </defs>
        <circle
          className="agent-avatar-backdrop"
          cx="40"
          cy="40"
          r="39"
          fill={`url(#${key}-sky)`}
        />
        <ellipse
          className="agent-avatar-shadow"
          cx="40"
          cy="66"
          rx="20"
          ry="5"
          fill={ink}
          opacity=".09"
        />
        <g className="agent-avatar-reaction">
          <g className="agent-avatar-body">
            <g className="agent-avatar-tilt">
              <g className="agent-avatar-accessory">
                {kind === "sprout" && (
                  <>
                    <path
                      d="M40 30V18"
                      stroke={ink}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    <path
                      d="M40 23C28 24 28 12 29 12c10 0 13 5 11 11Z"
                      fill={tint}
                    />
                    <path
                      d="M40 21c0-9 8-10 12-9-1 9-7 11-12 9Z"
                      fill={ink}
                      opacity=".65"
                    />
                  </>
                )}
                {kind === "orbit" && (
                  <g transform="rotate(-14 40 51)">
                    <use href={`#${key}-orbit-ring`} />
                  </g>
                )}
                {kind === "moss" && (
                  <>
                    <path
                      d="M24 35 20 19Q36 20 34 32M46 32Q44 20 60 19L56 35"
                      fill={tint}
                    />
                  </>
                )}
                {kind === "pebble" && (
                  <>
                    <ellipse
                      cx="26"
                      cy="28"
                      rx="6"
                      ry="10"
                      fill={tint}
                      transform="rotate(-24 26 28)"
                    />
                    <ellipse
                      cx="54"
                      cy="28"
                      rx="6"
                      ry="10"
                      fill={tint}
                      transform="rotate(24 54 28)"
                    />
                  </>
                )}
              </g>
              <path
                className={kind === "spark" ? "agent-avatar-flame" : undefined}
                filter={`url(#${key}-edge)`}
                d={
                  kind === "ripple"
                    ? "M24 64c-8 0-13-6-13-14 0-7 5-13 12-14-2-8 4-15 12-13 6-7 18-2 19 7 8-3 15 4 13 12 6 3 6 13 0 17-3 4-7 5-12 5Z"
                    : kind === "spark"
                      ? "M40 66C26 66 17 59 17 47C17 39 22 32 26 28C24 35 29 38 31 38C29 25 38 22 42 14Q44 10 44 15C43 25 57 29 54 40C59 38 60 34 59 31C65 37 67 44 64 53C61 62 51 66 40 66Z"
                      : "M18 46c0-16 8-23 22-23s22 7 22 23c0 13-8 20-22 20S18 59 18 46Z"
                }
                fill={`url(#${key}-body)`}
                stroke="#fff"
                strokeWidth="1.5"
              />
              <path
                className={
                  kind === "spark" ? "agent-avatar-flame-highlight" : undefined
                }
                d={
                  kind === "ripple"
                    ? "M28 33c0-5 5-7 9-4m5-3c4 0 7 3 7 7"
                    : kind === "spark"
                      ? "M24 46C24 42 26 39 28 37M37 30C38 26 40 24 42 21"
                      : "M25 39c3-6 10-9 17-9"
                }
                stroke="#fff"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity=".7"
              />
              <g
                className="agent-avatar-gaze"
                stroke={ink}
                strokeWidth="3.5"
                strokeLinecap="round"
              >
                <g className="agent-avatar-eyes">
                  <g className="agent-avatar-eyes-rest">
                    {kind === "moss" || kind === "spark" ? (
                      <path d="m29 46 3-2 3 2M47 46l3-2 3 2" />
                    ) : (
                      <path d="M31 43v5M49 43v5" />
                    )}
                  </g>
                  <path
                    className="agent-avatar-eyes-smile"
                    d="m28 46 3-3 3 3m12 0 3-3 3 3"
                  />
                </g>
                <path
                  className="agent-avatar-mouth"
                  d="M36 53q4 4 8 0"
                  strokeWidth="2"
                />
                <g className="agent-avatar-cheeks" fill={tint} stroke="none">
                  <ellipse cx="26" cy="52" rx="3" ry="1.7" />
                  <ellipse cx="54" cy="52" rx="3" ry="1.7" />
                </g>
              </g>
              {kind === "orbit" && (
                <g className="agent-avatar-accessory">
                  <g transform="rotate(-14 40 51)">
                    <g clipPath={`url(#${key}-orbit-front)`}>
                      <use href={`#${key}-orbit-ring`} />
                    </g>
                  </g>
                </g>
              )}
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
