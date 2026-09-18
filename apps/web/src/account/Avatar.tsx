import { initials } from "./model";
import type { User } from "@supabase/supabase-js";

// Original vector artwork bundled with the app. Profiles store only a preset ID.
export const avatars = [
  {
    id: "cloud",
    name: "Cloud",
    sky: "#d9e7ed",
    ink: "#6b91a6",
    light: "#f8fbf8",
  },
  { id: "sun", name: "Sun", sky: "#f2e6cd", ink: "#c89351", light: "#fff4d7" },
  {
    id: "moon",
    name: "Moon",
    sky: "#dcdfea",
    ink: "#7c83a6",
    light: "#f5f1dc",
  },
  {
    id: "fern",
    name: "Fern",
    sky: "#e0e8d9",
    ink: "#758d6d",
    light: "#f5f5e9",
  },
  { id: "fox", name: "Fox", sky: "#efdfd5", ink: "#b47f63", light: "#fff3e2" },
  {
    id: "moth",
    name: "Moth",
    sky: "#e5deea",
    ink: "#9a82a0",
    light: "#faf0ed",
  },
  {
    id: "wave",
    name: "Wave",
    sky: "#d6e7e4",
    ink: "#6d9b98",
    light: "#f0f6ea",
  },
  {
    id: "mountain",
    name: "Mountain",
    sky: "#e0e5e8",
    ink: "#7f979f",
    light: "#f8f4e8",
  },
] as const;
export type AvatarId = (typeof avatars)[number]["id"];
export type AvatarSelection = AvatarId | "initials";
export function avatarId(
  user: Pick<User, "id" | "user_metadata">,
): AvatarSelection {
  if (user.user_metadata?.avatar_id === "initials") return "initials";
  const selected = avatars.find((a) => a.id === user.user_metadata?.avatar_id);
  if (selected) return selected.id;
  let hash = 0;
  for (const c of user.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return avatars[hash % avatars.length].id;
}
export function shuffledAvatar(current: AvatarSelection): AvatarId {
  const options = avatars.filter((a) => a.id !== current);
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return options[value % options.length].id;
}
export function Avatar({
  user,
  value,
  large = false,
}: {
  user: Pick<User, "id" | "user_metadata">;
  value?: AvatarSelection;
  large?: boolean;
}) {
  const selection = value ?? avatarId(user);
  if (selection === "initials")
    return (
      <span
        className={`account-avatar initials-avatar${large ? " account-avatar-large" : ""}`}
        aria-hidden="true"
      >
        {initials(user)}
      </span>
    );
  const art = avatars.find((a) => a.id === selection)!;
  return (
    <span
      className={`account-avatar artwork-avatar${large ? " account-avatar-large" : ""}`}
    >
      <svg
        className="size-full"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="32" cy="32" r="32" fill={art.sky} />
        <g
          transform="translate(32 32) scale(.78) translate(-32 -32)"
          fill={art.ink}
          stroke={art.ink}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {art.id === "cloud" && (
            <g transform="translate(0 4)">
              <path
                d="M18 40c-9 0-10-13-1-15 1-12 19-13 22-1 13-1 16 16 3 16Z"
                transform="translate(1 2)"
                opacity=".18"
                stroke="none"
              />
              <path
                d="M18 40c-9 0-10-13-1-15 1-12 19-13 22-1 13-1 16 16 3 16Z"
                fill={art.light}
                stroke="none"
              />
            </g>
          )}
          {art.id === "sun" && (
            <>
              <circle cx="32" cy="32" r="13" fill={art.light} strokeWidth="4" />
              <path d="M32 9v5m0 36v5M9 32h5m36 0h5M16 16l4 4m24 24 4 4M16 48l4-4m24-24 4-4" />
            </>
          )}
          {art.id === "moon" && (
            <>
              <path
                d="M38 13A21 21 0 1 0 52 41C28 47 21 25 38 13Z"
                fill={art.light}
                stroke="none"
              />
              <path
                d="m47 17 1.5 4.5L53 23l-4.5 1.5L47 29l-1.5-4.5L41 23l4.5-1.5Z"
                stroke="none"
              />
            </>
          )}
          {art.id === "fern" && (
            <>
              <path d="M30 53 35 12" fill="none" />
              <path
                d="M33 27C17 27 16 15 19 12c9 0 14 6 14 15Zm-1 13c-17 0-20-9-19-14 11-2 17 4 19 14Zm2-17c14 0 17-8 16-13-9 0-15 5-16 13Zm-1 15c16 0 20-9 18-14-10 0-16 6-18 14Z"
                stroke="none"
              />
            </>
          )}
          {art.id === "fox" && (
            <>
              <path d="m11 13 16 8h10l16-8-3 28-18 13-18-13Z" stroke="none" />
              <path
                d="m15 33 17 10 17-10-6 14-11 7-11-7Z"
                fill={art.light}
                stroke="none"
              />
              <path
                d="m17 20 6 4-7 4Zm30 0-6 4 7 4Z"
                fill={art.light}
                stroke="none"
              />
              <path d="m29 42 3 3 3-3" fill="#435763" stroke="#435763" />
              <path d="M23 34h1m16 0h1" stroke="#435763" strokeWidth="3" />
            </>
          )}
          {art.id === "moth" && (
            <>
              <path
                d="M30 28C18 10 7 18 12 35l15 6c-13 0-8 16 5 8 13 8 18-8 5-8l15-6c5-17-6-25-18-7Z"
                stroke="none"
              />
              <path d="M32 25v24m-1-25-5-8m7 8 5-8" stroke={art.light} />
              <circle cx="20" cy="30" r="4" fill={art.light} stroke="none" />
              <circle cx="44" cy="30" r="4" fill={art.light} stroke="none" />
            </>
          )}
          {art.id === "wave" && (
            <g transform="translate(0 -5)">
              <path
                d="M5 42c13 5 11-21 29-23 14-2 21 12 12 17 4-14-16-12-11 2 3 8 12 10 24 6v13H5Z"
                stroke="none"
              />
              <path
                d="M9 45c10 5 15-6 23-4m-21 10c13 3 24-3 37 0"
                stroke={art.light}
              />
            </g>
          )}
          {art.id === "mountain" && (
            <>
              <circle cx="44" cy="18" r="7" fill={art.light} stroke="none" />
              <path d="M3 52 24 17l20 35Z" stroke="none" />
              <path d="m24 17-8 14 8-4 8 4Z" fill={art.light} stroke="none" />
              <path d="m29 52 17-27 17 27Z" opacity=".65" stroke="none" />
            </>
          )}
        </g>
      </svg>
    </span>
  );
}
