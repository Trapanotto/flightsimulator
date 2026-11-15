import type { ComponentChildren } from 'preact';

/**
 * Line icons on a 24 px grid, drawn for this interface: one stroke weight, round joins, and
 * `currentColor`, so they follow the text colour and every state for free.
 */
function Icon({ children, size = 20 }: { children: ComponentChildren; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconPause = (p: P) => (
  <Icon {...p}>
    <path d="M9 5v14M15 5v14" stroke-width="2.25" />
  </Icon>
);
export const IconPlay = (p: P) => (
  <Icon {...p}>
    <path d="M7.5 5.5v13l11-6.5z" fill="currentColor" stroke-width="1.5" />
  </Icon>
);
export const IconView = (p: P) => (
  <Icon {...p}>
    <path d="M3 8.5V6a2 2 0 0 1 2-2h2.5M16.5 4H19a2 2 0 0 1 2 2v2.5M21 15.5V18a2 2 0 0 1-2 2h-2.5M7.5 20H5a2 2 0 0 1-2-2v-2.5" />
    <circle cx="12" cy="12" r="3.25" />
  </Icon>
);
export const IconBack = (p: P) => (
  <Icon {...p}>
    <path d="M14.5 6 8.5 12l6 6" />
  </Icon>
);
export const IconClose = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const IconSettings = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);
export const IconGlobe = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5S9.6 6.1 12 3.5z" />
  </Icon>
);
export const IconPlane = (p: P) => (
  <Icon {...p}>
    <path d="M12 3c.9 0 1.4 1 1.4 2.4V9l7.1 4.1v2l-7.1-2.2v4.4l2.2 1.7v1.6L12 19.8l-3.6.8V19l2.2-1.7v-4.4L3.5 15.1v-2L10.6 9V5.4C10.6 4 11.1 3 12 3z" />
  </Icon>
);
export const IconRunway = (p: P) => (
  <Icon {...p}>
    <path d="M8 21 10 3M16 21 14 3M12 5v2.5M12 11v2.5M12 17v2.5" />
  </Icon>
);
export const IconClimb = (p: P) => (
  <Icon {...p}>
    <path d="M3 19h18M5 15.5 19 6M14 6h5v5" />
  </Icon>
);
export const IconRestart = (p: P) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
    <path d="M4 4v4.5h4.5" />
  </Icon>
);
export const IconExit = (p: P) => (
  <Icon {...p}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" />
  </Icon>
);
export const IconSun = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.75" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Icon>
);
export const IconFair = (p: P) => (
  <Icon {...p}>
    <path d="M9 3.5v1.5M3.5 9H5M5.1 5.1l1 1M12.9 5.1l-1 1" />
    <path d="M6.2 11.2A3.4 3.4 0 1 1 12 8" />
    <path d="M8 20h9.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6.6A3.2 3.2 0 0 0 8 20z" />
  </Icon>
);
export const IconCloud = (p: P) => (
  <Icon {...p}>
    <path d="M7 19h10.5a4 4 0 0 0 .5-8 6 6 0 0 0-11.6 1.2A3.4 3.4 0 0 0 7 19z" />
  </Icon>
);
export const IconOvercast = (p: P) => (
  <Icon {...p}>
    <path d="M9 9.5a5 5 0 0 1 9.4 1.3 3.3 3.3 0 0 1 .3 6.4" />
    <path
      d="M5.5 20.5h9a3.3 3.3 0 0 0 .4-6.6 4.8 4.8 0 0 0-9.2.7 3 3 0 0 0-.2 5.9z"
      fill="currentColor"
      fill-opacity="0.25"
    />
  </Icon>
);
export const IconLive = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.3 9.3 0 0 1 0-13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2" />
  </Icon>
);
export const IconClock = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
export const IconChevronUp = (p: P) => (
  <Icon {...p}>
    <path d="M6 14.5 12 8.5l6 6" />
  </Icon>
);
export const IconChevronDown = (p: P) => (
  <Icon {...p}>
    <path d="M6 9.5l6 6 6-6" />
  </Icon>
);
export const IconGear = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v6" />
    <circle cx="12" cy="15" r="5.5" />
    <circle cx="12" cy="15" r="1.75" />
  </Icon>
);
export const IconBrake = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M4.5 4.5 7 7M19.5 4.5 17 7" />
  </Icon>
);
export const IconSound = (p: P) => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Icon>
);
export const IconMute = (p: P) => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  </Icon>
);
/** Hochnebel: sunshine above a flat deck, grey below it. */
export const IconStratus = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="7" r="2.75" />
    <path d="M12 2v.8M7.2 4.2l.6.6M16.8 4.2l-.6.6M5.5 7h.8M17.7 7h.8" />
    <path d="M3 12.5h18M5 16h14M7.5 19.5h9" />
  </Icon>
);
/** Final approach: a glide path down to a runway threshold. */
export const IconApproach = (p: P) => (
  <Icon {...p}>
    <path d="M3 6.5 17 15" stroke-dasharray="2.2 2.2" />
    <path d="M14 19h7M4 19h4" />
    <path d="M17 15l1.5 4" />
  </Icon>
);
export const IconRadio = (p: P) => (
  <Icon {...p}>
    <path d="M5 13v-1a7 7 0 0 1 14 0v1" />
    <rect x="3.5" y="13" width="4" height="6" rx="1.5" />
    <rect x="16.5" y="13" width="4" height="6" rx="1.5" />
    <path d="M18.5 19v.5a2 2 0 0 1-2 2H13" />
  </Icon>
);
export const IconChecklist = (p: P) => (
  <Icon {...p}>
    <path d="M10 6.5h10M10 12h10M10 17.5h10" />
    <path d="M3.5 6.5l1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3" />
    <circle cx="5.5" cy="17.5" r="1.4" />
  </Icon>
);
/** The radio stack: two frequency windows. */
export const IconStack = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="6" rx="1.5" />
    <rect x="3" y="13" width="18" height="6" rx="1.5" />
    <path d="M6.5 8h5M6.5 16h5M16.5 8h1M16.5 16h1" />
  </Icon>
);
export const IconAutopilot = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h5l1.5-2.5 2 5 1.5-2.5h7" />
  </Icon>
);
export const IconSwitches = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="7" height="16" rx="3.5" />
    <circle cx="7" cy="8" r="2" />
    <rect x="13.5" y="4" width="7" height="16" rx="3.5" />
    <circle cx="17" cy="16" r="2" />
  </Icon>
);
export const IconTools = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Icon>
);
export const IconSwap = (p: P) => (
  <Icon {...p}>
    <path d="M4 8.5h15l-3.5-3.5M20 15.5H5l3.5 3.5" />
  </Icon>
);
export const IconPlus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);
export const IconMinus = (p: P) => (
  <Icon {...p}>
    <path d="M5.5 12h13" />
  </Icon>
);
/** The whole map again: four corners pointing out. */
export const IconExpand = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </Icon>
);
export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </Icon>
);
export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const IconSide = (p: P) => (
  <Icon {...p}>
    <path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5M3.5 12h17" />
  </Icon>
);
/** Two chevrons: a coarse step (flipped by CSS for the other way). */
export const IconFast = (p: P) => (
  <Icon {...p}>
    <path d="M12 6 6 12l6 6M18 6l-6 6 6 6" />
  </Icon>
);
export const IconRoute = (p: P) => (
  <Icon {...p}>
    <circle cx="6" cy="18" r="2.25" />
    <circle cx="18" cy="6" r="2.25" />
    <path d="M8 16.5c4-1 2-6 5.5-8.5" stroke-dasharray="2 2.2" />
  </Icon>
);
export const IconWarning = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </Icon>
);

// Phase 4: the kinds of aircraft, seen from above, and the levers they bring.
export const IconPiston = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.6c.8 0 1.2.8 1.2 1.8v2.8h7.3v2.4h-7.3v6.1l2.6 1v1.6H8.2v-1.6l2.6-1v-6.1H3.5V8.2h7.3V5.4c0-1 .4-1.8 1.2-1.8z" />
    <path d="M9.6 2.5h4.8" />
  </Icon>
);
export const IconTurboprop = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.4c.7 0 1.1.8 1.1 1.8v4l7.4 2.1v1.8l-7.4-.9v5.4l2.8 1.4v1.5H8.1V19l2.8-1.4v-5.4l-7.4.9v-1.8l7.4-2.1v-4c0-1 .4-1.8 1.1-1.8z" />
    <path d="M9.6 2.4h4.8" />
  </Icon>
);
export const IconAirliner = IconPlane;
export const IconFighter = (p: P) => (
  <Icon {...p}>
    <path d="M12 2.5l1.2 3.4.3 4.4 6.9 4.9v1.7l-6.9-1.7-.3 2.3 2.7 2v1.6L12 20.2l-3.9.9v-1.6l2.7-2-.3-2.3-6.9 1.7v-1.7l6.9-4.9.3-4.4z" />
  </Icon>
);
export const IconSpeedbrake = (p: P) => (
  <Icon {...p}>
    <path d="M3 16h18" />
    <path d="M7 16l4-6M13 16l4-6" />
  </Icon>
);
export const IconReverse = (p: P) => (
  <Icon {...p}>
    <path d="M19 12H6M10 7.5 5.5 12l4.5 4.5" />
  </Icon>
);

// Replay and photo mode.
export const IconReplay = (p: P) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M10.5 9.2v5.6l4.6-2.8z" fill="currentColor" stroke-width="1.25" />
  </Icon>
);
export const IconCamera = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5l1.6-2.2h5.8L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <circle cx="12" cy="12.8" r="3.4" />
  </Icon>
);
export const IconHide = (p: P) => (
  <Icon {...p}>
    <path d="M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6z" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M4.5 19.5 19.5 4.5" />
  </Icon>
);

/** A parachute canopy over a jumper: leaving the aircraft. */
export const IconParachute = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 10a8.5 6 0 0 1 17 0c-1.4-1-2.8-1-4.2 0-1.4-1-2.9-1-4.3 0-1.4-1-2.9-1-4.3 0-1.4-1-2.8-1-4.2 0z" />
    <path d="M3.5 10 11 17M20.5 10 13 17M12 10v7" />
    <circle cx="12" cy="19" r="1.6" />
  </Icon>
);

/** The icon of a kind of aircraft. */
export function CategoryIcon({ category, size }: { category: string; size?: number }) {
  switch (category) {
    case 'turboprop':
      return <IconTurboprop size={size} />;
    case 'airliner':
      return <IconAirliner size={size} />;
    case 'fighter':
      return <IconFighter size={size} />;
    default:
      return <IconPiston size={size} />;
  }
}
