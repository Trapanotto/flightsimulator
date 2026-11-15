/**
 * The A320's flight control and system computers as one control law for the flight model:
 * the fly-by-wire laws (fbw.ts) fly the surfaces, the system controllers (systems.ts) run
 * the APU, bleed, start valves, electrical, hydraulic and fuel systems, and the warning
 * computer fills the ECAM. They report into the A320 block of the telemetry that the flight
 * guidance computer (fmgc.ts) owns, as the real computers talk over their data buses: the
 * flight guidance reads the law, the alpha floor and the power state there, and these read
 * whether the autopilot is engaged.
 */
import type { AirbusTelemetry } from '../avionicsTypes';
import type {
  ControlLaw,
  ControlLawContext,
  SurfaceCommand,
  TypeSystemsContext,
} from '../controlLaw';
import type { AircraftDefinition } from '../definition';
import { KT } from '../math';
import { FlyByWire } from './fbw';
import { SLATS_FLAPS, VFE, VLE, VMO, type A320Config } from './speeds';
import { A320Systems } from './systems';
import { newAirbusTelemetry } from './telemetry';

export class A320Computers implements ControlLaw {
  readonly shaker = false;
  readonly pusher = false;
  readonly fbw: FlyByWire;
  readonly systemsComputer = new A320Systems();
  /** Where the computers report when no flight guidance unit owns the block. */
  private readonly own = newAirbusTelemetry();
  private first = true;
  private readonly warned = new Set<string>();
  private readonly cautioned = new Set<string>();
  private lastWarningButton = 0;
  private lastCautionButton = 0;
  private readonly engineWasRunning = [false, false];
  private readonly red: string[] = [];
  private readonly amber: string[] = [];

  constructor(readonly def: AircraftDefinition) {
    this.fbw = new FlyByWire(def);
  }

  private block(t: { avionics?: { autopilot: { airbus?: AirbusTelemetry } } }): AirbusTelemetry {
    return t.avionics?.autopilot.airbus ?? this.own;
  }

  reset() {
    this.fbw.reset();
    this.systemsComputer.reset();
    this.first = true;
    this.warned.clear();
    this.cautioned.clear();
    this.engineWasRunning.fill(false);
  }

  systems(ctx: TypeSystemsContext) {
    const b = this.block(ctx.telemetry);
    const slatsOut = SLATS_FLAPS[this.fbw.config][0] > 0;
    this.systemsComputer.step(ctx, b.systems, slatsOut);
    b.systems.grossMass = this.def.mass + ctx.systems.fuel.total;
    if (this.first) for (let i = 0; i < 2; i++) this.engineWasRunning[i] = ctx.engines[i]!.running;
    this.ecam(ctx, b);
  }

  step(ctx: ControlLawContext, out: SurfaceCommand) {
    const b = this.block(ctx.telemetry);
    this.fbw.step(ctx, out, this.systemsComputer.state, b.controls);
    if (this.first) {
      this.first = false;
      this.fbw.initialSlats(SLATS_FLAPS[this.fbw.config][0]);
    }
  }

  /** The flight warning computer: red warnings, amber cautions and the memo (FCOM DSC-31). */
  private ecam(ctx: TypeSystemsContext, b: AirbusTelemetry) {
    const t = ctx.telemetry;
    const c = ctx.cockpit;
    const s = b.systems;
    const fc = b.controls;
    const ecam = b.ecam;
    const memo = ecam.memo;
    const red = this.red;
    const amber = this.amber;
    red.length = 0;
    amber.length = 0;
    memo.length = 0;
    const air = !t.onGround;
    const ias = t.ias / KT;
    const aglFt = (t.agl ?? 10_000) / 0.3048;
    const levers = ctx.controls.throttle;
    const anyRunning = ctx.engines.some((p) => p.running);
    const config = fc.config as A320Config;
    // ---- red ----
    if (air && (ias > VMO + 4 || (t.mach ?? 0) > 0.826)) red.push('OVER SPEED VMO/MMO');
    else if (air && config !== '0' && ias > VFE[config] + 4) red.push('OVER SPEED VFE');
    else if (air && t.gear > 0.01 && ias > VLE + 4) red.push('OVER SPEED VLE');
    if (!air && levers.some((x) => x >= 0.8) && ias < 80) {
      if (config === '0' || config === 'FULL') red.push('CONFIG FLAPS NOT IN T.O CONFIG');
      if ((t.speedbrake ?? 0) > 0.05 && !fc.groundSpoilers)
        red.push('CONFIG SPD BRK NOT RETRACTED');
      if (ctx.controls.parkingBrake) red.push('CONFIG PARK BRK ON');
      if (fc.stabiliser > 7 || fc.stabiliser < -2.5) red.push('CONFIG PITCH TRIM NOT IN T.O RANGE');
    }
    if (
      air &&
      t.gear < 0.99 &&
      aglFt < 750 &&
      (config === '3' || config === 'FULL' || levers.every((x) => x < 0.05))
    )
      red.push('L/G GEAR NOT DOWN');
    if (s.air.cabinAltitude > 9550) red.push('CAB PR EXCESS CAB ALT');
    // ---- amber ----
    for (let i = 0; i < 2; i++) {
      const p = ctx.engines[i]!;
      const master = (ctx.controls.condition?.[i] ?? 0) >= 0.5;
      if (p.running) this.engineWasRunning[i] = true;
      if (!master) this.engineWasRunning[i] = false;
      if (this.engineWasRunning[i] && !p.running && master) amber.push(`ENG ${i + 1} FAIL`);
    }
    if (fc.law === 'direct' && (air || anyRunning)) amber.push('F/CTL DIRECT LAW');
    if (anyRunning) {
      if (s.hydraulics.green < 1450) amber.push('HYD G SYS LO PR');
      if (s.hydraulics.blue < 1450) amber.push('HYD B SYS LO PR');
      if (s.hydraulics.yellow < 1450) amber.push('HYD Y SYS LO PR');
      if (ctx.engines[0]!.running && s.electrical.source[0] !== 'gen1' && c.get('generator1') === 1)
        amber.push('ELEC GEN 1 FAULT');
      if (ctx.engines[1]!.running && s.electrical.source[1] !== 'gen2' && c.get('generator2') === 1)
        amber.push('ELEC GEN 2 FAULT');
    }
    if (s.electrical.dcBat && !s.electrical.ac1 && (air || anyRunning))
      amber.push('ELEC AC BUS 1 FAULT');
    if (s.electrical.dcBat && !s.electrical.ac2 && (air || anyRunning))
      amber.push('ELEC AC BUS 2 FAULT');
    if (air && !s.adirs.aligned) amber.push('NAV ADR/IR FAULT');
    if (s.electrical.dcBat && s.fuel.tanks[0] < 750) amber.push('FUEL L WING TK LO LVL');
    if (s.electrical.dcBat && s.fuel.tanks[2] < 750) amber.push('FUEL R WING TK LO LVL');
    if (t.systems?.pitotBlocked) amber.push('NAV IAS DISAGREE');
    for (let i = 0; i < 2; i++)
      if (ctx.engines[i]!.running && (ctx.engines[i]!.telemetry.oilPressure ?? 100) < 13)
        amber.push(`ENG ${i + 1} OIL LO PR`);
    if (air && (t.speedbrake ?? 0) > 0.05 && levers.some((x) => x > 0.7))
      amber.push('SPD BRK STILL OUT');
    const w = ecam.warnings;
    w.length = 0;
    for (const r of red) w.push(r);
    for (const a of amber) w.push(a);

    // ---- master lights: new items light them, the buttons put them out ----
    const wb = c.get('masterWarning');
    const cb = c.get('masterCaution');
    for (const r of red)
      if (!this.warned.has(r)) {
        this.warned.add(r);
        ecam.masterWarning = true;
      }
    for (const a of amber)
      if (!this.cautioned.has(a)) {
        this.cautioned.add(a);
        ecam.masterCaution = true;
      }
    for (const r of this.warned) if (!red.includes(r)) this.warned.delete(r);
    for (const a of this.cautioned) if (!amber.includes(a)) this.cautioned.delete(a);
    if ((wb >= 0.5 && this.lastWarningButton < 0.5) || red.length === 0) ecam.masterWarning = false;
    if ((cb >= 0.5 && this.lastCautionButton < 0.5) || amber.length === 0)
      ecam.masterCaution = false;
    this.lastWarningButton = wb;
    this.lastCautionButton = cb;

    // ---- memo ----
    const both = ctx.engines.every((p) => p.running);
    const todo = (ok: boolean, text: string) => (ok ? text : `${text} (NOT DONE)`);
    if (!air && both && ias < 80) {
      memo.push(
        todo(fc.autobrake === 'max', 'T.O AUTO BRK MAX'),
        todo(c.get('seatBelts') > 0, 'SIGNS ON'),
        todo(fc.spoilersArmed, 'SPLRS ARM'),
        todo(config !== '0' && config !== 'FULL', 'FLAPS T.O'),
        todo(!red.some((x) => x.startsWith('CONFIG')), 'T.O CONFIG NORMAL'),
      );
    } else if (air && t.gear > 0.01 && aglFt < 2000) {
      memo.push(
        todo(t.gear >= 0.99, 'LDG GEAR DN'),
        todo(c.get('seatBelts') > 0, 'SIGNS ON'),
        todo(fc.spoilersArmed, 'SPLRS ARM'),
        todo(config === 'FULL' || config === '3', 'FLAPS FULL'),
      );
    }
    if (ctx.controls.parkingBrake) memo.push('PARK BRK');
    if (air && (t.speedbrake ?? 0) > 0.05) memo.push('SPEED BRK');
    if (s.apu.available) memo.push(s.apu.bleed ? 'APU BLEED' : 'APU AVAIL');
    if (s.start.ignition[0] || s.start.ignition[1]) memo.push('IGNITION');
    if (c.get('seatBelts') > 0) memo.push('SEAT BELTS');
    if (s.antiIce.engine[0] || s.antiIce.engine[1]) memo.push('ENG A.ICE');
    if (s.antiIce.wing) memo.push('WING A.ICE');
    if (fc.spoilersArmed && t.onGround && !both) memo.push('GND SPLRS ARMED');
    if (fc.autobrake !== 'off')
      memo.push(
        `AUTO BRK ${fc.autobrake === 'low' ? 'LO' : fc.autobrake === 'medium' ? 'MED' : 'MAX'}`,
      );
    if (s.hydraulics.ptu) memo.push('HYD PTU');
    if (s.hydraulics.rat) memo.push('RAT OUT');
    if (!air && !s.adirs.aligned && c.get('adirs') === 1)
      memo.push(`IR IN ALIGN ${Math.ceil(s.adirs.remaining)} S`);
  }
}
