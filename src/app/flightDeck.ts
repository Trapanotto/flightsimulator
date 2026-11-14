import type { CockpitSound, RadioVoice } from '@audio';
import { ilsFor, magneticDeclination, navDatabase, planFlight } from '@geo';
import type { ControlSpec, FailureId, SimAircraft } from '@sim';
import type { Weather } from '@sky';
import { type FlightPlan, game, lang } from '@ui';
import { ATC_WORLD, comFrequency } from './atcWorld';
import {
  AtcController,
  C172_CHECKLISTS,
  ChecklistRunner,
  atcConfigFromPlan,
  atcSituation,
  atcWeatherFromSky,
} from './procedures';

/** Sea-level pressure of the simulated atmosphere, hPa (the standard one for now). */
const QNH = 1013;
/** Seconds a pressed button stays down: long enough for the simulation to see the press. */
const BUTTON_HOLD = 0.12;
/** Seconds the starter may crank after a tap on START from a panel without a key to hold. */
const START_HOLD = 8;
const MAGNETOS_BOTH = 3;
const MAGNETOS_START = 4;

interface Scheduled {
  id: FailureId;
  at: number;
}

/**
 * Everything of a flight that is not flying: the cockpit's switches as the interface and the
 * 3D cockpit operate them, the radio and its controller, checklists, planned failures. One
 * per flight; the app creates it when the aircraft is placed and updates it every frame.
 */
export class FlightDeck {
  private readonly specs = new Map<string, ControlSpec>();
  private readonly atc: AtcController | undefined;
  private readonly checklists: ChecklistRunner;
  private readonly pressed = new Map<string, number>();
  private readonly failures: Scheduled[] = [];
  private readonly values: Record<string, number> = {};
  private sinceAtc = 1;
  private sincePublish = 1;
  private startHeld = false;
  private startTimer = 0;
  private language = lang.value;

  constructor(
    private readonly aircraft: SimAircraft,
    private readonly plan: FlightPlan,
    weather: Weather,
    private readonly sounds: { cockpit: CockpitSound; radio: RadioVoice },
  ) {
    for (const s of aircraft.cockpit.specs) this.specs.set(s.id, s);
    game.controls.value = aircraft.cockpit.specs;

    aircraft.failures.clear();
    for (const f of plan.failures ?? [])
      this.failures.push({
        id: f.id,
        // Some time in the first twenty minutes, but not in the first two.
        at: f.after === 'random' ? 120 + Math.random() * 1080 : f.after,
      });

    this.setUpAvionics();

    const config =
      plan.atc === false
        ? undefined
        : atcConfigFromPlan(plan, atcWeatherFromSky(weather, QNH), ATC_WORLD);
    if (config) {
      const at = this.homeOf(plan);
      config.declinationDeg = at ? magneticDeclination(at.lon, at.lat) : 3;
      this.atc = new AtcController(config);
    }
    game.atc.value = this.atc ? this.atc.view() : null;

    this.checklists = new ChecklistRunner(C172_CHECKLISTS, aircraft.cockpit.specs, this.language);
    game.checklists.value = this.checklists.list();
    game.checklist.value = null;
  }

  private homeOf(plan: FlightPlan) {
    const icao = plan.airport ?? (plan.start.kind === 'air' ? undefined : plan.start.airport);
    return icao ? ATC_WORLD.airport(icao) : undefined;
  }

  /** Radios and GPS as a pilot would have set them up before this flight. */
  private setUpAvionics() {
    const { aircraft, plan } = this;
    const c = aircraft.cockpit;
    aircraft.avionics.setDatabase(navDatabase());
    c.set('altimeterSetting', QNH);

    const home = this.homeOf(plan);
    const start = plan.start;
    const arriving = start.kind === 'approach';
    const destination =
      plan.destination ?? (arriving ? { airport: start.airport, runway: start.runway } : undefined);
    const departure = start.kind === 'air' ? plan.airport : start.airport;

    if (destination && departure) {
      const route = planFlight(departure, destination.airport, { runway: destination.runway });
      if (route) {
        // Waypoints the pilot put between the two go after the departure airport.
        const between = (plan.route ?? []).map((w) => ({ ...w }));
        aircraft.avionics.setFlightPlan([route[0]!, ...between, ...route.slice(1)]);
        // Started on final: the approach fix lies behind, fly to the runway.
        if (arriving) aircraft.avionics.directTo(route.length + between.length - 1);
        const runway = destination.runway ?? route[route.length - 1]!.ident.replace(/^RW/, '');
        const ils = ilsFor(destination.airport, runway);
        if (ils) {
          // The approach on NAV 1: active when arriving, standing by when departing.
          c.set(arriving ? 'nav1Active' : 'nav1Standby', ils.frequency);
          if (ils.course !== undefined)
            c.set('obs1', Math.round(ils.course - magneticDeclination(ils.lon, ils.lat)));
        }
      }
    }

    // COM 1 on the first station to call: tower when arriving or lined up, else ground.
    const stations = home?.stations ?? [];
    const pick = (...roles: string[]) =>
      roles.map((r) => stations.find((s) => s.role === r)).find((s) => s !== undefined);
    const first = arriving
      ? (pick('arrival', 'tower', 'aerodrome') ?? pick('tower'))
      : plan.coldStart
        ? pick('ground', 'tower', 'aerodrome')
        : pick('tower', 'aerodrome');
    if (first) c.set('com1Active', first.frequency);
    const second = pick('atis') ?? pick('tower');
    if (second) c.set('com1Standby', second.frequency);
  }

  /**
   * Operates a control. `held` is for the start key under a pointer that stays down: the app
   * sets it back to BOTH on release; from a panel, a tap cranks until the engine runs.
   */
  setControl(id: string, value: number, held = false) {
    const spec = this.specs.get(id);
    if (!spec) return;
    const c = this.aircraft.cockpit;
    const before = c.get(id);
    c.set(id, value);
    const after = c.get(id);
    if (after === before) return;
    if (spec.kind === 'button') {
      if (after >= 0.5) this.pressed.set(id, BUTTON_HOLD);
      this.sounds.cockpit.switchClick(after >= 0.5);
    } else if (spec.kind === 'knob') this.sounds.cockpit.knobTick();
    else if (spec.kind === 'lever') this.sounds.cockpit.lever(after - before);
    else this.sounds.cockpit.switchClick(after > before);
    if (id === 'magnetos') {
      this.startHeld = held && after === MAGNETOS_START;
      this.startTimer = after === MAGNETOS_START ? START_HOLD : 0;
    }
    this.publish();
  }

  /** Tunes COM 1 to a published frequency (the interface's shortcut past the knobs). */
  tuneCom1(khz: number) {
    this.setControl('com1Standby', comFrequency(khz));
    this.setControl('com1Swap', 1);
  }

  reply(optionId: string) {
    if (this.atc) this.handle(this.atc.reply(optionId));
  }

  openChecklist(id: string | null) {
    this.checklists.open(id);
    this.publishChecklist();
  }

  checkItem() {
    this.checklists.tick();
    this.publishChecklist();
  }

  setFailure(id: FailureId, failed: boolean) {
    this.aircraft.failures.set(id, failed);
  }

  /** The control the open checklist is waiting for, for the 3D cockpit's highlight. */
  get highlighted(): string | null {
    return game.checklist.value?.items.find((i) => i.state === 'current')?.control ?? null;
  }

  /** Per frame while the flight runs. `position`: degrees and metres above sea level. */
  update(dt: number, position: { lon: number; lat: number; msl: number }) {
    const { aircraft } = this;
    const t = aircraft.telemetry;
    const c = aircraft.cockpit;

    // Buttons come up again by themselves.
    for (const [id, left] of this.pressed) {
      if (left - dt > 0) this.pressed.set(id, left - dt);
      else {
        this.pressed.delete(id);
        c.set(id, 0);
      }
    }
    // The start key springs back: when released, once the engine runs, or after a while.
    if (c.get('magnetos') === MAGNETOS_START && !this.startHeld) {
      this.startTimer -= dt;
      if (this.startTimer <= 0 || (t.engines[0]?.running && (t.engines[0]?.rpm ?? 0) > 500))
        c.set('magnetos', MAGNETOS_BOTH);
    }

    for (let i = this.failures.length - 1; i >= 0; i--) {
      if (t.time < this.failures[i]!.at) continue;
      aircraft.failures.set(this.failures[i]!.id, true);
      this.failures.splice(i, 1);
    }

    this.sincePublish += dt;
    if (this.sincePublish >= 0.1) this.publish();

    this.sinceAtc += dt;
    if (this.atc && this.sinceAtc >= 0.25) {
      this.sinceAtc = 0;
      this.handle(
        this.atc.update(atcSituation(t, position, this.values, aircraft.failures.active('com1'))),
      );
      game.atc.value = this.atc.view();
    }
  }

  private publish() {
    this.sincePublish = 0;
    const c = this.aircraft.cockpit;
    let changed = game.cockpit.value === null;
    for (const s of c.specs) {
      const v = c.get(s.id);
      if (this.values[s.id] !== v) changed = true;
      this.values[s.id] = v;
    }
    if (changed) game.cockpit.value = { ...this.values };
    if (lang.value !== this.language) {
      this.language = lang.value;
      this.checklists.lang = this.language;
      game.checklists.value = this.checklists.list();
    }
    this.publishChecklist();
  }

  private publishChecklist() {
    this.checklists.update(this.values, this.aircraft.telemetry);
    const next = this.checklists.view();
    const now = game.checklist.value;
    // The view is rebuilt every time: only a real change is worth a redraw.
    if (JSON.stringify(next) !== JSON.stringify(now)) game.checklist.value = next;
  }

  private handle(events: ReturnType<AtcController['update']>) {
    for (const e of events) {
      if (e.type === 'message') void this.sounds.radio.say(e.spoken, e.message.from);
      // The next frequency waits in standby: one press of the swap button and it is tuned.
      else if (e.type === 'frequency') this.aircraft.cockpit.set('com1Standby', e.khz);
    }
    if (events.length && this.atc) game.atc.value = this.atc.view();
  }

  /** The flight is over: nothing of it stays on screen or in the air. */
  dispose() {
    this.sounds.radio.cancel();
    game.atc.value = null;
    game.checklist.value = null;
    game.checklists.value = [];
    game.cockpit.value = null;
    game.controls.value = [];
  }
}
