/**
 * The A320's system controllers, as far as a flight from cold and dark to shutdown touches
 * them. The generic systems (src/sim/systems) carry the batteries' voltage, the fuel tanks'
 * contents, the green system for the gear and the cabin pressure; this module adds what is
 * the Airbus's own:
 *
 * - APU: master switch, start (about 40 s to 95 % and AVAIL two seconds later), bleed and
 *   generator.
 * - Pneumatics: engine bleed (above about 50 % N2), APU bleed with priority, crossbleed (auto:
 *   open with the APU bleed), duct pressures.
 * - Engine start, automatic (FCOM DSC-70): with the mode selector at IGN/START and the
 *   master on, the start valve opens if there is duct pressure; ignition from 16 % N2 (fuel
 *   flows from the master, the engine lights from there), starter cut-out at 50 %, idle at
 *   about 19.5 % N1 / 58.5 % N2. CRANK with the master off turns the engine dry.
 * - ADIRS: alignment takes 60 s here (about ten minutes in the aircraft, shortened so a
 *   cold start stays playable); without it no attitude, and the flight controls in direct law.
 * - Electrical: AC 1 and 2 from their engine's generator, else from external power (on the
 *   ground), the APU generator or the other engine's generator; AC ESS from AC 1 (or AC 2);
 *   DC ESS from the transformer-rectifiers or the batteries. The battery chargers keep the
 *   batteries topped up while AC is on.
 * - Hydraulics: green (engine 1 pump), yellow (engine 2 pump, electric pump), blue (electric
 *   pump, running with an engine or in flight), the power transfer unit between green and
 *   yellow, the ram air turbine on blue when AC is lost in flight. 3000 psi.
 * - Fuel: centre tank first (its pumps run with the slats retracted, the wings hold their
 *   level), the crossfeed lets the fuller wing feed both engines.
 * - Air: packs, anti-ice; the brakes' accumulator.
 */
import type { TypeSystemsContext } from '../controlLaw';
import type { AirbusSystems } from '../avionicsTypes';
import { clamp } from '../math';

const PSI_NOMINAL = 3000;
/** APU: seconds from the start to 95 % (APS 3200, about 40 s from memory) and to AVAIL. */
export const APU_START_TIME = 40;
const APU_AVAIL_DELAY = 2;
/** ADIRS alignment, s (shortened; see above). */
export const ADIRS_ALIGN_TIME = 60;
/** Engine start: duct pressure the start valve needs, psi; ignition N2. */
const START_PSI = 25;
const IGNITION_N2 = 0.16;
const CUTOUT_N2 = 0.5;

export interface SystemsState {
  /** AC 1 / AC 2 have power (displays, fly-by-wire computers, flight guidance). */
  acPowered: boolean;
  dcEssPowered: boolean;
  adirsAligned: boolean;
  green: number;
  blue: number;
  yellow: number;
  /** Ground spoilers, brakes and steering need these. */
  brakePressure: number;
}

export class A320Systems {
  readonly state: SystemsState = {
    acPowered: false,
    dcEssPowered: false,
    adirsAligned: false,
    green: 0,
    blue: 0,
    yellow: 0,
    brakePressure: 0,
  };
  private apuN = 0;
  private apuEgt = 15;
  private apuStarting = false;
  private apuAvailTimer = 0;
  private apuFlap = 0;
  private adirsTimer = 0;
  private first = true;
  private readonly tanks = new Float64Array(3);
  private fuelUsed = 0;
  private accumulator = 3000;
  private lastStartButton = 0;

  reset() {
    this.first = true;
    this.apuN = 0;
    this.apuEgt = 15;
    this.apuStarting = false;
    this.apuAvailTimer = 0;
    this.apuFlap = 0;
    this.adirsTimer = 0;
    this.fuelUsed = 0;
    this.accumulator = 3000;
    this.lastStartButton = 0;
    const s = this.state;
    s.acPowered = false;
    s.dcEssPowered = false;
    s.adirsAligned = false;
    s.green = s.blue = s.yellow = 0;
  }

  step(ctx: TypeSystemsContext, out: AirbusSystems, slatsOut: boolean) {
    const c = ctx.cockpit;
    const dt = ctx.dt;
    const t = ctx.telemetry;
    const e1 = ctx.engines[0]!;
    const e2 = ctx.engines[1]!;
    const n2a = e1.accessorySpeed / 100;
    const n2b = e2.accessorySpeed / 100;
    const elec = ctx.systems.electrical;
    const air = !t.onGround;
    if (this.first) this.initialise(ctx);

    // ---- DC: the batteries (and the TRs once AC is on) ----
    const dcBat = elec.volts > 20;
    out.electrical.dcBat = dcBat;
    out.electrical.batteryVolts[0] = c.get('battery') === 1 ? elec.volts : 0;
    out.electrical.batteryVolts[1] = c.get('battery2') === 1 ? elec.volts : 0;

    // ---- APU ----
    const master = c.get('apuMaster') === 1 && dcBat;
    const button = c.get('apuStart');
    // The air intake flap takes a few seconds to open before the starter may turn.
    this.apuFlap = master ? Math.min(1, this.apuFlap + dt / 3) : 0;
    if (button >= 0.5 && this.lastStartButton < 0.5 && master) this.apuStarting = true;
    this.lastStartButton = button;
    const fuel = ctx.systems.fuel.total > 0;
    if (!master || !fuel) this.apuStarting = false;
    let apuTarget = 0;
    if (master && fuel && (this.apuStarting || this.apuN > 0.9) && this.apuFlap >= 1) apuTarget = 1;
    if (apuTarget > this.apuN) this.apuN = Math.min(1, this.apuN + (0.95 / APU_START_TIME) * dt);
    else this.apuN = Math.max(0, this.apuN - dt / 20);
    if (this.apuN >= 0.95) {
      this.apuStarting = false;
      this.apuAvailTimer += dt;
    } else this.apuAvailTimer = 0;
    const apuAvail = this.apuAvailTimer >= APU_AVAIL_DELAY && this.apuN > 0.9;
    // EGT peaks during the light-off, settles at about 400 °C at no load.
    const ambient = t.engines[0]!.turbineTemperature ?? 15;
    const egtTarget =
      this.apuN > 0.1
        ? this.apuN < 0.95
          ? 300 + 500 * Math.sin(Math.PI * this.apuN)
          : 380
        : ambient;
    this.apuEgt += (egtTarget - this.apuEgt) * (1 - Math.exp(-dt / 3));
    out.apu.master = master;
    out.apu.n = this.apuN * 100;
    out.apu.egt = this.apuEgt;
    out.apu.available = apuAvail;

    // ---- AC sources ----
    const gen1 = c.get('generator1') === 1 && n2a > 0.55 && !ctx.failures.active('alternator');
    const gen2 = c.get('generator2') === 1 && n2b > 0.55;
    const apuGen = apuAvail && c.get('apuGenerator') === 1;
    const ext = !air && c.get('externalPower') === 1;
    const pick = (own: boolean, ownName: string, other: boolean, otherName: string) =>
      own ? ownName : ext ? 'ext' : apuGen ? 'apu' : other ? otherName : 'none';
    const s1 = pick(gen1, 'gen1', gen2, 'gen2');
    const s2 = pick(gen2, 'gen2', gen1, 'gen1');
    const ac1 = s1 !== 'none';
    const ac2 = s2 !== 'none';
    const e = out.electrical;
    e.source[0] = s1;
    e.source[1] = s2;
    e.ac1 = ac1;
    e.ac2 = ac2;
    e.acEss = ac1 || ac2;
    e.dcEss = e.acEss || dcBat;
    out.apu.generator = apuGen && (s1 === 'apu' || s2 === 'apu');
    // The battery chargers top up the batteries while AC is on.
    if (e.acEss)
      for (let i = 0; i < elec.charges.length; i++)
        elec.charges[i] = Math.min(1, elec.charges[i]! + dt / 1800);

    // ---- ADIRS ----
    if (c.get('adirs') === 1 && e.dcEss) {
      this.adirsTimer += dt;
    } else this.adirsTimer = 0;
    const aligned = this.adirsTimer >= ADIRS_ALIGN_TIME;
    out.adirs.aligned = aligned;
    out.adirs.remaining =
      c.get('adirs') === 1 ? Math.max(0, ADIRS_ALIGN_TIME - this.adirsTimer) : 0;

    // ---- pneumatics ----
    const apuBleed = apuAvail && c.get('apuBleed') === 1;
    // The engine bleed valves close while the APU bleed feeds the ducts.
    const bleed1 =
      c.get('bleed1') === 1 && n2a > 0.5 && !apuBleed ? 45 * clamp((n2a - 0.5) / 0.1, 0, 1) : 0;
    const bleed2 =
      c.get('bleed2') === 1 && n2b > 0.5 && !apuBleed ? 45 * clamp((n2b - 0.5) / 0.1, 0, 1) : 0;
    const xbleed = c.get('crossbleed') === 1 || apuBleed;
    let left = Math.max(bleed1, apuBleed ? 38 : 0);
    let right = bleed2;
    if (xbleed) left = right = Math.max(left, right);
    out.bleed[0] = left;
    out.bleed[1] = right;
    out.apu.bleed = apuBleed;

    // ---- engine start ----
    const mode = c.get('engineMode');
    const st = out.start;
    for (let i = 0; i < 2; i++) {
      const plant = ctx.engines[i]!;
      const input = ctx.engineInputs[i]!;
      const n2 = plant.accessorySpeed / 100;
      const masterOn = (ctx.controls.condition?.[i] ?? 0) >= 0.5;
      const duct = i === 0 ? left : right;
      const autoStart = mode === 2 && masterOn && !plant.running && n2 < CUTOUT_N2;
      const crank = mode === 0 && !masterOn && n2 < CUTOUT_N2;
      const valve =
        (autoStart || crank || (plant.cranking && masterOn && mode === 2)) && duct >= START_PSI;
      st.valve[i] = valve && plant.accessorySpeed / 100 < CUTOUT_N2;
      input.starter = st.valve[i]!;
      input.starterPower = st.valve[i] ? clamp(duct / 40, 0, 1) : 0;
      // The igniters fire from 16 % N2 during an automatic start; IGN/START also keeps them
      // on in flight (continuous relight).
      const ign =
        (mode === 2 && masterOn && n2 >= IGNITION_N2 && (st.valve[i] || !plant.running)) ||
        (mode === 2 && air && masterOn);
      st.ignition[i] = ign && e.dcEss;
      input.ignition = st.ignition[i] ? 1 : 0;
      input.continuousIgnition = mode === 2 && air && e.dcEss;
      st.phase[i] = plant.running
        ? n2 >= 0.57
          ? 'idle'
          : 'light-off'
        : st.valve[i]
          ? n2 >= IGNITION_N2 && masterOn
            ? 'ignition'
            : 'starter'
          : masterOn && mode === 2
            ? 'waiting'
            : 'off';
    }

    // ---- hydraulics ----
    const greenPump = c.get('hydGreen') === 1 && n2a > 0.4 && e1.running;
    const yellowPump = c.get('hydYellow') === 1 && n2b > 0.4 && e2.running;
    const yellowElec = c.get('hydYellowElectric') === 1 && ac2;
    const anyEngine = e1.running || e2.running;
    const blueElec = c.get('hydBlue') === 1 && (ac1 || ac2) && (anyEngine || air);
    const rat = air && !e.acEss && t.ias > 50;
    let gTarget = greenPump ? PSI_NOMINAL : 0;
    let yTarget = yellowPump || yellowElec ? PSI_NOMINAL : 0;
    const bTarget = blueElec ? PSI_NOMINAL : rat ? 2500 : 0;
    // PTU: runs when the two differ by more than 500 psi and one engine pump drives.
    let ptu = false;
    if (anyEngine && Math.abs(this.state.green - this.state.yellow) > 500) {
      if (gTarget > 0 && yTarget === 0) yTarget = 2800;
      if (yTarget > 0 && gTarget === 0) gTarget = 2800;
      ptu = true;
    }
    const s = this.state;
    s.green = approach(s.green, gTarget, dt);
    s.yellow = approach(s.yellow, yTarget, dt);
    s.blue = approach(s.blue, bTarget, dt);
    const h = out.hydraulics;
    h.green = s.green;
    h.blue = s.blue;
    h.yellow = s.yellow;
    h.ptu = ptu && (gTarget === 2800 || yTarget === 2800);
    h.rat = rat;
    // Brakes: green normally, the yellow accumulator for the parking brake and alternate.
    const brakeSource = Math.max(s.green, s.yellow);
    this.accumulator = Math.max(this.accumulator, s.yellow);
    s.brakePressure = Math.max(brakeSource, this.accumulator * 0.98);
    out.brakes.pressure = s.brakePressure;
    out.brakes.parking = ctx.controls.parkingBrake;
    out.brakes.antiSkid = e.dcEss;

    // ---- fuel ----
    this.fuel(ctx, out, slatsOut, ac1 || ac2);

    // ---- air ----
    const packs = out.air.packs;
    packs[0] = c.get('pack1') === 1 && left > 15;
    packs[1] = c.get('pack2') === 1 && right > 15;
    const sys = t.systems;
    out.air.cabinAltitude = (sys?.cabinAltitude ?? 0) / 0.3048;
    out.air.cabinRate = ((sys?.cabinRate ?? 0) / 0.3048) * 60;
    out.air.differential = (sys?.cabinDifferential ?? 0) / 6894.757;
    out.antiIce.wing = c.get('wingAntiIce') === 1 && Math.max(left, right) > 15;
    out.antiIce.engine[0] = c.get('engineAntiIce1') === 1 && e1.running;
    out.antiIce.engine[1] = c.get('engineAntiIce2') === 1 && e2.running;

    s.acPowered = e.acEss;
    s.dcEssPowered = e.dcEss;
    s.adirsAligned = aligned;
  }

  /** A start with the engines running finds the aircraft as a crew would have it. */
  private initialise(ctx: TypeSystemsContext) {
    this.first = false;
    const running = ctx.engines.some((p) => p.running);
    const fuel = ctx.systems.fuel.amount;
    for (let i = 0; i < 3; i++) this.tanks[i] = fuel[i]!;
    if (running && ctx.cockpit.get('adirs') === 1) this.adirsTimer = ADIRS_ALIGN_TIME;
    if (running) {
      const p = PSI_NOMINAL;
      this.state.green = this.state.blue = this.state.yellow = p;
    }
  }

  /**
   * Centre tank first, as the A320's pumps do it: the generic system draws every engine's
   * fuel evenly from the tanks that feed it; this puts what came out of the wrong tank back.
   */
  private fuel(ctx: TypeSystemsContext, out: AirbusSystems, slatsOut: boolean, ac: boolean) {
    const c = ctx.cockpit;
    const a = ctx.systems.fuel.amount;
    const prev = this.tanks;
    const f = out.fuel;
    const pumpL = c.get('fuelPumpsLeft') === 1 && ac;
    const pumpR = c.get('fuelPumpsRight') === 1 && ac;
    const anyEngine = ctx.engines.some((p) => p.running);
    // AUTO: the centre pumps run with an engine running and the slats retracted.
    const pumpC = c.get('fuelPumpsCenter') === 1 && ac && anyEngine && !slatsOut && a[2]! > 0;
    f.pumps.left = pumpL;
    f.pumps.right = pumpR;
    f.pumps.centre = pumpC;
    f.crossfeed = c.get('fuelCrossfeed') === 1;
    // A refuelling (or a reset) between two steps: start again from what is there.
    if (a[0]! > prev[0]! + 1e-6 || a[1]! > prev[1]! + 1e-6 || a[2]! > prev[2]! + 1e-6) {
      for (let i = 0; i < 3; i++) prev[i] = a[i]!;
    }
    const dl = prev[0]! - a[0]!;
    const dr = prev[1]! - a[1]!;
    const dc = prev[2]! - a[2]!;
    const burn = dl + dr + dc;
    this.fuelUsed += Math.max(0, burn);
    if (pumpC) {
      // The wings stay full while the centre tank feeds.
      const fromCentre = Math.min(prev[2]!, burn);
      a[2] = prev[2]! - fromCentre;
      const rest = burn - fromCentre;
      a[0] = prev[0]! - rest / 2;
      a[1] = prev[1]! - rest / 2;
    } else {
      // Without its pumps the centre tank gives nothing; each engine draws its own wing.
      a[2] = prev[2]!;
      a[0] = prev[0]! - dl - dc / 2;
      a[1] = prev[1]! - dr - dc / 2;
    }
    if (f.crossfeed && (pumpL || pumpR)) {
      // The fuller wing feeds both engines.
      const diff = a[0]! - a[1]!;
      const move = clamp(diff / 2, -2 * ctx.dt, 2 * ctx.dt);
      a[0] = a[0]! - move;
      a[1] = a[1]! + move;
    }
    for (let i = 0; i < 3; i++) {
      a[i] = Math.max(0, a[i]!);
      prev[i] = a[i]!;
    }
    f.tanks[0] = a[0]!;
    f.tanks[1] = a[2]!;
    f.tanks[2] = a[1]!;
    f.used = this.fuelUsed;
  }
}

/** Pressure builds within a second; without a pump the accumulators bleed down slowly. */
function approach(p: number, target: number, dt: number) {
  const tau = target > p ? 0.6 : 15;
  return p + (target - p) * (1 - Math.exp(-dt / tau));
}
