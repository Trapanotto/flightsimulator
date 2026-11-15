/** The C172S checklists as data, and the runner that ticks them off. */
import { describe, expect, it } from 'vitest';
import { C172_CONTROLS, type Telemetry } from '../src/sim';
import { C172_CHECKLISTS, type Check, ChecklistRunner } from '../src/app/procedures';

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
];

function checksOf(c: Check): Check[] {
  return 'all' in c ? c.all.flatMap(checksOf) : [c];
}

/** A cold, parked C172: every control at its initial value. */
function coldCockpit(): Record<string, number> {
  return Object.fromEntries(C172_CONTROLS.map((s) => [s.id, s.initial]));
}

const KT = 1 / 1.943844;
const FT = 1 / 3.28084;

function telemetry(p: {
  rpm?: number;
  iasKt?: number;
  onGround?: boolean;
  aglFt?: number;
  vsFpm?: number;
  running?: boolean;
  busVolts?: number;
  oilPressure?: number;
  lowVolts?: boolean;
  lowVacuum?: boolean;
  gsKt?: number;
}): Telemetry {
  const onGround = p.onGround ?? true;
  return {
    time: 0,
    ias: (p.iasKt ?? 0) * KT,
    tas: (p.iasKt ?? 0) * KT,
    groundSpeed: (p.gsKt ?? p.iasKt ?? 0) * KT,
    altitude: 500,
    agl: (p.aglFt ?? (onGround ? 0 : 3000)) * FT,
    verticalSpeed: ((p.vsFpm ?? 0) * FT) / 60,
    headingDeg: 0,
    trackDeg: 0,
    pitch: 0,
    bank: 0,
    alpha: 0,
    beta: 0,
    loadFactor: 1,
    onGround,
    stallWarning: false,
    flaps: 0,
    gear: 1,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    engines: [{ running: p.running ?? false, rpm: p.rpm ?? 0, power: 0, fuelFlow: 0 }],
    fuel: 100,
    crashed: undefined,
    systems: {
      busVolts: p.busVolts ?? 24,
      batteryAmps: 0,
      batteryCharge: 1,
      avionicsPowered: true,
      fuelLeft: 50,
      fuelRight: 50,
      fuelAvailable: true,
      vacuum: 5,
      oilTemperature: 80,
      oilPressure: p.oilPressure ?? 0,
      egt: 0.8,
      carbIce: 0,
      airframeIce: 0,
      pitotBlocked: false,
      lights: { beacon: false, landing: false, taxi: false, nav: false, strobe: false },
      panelLight: 0,
      annunciators: {
        lowVolts: p.lowVolts ?? false,
        lowFuelLeft: false,
        lowFuelRight: false,
        lowVacuum: p.lowVacuum ?? false,
        oilPressure: false,
      },
    },
  };
}

describe('C172S checklists', () => {
  it('has the normal and emergency checklists of the handbook', () => {
    expect(C172_CHECKLISTS.map((l) => l.id)).toEqual([
      'preflight',
      'beforeStart',
      'engineStart',
      'beforeTakeoff',
      'takeoff',
      'climb',
      'cruise',
      'descent',
      'beforeLanding',
      'afterLanding',
      'securing',
      'engineFailure',
      'engineRestart',
      'lowVoltage',
      'vacuumFailure',
      'icing',
    ]);
  });

  it('checks only controls that exist, for values they can take', () => {
    for (const list of C172_CHECKLISTS)
      for (const item of list.items) {
        if (!item.check) continue;
        for (const c of checksOf(item.check)) {
          const where = `${list.id}.${item.id}`;
          if ('telemetry' in c) {
            expect(TELEMETRY_KEYS, where).toContain(c.telemetry);
            continue;
          }
          if ('all' in c || 'any' in c) continue;
          const spec = C172_CONTROLS.find((s) => s.id === c.control);
          expect(spec, where).toBeDefined();
          if ('is' in c) {
            for (const v of Array.isArray(c.is) ? c.is : [c.is]) {
              if (typeof v === 'string') expect(spec!.positions, where).toContain(v);
              else if (spec!.kind === 'toggle') expect([0, 1], where).toContain(v);
              else expect(spec!.kind, where).toBe('selector');
            }
          } else {
            expect(['lever', 'knob'], where).toContain(spec!.kind);
            const lo = spec!.min ?? 0;
            const hi = spec!.max ?? 1;
            if ('min' in c && c.min !== undefined) expect(c.min, where).toBeGreaterThanOrEqual(lo);
            if ('max' in c && c.max !== undefined) expect(c.max, where).toBeLessThanOrEqual(hi);
          }
        }
      }
  });

  it('is complete in both languages', () => {
    for (const list of C172_CHECKLISTS) {
      const ids = list.items.map((i) => i.id);
      expect(new Set(ids).size, list.id).toBe(ids.length);
      for (const text of [list.title, ...list.items.flatMap((i) => [i.label, i.expect])]) {
        expect(text.de.trim().length, list.id).toBeGreaterThan(0);
        expect(text.en.trim().length, list.id).toBeGreaterThan(0);
        // Swiss spelling.
        expect(text.de, list.id).not.toContain('ß');
      }
      expect(list.title.de).not.toBe(list.title.en);
    }
  });

  it('uses the handbook figures', () => {
    const find = (list: string, item: string) =>
      C172_CHECKLISTS.find((l) => l.id === list)!.items.find((i) => i.id === item)!.check as {
        min: number;
        max?: number;
      };
    // POH section 4: run-up at 1800 RPM, rotate at 55 KIAS; section 3: best glide 68 KIAS.
    const runup = find('beforeTakeoff', 'runup');
    expect((runup.min + runup.max!) / 2).toBe(1800);
    expect(find('takeoff', 'rotate').min).toBe(55);
    const glide = find('engineFailure', 'glide');
    expect((glide.min + glide.max!) / 2).toBe(68);
  });
});

describe('ChecklistRunner', () => {
  it('ticks items as the cockpit changes, in order', () => {
    const r = new ChecklistRunner();
    const cockpit = coldCockpit();
    r.open('engineStart');
    r.update(cockpit, telemetry({}));
    const states = () => r.view()!.items.map((i) => i.state);
    expect(r.view()!.items[0]).toEqual({
      label: 'Throttle',
      expect: 'OPEN 1/4 INCH',
      state: 'current',
      control: 'throttle',
    });
    cockpit.throttle = 0.08;
    r.update(cockpit, telemetry({}));
    // Mixture is at idle cutoff already: it ticks at once, the propeller area waits for a hand.
    expect(states().slice(0, 4)).toEqual(['done', 'done', 'current', 'todo']);
    r.tick();
    cockpit.battery = 1;
    r.update(cockpit, telemetry({}));
    expect(states()[3]).toBe('current');
    cockpit.alternator = 1;
    cockpit.lightBeacon = 1;
    cockpit.fuelPump = 1;
    r.update(cockpit, telemetry({}));
    expect(states().indexOf('current')).toBe(6);
    r.tick();
    cockpit.fuelPump = 0;
    r.update(cockpit, telemetry({}));
    expect(states().indexOf('current')).toBe(8);
    r.update(cockpit, telemetry({ running: true, rpm: 1000 }));
    cockpit.mixture = 1;
    r.update(cockpit, telemetry({ running: true, rpm: 1000, oilPressure: 40, busVolts: 28 }));
    cockpit.avionics = 1;
    r.update(cockpit, telemetry({ running: true, rpm: 1000, oilPressure: 40, busVolts: 28 }));
    expect(states().indexOf('current')).toBe(13);
    r.tick();
    expect(states().every((s) => s === 'done')).toBe(true);
    expect(r.isComplete('engineStart')).toBe(true);
  });

  it('keeps an item waiting for its turn even if its state is already right', () => {
    const r = new ChecklistRunner();
    const cockpit = coldCockpit();
    r.open('preflight');
    r.update(cockpit, telemetry({}));
    // 'Master OFF' further down is true already, but 'Master ON' comes first.
    const v = r.view()!;
    expect(v.items.findIndex((i) => i.state === 'current')).toBe(0);
    expect(v.items[8]!.state).toBe('todo');
  });

  it('speaks German or English', () => {
    const r = new ChecklistRunner(undefined, undefined, 'de');
    r.open('securing');
    expect(r.view()!.title).toBe('Abstellen');
    expect(r.view()!.items[0]).toMatchObject({ label: 'Parkbremse', expect: 'GESETZT' });
    r.lang = 'en';
    expect(r.view()!.title).toBe('Securing airplane');
    expect(r.list()[0]).toEqual({ id: 'preflight', title: 'Preflight inspection (cabin)' });
    r.open(null);
    expect(r.view()).toBeNull();
  });

  it('suggests the checklist for the phase of flight', () => {
    const r = new ChecklistRunner();
    const cockpit = coldCockpit();
    const at = (t: Telemetry) => {
      r.update(cockpit, t);
      return r.suggest();
    };
    expect(at(telemetry({}))).toBe('preflight');
    r.open('preflight');
    for (let i = 0; i < 12; i++) r.tick();
    expect(at(telemetry({}))).toBe('beforeStart');
    expect(at(telemetry({ running: true, rpm: 1000 }))).toBe('beforeTakeoff');
    expect(
      at(telemetry({ onGround: false, iasKt: 75, vsFpm: 700, running: true, rpm: 2500 })),
    ).toBe('climb');
    expect(at(telemetry({ onGround: false, iasKt: 110, running: true, rpm: 2400 }))).toBe('cruise');
    expect(
      at(
        telemetry({
          onGround: false,
          iasKt: 110,
          vsFpm: -500,
          aglFt: 4000,
          running: true,
          rpm: 2200,
        }),
      ),
    ).toBe('descent');
    expect(
      at(
        telemetry({
          onGround: false,
          iasKt: 80,
          vsFpm: -500,
          aglFt: 1500,
          running: true,
          rpm: 2000,
        }),
      ),
    ).toBe('beforeLanding');
    expect(at(telemetry({ onGround: false, iasKt: 68, aglFt: 3000 }))).toBe('engineRestart');
    expect(at(telemetry({ onGround: false, iasKt: 68, aglFt: 800 }))).toBe('engineFailure');
    expect(
      at(telemetry({ onGround: false, iasKt: 100, running: true, rpm: 2400, lowVolts: true })),
    ).toBe('lowVoltage');
    expect(
      at(telemetry({ onGround: false, iasKt: 100, running: true, rpm: 2400, lowVacuum: true })),
    ).toBe('vacuumFailure');
    expect(at(telemetry({ running: true, rpm: 1000, gsKt: 10 }))).toBe('afterLanding');
  });

  it('saves and restores where it stands', () => {
    const r = new ChecklistRunner();
    r.open('beforeStart');
    r.update(coldCockpit(), telemetry({}));
    r.tick();
    const copy = new ChecklistRunner(
      undefined,
      undefined,
      'en',
      JSON.parse(JSON.stringify(r.save())),
    );
    expect(copy.view()).toEqual(r.view());
  });
});
