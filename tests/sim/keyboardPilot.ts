/**
 * Landings flown as a keyboard gives them: all-or-nothing keys tapped in short bursts, the
 * rudder left to the app's helper (RudderFeet), as crudePilot.test.ts flies the take-offs.
 */
import { createAircraft } from '../../src/sim';
import type { FlightModel } from '../../src/sim/flightModel';
import { FLAPS, newFa18, setFuel } from './fa18Harness';
import { DEG, FT, KT, RudderFeet, SIM_DT, clamp } from './harness';
import {
  GLIDE_PATH,
  centreLineHeading,
  flyLanding,
  glidePathHeight,
  onFinal,
  runwayPosition,
  struts,
  type LandingFlight,
} from './landingProcedures';

const wrap = (deg: number) => ((deg + 540) % 360) - 180;

/**
 * A keyboard, as src/app/input.ts reads it: a held key drives its axis towards full travel
 * (times the key authority; roll keeps more of it) at 1.8 per second and a released one lets
 * it back at 2.6; the throttle keys move the lever at 0.45 per second.
 */
export class Keys {
  private pitch = 0;
  private roll = 0;
  private readonly key = { pitch: 0, roll: 0, throttle: 0 };
  private readonly until = { pitch: 0, roll: 0, throttle: 0 };
  constructor(private readonly ac: FlightModel) {}

  /** Holds a key (-1 or +1) of an axis for `seconds`. */
  tap(axis: 'pitch' | 'roll' | 'throttle', key: number, seconds: number) {
    this.key[axis] = key;
    this.until[axis] = this.ac.telemetry.time + seconds;
  }

  step(dt: number, authority: number) {
    const time = this.ac.telemetry.time;
    const c = this.ac.controls;
    for (const a of ['pitch', 'roll', 'throttle'] as const)
      if (time >= this.until[a]) this.key[a] = 0;
    const move = (v: number, target: number) => {
      const rate = (target === 0 ? 2.6 : 1.8) * dt;
      return v + clamp(target - v, -rate, rate);
    };
    this.pitch = move(this.pitch, this.key.pitch * authority);
    this.roll = move(this.roll, this.key.roll * (0.5 + 0.5 * authority));
    c.pitch = this.pitch;
    c.roll = this.roll;
    c.throttle.fill(clamp((c.throttle[0] ?? 0) + this.key.throttle * 0.45 * dt, 0, 1));
  }
}

/** The app's key authority for a turboprop (src/app/App.ts), from its landing stall speed. */
function turbopropAuthority(ac: FlightModel) {
  const { info, telemetry } = ac;
  const lo = 1.2 * info.vs0;
  const hi = 2.2 * info.vs0;
  return 0.6 * (1 - 0.65 * clamp((telemetry.ias - lo) / (hi - lo), 0, 1));
}

/** The crude pilot looks every `period` s and decides on a key. */
class Glance {
  private next = 0;
  constructor(private readonly period: number) {}
  due(time: number) {
    if (time < this.next) return false;
    this.next = time + this.period;
    return true;
  }
}

/** Wings towards the centre line: a roll key when the bank is 2° off the one wanted. */
function wings(f: LandingFlight, keys: Keys, seconds: number) {
  const t = f.ac.telemetry;
  const bank = clamp(0.03 * wrap(centreLineHeading(f) - t.trackDeg), -0.2, 0.2);
  if (t.bank < bank - 2 * DEG) keys.tap('roll', 1, seconds);
  else if (t.bank > bank + 2 * DEG) keys.tap('roll', -1, seconds);
}

/**
 * The PC-12 by keyboard: the yoke tapped when the path or the sink rate are well off, the
 * throttle when the speed is, power off at 50 ft, short pulls while it still sinks fast near
 * the ground, then both brakes and, with the nose wheel down, reverse.
 */
export function pc12KeyboardLanding(trace?: (f: LandingFlight, phase: string) => void) {
  const ac = createAircraft('pc12') as FlightModel;
  const f = onFinal(ac, 3, 85, { flaps: 1 });
  const t = ac.telemetry;
  const c = ac.controls;
  const keys = new Keys(ac);
  const feet = new RudderFeet(ac, 0);
  const power = new Glance(3);
  const look = new Glance(0.4);
  const lateral = new Glance(0.3);
  // Trimmed for 85 KIAS by the reset, as a keyboard pilot leaves it: less power takes it down
  // the path at that speed, and a tap of power more or less corrects the path.
  c.throttle.fill(0.6 * c.throttle[0]!);
  let phase: 'approach' | 'flare' | 'rollout' = 'approach';
  const rec = flyLanding(f, 240, (dt) => {
    trace?.(f, phase);
    const agl = t.agl ?? 100;
    if (phase !== 'rollout' && lateral.due(t.time)) wings(f, keys, 0.15);
    if (phase === 'approach') {
      if (power.due(t.time)) {
        const above = t.altitude - glidePathHeight(runwayPosition(f).along) - 2;
        if (above > 6 && t.verticalSpeed > -4) keys.tap('throttle', -1, 0.1);
        else if (above < -6 || t.verticalSpeed < -5) keys.tap('throttle', 1, 0.1);
      }
      if (agl < 50 * FT) phase = 'flare';
    } else if (phase === 'flare') {
      keys.tap('throttle', -1, 0.1);
      // From about 40 ft pulls, held a little longer, whenever it sinks faster than about
      // 250 ft/min, and near the runway to keep the nose up, unless it is already high.
      const low = t.verticalSpeed < -1.2 || (agl < 3 && t.pitch < 3 * DEG);
      if (agl < 12 && look.due(t.time) && low && t.pitch < 6 * DEG) keys.tap('pitch', 1, 0.3);
      if (t.onGround) phase = 'rollout';
    } else {
      c.reverse = struts(ac)[0]! > 0;
      keys.tap('throttle', c.reverse && t.ias / KT > 30 ? 1 : -1, 0.1);
      c.brakeLeft = c.brakeRight = 1;
    }
    keys.step(dt, turbopropAuthority(ac));
    feet.step(dt);
  });
  return rec.done();
}

/**
 * The F/A-18 by keyboard: in the powered approach the stick asks for angle of attack, so taps
 * of stick move the path at once (the FCS goes back to on-speed when they end) while the
 * automatic throttle keeps it on speed; the wings by taps, onto the runway without a flare,
 * then idle and both brakes, the nose wheel left to the helper at its gentle jet gain.
 */
export function fa18KeyboardLanding(trace?: (f: LandingFlight, phase: string) => void) {
  const ac = newFa18();
  const f = onFinal(ac, 3, 138, { flaps: FLAPS.full });
  setFuel(f, 15_000 - ac.def.mass);
  ac.controls.pitchTrim = 0;
  const t = ac.telemetry;
  const c = ac.controls;
  const keys = new Keys(ac);
  const feet = new RudderFeet(ac, 0, 0.15, false);
  const path = new Glance(1);
  const lateral = new Glance(0.3);
  let phase: 'approach' | 'rollout' = 'approach';
  // Power back from the level trim to about what a 3° path takes, and the automatic throttle
  // on: with the flaps down it holds on-speed angle of attack (the approach power
  // compensator). By throttle taps alone the held angle of attack turns each change of power
  // into a slow, lightly damped swing of speed and path that the taps keep feeding.
  c.throttle.fill(0.83 * c.throttle[0]!);
  ac.cockpit.set('athr', 1);
  ac.step(SIM_DT, f.env);
  ac.cockpit.set('athr', 0);
  const rec = flyLanding(f, 200, (dt) => {
    trace?.(f, phase);
    if (phase === 'approach') {
      if (lateral.due(t.time)) wings(f, keys, 0.1);
      // A tap and a look at what it did; down low the aircraft is left to fly onto the runway.
      if ((t.agl ?? 100) > 10 && path.due(t.time)) {
        const above = t.altitude - glidePathHeight(runwayPosition(f).along) - 2.5;
        const vsTarget = -t.groundSpeed * Math.tan(GLIDE_PATH) - clamp(0.1 * above, -1.5, 1.5);
        if (t.verticalSpeed < vsTarget - 1) keys.tap('pitch', 1, 0.4);
        else if (t.verticalSpeed > vsTarget + 1) keys.tap('pitch', -1, 0.4);
      }
      if (t.onGround) phase = 'rollout';
    } else {
      keys.tap('throttle', -1, 0.1);
      c.brakeLeft = c.brakeRight = 1;
    }
    keys.step(dt, 1);
    feet.step(dt);
  });
  return rec.done();
}
