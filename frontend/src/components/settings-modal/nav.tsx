import type { Section } from "./types";

// ---------------------------------------------------------------------------
// Nav sections
// ---------------------------------------------------------------------------

export const SECTIONS: Section[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {/* Two overlapping rounded panes — reads as stacked app windows. */}
        <rect x="3" y="4" width="13" height="13" rx="2.5" />
        <rect x="8" y="7" width="13" height="13" rx="2.5" />
      </svg>
    ),
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    ),
  },
  {
    id: "harnesses",
    label: "Harnesses",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3h6M9 21h6M3 9v6M21 9v6" />
        <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
      </svg>
    ),
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {/* git-branch-ish icon: two nodes connected by a curve. */}
        <circle cx="6" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="8" r="2" />
        <path d="M6 8v8" />
        <path d="M18 10c0 4-4 4-6 4H8" />
      </svg>
    ),
  },
  {
    id: "updates",
    label: "Updates",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
        <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
        <polyline points="21 3 21 8 16 8" />
        <polyline points="3 21 3 16 8 16" />
      </svg>
    ),
  },
];
