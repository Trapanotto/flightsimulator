/**
 * Fakes for the interface demo beyond the flight itself: the replay and the photo mode (from
 * the pause menu), and the pilot outside the aircraft.
 *
 * URL switches:
 *   screen=replay|photo   noreplay
 *   pilot=freefall|low|canopy|walk|enter|lost   the pilot outside, frozen in that state
 */
import { type UiActions, game } from '@ui';

let replayTimer = 0;
let pilotTimer = 0;
let replayFrom: 'paused' | 'flight' = 'paused';
let photoFrom: 'paused' | 'flight' | 'replay' = 'paused';

function startReplayClock() {
  clearInterval(replayTimer);
  replayTimer = window.setInterval(() => {
    const r = game.replay.value;
    if (!r || !r.playing) return;
    const time = Math.min(r.end, r.time + 0.1 * r.speed);
    game.replay.value = { ...r, time, playing: time < r.end };
  }, 100);
}

const PILOT = {
  freefall: { state: 'freefall', agl: 1840, speed: 31, verticalSpeed: -53, canEnter: false },
  low: { state: 'freefall', agl: 430, speed: 30, verticalSpeed: -53, canEnter: false },
  canopy: { state: 'canopy', agl: 212, speed: 9.5, verticalSpeed: -4.8, canEnter: false },
  walk: { state: 'walk', agl: 0, speed: 1.4, verticalSpeed: 0, canEnter: false },
  enter: { state: 'walk', agl: 0, speed: 0, verticalSpeed: 0, canEnter: true },
  lost: { state: 'walk', agl: 0, speed: 0, verticalSpeed: 0, canEnter: false },
} as const;

/** Adds the actions and fills the signals; `still` keeps the pilot where the URL put it. */
export function installExtras(actions: UiActions, q: URLSearchParams) {
  game.canReplay.value = !q.has('noreplay');
  actions.openReplay = () => {
    replayFrom = game.screen.value === 'flight' ? 'flight' : 'paused';
    game.replay.value = { time: 120, start: 0, end: 754, playing: true, speed: 1 };
    game.screen.value = 'replay';
    startReplayClock();
  };
  actions.closeReplay = () => {
    clearInterval(replayTimer);
    game.replay.value = null;
    game.screen.value = replayFrom;
  };
  actions.replaySeek = (time) => {
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, time };
  };
  actions.replayPlay = (playing) => {
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, playing };
  };
  actions.replaySpeed = (speed) => {
    const r = game.replay.value;
    if (r) game.replay.value = { ...r, speed };
  };
  actions.openPhoto = () => {
    const s = game.screen.value;
    photoFrom = s === 'replay' ? 'replay' : s === 'flight' ? 'flight' : 'paused';
    game.photo.value = { fov: 50, roll: 0, time: 15.5, aircraft: true };
    game.screen.value = 'photo';
  };
  actions.closePhoto = () => {
    game.photo.value = null;
    game.screen.value = photoFrom;
  };
  actions.photoSet = (patch) => {
    const p = game.photo.value;
    if (p) game.photo.value = { ...p, ...patch };
  };
  actions.photoSave = () => console.info('photoSave');

  // Leaving the aircraft: a jump in flight falls until the chute is pulled; on the ground
  // the pilot stands beside the aircraft and X gets back in.
  actions.leaveAircraft = () => {
    const p = game.pilot.value;
    if (p) {
      if (p.canEnter) {
        clearInterval(pilotTimer);
        game.pilot.value = null;
      }
      return;
    }
    const tel = game.telemetry.value;
    const onGround = tel?.onGround ?? true;
    game.pilot.value = {
      ...(onGround ? PILOT.enter : PILOT.freefall),
      agl: onGround ? 0 : (tel?.agl ?? 1500),
      headingDeg: tel?.headingDeg ?? 140,
      aircraftLost: false,
    };
    if (!onGround) fall();
  };
  actions.pullChute = () => {
    const p = game.pilot.value;
    if (p?.state === 'freefall') game.pilot.value = { ...p, state: 'canopy', verticalSpeed: -5 };
  };
}

function fall() {
  clearInterval(pilotTimer);
  pilotTimer = window.setInterval(() => {
    const p = game.pilot.value;
    if (!p || game.screen.value !== 'flight') return;
    // Only the pilot opens the chute: a fall without it ends on the ground, hard.
    const state = p.state;
    const verticalSpeed = state === 'freefall' ? -53 : -4.8;
    const agl = Math.max(0, p.agl + verticalSpeed * 0.1);
    if (agl <= 0) {
      clearInterval(pilotTimer);
      game.pilot.value = { ...p, ...PILOT.walk, aircraftLost: true, agl: 0 };
      return;
    }
    game.pilot.value = { ...p, state, agl, verticalSpeed };
  }, 100);
}

/** Opens what the URL asks for, after the demo's own screens are set up. */
export function openExtras(q: URLSearchParams, actions: UiActions) {
  const screen = q.get('screen');
  if (screen === 'replay') actions.openReplay?.();
  if (screen === 'photo') actions.openPhoto?.();
  const pilot = q.get('pilot') as keyof typeof PILOT | null;
  if (pilot && PILOT[pilot]) {
    game.pilot.value = {
      ...PILOT[pilot],
      headingDeg: 214,
      aircraftLost: pilot === 'lost',
    };
    if (pilot === 'lost') {
      const tel = game.telemetry.value;
      if (tel) game.telemetry.value = { ...tel, crashed: 'terrain' };
    }
  }
}
