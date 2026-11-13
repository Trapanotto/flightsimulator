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
export const IconArrowRight = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
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
export const IconHangar = (p: P) => (
  <Icon {...p}>
    <path d="M3 20V10.5C3 8 7 5 12 5s9 3 9 5.5V20M7 20v-6h10v6" />
  </Icon>
);
export const IconSchool = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 9.5 12 5l9.5 4.5L12 14z" />
    <path d="M6.5 11.6V16c1.5 1.4 3.5 2 5.5 2s4-.6 5.5-2v-4.4M21.5 9.5V15" />
  </Icon>
);
export const IconLogbook = (p: P) => (
  <Icon {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
    <path d="M9 7.5h6M9 11h4" />
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
export const IconWarning = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </Icon>
);
