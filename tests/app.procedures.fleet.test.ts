/** The checklists of every type: their machine checks, both languages, and the suggestions. */
import { describe, expect, it } from 'vitest';
import { C172_CONTROLS, type ControlSpec, PC12_CONTROLS, type Telemetry } from '../src/sim';
import { A320_CONTROLS } from '../src/sim/cockpitA320';
import { FA18_CONTROLS } from '../src/sim/cockpitFa18';
import {
  type Check,
  type ChecklistDef,
  ChecklistRunner,
  checklistsFor,
  phaseOf,
} from '../src/app/procedures';

const TELEMETRY_KEYS = [
  'rpm',
  'iasKt',
  'aglFt',
  'groundSpeedKt',
  'verticalSpeedFpm',
  'onGround',
  'engineRunning',
  'busVolts',
  'batteryAmps',
  'oilPressure',
  'vacuum',
  'lowVolts',
  'lowVacuum',
  'enginesRunning',
  'engineStarting',
  'n2',
  'n1',
  'itt',
  'torque',
  'propRpm',
  'afterburner',
  'reversing',
  'gear',
  'flaps',
  'speedbrake',
  'mach',
  'alphaDeg',
  'pitchDeg',
  'bankDeg',
  'altitudeFt',
  'cabinAltitudeFt',
  'cabinAltitudeWarning',
  'gearUnsafe',
  'hydraulicsLow',
  'generatorsOff',
  'baroStd',
  'stallWarning',
  'airframeIce',
  'carbIce',
  'pitotBlocked',
];

const FLEET = [
  { id: 'c172', specs: C172_CONTROLS, engines: 1 },
  { id: 'pc12', specs: PC12_CONTROLS, engines: 1 },
  { id: 'a320', specs: A320_CONTROLS, engines: 2 },
  { id: 'fa18', specs: FA18_CONTROLS, engines: 2 },
] as const;

const leaves = (c: Check): Check[] =>
  'all' in c ? c.all.flatMap(leaves) : 'any' in c ? c.any.flatMap(leaves) : [c];

function problems(lists: readonly ChecklistDef[], specs: readonly ControlSpec[], engines: number) {
  const out: string[] = [];
  const checkOne = (where: string, c: Check) => {
    if ('telemetry' in c) {
      if (!TELEMETRY_KEYS.includes(c.telemetry)) out.push(`${where}: telemetry ${c.telemetry}`);
      if (c.engine !== undefined && (c.engine < 0 || c.engine >= engines))
        out.push(`${where}: engine ${c.engine}`);
      return;
    }
    if (!('control' in c)) return;
    const spec = specs.find((s) => s.id === c.control);
    if (!spec) return out.push(`${where}: no control ${c.control}`);
    if ('is' in c) {
      for (const v of Array.isArray(c.is) ? c.is : [c.is]) {
        if (typeof v === 'string') {
          if (!spec.positions?.includes(v)) out.push(`${where}: ${c.control} has no ${v}`);
        } else if (spec.kind === 'toggle' || spec.kind === 'button') {
          if (v !== 0 && v !== 1) out.push(`${where}: ${c.control} toggles 0/1, not ${v}`);
        } else if (spec.kind !== 'selector') out.push(`${where}: ${c.control} is a ${spec.kind}`);
        else if (v < 0 || v >= (spec.positions?.length ?? 0))
          out.push(`${where}: ${c.control} index ${v}`);
      }
    } else {
      if (!['lever', 'knob'].includes(spec.kind)) out.push(`${where}: ${c.control} has no range`);
      const lo = spec.min ?? 0;
      const hi = spec.max ?? 1;
      if (c.min !== undefined && (c.min < lo || c.min > hi)) out.push(`${where}: min ${c.min}`);
      if (c.max !== undefined && (c.max < lo || c.max > hi)) out.push(`${where}: max ${c.max}`);
    }
  };
  for (const list of lists) {
    if (list.trigger) for (const c of leaves(list.trigger)) checkOne(`${list.id}.trigger`, c);
    for (const it of list.items)
      if (it.check) for (const c of leaves(it.check)) checkOne(`${list.id}.${it.id}`, c);
  }
  return out;
}

describe.each(FLEET)('checklists of $id', ({ id, specs, engines }) => {
  const lists = checklistsFor(id);

  it('check only controls of this type, for values they can take', () => {
    expect(problems(lists, specs, engines)).toEqual([]);
  });

  it('are complete in German and English, with Swiss spelling', () => {
    const listIds = lists.map((l) => l.id);
    expect(new Set(listIds).size).toBe(listIds.length);
    for (const list of lists) {
      const ids = list.items.map((i) => i.id);
      expect(new Set(ids).size, list.id).toBe(ids.length);
      expect(list.items.length, list.id).toBeGreaterThan(2);
      for (const text of [list.title, ...list.items.flatMap((i) => [i.label, i.expect])]) {
        expect(text.de.trim().length, list.id).toBeGreaterThan(0);
        expect(text.en.trim().length, list.id).toBeGreaterThan(0);
        expect(text.de, list.id).not.toContain('ß');
      }
      expect(list.title.de, list.id).not.toBe(list.title.en);
      if (list.kind === 'normal') expect(phaseOf(list), list.id).toBeDefined();
      if (list.requires) expect(listIds, list.id).toContain(list.requires);
    }
  });

  it('check most items by machine', () => {
    const items = lists.flatMap((l) => l.items);
    expect(items.filter((i) => i.check).length / items.length).toBeGreaterThan(0.45);
  });
});

describe('the handbook figures', () => {
  const find = (id: 'pc12' | 'a320' | 'fa18', list: string, item: string) =>
    checklistsFor(id)
      .find((l) => l.id === list)!
      .items.find((i) => i.id === item)!;
  it('PC-12: light-off at 13 % Ng, rotation at 83 KIAS, best glide 119 KIAS', () => {
    expect(find('pc12', 'engineStart', 'ng13').check).toEqual({ telemetry: 'n2', min: 13 });
    expect(find('pc12', 'takeoff', 'rotate').check).toEqual({ telemetry: 'iasKt', min: 83 });
    const g = find('pc12', 'engineFailure', 'glide').check as { min: number; max: number };
    expect((g.min + g.max) / 2).toBe(119);
    // Start order of the handbook: batteries, EPS, pumps, starter, Ng 13 %, condition lever.
    const order = checklistsFor('pc12')
      .find((l) => l.id === 'engineStart')!
      .items.map((i) => i.id);
    const at = (x: string) => order.indexOf(x);
    expect(at('batteries')).toBeLessThan(at('epsArmed'));
    expect(at('epsArmed')).toBeLessThan(at('fuelPumps'));
    expect(at('fuelPumps')).toBeLessThan(at('starter'));
    expect(at('starter')).toBeLessThan(at('ng13'));
    expect(at('ng13')).toBeLessThan(at('conditionGroundIdle'));
    expect(at('itt')).toBeLessThan(at('generators'));
    expect(at('generators')).toBeLessThan(at('avionicsOn'));
  });
  it('A320: the thrust lever detents of the cockpit, the right engine first', () => {
    const clb = find('a320', 'takeoff', 'thrustReduction').check as { all: Check[] };
    const lever = leaves(clb.all[1]!)[0] as { min: number; max: number };
    expect(lever.min).toBeLessThan(0.62);
    expect(lever.max).toBeGreaterThan(0.62);
    const order = checklistsFor('a320')
      .find((l) => l.id === 'engineStart')!
      .items.map((i) => i.id);
    expect(order.indexOf('master2')).toBeLessThan(order.indexOf('master1'));
  });
  it('F/A-18: on-speed angle of attack 8.1°, right engine before the left', () => {
    const aoa = leaves(find('fa18', 'landing', 'onSpeed').check!)[1] as {
      min: number;
      max: number;
    };
    expect((aoa.min + aoa.max) / 2).toBeCloseTo(8.1, 5);
    const order = checklistsFor('fa18')
      .find((l) => l.id === 'engineStart')!
      .items.map((i) => i.id);
    expect(order.indexOf('crankRight')).toBeLessThan(order.indexOf('crankLeft'));
  });
});

// ---------------------------------------------------------------- suggestions

const KT = 1 / 1.943844;
const FT = 1 / 3.28084;

function telemetry(
  engines: number,
  p: {
    iasKt?: number;
    onGround?: boolean;
    aglFt?: number;
    vsFpm?: number;
    running?: number;
    gsKt?: number;
    alphaDeg?: number;
    cabinWarning?: boolean;
  },
): Telemetry {
  const onGround = p.onGround ?? true;
  const running = p.running ?? 0;
  return {
    time: 0,
    ias: (p.iasKt ?? 0) * KT,
    tas: (p.iasKt ?? 0) * KT,
    groundSpeed: (p.gsKt ?? p.iasKt ?? 0) * KT,
    altitude: 500,
    agl: (p.aglFt ?? (onGround ? 0 : 5000)) * FT,
    verticalSpeed: ((p.vsFpm ?? 0) * FT) / 60,
    headingDeg: 0,
    trackDeg: 0,
    pitch: 0,
    bank: 0,
    alpha: ((p.alphaDeg ?? 3) * Math.PI) / 180,
    beta: 0,
    loadFactor: 1,
    onGround,
    stallWarning: false,
    flaps: 0,
    gear: 1,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    // No propeller rpm on the jets: only `running` and the turbine values.
    engines: Array.from({ length: engines }, (_, i) => ({
      running: i < running,
      rpm: 0,
      power: 0,
      fuelFlow: 0,
      n2: i < running ? 70 : 0,
    })),
    fuel: 1000,
    crashed: undefined,
    systems: {
      busVolts: 28,
      batteryAmps: 0,
      batteryCharge: 1,
      avionicsPowered: true,
      fuelLeft: 500,
      fuelRight: 500,
      fuelAvailable: true,
      vacuum: 5,
      oilTemperature: 80,
      oilPressure: 100,
      egt: 0.8,
      carbIce: 0,
      airframeIce: 0,
      pitotBlocked: false,
      lights: { beacon: false, landing: false, taxi: false, nav: false, strobe: false },
      panelLight: 0,
      annunciators: {
        lowVolts: false,
        lowFuelLeft: false,
        lowFuelRight: false,
        lowVacuum: false,
        oilPressure: false,
        cabinAltitude: p.cabinWarning ?? false,
      },
    },
  };
}

function runner(id: (typeof FLEET)[number]['id']) {
  const f = FLEET.find((x) => x.id === id)!;
  const r = new ChecklistRunner(checklistsFor(id), f.specs);
  const cockpit = Object.fromEntries(f.specs.map((s) => [s.id, s.initial]));
  const at = (p: Parameters<typeof telemetry>[1]) => {
    r.update(cockpit, telemetry(f.engines, p));
    return r.suggest();
  };
  const finish = (list: string) => {
    r.open(list);
    for (let i = 0; i < 40; i++) r.tick();
    r.open(null);
  };
  return { r, at, finish, cockpit };
}

describe('phase-of-flight suggestions', () => {
  it('PC-12: start, taxi, the flight, an engine failure and the air start', () => {
    const { at, finish } = runner('pc12');
    expect(at({})).toBe('beforeStart');
    finish('beforeStart');
    expect(at({})).toBe('engineStart');
    expect(at({ running: 1 })).toBe('beforeTaxi');
    expect(at({ onGround: false, iasKt: 130, vsFpm: 1500, running: 1 })).toBe('climb');
    expect(at({ onGround: false, iasKt: 250, running: 1 })).toBe('cruise');
    expect(at({ onGround: false, iasKt: 200, vsFpm: -1000, aglFt: 8000, running: 1 })).toBe(
      'descent',
    );
    expect(at({ onGround: false, iasKt: 110, vsFpm: -600, aglFt: 1200, running: 1 })).toBe(
      'beforeLanding',
    );
    expect(at({ onGround: false, iasKt: 119, aglFt: 6000 })).toBe('engineFailure');
    finish('engineFailure');
    expect(at({ onGround: false, iasKt: 119, aglFt: 6000 })).toBe('airStart');
    expect(at({ onGround: false, iasKt: 200, running: 1, cabinWarning: true })).toBe(
      'emergencyDescent',
    );
    expect(at({ running: 1, gsKt: 10 })).toBe('afterLanding');
  });

  it('A320: from cold and dark to parking, with the abnormal lists', () => {
    const { at, finish, cockpit } = runner('a320');
    expect(at({})).toBe('cockpitPreparation');
    finish('cockpitPreparation');
    finish('beforeStart');
    // One engine running: still starting.
    expect(at({ running: 1 })).toBe('engineStart');
    expect(at({ running: 2 })).toBe('afterStart');
    // The take-off roll at FLX thrust is not a rejected take-off; retarding at speed is.
    cockpit.throttle1 = cockpit.throttle2 = 0.82;
    expect(at({ running: 2, gsKt: 80 })).toBe('afterStart');
    cockpit.throttle1 = cockpit.throttle2 = 0;
    expect(at({ running: 2, gsKt: 80 })).toBe('rejectedTakeoff');
    expect(at({ running: 1, gsKt: 80 })).toBe('rejectedTakeoff');
    expect(at({ onGround: false, iasKt: 160, vsFpm: 1500, aglFt: 800, running: 1 })).toBe(
      'engineFailureTakeoff',
    );
    expect(at({ onGround: false, iasKt: 290, vsFpm: 2500, aglFt: 9000, running: 2 })).toBe('climb');
    expect(at({ onGround: false, iasKt: 280, vsFpm: -2000, aglFt: 20_000, running: 2 })).toBe(
      'descent',
    );
    expect(at({ onGround: false, iasKt: 250, vsFpm: -1500, aglFt: 8000, running: 2 })).toBe(
      'approach',
    );
    finish('approach');
    expect(at({ onGround: false, iasKt: 140, vsFpm: -700, aglFt: 1500, running: 2 })).toBe(
      'landing',
    );
    // After landing the rejected take-off is not due, however fast the roll-out.
    expect(at({ running: 2, gsKt: 10 })).toBe('afterLanding');
    expect(at({ running: 1, gsKt: 60 })).toBe('afterLanding');
  });

  it('F/A-18: one engine, both engines, out of control', () => {
    const { at, finish } = runner('fa18');
    expect(at({})).toBe('preStart');
    finish('preStart');
    expect(at({ running: 1 })).toBe('engineStart');
    expect(at({ running: 2 })).toBe('beforeTaxi');
    expect(at({ onGround: false, iasKt: 350, vsFpm: 8000, running: 2 })).toBe('climb');
    expect(at({ onGround: false, iasKt: 300, running: 1 })).toBe('singleEngine');
    expect(at({ onGround: false, iasKt: 250, running: 0 })).toBe('flameoutApproach');
    expect(at({ onGround: false, iasKt: 200, running: 2, alphaDeg: 45 })).toBe('outOfControl');
    expect(at({ onGround: false, iasKt: 150, vsFpm: -800, aglFt: 1000, running: 2 })).toBe(
      'landing',
    );
  });
});
