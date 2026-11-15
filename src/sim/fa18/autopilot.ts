/**
 * The Hornet's flight guidance as its mission computer flies it through the flight control
 * system (NATOPS, automatic flight control): attitude hold (ATT), heading select (HSEL),
 * barometric and radar altitude hold (BALT, RALT), coupled steering to the selected source
 * (CPL WYPT on the GPS flight plan, CPL TCN on the TACAN, CPL ILS on the localizer of NAV 1,
 * lateral only), and the automatic throttle control (ATC): airspeed hold up and away,
 * on-speed angle of attack in the powered approach. The paddle switch disconnects the
 * autopilot; the autopilot modes are available with the flaps in AUTO only.
 *
 * It flies the stick: with the FCS's load factor command a neutral stick already holds the
 * flight path, so the outer loops only ask for the change of flight path angle and bank.
 */
import type { AutopilotCommand, AutopilotTelemetry, AvionicsInput } from '../avionicsTypes';
import type { AutopilotComputer, AutopilotContext } from '../avionics/config';
import { DEG, FT, KT, clamp } from '../math';
import { FA18_FCS } from './fcs';

const G = 9.80665;
const DISCONNECT_WARNING_S = 2;
/** The ATC flies the throttles between idle and military power. */
const ATC_MAX = 0.75;
const RADAR_LIMIT = 5000 * FT;

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

type Lateral = 'att' | 'hsel' | 'cpl';
type Vertical = 'att' | 'balt' | 'ralt';

export class Fa18Autopilot implements AutopilotComputer {
  readonly telemetry: AutopilotTelemetry = {
    engaged: false,
    lateral: 'roll',
    lateralArmed: undefined,
    vertical: 'pitch',
    verticalArmed: undefined,
    selectedAltitude: 0,
    selectedVerticalSpeed: 0,
    disconnectWarning: false,
    selectedSpeed: 0,
    autothrottle: { engaged: false, mode: 'off' },
    annunciations: [],
  };
  private readonly out: AutopilotCommand = { roll: 0, pitch: 0, pitchTrim: 0 };
  private lateral: Lateral = 'att';
  private vertical: Vertical = 'att';
  private bankHold = 0;
  private headingHold = 0;
  private pitchHold = 0;
  private altitudeHold = 0;
  private radarHold = 0;
  private gammaIntegral = 0;
  private atc = false;
  private atcMode: 'speed' | 'aoa' = 'speed';
  private atcSpeed = 0;
  private throttle = 0;
  private warning = 0;
  private override = 0;
  private lastBank = NaN;
  private rollRate = 0;
  private source = 'nav1';

  get command(): AutopilotCommand | undefined {
    return this.telemetry.engaged || this.atc ? this.out : undefined;
  }

  reset() {
    const t = this.telemetry;
    t.engaged = false;
    t.lateral = 'roll';
    t.vertical = 'pitch';
    t.disconnectWarning = false;
    t.autothrottle = { engaged: false, mode: 'off' };
    t.annunciations = [];
    this.atc = false;
    this.warning = 0;
    this.override = 0;
    this.lastBank = NaN;
    this.rollRate = 0;
    this.gammaIntegral = 0;
  }

  step(dt: number, ctx: AutopilotContext) {
    const t = this.telemetry;
    const input = ctx.input;
    const cockpit = ctx.cockpit;
    const flapsAuto = cockpit.get('flaps') === 0;
    this.source = ctx.source;
    this.warning = Math.max(0, this.warning - dt);
    this.trackRates(dt, input);
    if (!input.powered) {
      if (t.engaged) this.disconnect();
      this.atc = false;
    } else {
      const pressed = ctx.pressed;
      if (pressed('apDisconnect') && t.engaged) this.disconnect();
      if (t.engaged) {
        const firm = Math.abs(input.pilotPitch) > 0.4 || Math.abs(input.pilotRoll) > 0.4;
        this.override = firm ? this.override + dt : 0;
        if (this.override > 0.25 || !flapsAuto || input.onGround) this.disconnect();
      }
      const engage = () => {
        if (t.engaged || input.onGround || !flapsAuto) return t.engaged;
        t.engaged = true;
        this.lateral = 'att';
        this.vertical = 'att';
        this.bankHold = Math.abs(input.bank) < 5 * DEG ? 0 : input.bank;
        this.headingHold = input.indicatedHeading;
        this.pitchHold = input.pitch;
        this.gammaIntegral = 0;
        this.override = 0;
        return true;
      };
      if (pressed('apEngage')) {
        if (t.engaged) this.disconnect();
        else engage();
      }
      if (pressed('apAttitude') && engage()) {
        this.lateral = 'att';
        this.vertical = 'att';
        this.bankHold = Math.abs(input.bank) < 5 * DEG ? 0 : input.bank;
        this.headingHold = input.indicatedHeading;
        this.pitchHold = input.pitch;
      }
      if (pressed('apHdg') && engage()) this.lateral = this.lateral === 'hsel' ? 'att' : 'hsel';
      if (pressed('apNav') && engage())
        this.lateral = this.lateral === 'cpl' || !ctx.lateral.valid ? 'att' : 'cpl';
      if (pressed('apAlt') && engage()) {
        this.vertical = this.vertical === 'balt' ? 'att' : 'balt';
        this.altitudeHold = input.indicatedAltitude;
        this.pitchHold = input.pitch;
      }
      if (pressed('apRadarAlt') && engage()) {
        const ra = input.radarAltitude;
        if (this.vertical === 'ralt' || ra === undefined || ra > RADAR_LIMIT) this.vertical = 'att';
        else {
          this.vertical = 'ralt';
          this.radarHold = ra;
        }
      }
      if (this.lateral === 'cpl' && !ctx.lateral.valid) this.lateral = 'att';
      if (this.vertical === 'ralt' && (input.radarAltitude ?? Infinity) > RADAR_LIMIT)
        this.vertical = 'att';
      if (pressed('athr')) {
        if (this.atc || input.onGround) this.atc = false;
        else {
          this.atc = true;
          this.atcSpeed = input.ias;
          this.throttle = 0.5 * (cockpit.get('throttle1') + cockpit.get('throttle2'));
        }
      }
      this.atcMode = flapsAuto ? 'speed' : 'aoa';
      if (input.onGround) this.atc = false;
    }

    // ---- fly ----
    this.out.pitchTrim = cockpit.get('trim');
    if (t.engaged) {
      this.out.roll = this.flyLateral(input, ctx, cockpit.get('headingBug'));
      this.out.pitch = this.flyVertical(dt, input);
    } else {
      this.out.roll = input.pilotRoll;
      this.out.pitch = input.pilotPitch;
    }
    if (this.atc) {
      this.flyThrottle(dt, input);
      this.out.throttle = this.throttleOut;
    } else this.out.throttle = undefined;

    // ---- telemetry ----
    t.lateral = this.lateral === 'hsel' ? 'hdg' : this.lateral === 'cpl' ? 'nav' : 'roll';
    t.vertical = this.vertical === 'att' ? 'pitch' : 'alt';
    t.selectedAltitude = this.vertical === 'ralt' ? this.radarHold / FT : this.altitudeHold / FT;
    t.selectedSpeed = this.atcSpeed / KT;
    t.autothrottle = { engaged: this.atc, mode: this.atc ? 'speed' : 'off' };
    t.disconnectWarning = this.warning > 0;
    const ann = t.annunciations!;
    ann.length = 0;
    if (t.engaged) {
      if (this.lateral === 'hsel') ann.push('HSEL');
      else if (this.lateral === 'cpl')
        ann.push(
          this.source === 'gps' ? 'CPL WYPT' : this.source === 'nav2' ? 'CPL TCN' : 'CPL ILS',
        );
      if (this.vertical === 'balt') ann.push('BALT');
      else if (this.vertical === 'ralt') ann.push('RALT');
      if (this.lateral === 'att' && this.vertical === 'att') ann.push('ATT');
    }
    if (this.atc) ann.push('ATC');
  }

  private disconnect() {
    this.telemetry.engaged = false;
    this.override = 0;
    this.warning = DISCONNECT_WARNING_S;
  }

  private flyLateral(input: AvionicsInput, ctx: AutopilotContext, bug: number): number {
    let bank: number;
    const heading = input.indicatedHeading;
    if (this.lateral === 'hsel') bank = clamp(1.2 * wrap180(bug - heading), -30, 30) * DEG;
    else if (this.lateral === 'cpl') {
      const g = ctx.lateral;
      const distance = this.source === 'nav1' ? 1200 : 2500;
      const intercept = clamp(g.offset / distance / DEG, -45, 45);
      bank = clamp(1.2 * wrap180(g.course + intercept - heading), -30, 30) * DEG;
    } else if (this.bankHold === 0)
      bank = clamp(1.0 * wrap180(this.headingHold - heading), -10, 10) * DEG;
    else bank = this.bankHold;
    // The FCS flies roll rate: ask for a rate towards the bank.
    const rateCmd = clamp(1.2 * (bank - input.bank), -20 * DEG, 20 * DEG);
    const stick = (rateCmd - 0.3 * (this.rollRate - rateCmd)) / (0.35 * FA18_FCS.rollRate);
    return clamp(stick, -0.4, 0.4);
  }

  private flyVertical(dt: number, input: AvionicsInput): number {
    const v = Math.max(input.tas ?? input.ias, 50);
    const gamma = Math.asin(clamp(input.verticalSpeed / v, -1, 1));
    let gammaCmd: number;
    if (this.vertical === 'balt') {
      const vs = clamp((this.altitudeHold - input.indicatedAltitude) / 6, -40, 40);
      gammaCmd = Math.asin(clamp(vs / v, -0.5, 0.5));
    } else if (this.vertical === 'ralt') {
      const vs = clamp(
        ((this.radarHold - (input.radarAltitude ?? this.radarHold)) * 1) / 4,
        -30,
        30,
      );
      gammaCmd = Math.asin(clamp(vs / v, -0.5, 0.5));
    } else {
      // Attitude hold: the pitch held, as flight path change (the angle of attack barely moves).
      gammaCmd = gamma + clamp(this.pitchHold - input.pitch, -10 * DEG, 10 * DEG);
    }
    const err = clamp(gammaCmd - gamma, -15 * DEG, 15 * DEG);
    this.gammaIntegral = clamp(this.gammaIntegral + 0.15 * err * dt, -0.05, 0.05);
    // Load factor change for that flight path rate, as the FCS's stick gearing near centre.
    const dn = ((v / G) * 0.6 * (err + this.gammaIntegral)) / Math.max(Math.cos(input.bank), 0.5);
    const stick = clamp(dn, -1.5, 1.5) / (0.35 * (FA18_FCS.gLimit - 1));
    return clamp(stick, -0.4, 0.4);
  }

  /** ATC: an integral throttle position plus a proportional part on the error. */
  private flyThrottle(dt: number, input: AvionicsInput) {
    let err: number;
    let kp: number;
    let ki: number;
    if (this.atcMode === 'speed') {
      err = (this.atcSpeed - input.ias) / KT;
      kp = 0.012;
      ki = 0.004;
    } else {
      // Slow (angle of attack high): more thrust.
      err = ((input.alpha ?? FA18_FCS.onSpeedAlpha) - FA18_FCS.onSpeedAlpha) / DEG;
      kp = 0.06;
      ki = 0.03;
    }
    this.throttle = clamp(this.throttle + ki * err * dt, 0, ATC_MAX);
    this.throttleOut = clamp(this.throttle + kp * err, 0, ATC_MAX);
  }

  private throttleOut = 0;

  private trackRates(dt: number, input: AvionicsInput) {
    if (Number.isNaN(this.lastBank)) this.lastBank = input.bank;
    let db = input.bank - this.lastBank;
    if (db > Math.PI) db -= 2 * Math.PI;
    else if (db < -Math.PI) db += 2 * Math.PI;
    this.rollRate += Math.min(1, dt / 0.05) * (db / dt - this.rollRate);
    this.lastBank = input.bank;
  }
}
