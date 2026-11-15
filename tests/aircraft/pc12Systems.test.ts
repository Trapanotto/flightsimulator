import { describe, expect, it } from 'vitest';
import { BLADE, bladeAngle, gearLights, gearSequence } from '../../src/aircraft/pc12Parts';
import {
  type CasInputs,
  PC12_LIMITS,
  PC12_SPEEDS,
  TORQUE_MAX_PSI,
  altitudeDigits,
  crewAlerts,
  flapDegrees,
  formatBaro,
  formatNg,
  formatRadarAltitude,
  formatSelectedAltitude,
  formatTorque,
  formatVs,
  fuelFlowLbh,
  gaugeZone,
  mapNorthUp,
  mapRangeNm,
  maxSpeed,
  modeAnnunciation,
  stallSpeed,
  stationOffset,
} from '../../src/aircraft/pc12Avionics';
import { avionicsFromCockpit } from '../../src/aircraft/avionicsFormat';
import { CockpitPanel, type EngineTelemetry, PC12_CONTROLS } from '../../src/sim';

describe('gear sequence', () => {
  const at = (g: number) => gearSequence(g);

  it('is closed and stowed up, down and locked with the main doors shut again', () => {
    expect(at(0)).toEqual({ main: 0, nose: 0, mainDoors: 0, noseDoors: 0 });
    const down = at(1);
    expect(down.main).toBe(1);
    expect(down.nose).toBe(1);
    expect(down.mainDoors).toBe(0);
    // The nose doors are linked to the leg and stay open while it is down.
    expect(down.noseDoors).toBe(1);
  });

  it('opens the doors before a leg moves and keeps them open while it does', () => {
    for (let g = 0; g <= 1.0001; g += 0.01) {
      const p = at(g);
      if (p.main > 0 && p.main < 1) expect(p.mainDoors, `g=${g}`).toBe(1);
      if (p.nose > 0 && p.nose < 1) expect(p.noseDoors, `g=${g}`).toBe(1);
    }
  });

  it('moves the legs monotonically with the gear position, the nose a little behind', () => {
    let last = at(0);
    for (let g = 0.01; g <= 1.0001; g += 0.01) {
      const p = at(g);
      expect(p.main).toBeGreaterThanOrEqual(last.main);
      expect(p.nose).toBeGreaterThanOrEqual(last.nose);
      last = p;
    }
    expect(at(0.2).nose).toBeLessThan(at(0.2).main);
  });

  it('lights three greens only down and locked, red in transit, nothing up', () => {
    expect(gearLights(1)).toEqual({ down: true, transit: false });
    expect(gearLights(0)).toEqual({ down: false, transit: false });
    expect(gearLights(0.5)).toEqual({ down: false, transit: true });
    // Locked down while the main doors still close: greens and the red together.
    expect(gearLights(0.95)).toEqual({ down: true, transit: true });
    expect(gearLights(0.8).down).toBe(false);
  });
});

describe('propeller blade angle', () => {
  const eng = (e: Partial<EngineTelemetry>): EngineTelemetry => ({
    running: true,
    rpm: 1700,
    power: 0.5,
    fuelFlow: 0.03,
    propRpm: 1700,
    torque: 0.5,
    ...e,
  });

  it('feathers a stopped engine and reverses when selected', () => {
    expect(bladeAngle(eng({ running: false, rpm: 0, propRpm: 0 }), 0)).toBe(BLADE.feather);
    expect(bladeAngle(eng({ reversing: true }), 20)).toBe(BLADE.reverse);
    expect(BLADE.reverse).toBeLessThan(0);
  });

  it('sits on the fine stop at idle on the ground and coarsens with speed and power', () => {
    const idle = bladeAngle(eng({ torque: 0, power: 0 }), 0);
    expect(idle).toBeCloseTo(BLADE.fine, 5);
    const climb = bladeAngle(eng({ torque: 1 }), 70);
    const cruise = bladeAngle(eng({ torque: 0.85 }), 135);
    expect(climb).toBeGreaterThan(idle);
    expect(cruise).toBeGreaterThan(climb);
    expect(cruise).toBeLessThanOrEqual(BLADE.coarse);
  });
});

describe('PC-12 limitations (POH section 2)', () => {
  it('marks the engine limits of the PT6A-67P', () => {
    expect(TORQUE_MAX_PSI).toBe(44.34);
    expect(PC12_LIMITS.torque.redLine).toEqual([44.3]);
    expect(PC12_LIMITS.itt.redLine).toEqual([850]);
    expect(PC12_LIMITS.itt.amber).toEqual([[820, 850]]);
    expect(PC12_LIMITS.ng.redLine).toEqual([104]);
    expect(PC12_LIMITS.np.redLine).toEqual([1700]);
    expect(PC12_LIMITS.oilP.green).toEqual([90, 135]);
    expect(PC12_LIMITS.oilT.redLine).toEqual([110]);
  });

  it('colours gauge values by their band', () => {
    expect(gaugeZone(30, PC12_LIMITS.torque)).toBe('green');
    expect(gaugeZone(45, PC12_LIMITS.torque)).toBe('red');
    expect(gaugeZone(835, PC12_LIMITS.itt)).toBe('amber');
    expect(gaugeZone(860, PC12_LIMITS.itt)).toBe('red');
    expect(gaugeZone(70, PC12_LIMITS.oilP)).toBe('amber');
    expect(gaugeZone(40, PC12_LIMITS.oilP)).toBe('red');
    expect(gaugeZone(1000, PC12_LIMITS.np)).toBe('white');
  });

  it('knows the airspeed limits and lowers the barber pole for Mach, flaps and gear', () => {
    expect(PC12_SPEEDS.vmo).toBe(236);
    expect(PC12_SPEEDS.mmo).toBe(0.48);
    expect(PC12_SPEEDS.vfe[15]).toBe(163);
    expect(PC12_SPEEDS.vfe[40]).toBe(117);
    expect(maxSpeed(150, 0.25, 0, 0)).toBe(236);
    // At FL250 the Mach limit comes first: 0.48 at an IAS/Mach ratio of 180/0.43.
    expect(maxSpeed(180, 0.43, 0, 0)).toBeCloseTo((180 * 0.48) / 0.43, 5);
    expect(maxSpeed(100, 0.15, 1, 1)).toBe(117);
    expect(maxSpeed(150, 0.25, 0, 0.5)).toBe(PC12_SPEEDS.vlo);
  });

  it('interpolates the stall speed between the flap settings', () => {
    expect(stallSpeed(0)).toBe(91);
    expect(stallSpeed(1)).toBe(67);
    expect(stallSpeed(15 / 40)).toBeCloseTo(78, 5);
    expect(flapDegrees(0.75)).toBe(30);
    expect(flapDegrees(0.1)).toBe(0);
  });
});

describe('PC-12 display formatting', () => {
  it('formats engine values as the Apex shows them', () => {
    expect(formatTorque(38.24)).toBe('38.2');
    expect(formatNg(97.06)).toBe('97.1');
    expect(fuelFlowLbh(330 / 2.20462 / 3600)).toBe(330);
  });

  it('shows the altimeter setting, selected altitude, rolling digits and VS', () => {
    expect(formatBaro(1013.25, true)).toBe('STD');
    expect(formatBaro(1021.4, false)).toBe('1021 HPA');
    expect(formatSelectedAltitude(12049)).toBe('12000');
    expect(altitudeDigits(12345)).toEqual({ thousands: '12', hundreds: '3', tens: 45 });
    expect(altitudeDigits(-80)).toEqual({ thousands: '-', hundreds: '0', tens: 80 });
    expect(formatVs(60)).toBe('');
    expect(formatVs(-1234)).toBe('1250');
  });

  it('shows the radar altitude near the ground only', () => {
    expect(formatRadarAltitude(undefined)).toBe('');
    expect(formatRadarAltitude(3000)).toBe('');
    expect(formatRadarAltitude(1234)).toBe('1230');
    expect(formatRadarAltitude(152)).toBe('150');
    expect(formatRadarAltitude(-3)).toBe('0');
  });

  it('snaps the map range to the Apex steps and goes north-up for the long ranges', () => {
    expect(mapRangeNm(20)).toBe(20);
    expect(mapRangeNm(25)).toBe(40);
    expect(mapRangeNm(320)).toBe(320);
    expect(mapNorthUp(20)).toBe(false);
    expect(mapNorthUp(160)).toBe(true);
    const o = stationOffset(90, 10);
    expect(o.east).toBeCloseTo(10, 9);
    expect(o.north).toBeCloseTo(0, 9);
  });

  it('annunciates the autopilot modes with the Apex names', () => {
    const av = avionicsFromCockpit(new CockpitPanel(PC12_CONTROLS))!;
    av.autopilot = {
      ...av.autopilot,
      engaged: true,
      yawDamper: true,
      lateral: 'apr',
      vertical: 'gs',
      lateralArmed: undefined,
      verticalArmed: undefined,
      flightDirector: { pitch: 0, bank: 0 },
    };
    const ils = modeAnnunciation(av, 'nav1');
    expect(ils).toMatchObject({ ap: true, yd: true, lateral: 'LOC', vertical: 'GS' });
    const lnav = modeAnnunciation(
      {
        ...av,
        autopilot: { ...av.autopilot, lateral: 'nav', vertical: 'alt', verticalArmed: 'alt' },
      },
      'gps',
    );
    expect(lnav).toMatchObject({ lateral: 'LNAV', vertical: 'ALT', verticalArmed: 'ALTS' });
    // Without the flight director and autopilot nothing is annunciated.
    const off = modeAnnunciation(
      { ...av, autopilot: { ...av.autopilot, engaged: false, flightDirector: undefined } },
      'nav1',
    );
    expect(off.lateral).toBe('');
  });
});

describe('PC-12 crew alerting', () => {
  const base = (
    over: Partial<CasInputs> = {},
    switches: Record<string, number> = {},
  ): CasInputs => {
    const panel = new CockpitPanel(PC12_CONTROLS);
    panel.reset(true);
    for (const [k, v] of Object.entries(switches)) panel.set(k, v);
    return {
      systems: undefined,
      switch: (id) => panel.get(id),
      onGround: false,
      engineRunning: true,
      gear: 0,
      flaps: 0,
      ias: 180,
      agl: 8000,
      cabinAltitude: 8000,
      torquePsi: 36,
      itt: 700,
      oilPressure: 110,
      ...over,
    };
  };

  it('is quiet in a normal cruise with everything set up', () => {
    const msgs = crewAlerts(base({}, { pitotHeat: 1, battery2: 1, generator2: 1, eps: 1 }));
    expect(msgs.filter((m) => m.level !== 'advisory')).toEqual([]);
  });

  it('orders warnings before cautions before advisories', () => {
    const msgs = crewAlerts(
      base({ oilPressure: 40, cabinAltitude: 12000 }, { generator1: 0, ignition: 1 }),
    );
    const levels = msgs.map((m) => m.level);
    expect(msgs.map((m) => m.text)).toEqual(
      expect.arrayContaining(['OIL PRESS', 'CAB PRESS', 'GEN 1 OFF', 'IGNITION ON']),
    );
    const rank = { warning: 0, caution: 1, advisory: 2 };
    for (let i = 1; i < levels.length; i++)
      expect(rank[levels[i]!]).toBeGreaterThanOrEqual(rank[levels[i - 1]!]);
  });

  it('warns of the gear up with the flaps down or low and slow', () => {
    expect(crewAlerts(base({ gear: 0, flaps: 1 })).map((m) => m.text)).toContain('GEAR UNSAFE');
    expect(crewAlerts(base({ gear: 0, agl: 300, ias: 100 })).map((m) => m.text)).toContain(
      'GEAR UNSAFE',
    );
    expect(crewAlerts(base({ gear: 1, flaps: 1 })).map((m) => m.text)).not.toContain('GEAR UNSAFE');
  });
});
