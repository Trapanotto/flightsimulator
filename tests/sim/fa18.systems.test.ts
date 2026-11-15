/**
 * The Hornet's engines, its own systems and its flight guidance: the F404's spool and
 * afterburner, fuel flows, idle thrust, the APU and crank start in checklist order,
 * generators and hydraulics, fuel dump and bingo, the environmental system and oxygen,
 * canopy, hook, nosewheel steering, the head-up display data, TACAN, and the autopilot and
 * automatic throttle control.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT, type NavStation } from '../../src/sim';
import { destination } from '../../src/sim/avionics/geo';
import { FA18_FCS } from '../../src/sim/fa18/fcs';
import { cabinAltitudeFor } from '../../src/sim/fa18/systems';
import { tacanChannel, tacanFrequency } from '../../src/sim/fa18/tacan';
import { isa } from '../../src/sim/atmosphere';
import { DEG, FT, KT, Pid, fly, headingError } from './harness';
import {
  FLAPS,
  fa18Airborne,
  fa18OnGround,
  fa18Systems,
  hud,
  type Fa18Flight,
} from './fa18Harness';
import { HornetPilot } from './fa18Procedures';

const LAT = 46.91;
const LON = 7.5;

/** Presses a button for one step, as a finger on the panel does. */
function press(f: Fa18Flight, id: string) {
  f.ac.cockpit.set(id, 1);
  f.ac.step(SIM_DT, f.env);
  f.ac.cockpit.set(id, 0);
  f.ac.step(SIM_DT, f.env);
}

const ap = (f: Fa18Flight) => f.ac.telemetry.avionics!.autopilot;

describe('F404 engines', () => {
  it('spools from idle to military power in about 4 s and lights the afterburner at once', () => {
    const f = fa18OnGround();
    const { ac } = f;
    const t = ac.telemetry;
    const e = t.engines[0]!;
    expect(e.n2).toBeCloseTo(70, 0);
    // Open at idle, closed at military, wide open in full afterburner.
    expect(e.nozzle).toBeCloseTo(0.78, 2);
    ac.controls.parkingBrake = true;
    ac.controls.throttle.fill(0.75);
    const rated =
      ac.def.engines[0]!.kind === 'afterburning' ? ac.def.engines[0]!.engine.ratedThrust : 0;
    let t90 = NaN;
    fly(f, 8, () => {
      if (Number.isNaN(t90) && ac.engines[0]!.thrust > 0.9 * rated) t90 = t.time;
    });
    expect(t90).toBeGreaterThan(2.5);
    expect(t90).toBeLessThan(4.5);
    expect(e.nozzle).toBeLessThan(0.15);
    expect(e.afterburner).toBe(0);
    // Military power: about 3700 kg/h per engine at sea level static.
    expect(Math.abs((e.fuelFlow * 3600) / 3700 - 1)).toBeLessThan(0.05);
    expect(Math.abs(ac.engines[0]!.thrust / rated - 1)).toBeLessThan(0.02);
    ac.controls.throttle.fill(0.85);
    fly(f, 3);
    // A partial afterburner stage: part of the extra thrust, part of the extra fuel.
    expect(e.afterburner).toBeCloseTo(0.4, 1);
    const partial = ac.engines[0]!.thrust;
    ac.controls.throttle.fill(1);
    fly(f, 3);
    expect(e.afterburner).toBe(1);
    expect(e.nozzle).toBeCloseTo(1, 2);
    expect(ac.engines[0]!.thrust).toBeGreaterThan(partial);
    // 17 750 lbf, more than 17 000 kg/h of fuel.
    expect(Math.abs(ac.engines[0]!.thrust / (17_750 * 4.448222) - 1)).toBeLessThan(0.03);
    expect(e.fuelFlow * 3600).toBeGreaterThan(17_000);
    expect(e.turbineTemperature).toBeGreaterThan(850);
  });

  it('taxis by itself at idle thrust', () => {
    const f = fa18OnGround();
    f.ac.controls.parkingBrake = false;
    fly(f, 30);
    expect(f.ac.telemetry.groundSpeed / KT).toBeGreaterThan(8);
    expect(f.ac.telemetry.groundSpeed / KT).toBeLessThan(30);
    // The brakes hold it.
    f.ac.controls.brakeLeft = 1;
    f.ac.controls.brakeRight = 1;
    fly(f, 10);
    expect(f.ac.telemetry.groundSpeed).toBeLessThan(0.3);
  });

  it('starts cold by the cockpit controls in checklist order: battery, APU, crank right, then left', () => {
    const f = fa18OnGround({ enginesRunning: false });
    const { ac } = f;
    const t = ac.telemetry;
    const c = ac.cockpit;
    expect(t.engines.every((e) => !e.running)).toBe(true);
    c.set('canopy', 2);
    c.set('battery', 1);
    // Cranking needs the APU's air.
    c.set('engineCrank', 2);
    fly(f, 2);
    expect(t.engines[1]!.n2).toBeLessThan(1);
    c.set('apu', 1);
    fly(f, 18);
    expect(hud(f).apu).toBe('ready');
    c.set('engineCrank', 2);
    let lit = NaN;
    fly(f, 60, () => {
      const n2 = t.engines[1]!.n2!;
      // Throttle to IDLE at 15 % N2 minimum.
      if (n2 >= 15 && c.get('fuelCutoff2') === 0) c.set('fuelCutoff2', 1);
      if (Number.isNaN(lit) && t.engines[1]!.running) lit = t.time;
    });
    expect(t.engines[1]!.running).toBe(true);
    expect(t.engines[1]!.n2).toBeCloseTo(70, 0);
    // The crank switch dropped back to OFF by itself.
    expect(c.get('engineCrank')).toBe(1);
    expect(ac.systems.electrical.generatorOnline[1]).toBe(1);
    expect(hud(f).cautions).toContain('L GEN');
    c.set('engineCrank', 0);
    fly(f, 60, () => {
      if (t.engines[0]!.n2! >= 15 && c.get('fuelCutoff1') === 0) c.set('fuelCutoff1', 1);
    });
    expect(t.engines[0]!.running).toBe(true);
    expect(ac.systems.telemetry.hydraulics!.every((p) => p > 2900)).toBe(true);
    expect(hud(f).cautions).not.toContain('L GEN');
    expect(hud(f).cautions).not.toContain('HYD 1');
    expect(hud(f).cautions).not.toContain('CANOPY');
    // The APU runs on a minute after both generators are on line, then stops by itself.
    fly(f, 30);
    expect(hud(f).apu).toBe('off');
    expect(c.get('apu')).toBe(0);
    // About half a minute from crank to idle per engine.
    expect(lit).toBeGreaterThan(22);
    expect(lit).toBeLessThan(50);
  }, 30_000);

  it('cuts the fuel with the throttle round the horn: the engine stops, its generator and pump go', () => {
    const f = fa18Airborne(4000, 350);
    const { ac } = f;
    ac.cockpit.set('fuelCutoff1', 0);
    fly(f, 20);
    expect(ac.telemetry.engines[0]!.running).toBe(false);
    expect(hud(f).cautions).toEqual(expect.arrayContaining(['L ENG OUT', 'L GEN']));
    // HYD 1 bleeds down slowly; HYD 2 and the right engine carry on.
    expect(ac.telemetry.engines[1]!.running).toBe(true);
    expect(ac.systems.telemetry.hydraulics![1]).toBeGreaterThan(2900);
  });
});

describe('F/A-18 systems', () => {
  it('dumps fuel down to the bingo setting and shows BINGO below it', () => {
    const f = fa18Airborne(5000, 350);
    const { ac } = f;
    const c = ac.cockpit;
    c.set('bingo', 3500);
    const before = ac.systems.fuel.total;
    c.set('fuelDump', 1);
    fly(f, 30);
    // About 7.5 kg/s with the engines' own burn on top.
    const rate = (before - ac.systems.fuel.total) / 30;
    expect(rate).toBeGreaterThan(7.5);
    expect(rate).toBeLessThan(10);
    expect(hud(f).advisories).toContain('DUMP');
    fly(f, 240);
    expect(ac.systems.fuel.total).toBeLessThan(3500);
    expect(ac.systems.fuel.total).toBeGreaterThan(3300);
    expect(hud(f).fuelDumping).toBe(false);
    // The feed tanks were kept.
    expect(ac.systems.fuel.amount[0]).toBeGreaterThan(ac.systems.fuel.amount[2]!);
    expect(hud(f).bingo).toBe(true);
    expect(hud(f).cautions).toContain('BINGO');
  }, 30_000);

  it('holds the cabin at 8000 ft up to 23 000 ft and 5 psi above, with OBOGS oxygen', () => {
    expect(cabinAltitudeFor(isa(5000 * FT).pressure) / FT).toBeCloseTo(5000, -1);
    expect(cabinAltitudeFor(isa(20_000 * FT).pressure) / FT).toBeCloseTo(8000, -1);
    const f = fa18Airborne(40_000 * FT, 480);
    fly(f, 1);
    const cabin = fa18Systems(f).cabinAltitude / FT;
    // 5 psi on the 2.7 psi outside at FL400: about 17 000 ft.
    expect(cabin).toBeGreaterThan(15_000);
    expect(cabin).toBeLessThan(19_000);
    expect(hud(f).oxygen).toBe(true);
    f.ac.cockpit.set('cabinPressure', 1);
    fly(f, 1);
    expect(fa18Systems(f).cabinAltitude / FT).toBeGreaterThan(39_000);
    expect(hud(f).cautions).toContain('CABIN ALT');
    f.ac.cockpit.set('oxygen', 0);
    fly(f, 1);
    expect(hud(f).cautions).toContain('OBOGS');
  });

  it('opens and closes the canopy, lowers the hook, and steers the nose wheel at two gains', () => {
    const f = fa18OnGround();
    const { ac } = f;
    const c = ac.cockpit;
    c.set('canopy', 0);
    fly(f, 7);
    expect(hud(f).canopy).toBe(0);
    expect(hud(f).cautions).toContain('CANOPY');
    c.set('canopy', 2);
    fly(f, 7);
    expect(hud(f).canopy).toBe(1);
    c.set('hook', 1);
    fly(f, 3);
    expect(hud(f).hook).toBe(1);
    expect(hud(f).advisories).toContain('HOOK');
    // Taxiing at a walking pace: full pedal turns tighter with the NWS button held (high gain).
    const yawRate = (high: boolean) => {
      const g = fa18OnGround();
      g.ac.controls.parkingBrake = false;
      fly(g, 5);
      let r = 0;
      fly(g, 4, () => {
        g.ac.controls.yaw = 1;
        g.ac.cockpit.set('nosewheelSteering', high ? 1 : 0);
        r = g.ac.state.angularVelocity.z;
      });
      return { r, mode: hud(g).nosewheelSteering };
    };
    const low = yawRate(false);
    const high = yawRate(true);
    expect(low.mode).toBe('low');
    expect(high.mode).toBe('high');
    // At a walking pace the high gain's 75° are limited by the nose tyre's grip.
    expect(high.r).toBeGreaterThan(1.15 * low.r);
    expect(low.r).toBeGreaterThan(1 * DEG);
    // The paddle switch disengages it.
    press(f, 'apDisconnect');
    expect(ac.steeringScale).toBe(0);
    expect(hud(f).nosewheelSteering).toBe('off');
    press(f, 'nosewheelSteering');
    expect(hud(f).nosewheelSteering).toBe('low');
  }, 30_000);

  it('fills the head-up display: velocity vector, AoA, g and peak g, Mach, radar altitude, bank', () => {
    const f = fa18Airborne(300, 400, { heading: 90, wind: { fromDeg: 0, speed: 15 } });
    const { ac } = f;
    const t = ac.telemetry;
    fly(f, 1);
    const h = hud(f);
    expect(h.mach).toBeCloseTo(t.mach!, 6);
    expect(h.alpha).toBe(t.alpha);
    // Wind from the north on an easterly heading: the velocity vector drifts right.
    expect(h.drift).toBeGreaterThan(1 * DEG);
    expect(h.drift).toBeLessThan(5 * DEG);
    expect(h.radarAltitude).toBeDefined();
    expect(Math.abs(h.radarAltitude! - 300)).toBeLessThan(5);
    expect(h.radarAltitudeShown).toBe(false);
    ac.cockpit.set('hudAltitude', 1);
    fly(f, 0.1);
    expect(h.radarAltitudeShown).toBe(true);
    expect(h.gear).toBe('up');
    expect(h.flapMode).toBe('auto');
    expect(h.fcsMode).toBe('ua');
    expect(h.onSpeed).toBeUndefined();
    const pilot = new HornetPilot(f);
    fly(f, 4, (dt) => {
      ac.controls.pitch = 0.5;
      pilot.bankTo(0, dt);
    });
    expect(h.peakG).toBeGreaterThan(3);
    expect(h.peakG).toBeGreaterThanOrEqual(h.g);
    expect(Math.abs(h.flightPath - Math.atan2(t.verticalSpeed, t.groundSpeed))).toBeLessThan(1e-9);
    // MASTER CAUTION resets the peak.
    ac.controls.pitch = 0;
    fly(f, 3);
    press(f, 'masterCaution');
    expect(h.peakG).toBeLessThan(2);
    expect(Math.abs(h.bank - t.bank)).toBeLessThan(1e-9);
    expect(h.gLimit).toBeCloseTo((7.5 * FA18_FCS.designMass) / ac.mass, 1);
    expect(h.fuel).toBeCloseTo(ac.systems.fuel.total, 6);
  });
});

describe('F/A-18 TACAN and flight guidance', () => {
  it('pairs TACAN channels with their VHF frequencies (ICAO Annex 10)', () => {
    expect(tacanFrequency(17)).toBe(108_000);
    expect(tacanFrequency(59)).toBe(112_200);
    expect(tacanFrequency(70)).toBe(112_300);
    expect(tacanFrequency(126)).toBe(117_900);
    expect(tacanFrequency(1)).toBeUndefined();
    expect(tacanFrequency(65)).toBeUndefined();
    for (let ch = 17; ch <= 126; ch++) {
      const fr = tacanFrequency(ch);
      if (fr !== undefined) expect(tacanChannel(fr)).toBe(ch);
    }
  });

  it('steers to a TACAN station: bearing and range on the HUD, coupled steering on its course', () => {
    // A VOR-DME on 113.20 MHz (channel 79X) 30 NM north.
    const at = destination(LAT, LON, 0, 30 * 1852, { lat: 0, lon: 0 });
    const station: NavStation = {
      ident: 'TCN',
      name: 'Test VORTAC',
      type: 'VOR-DME',
      frequency: 113_200,
      lon: at.lon,
      lat: at.lat,
      elevation: 500,
      rangeNm: 150,
      dme: { lon: at.lon, lat: at.lat, elevation: 500 },
    };
    const f = fa18Airborne(6000, 400, { heading: 60 });
    const { ac } = f;
    ac.avionics.setDatabase({ onFrequency: (fr) => (fr === station.frequency ? [station] : []) });
    ac.cockpit.set('navSource', 2);
    ac.cockpit.set('tacanChannel', tacanChannel(113_200)!);
    // Inbound on the 360° course.
    ac.cockpit.set('obs1', 0);
    fly(f, 3);
    const h = hud(f);
    expect(h.steering.source).toBe('tacan');
    expect(h.steering.valid).toBe(true);
    expect(Math.abs(headingError(0, h.steering.bearing!))).toBeLessThan(5);
    expect(Math.abs(h.steering.rangeNm! - 30)).toBeLessThan(2);
    press(f, 'apEngage');
    press(f, 'apNav');
    expect(ap(f).lateral).toBe('nav');
    expect(ap(f).annunciations).toContain('CPL TCN');
    fly(f, 180);
    expect(Math.abs(headingError(0, ac.telemetry.headingDeg))).toBeLessThan(10);
    expect(Math.abs(ac.telemetry.avionics!.nav2.deviation)).toBeLessThan(0.15);
  }, 30_000);

  it('holds attitude, selects a heading, holds baro and radar altitude, disconnects with the paddle', () => {
    const f = fa18Airborne(5000, 420, { heading: 0 });
    const { ac } = f;
    const t = ac.telemetry;
    press(f, 'apEngage');
    expect(ap(f).engaged).toBe(true);
    expect(ap(f).annunciations).toContain('ATT');
    const h0 = t.altitude;
    fly(f, 30);
    expect(Math.abs(t.altitude - h0)).toBeLessThan(30);
    expect(Math.abs(headingError(0, t.headingDeg))).toBeLessThan(2);
    // Heading select.
    ac.cockpit.set('headingBug', 90);
    press(f, 'apHdg');
    expect(ap(f).annunciations).toContain('HSEL');
    let maxBank = 0;
    fly(f, 100, () => {
      maxBank = Math.max(maxBank, Math.abs(t.bank));
    });
    expect(Math.abs(headingError(90, t.instruments!.heading))).toBeLessThan(3);
    expect(maxBank).toBeLessThan(33 * DEG);
    // Baro altitude: a disturbance is flown back out.
    press(f, 'apAlt');
    expect(ap(f).annunciations).toContain('BALT');
    const hold = t.instruments!.altitude;
    let worst = 0;
    fly(f, 60, () => {
      worst = Math.max(worst, Math.abs(t.instruments!.altitude - hold));
    });
    expect(worst).toBeLessThan(25);
    // Paddle: off, with the warning.
    press(f, 'apDisconnect');
    expect(ap(f).engaged).toBe(false);
    expect(ap(f).disconnectWarning).toBe(true);
    // Radar altitude over flat ground at 500 ft.
    const g = fa18Airborne(500 * FT, 420);
    press(g, 'apEngage');
    press(g, 'apRadarAlt');
    expect(ap(g).annunciations).toContain('RALT');
    const ra0 = g.ac.telemetry.agl!;
    let worstRa = 0;
    fly(g, 60, () => {
      worstRa = Math.max(worstRa, Math.abs(g.ac.telemetry.agl! - ra0));
    });
    expect(worstRa).toBeLessThan(10);
    // A firm stick input disconnects; and with the flaps down it will not engage.
    g.ac.controls.pitch = 0.6;
    fly(g, 0.5);
    expect(ap(g).engaged).toBe(false);
    g.ac.controls.pitch = 0;
  }, 30_000);

  it('steers along the GPS flight plan (CPL WYPT)', () => {
    const wp1 = destination(LAT, LON, 90, 25 * 1852, { lat: 0, lon: 0 });
    const wp2 = destination(wp1.lat, wp1.lon, 90, 40 * 1852, { lat: 0, lon: 0 });
    const f = fa18Airborne(7000, 450, { heading: 30 });
    const { ac } = f;
    ac.avionics.setFlightPlan([
      { ident: 'A', ...wp1 },
      { ident: 'B', ...wp2 },
    ]);
    ac.cockpit.set('navSource', 1);
    fly(f, 1);
    expect(hud(f).steering.source).toBe('wypt');
    expect(hud(f).steering.valid).toBe(true);
    expect(hud(f).steering.minutes).toBeGreaterThan(1);
    press(f, 'apEngage');
    press(f, 'apNav');
    expect(ap(f).annunciations).toContain('CPL WYPT');
    fly(f, 150);
    const gps = ac.telemetry.avionics!.gps;
    expect(Math.abs(gps.crossTrackNm!)).toBeLessThan(1);
    expect(
      Math.abs(headingError(gps.desiredTrack!, ac.telemetry.instruments!.heading)),
    ).toBeLessThan(10);
  }, 30_000);

  it('holds the airspeed with the ATC up and away, and the on-speed angle of attack in the approach', () => {
    const f = fa18Airborne(4000, 380);
    const { ac } = f;
    const t = ac.telemetry;
    const pilot = new HornetPilot(f);
    press(f, 'athr');
    expect(ap(f).autothrottle?.engaged).toBe(true);
    const v0 = t.ias;
    let worst = 0;
    fly(f, 60, (dt) => {
      // A 45° bank turn: the ATC adds the thrust.
      pilot.bankTo(t.time < 40 ? 45 * DEG : 0, dt);
      pilot.flyGamma(0, dt, t.time < 40 ? 1 / Math.cos(45 * DEG) - 1 : 0);
      if (t.time > 10) worst = Math.max(worst, Math.abs(t.ias - v0));
    });
    expect(worst / KT).toBeLessThan(8);
    expect(ap(f).annunciations).toContain('ATC');
    const g = fa18Airborne(600, 150, { flaps: FLAPS.full, gearDown: true });
    g.ac.controls.pitchTrim = 0;
    press(g, 'athr');
    const pa = new HornetPilot(g);
    const path = new Pid(0.8, 0.15, 0, 0.3);
    fly(g, 60, (dt) => {
      // The pilot flies the glide path with the stick (angle of attack), the ATC the speed.
      pa.heading(0, dt);
      g.ac.controls.pitch = path.update(-3 * DEG - pa.gamma, dt);
    });
    expect(Math.abs(g.ac.telemetry.alpha - FA18_FCS.onSpeedAlpha)).toBeLessThan(0.7 * DEG);
    expect(hud(g).onSpeed).toBe('onSpeed');
  }, 30_000);
});
