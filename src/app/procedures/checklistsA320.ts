/**
 * The Airbus A320 in the manner of the flight crew operating manual's standard operating
 * procedures: each list is the flow the crew does from memory, ending in the items the
 * written checklist reads back, condensed to what the simulated cockpit has. Take-off,
 * landing, go-around and the rejected take-off list their callouts as items, as the pilot
 * monitoring would call them. Control names are those of A320_CONTROLS.
 *
 * Figures: thrust lever detents on the 0..1 travel idle 0, CLB 0.62, FLX/MCT 0.82, TOGA 1
 * (as the cockpit defines them); 250 kt below FL 100; transition altitude 7000 ft in
 * Switzerland; CFM56-5B EGT limit 725 °C at the start; reversers to idle at 70 kt; the
 * speeds that depend on the mass (V1, VR, V2, VAPP) are given as typical ranges for a
 * medium mass (VR about 140–150 kt, VAPP about 130–140 kt), not as one number.
 *
 * Left out on purpose: the engine fire (not simulated) and the dual hydraulic failure (too
 * deep for the simulated systems).
 */
import {
  AIRBORNE,
  AS_REQUIRED,
  CHECK,
  COMPLETE,
  type ChecklistDef,
  OFF,
  ON,
  SET,
  UP,
  all,
  any,
  is,
  item,
  range,
  t,
  tel,
} from './checklists';

const ARMED = t('SCHARF', 'ARMED');
const DISARMED = t('ENTSCHÄRFT', 'DISARMED');
const IDLE_BOTH = all(range('throttle1', 0, 0.03), range('throttle2', 0, 0.03));
/** The levers in the CLB detent (0.62), with the play of a hand on them. */
const CLIMB_DETENT = all(range('throttle1', 0.58, 0.66), range('throttle2', 0.58, 0.66));

const parkingBrakeOn = item(
  'parkingBrake',
  t('Parkbremse', 'Parking brake'),
  ON,
  is('parkingBrake', 1),
);
const baroStd = item(
  'baroStd',
  t(
    'Höhenmesser (über 7000 ft, Übergangshöhe)',
    'Baro reference (above 7000 ft, transition altitude)',
  ),
  t('STD', 'STD'),
  tel('baroStd', 1),
);
const baroQnh = item(
  'baroQnh',
  t('Höhenmesser (unter der Übergangsfläche)', 'Baro reference (below transition level)'),
  t('QNH GESETZT', 'QNH SET'),
  tel('baroStd', undefined, 0),
);

export const A320_CHECKLISTS: readonly ChecklistDef[] = [
  {
    id: 'cockpitPreparation',
    title: t('Cockpitvorbereitung (Cold and Dark)', 'Cockpit preparation (cold and dark)'),
    kind: 'normal',
    items: [
      item(
        'batteries',
        t('Batterien 1 und 2', 'Batteries 1 and 2'),
        t('EIN (über 25,5 V)', 'ON (above 25.5 V)'),
        all(is('battery', 1), is('battery2', 1)),
      ),
      item(
        'power',
        t('Bodenstrom oder APU', 'External power or APU'),
        t('EIN (APU: MASTER, START, AVAIL)', 'ON (APU: MASTER, START, AVAIL)'),
        any(is('externalPower', 1), is('apuMaster', 1)),
      ),
      item(
        'apuBleed',
        t('APU-Zapfluft', 'APU bleed'),
        t('EIN (sobald APU AVAIL)', 'ON (when APU AVAIL)'),
      ),
      item(
        'adirs',
        t('ADIRS 1, 2, 3', 'ADIRS 1, 2, 3'),
        t('NAV (Ausrichtung läuft)', 'NAV (alignment)'),
        is('adirs', 'nav'),
      ),
      item('navLights', t('Positionslichter', 'Navigation lights'), ON, is('lightNav', 1)),
      item(
        'fuelPumps',
        t('Treibstoffpumpen (links, Mitte, rechts)', 'Fuel pumps (left, centre, right)'),
        ON,
        all(is('fuelPumpsLeft', 1), is('fuelPumpsCenter', 1), is('fuelPumpsRight', 1)),
      ),
      item('crossfeed', t('Crossfeed', 'Fuel crossfeed'), OFF, is('fuelCrossfeed', 0)),
      item(
        'hydraulics',
        t('Hydraulik (Grün, Gelb, Blau)', 'Hydraulics (green, yellow, blue)'),
        t('PUMPEN EIN, Gelb elektrisch AUS', 'PUMPS ON, yellow electric pump OFF'),
        all(is('hydGreen', 1), is('hydYellow', 1), is('hydBlue', 1), is('hydYellowElectric', 0)),
      ),
      item(
        'bleeds',
        t('Zapfluft, Packs', 'Bleeds and packs'),
        ON,
        all(is('bleed1', 1), is('bleed2', 1), is('pack1', 1), is('pack2', 1)),
      ),
      item(
        'probeHeat',
        t('Sonden- und Scheibenheizung', 'Probe and window heat'),
        t('AUTO', 'AUTO'),
        is('probeHeat', 0),
      ),
      item('seatBelts', t('Anschnallzeichen', 'Seat belt signs'), ON, is('seatBelts', 'on')),
      item('fd', t('Flugregler (FD)', 'Flight directors'), ON, is('flightDirector', 1)),
      item(
        'altimeter',
        t('Höhenmesser', 'Baro reference'),
        t('AUF QNH', 'SET to QNH'),
        tel('baroStd', undefined, 0),
      ),
      item(
        'fcuAltitude',
        t('FCU: erste Freigabehöhe', 'FCU: initial cleared altitude'),
        SET,
        range('fcuAltitude', 3000, 7000),
      ),
      item(
        'flightPlan',
        t('Flugplan, Startdaten', 'Flight plan and takeoff data'),
        t('EINGEGEBEN, GEPRÜFT', 'ENTERED and CHECKED'),
      ),
      item(
        'xpdrCode',
        t('Transponder', 'Transponder'),
        t('CODE GESETZT, STBY', 'CODE SET, STBY'),
        is('xpdrMode', 'standby'),
      ),
    ],
  },
  {
    id: 'beforeStart',
    title: t('Vor dem Anlassen', 'Before start'),
    kind: 'normal',
    items: [
      item(
        'clearance',
        t('Start- und Push-back-Freigabe', 'Start-up and push-back clearance'),
        t('ERHALTEN', 'OBTAINED'),
      ),
      item('doors', t('Türen', 'Doors'), t('ZU', 'CLOSED')),
      item('beacon', t('Blitzlicht (BEACON)', 'Beacon'), ON, is('lightBeacon', 1)),
      item('thrustLevers', t('Schubhebel', 'Thrust levers'), t('LEERLAUF', 'IDLE'), IDLE_BOTH),
      parkingBrakeOn,
      item('adirs', t('ADIRS', 'ADIRS'), t('NAV', 'NAV'), is('adirs', 'nav')),
      item('fuel', t('Treibstoffmenge', 'Fuel quantity'), CHECK),
      item(
        'takeoffData',
        t('Startdaten (V1, VR, V2, FLEX)', 'Takeoff data (V1, VR, V2, FLEX)'),
        SET,
      ),
      item(
        'externalPowerOff',
        t('Bodenstrom', 'External power'),
        t('AUS (APU läuft)', 'OFF (APU running)'),
        is('externalPower', 0),
      ),
    ],
  },
  {
    id: 'engineStart',
    title: t('Anlassen der Triebwerke', 'Engine start'),
    kind: 'normal',
    items: [
      item('apuBleed', t('APU-Zapfluft', 'APU bleed'), ON, is('apuBleed', 1)),
      item(
        'mode',
        t('Triebwerkwahlschalter', 'Engine mode selector'),
        t('IGN/START', 'IGN/START'),
        is('engineMode', 'ignitionStart'),
      ),
      item('master2', t('Triebwerk 2 Master', 'Engine 2 master'), ON, is('engineMaster2', 1)),
      item(
        'n2Rising2',
        t('Triebwerk 2: N2', 'Engine 2: N2'),
        t('STEIGT', 'RISING'),
        tel('n2', 10, undefined, 1),
      ),
      item(
        'egt2',
        t('Triebwerk 2: EGT', 'Engine 2: EGT'),
        t('ÜBERWACHEN (höchstens 725 °C)', 'MONITOR (725 °C max)'),
        all(tel('engineRunning', 1, undefined, 1), tel('itt', undefined, 725, 1)),
      ),
      item(
        'idle2',
        t('Triebwerk 2: Leerlauf', 'Engine 2: idle'),
        t('STABIL (N2 um 58 %)', 'STABLE (N2 about 58 %)'),
        tel('n2', 55, undefined, 1),
      ),
      item('master1', t('Triebwerk 1 Master', 'Engine 1 master'), ON, is('engineMaster1', 1)),
      item(
        'egt1',
        t('Triebwerk 1: EGT', 'Engine 1: EGT'),
        t('ÜBERWACHEN (höchstens 725 °C)', 'MONITOR (725 °C max)'),
        all(tel('engineRunning', 1, undefined, 0), tel('itt', undefined, 725, 0)),
      ),
      item(
        'idle1',
        t('Triebwerk 1: Leerlauf', 'Engine 1: idle'),
        t('STABIL (N2 um 58 %)', 'STABLE (N2 about 58 %)'),
        tel('n2', 55, undefined, 0),
      ),
      item(
        'modeNorm',
        t('Triebwerkwahlschalter', 'Engine mode selector'),
        t('NORM', 'NORM'),
        is('engineMode', 'normal'),
      ),
    ],
  },
  {
    id: 'afterStart',
    title: t('Nach dem Anlassen', 'After start'),
    kind: 'normal',
    items: [
      item('apuBleedOff', t('APU-Zapfluft', 'APU bleed'), OFF, is('apuBleed', 0)),
      item(
        'apuOff',
        t('APU Master', 'APU master'),
        t('AUS (wenn nicht benötigt)', 'OFF (unless required)'),
        is('apuMaster', 0),
      ),
      item('antiIce', t('Triebwerkenteisung', 'Engine anti-ice'), AS_REQUIRED),
      item('ecam', t('ECAM-Status', 'ECAM status'), CHECK),
      item('spoilers', t('Ground Spoiler', 'Ground spoilers'), ARMED, is('spoilersArmed', 1)),
      item(
        'rudderTrim',
        t('Seitenrudertrimmung', 'Rudder trim'),
        t('NULL', 'ZERO'),
        range('rudderTrim', -0.02, 0.02),
      ),
      item(
        'pitchTrim',
        t('Höhenrudertrimmung', 'Pitch trim'),
        t('FÜR DEN START GESETZT', 'SET for takeoff'),
      ),
      item(
        'flaps',
        t('Landeklappen', 'Flaps'),
        t('START (1, 2 oder 3)', 'TAKEOFF (1, 2 or 3)'),
        is('flaps', ['1', '2', '3']),
      ),
    ],
  },
  {
    id: 'taxi',
    title: t('Rollen', 'Taxi'),
    kind: 'normal',
    items: [
      item('taxiClearance', t('Rollfreigabe', 'Taxi clearance'), t('ERHALTEN', 'OBTAINED')),
      item(
        'noseLight',
        t('Bugscheinwerfer', 'Nose light'),
        t('TAXI', 'TAXI'),
        is('lightNose', 'taxi'),
      ),
      item('parkingBrakeOff', t('Parkbremse', 'Parking brake'), OFF, is('parkingBrake', 0)),
      item('brakes', t('Bremsen', 'Brakes'), CHECK),
      item(
        'flightControls',
        t('Steuerung (Sidestick, Pedale)', 'Flight controls (sidestick, pedals)'),
        CHECK,
      ),
      item('autobrake', t('Autobrake', 'Auto brake'), t('MAX', 'MAX'), is('autobrake', 'max')),
      item('fcu', t('FCU: Freigabehöhe, Kurs', 'FCU: cleared altitude, heading'), SET),
      item('briefing', t('Startbriefing', 'Takeoff briefing'), COMPLETE),
    ],
  },
  {
    id: 'beforeTakeoff',
    title: t('Vor dem Start (unter dem Strich)', 'Before takeoff (below the line)'),
    kind: 'normal',
    items: [
      item('cabin', t('Kabine', 'Cabin'), t('BEREIT', 'READY')),
      item(
        'xpdr',
        t('Transponder, TCAS', 'Transponder and TCAS'),
        t('ON / TA-RA', 'ON / TA-RA'),
        is('xpdrMode', ['on', 'alt']),
      ),
      item('strobe', t('Blitzlichter (STROBE)', 'Strobe lights'), ON, is('lightStrobe', 'on')),
      item('landingLights', t('Landescheinwerfer', 'Landing lights'), ON, is('lightLanding', 1)),
      item(
        'noseLight',
        t('Bugscheinwerfer', 'Nose light'),
        t('T.O.', 'T.O.'),
        is('lightNose', 'takeoff'),
      ),
      item(
        'turnoff',
        t('Abrollscheinwerfer', 'Runway turn-off lights'),
        ON,
        is('lightRunwayTurnoff', 1),
      ),
      item('packs', t('Packs', 'Packs'), AS_REQUIRED),
      item('runway', t('Startpiste', 'Takeoff runway'), t('BESTÄTIGT', 'CONFIRMED')),
    ],
  },
  {
    id: 'takeoff',
    title: t('Start', 'Takeoff'),
    kind: 'normal',
    items: [
      item(
        'n1Stable',
        t('Schubhebel auf 50 % N1', 'Thrust levers to 50 % N1'),
        t('STABIL', 'STABILISED'),
        all(tel('n1', 45, undefined, 0), tel('n1', 45, undefined, 1)),
      ),
      item(
        'thrustSet',
        t('«FLEX» oder «TOGA» – «Thrust set»', '"FLEX" or "TOGA" – "Thrust set"'),
        t('SCHUBHEBEL FLX/MCT oder TOGA', 'THRUST LEVERS FLX/MCT or TOGA'),
        all(range('throttle1', 0.78), range('throttle2', 0.78)),
      ),
      item(
        'hundred',
        t('«Hundert Knoten»', '"One hundred knots"'),
        t('GEPRÜFT', 'CHECKED'),
        tel('iasKt', 100),
      ),
      item('v1', t('«V1»', '"V1"'), t('HAND VON DEN SCHUBHEBELN', 'HAND OFF THE THRUST LEVERS')),
      item(
        'rotate',
        t('«Rotate»', '"Rotate"'),
        t('VR (um 140–150 kt)', 'VR (about 140–150 kt)'),
        tel('iasKt', 135),
      ),
      item(
        'positiveClimb',
        t('«Positive climb» – «Gear up»', '"Positive climb" – "Gear up"'),
        UP,
        all(AIRBORNE, is('gear', 0)),
      ),
      item(
        'thrustReduction',
        t('«LVR CLB» (Schubreduktionshöhe)', '"LVR CLB" (thrust reduction altitude)'),
        t('SCHUBHEBEL CLB', 'THRUST LEVERS CLB'),
        all(AIRBORNE, CLIMB_DETENT),
      ),
      item(
        'flaps1',
        t('«Flaps 1» (bei F)', '"Flaps 1" (at F speed)'),
        t('KLAPPEN 1', 'FLAPS 1'),
        is('flaps', ['1', '0']),
      ),
      item(
        'flaps0',
        t('«Flaps zero» (bei S)', '"Flaps zero" (at S speed)'),
        t('KLAPPEN 0', 'FLAPS 0'),
        is('flaps', '0'),
      ),
      item(
        'spoilersDisarm',
        t('Ground Spoiler', 'Ground spoilers'),
        DISARMED,
        is('spoilersArmed', 0),
      ),
    ],
  },
  {
    id: 'climb',
    title: t('Nach dem Start, Steigflug', 'After takeoff and climb'),
    kind: 'normal',
    items: [
      item(
        'gear',
        t('Fahrwerk', 'Landing gear'),
        UP,
        all(is('gear', 0), tel('gear', undefined, 0.01)),
      ),
      item('flaps', t('Landeklappen', 'Flaps'), t('EINGEFAHREN', 'RETRACTED'), is('flaps', '0')),
      item('noseLight', t('Bugscheinwerfer', 'Nose light'), OFF, is('lightNose', 'off')),
      item('packs', t('Packs', 'Packs'), ON, all(is('pack1', 1), is('pack2', 1))),
      item(
        'speed250',
        t('Fahrt unter FL 100', 'Speed below FL 100'),
        t('250 kt HÖCHSTENS', '250 KT MAX'),
      ),
      baroStd,
      item(
        'landingLights',
        t('Landescheinwerfer (FL 100)', 'Landing lights (FL 100)'),
        OFF,
        is('lightLanding', 0),
      ),
      item('seatBelts', t('Anschnallzeichen', 'Seat belt signs'), AS_REQUIRED),
    ],
  },
  {
    id: 'cruise',
    title: t('Reiseflug', 'Cruise'),
    kind: 'normal',
    items: [
      item(
        'level',
        t('Reiseflughöhe', 'Cruise level'),
        t('ERREICHT', 'REACHED'),
        tel('verticalSpeedFpm', -300, 300),
      ),
      item(
        'mach',
        t('Reisegeschwindigkeit', 'Cruise speed'),
        t('M 0,76–0,78', 'M .76–.78'),
        tel('mach', 0.72, 0.8),
      ),
      item('ecam', t('ECAM', 'ECAM'), CHECK),
      item('fuel', t('Treibstoff, Verbrauch', 'Fuel and fuel used'), CHECK),
    ],
  },
  {
    id: 'descent',
    title: t('Sinkflugvorbereitung', 'Descent preparation'),
    kind: 'normal',
    phase: 'descent',
    items: [
      item(
        'weather',
        t('ATIS, Wetter am Ziel', 'ATIS and destination weather'),
        t('ERHALTEN', 'OBTAINED'),
      ),
      item('landingElevation', t('Landeplatzhöhe', 'Landing elevation'), CHECK),
      item('briefing', t('Anflugbriefing', 'Approach briefing'), COMPLETE),
      item(
        'autobrake',
        t('Autobrake', 'Auto brake'),
        t('LOW oder MED', 'LOW or MED'),
        is('autobrake', ['low', 'medium']),
      ),
      item(
        'ils',
        t('ILS auf NAV 1', 'ILS on NAV 1'),
        t('GERASTET, KURS GESETZT', 'TUNED, COURSE SET'),
      ),
      item(
        'topOfDescent',
        t('Sinkflugbeginn', 'Top of descent'),
        t('3 NM je 1000 ft', '3 NM per 1000 FT'),
      ),
    ],
  },
  {
    id: 'approach',
    title: t('Anflug', 'Approach'),
    kind: 'normal',
    belowFt: 10_000,
    items: [
      baroQnh,
      item(
        'speed250',
        t('Fahrt unter FL 100', 'Speed below FL 100'),
        t('250 kt HÖCHSTENS', '250 KT MAX'),
        tel('iasKt', undefined, 255),
      ),
      item('landingLights', t('Landescheinwerfer', 'Landing lights'), ON, is('lightLanding', 1)),
      item('seatBelts', t('Anschnallzeichen', 'Seat belt signs'), ON, is('seatBelts', 'on')),
      item('ls', t('LS-Taste', 'LS pushbutton'), ON, is('ls', 1)),
      item(
        'ndMode',
        t('Navigationsanzeige', 'Navigation display'),
        t('ROSE ILS', 'ROSE ILS'),
        is('ndMode', 'ils'),
      ),
      item('minimum', t('Minimum', 'Minimum'), SET),
      item('ecam', t('ECAM-Status', 'ECAM status'), CHECK),
    ],
  },
  {
    id: 'landing',
    title: t('Landung', 'Landing'),
    kind: 'normal',
    items: [
      item(
        'flaps1',
        t('«Flaps 1» (Green Dot)', '"Flaps 1" (green dot)'),
        t('KLAPPEN 1', 'FLAPS 1'),
        is('flaps', ['1', '2', '3', 'full']),
      ),
      item(
        'flaps2',
        t('«Flaps 2» (bei S)', '"Flaps 2" (at S speed)'),
        t('KLAPPEN 2', 'FLAPS 2'),
        is('flaps', ['2', '3', 'full']),
      ),
      item(
        'gearDown',
        t('«Gear down»', '"Gear down"'),
        t('AUSGEFAHREN, 3 GRÜN', 'DOWN, 3 GREEN'),
        all(is('gear', 1), tel('gear', 0.99)),
      ),
      item('spoilers', t('Ground Spoiler', 'Ground spoilers'), ARMED, is('spoilersArmed', 1)),
      item(
        'flaps3',
        t('«Flaps 3» (bei F)', '"Flaps 3" (at F speed)'),
        t('KLAPPEN 3', 'FLAPS 3'),
        is('flaps', ['3', 'full']),
      ),
      item(
        'flapsFull',
        t('«Flaps full»', '"Flaps full"'),
        t('KLAPPEN VOLL', 'FLAPS FULL'),
        is('flaps', 'full'),
      ),
      item(
        'vapp',
        t('Endanflug', 'Final approach'),
        t('VAPP (um 130–140 kt)', 'VAPP (about 130–140 kt)'),
        tel('iasKt', 120, 150),
      ),
      item('cabin', t('Kabine', 'Cabin crew'), t('INFORMIERT', 'ADVISED')),
      item('memo', t('Landing Memo', 'Landing memo'), t('ALLES GRÜN', 'NO BLUE')),
      item(
        'retard',
        t('«Retard»', '"Retard"'),
        t('SCHUBHEBEL LEERLAUF', 'THRUST LEVERS IDLE'),
        IDLE_BOTH,
      ),
      item(
        'spoilersOut',
        t('«Spoilers»', '"Spoilers"'),
        t('AUSGEFAHREN', 'DEPLOYED'),
        all(tel('onGround', 1), tel('speedbrake', 0.8)),
      ),
      item(
        'reverseGreen',
        t('«Reverse green»', '"Reverse green"'),
        t('UMKEHRSCHUB', 'REVERSE'),
        is('reverse', 1),
      ),
      item('decel', t('«Decel»', '"Decel"'), CHECK),
      item(
        'seventy',
        t('«70 Knoten»', '"Seventy knots"'),
        t('UMKEHRSCHUB LEERLAUF', 'REVERSE IDLE'),
        tel('groundSpeedKt', undefined, 70),
      ),
      item(
        'reverseStowed',
        t('Umkehrschub', 'Reversers'),
        t('VERSTAUT (bei Rollgeschwindigkeit)', 'STOWED (at taxi speed)'),
        is('reverse', 0),
      ),
    ],
  },
  {
    id: 'afterLanding',
    title: t('Nach der Landung', 'After landing'),
    kind: 'normal',
    items: [
      item('spoilers', t('Ground Spoiler', 'Ground spoilers'), DISARMED, is('spoilersArmed', 0)),
      item('flaps', t('Landeklappen', 'Flaps'), t('EINGEFAHREN', 'RETRACTED'), is('flaps', '0')),
      item('apu', t('APU', 'APU'), t('START', 'START'), is('apuMaster', 1)),
      item(
        'strobe',
        t('Blitzlichter', 'Strobe lights'),
        t('AUTO', 'AUTO'),
        is('lightStrobe', 'auto'),
      ),
      item('landingLights', t('Landescheinwerfer', 'Landing lights'), OFF, is('lightLanding', 0)),
      item(
        'noseLight',
        t('Bugscheinwerfer', 'Nose light'),
        t('TAXI', 'TAXI'),
        is('lightNose', 'taxi'),
      ),
      item('turnoff', t('Abrollscheinwerfer', 'Runway turn-off lights'), AS_REQUIRED),
      item(
        'xpdr',
        t('Transponder, TCAS', 'Transponder and TCAS'),
        t('STBY', 'STBY'),
        is('xpdrMode', 'standby'),
      ),
      item('antiIce', t('Enteisung', 'Anti-ice'), AS_REQUIRED),
    ],
  },
  {
    id: 'parking',
    title: t('Parkieren', 'Parking'),
    kind: 'normal',
    items: [
      parkingBrakeOn,
      item('apuBleed', t('APU-Zapfluft', 'APU bleed'), ON, is('apuBleed', 1)),
      item(
        'masters',
        t('Triebwerk-Master 1 und 2', 'Engine masters 1 and 2'),
        OFF,
        all(is('engineMaster1', 0), is('engineMaster2', 0)),
      ),
      item(
        'enginesStopped',
        t('Triebwerke', 'Engines'),
        t('STEHEN', 'STOPPED'),
        tel('enginesRunning', undefined, 0),
      ),
      item('beacon', t('Blitzlicht (BEACON)', 'Beacon'), OFF, is('lightBeacon', 0)),
      item('seatBelts', t('Anschnallzeichen', 'Seat belt signs'), OFF, is('seatBelts', 'off')),
      item(
        'fuelPumps',
        t('Treibstoffpumpen', 'Fuel pumps'),
        OFF,
        all(is('fuelPumpsLeft', 0), is('fuelPumpsCenter', 0), is('fuelPumpsRight', 0)),
      ),
      item('externalPower', t('Bodenstrom', 'External power'), AS_REQUIRED),
    ],
  },
  {
    id: 'securing',
    title: t('Flugzeug sichern', 'Securing the aircraft'),
    kind: 'normal',
    items: [
      item('adirs', t('ADIRS 1, 2, 3', 'ADIRS 1, 2, 3'), OFF, is('adirs', 'off')),
      item('apuBleedOff', t('APU-Zapfluft', 'APU bleed'), OFF, is('apuBleed', 0)),
      item('apuOff', t('APU Master', 'APU master'), OFF, is('apuMaster', 0)),
      item(
        'lights',
        t('Aussenlichter', 'Exterior lights'),
        OFF,
        all(is('lightNav', 0), is('lightStrobe', 'off'), is('lightNose', 'off')),
      ),
      item('externalPowerOff', t('Bodenstrom', 'External power'), OFF, is('externalPower', 0)),
      item(
        'batteries',
        t('Batterien 1 und 2', 'Batteries 1 and 2'),
        OFF,
        all(is('battery', 0), is('battery2', 0)),
      ),
    ],
  },
  // ---- abnormal and emergency procedures ----
  {
    id: 'engineFailureTakeoff',
    title: t('Triebwerkausfall nach V1', 'Engine failure after V1'),
    kind: 'emergency',
    trigger: all(tel('enginesRunning', 1, 1), tel('aglFt', undefined, 3000)),
    priority: 1,
    items: [
      item(
        'callout',
        t('«Engine failure»', '"Engine failure"'),
        t('WEITERSTARTEN', 'CONTINUE TAKEOFF'),
      ),
      item('rudder', t('Seitenruder', 'Rudder'), t('SEITE HALTEN', 'MAINTAIN DIRECTION')),
      item(
        'rotate',
        t('Rotieren', 'Rotate'),
        t('VR, Ziel 12,5° Nase hoch', 'VR, 12.5° nose up target'),
      ),
      item(
        'gearUp',
        t('«Positive climb» – «Gear up»', '"Positive climb" – "Gear up"'),
        UP,
        all(AIRBORNE, is('gear', 0)),
      ),
      item('v2', t('Fahrt', 'Speed'), t('V2 bis V2 + 10', 'V2 to V2 + 10')),
      item(
        'ecam',
        t('Über 400 ft: ECAM-Massnahmen', 'Above 400 ft: ECAM actions'),
        t('BEGINNEN', 'START'),
      ),
      item(
        'leverIdle',
        t('Schubhebel des ausgefallenen Triebwerks', 'Thrust lever of the failed engine'),
        t('LEERLAUF (bestätigt)', 'IDLE (confirmed)'),
        any(range('throttle1', 0, 0.03), range('throttle2', 0, 0.03)),
      ),
      item(
        'masterOff',
        t('Master des ausgefallenen Triebwerks', 'Master switch of the failed engine'),
        t('AUS (bestätigt)', 'OFF (confirmed)'),
        any(is('engineMaster1', 0), is('engineMaster2', 0)),
      ),
      item(
        'accelerate',
        t('Beschleunigungshöhe', 'Acceleration altitude'),
        t('BESCHLEUNIGEN, Klappen einfahren', 'ACCELERATE, retract flaps'),
        is('flaps', '0'),
      ),
      item(
        'mct',
        t(
          'Schubhebel des laufenden Triebwerks (Green Dot)',
          'Thrust lever of the live engine (green dot)',
        ),
        t('MCT', 'MCT'),
        any(range('throttle1', 0.78, 0.86), range('throttle2', 0.78, 0.86)),
      ),
      item(
        'mayday',
        t('Notruf an ATC', 'ATC'),
        t('MAYDAY / PAN, Absicht melden', 'MAYDAY / PAN, state intentions'),
      ),
      item(
        'land',
        t('Landung', 'Landing'),
        t('NÄCHSTER GEEIGNETER FLUGHAFEN', 'NEAREST SUITABLE AIRPORT'),
      ),
    ],
  },
  {
    id: 'goAround',
    title: t('Durchstarten', 'Go-around'),
    kind: 'emergency',
    // Climbing away low with the gear down and flaps out, once the approach had begun.
    trigger: all(
      tel('verticalSpeedFpm', 500),
      tel('aglFt', undefined, 2500),
      tel('gear', 0.9),
      tel('flaps', 0.2),
    ),
    requires: 'approach',
    items: [
      item(
        'toga',
        t('«Go around – flaps»', '"Go around – flaps"'),
        t('SCHUBHEBEL TOGA', 'THRUST LEVERS TOGA'),
        all(range('throttle1', 0.97), range('throttle2', 0.97)),
      ),
      item(
        'flapsStep',
        t('Landeklappen', 'Flaps'),
        t('EINE STUFE EINFAHREN', 'RETRACT ONE STEP'),
        is('flaps', ['0', '1', '2', '3']),
      ),
      item(
        'positiveClimb',
        t('«Positive climb» – «Gear up»', '"Positive climb" – "Gear up"'),
        UP,
        all(AIRBORNE, is('gear', 0)),
      ),
      item(
        'fma',
        t('Flugmodusanzeige', 'Flight mode annunciator'),
        t('MAN TOGA, SRS, GA TRK', 'MAN TOGA, SRS, GA TRK'),
      ),
      item('altitude', t('Durchstarthöhe', 'Go-around altitude'), t('GESETZT', 'SET')),
      item(
        'clb',
        t('Schubreduktionshöhe', 'Thrust reduction altitude'),
        t('SCHUBHEBEL CLB', 'THRUST LEVERS CLB'),
        CLIMB_DETENT,
      ),
      item(
        'flapsUp',
        t('Landeklappen nach Plan', 'Flaps on schedule'),
        t('EINGEFAHREN', 'RETRACTED'),
        is('flaps', '0'),
      ),
      item('spoilers', t('Ground Spoiler', 'Ground spoilers'), DISARMED, is('spoilersArmed', 0)),
    ],
  },
  {
    id: 'rejectedTakeoff',
    title: t('Startabbruch', 'Rejected takeoff'),
    kind: 'emergency',
    trigger: all(tel('groundSpeedKt', 40), any(tel('enginesRunning', undefined, 1), IDLE_BOTH)),
    when: 'departure',
    priority: 2,
    items: [
      item(
        'stop',
        t('«Stop»', '"Stop"'),
        t('SCHUBHEBEL LEERLAUF', 'THRUST LEVERS IDLE'),
        IDLE_BOTH,
      ),
      item('reverse', t('Umkehrschub', 'Reverse'), t('VOLL', 'MAX'), is('reverse', 1)),
      item(
        'braking',
        t('Bremsen', 'Braking'),
        t('AUTOBRAKE MAX oder VOLL', 'AUTOBRAKE MAX or FULL MANUAL'),
      ),
      item(
        'seventy',
        t('«70 Knoten»', '"Seventy knots"'),
        t('UMKEHRSCHUB LEERLAUF', 'REVERSE IDLE'),
        tel('groundSpeedKt', undefined, 70),
      ),
      item(
        'stopped',
        t('Flugzeug', 'Aircraft'),
        t('STEHT', 'STOPPED'),
        tel('groundSpeedKt', undefined, 1),
      ),
      item(
        'reverseStowed',
        t('Umkehrschub', 'Reversers'),
        t('VERSTAUT', 'STOWED'),
        is('reverse', 0),
      ),
      parkingBrakeOn,
      item('atc', t('ATC', 'ATC'), t('INFORMIERT', 'NOTIFIED')),
      item(
        'cabin',
        t('Kabine', 'Cabin'),
        t('«Attention crew at stations»', '"Attention, crew at stations"'),
      ),
      item('evacuation', t('Evakuierung', 'Evacuation'), t('ERWÄGEN', 'CONSIDER')),
    ],
  },
  {
    id: 'emergencyDescent',
    title: t('Notabstieg', 'Emergency descent'),
    kind: 'emergency',
    trigger: any(tel('cabinAltitudeWarning', 1), tel('cabinAltitudeFt', 10_000)),
    priority: 2,
    items: [
      item('masks', t('Sauerstoffmasken', 'Crew oxygen masks'), t('AUF, 100 %', 'ON, 100 %')),
      item('signs', t('Anschnallzeichen', 'Seat belt signs'), ON, is('seatBelts', 'on')),
      item(
        'fcuAltitude',
        t('FCU-Höhe', 'FCU altitude'),
        t('10 000 ft ODER MSA, ZIEHEN', '10 000 FT or MSA, PULL'),
        range('fcuAltitude', undefined, 10_000),
      ),
      item(
        'heading',
        t('Kurs', 'Heading'),
        t('WEG VON DER LUFTSTRASSE, ZIEHEN', 'OFF AIRWAY, PULL'),
      ),
      item('thrust', t('Schub', 'Thrust'), t('LEERLAUF (A/THR aktiv)', 'IDLE (A/THR active)')),
      item(
        'speedbrake',
        t('Bremsklappen', 'Speed brake'),
        t('VOLL', 'FULL'),
        range('speedbrake', 0.9),
      ),
      item('speed', t('Fahrt', 'Speed'), t('MMO/VMO', 'MMO/VMO')),
      item(
        'mayday',
        t('ATC, Transponder', 'ATC and transponder'),
        t('MAYDAY, 7700', 'MAYDAY, 7700'),
        range('xpdrCode', 7700, 7700),
      ),
      item(
        'level',
        t('Höhe', 'Altitude'),
        t('10 000 ft ERREICHT', '10 000 FT REACHED'),
        tel('altitudeFt', undefined, 10_500),
      ),
      item(
        'speedbrakeIn',
        t('Bremsklappen (vor dem Einleveln)', 'Speed brake (before levelling off)'),
        t('EINGEFAHREN', 'RETRACTED'),
        range('speedbrake', undefined, 0.05),
      ),
    ],
  },
];
