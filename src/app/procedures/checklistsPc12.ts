/**
 * The checklists of the Pilatus PC-12 NG, after section 4 (normal procedures) and section 3
 * (emergency procedures) of the Pilot's Operating Handbook, condensed to what the simulated
 * cockpit has. Control names are those of PC12_CONTROLS.
 *
 * Figures: rotation 83 KIAS with flaps 15 (as the flight model's vRotate); VFE 165 / 130 /
 * 117 KIAS for flaps 15 / 30 / 40, VLE 180 KIAS, VMO 240 KIAS; torque limit 44.34 psi
 * (1.0 of the telemetry's torque share), ITT 820 °C in flight and 1000 °C for 5 s at the
 * start, Ng 104 %; the light-off at 13 % Ng; cabin altitude warning 10 000 ft. Best glide
 * with the propeller feathered: 119 KIAS at 4740 kg, from memory of the handbook's
 * section 3 (not checked against a copy); the check accepts ±5 KIAS around it.
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

const DOWN = t('AUSGEFAHREN', 'DOWN');
const AUTO = t('AUTO', 'AUTO');
const IDLE = t('LEERLAUF', 'IDLE');

const parkingBrakeSet = item(
  'parkingBrake',
  t('Parkbremse', 'Parking brake'),
  SET,
  is('parkingBrake', 1),
);
const pclIdle = item(
  'pcl',
  t('Leistungshebel (PCL)', 'Power control lever'),
  IDLE,
  range('throttle', 0, 0.03),
);
const conditionCutoff = item(
  'conditionCutoff',
  t('Condition-Hebel', 'Condition lever'),
  t('CUT-OFF/FEATHER', 'CUT-OFF/FEATHER'),
  is('condition', 'cutoff'),
);
const conditionFlightIdle = item(
  'conditionFlightIdle',
  t('Condition-Hebel', 'Condition lever'),
  t('FLIGHT IDLE', 'FLIGHT IDLE'),
  is('condition', 'flightIdle'),
);
const fuelShutoffOpen = item(
  'fuelShutoff',
  t('Brandhahn (Fuel Firewall Shutoff)', 'Fuel firewall shutoff valve'),
  t('OFFEN', 'OPEN'),
  is('fuelShutoff', 1),
);
const pumpsOn = item(
  'fuelPumps',
  t('Treibstoffpumpen links und rechts', 'Fuel pumps left and right'),
  ON,
  all(is('fuelPumpLeft', 'on'), is('fuelPumpRight', 'on')),
);
const pumpsAuto = item(
  'fuelPumpsAuto',
  t('Treibstoffpumpen links und rechts', 'Fuel pumps left and right'),
  AUTO,
  all(is('fuelPumpLeft', 'auto'), is('fuelPumpRight', 'auto')),
);
const generatorsOn = item(
  'generators',
  t('Generatoren 1 und 2', 'Generators 1 and 2'),
  ON,
  all(is('generator1', 1), is('generator2', 1)),
);
const gearDown = item(
  'gearDown',
  t('Fahrwerk', 'Landing gear'),
  t('AUSGEFAHREN, 3 GRÜN (unter 180 KIAS)', 'DOWN, 3 GREEN (below 180 KIAS)'),
  all(is('gear', 1), tel('gear', 0.99), tel('gearUnsafe', undefined, 0)),
);
const xpdr7700 = item(
  'squawk',
  t('Transponder', 'Transponder'),
  t('7700 NACH BEDARF', '7700 AS REQUIRED'),
  range('xpdrCode', 7700, 7700),
);
const glide = item(
  'glide',
  t('Fahrt', 'Airspeed'),
  t('119 KIAS (bestes Gleiten bei 4740 kg)', '119 KIAS (best glide at 4740 kg)'),
  tel('iasKt', 114, 124),
);

export const PC12_CHECKLISTS: readonly ChecklistDef[] = [
  {
    id: 'beforeStart',
    title: t('Vor dem Anlassen', 'Before starting engine'),
    kind: 'normal',
    items: [
      item('preflight', t('Vorflugkontrolle', 'Preflight inspection'), COMPLETE),
      item(
        'doors',
        t('Kabinen- und Frachttür', 'Passenger and cargo doors'),
        t('ZU und VERRIEGELT', 'CLOSED and LOCKED'),
      ),
      item(
        'seats',
        t('Sitze, Gurte', 'Seats and seat belts'),
        t('EINGESTELLT, GESCHLOSSEN', 'ADJUST and LOCK'),
      ),
      parkingBrakeSet,
      item('gearLever', t('Fahrwerkhebel', 'Landing gear lever'), DOWN, is('gear', 1)),
      pclIdle,
      conditionCutoff,
      fuelShutoffOpen,
      item('ignition', t('Zündung', 'Ignition'), AUTO, is('ignition', 'auto')),
      item('avionicsOff', t('Avionik', 'Avionics'), OFF, is('avionics', 0)),
      item(
        'generatorsOff',
        t('Generatoren 1 und 2', 'Generators 1 and 2'),
        OFF,
        all(is('generator1', 0), is('generator2', 0)),
      ),
    ],
  },
  {
    id: 'engineStart',
    title: t('Anlassen', 'Engine start'),
    kind: 'normal',
    items: [
      item(
        'batteries',
        t('Batterien 1 und 2', 'Batteries 1 and 2'),
        ON,
        all(is('battery', 1), is('battery2', 1)),
      ),
      item(
        'busVolts',
        t('Batteriespannung', 'Battery voltage'),
        t('24 V ODER MEHR', '24 V MINIMUM'),
        tel('busVolts', 24),
      ),
      item(
        'epsTest',
        t('Notstromversorgung (EPS)', 'Emergency power supply (EPS)'),
        t('TEST', 'TEST'),
        is('eps', 'test'),
      ),
      item(
        'epsArmed',
        t('Notstromversorgung (EPS)', 'Emergency power supply (EPS)'),
        t('ARMED', 'ARMED'),
        is('eps', 'armed'),
      ),
      item('beacon', t('Blitzlicht (BEACON)', 'Beacon light'), ON, is('lightBeacon', 1)),
      pumpsOn,
      item('propArea', t('Propellerbereich', 'Propeller area'), t('FREI', 'CLEAR')),
      item(
        'starter',
        t('Anlasser', 'Starter'),
        t('DRÜCKEN, Ng steigt', 'PRESS, check Ng rising'),
        any(tel('engineStarting', 1), tel('n2', 5)),
      ),
      item(
        'ng13',
        t('Gasgenerator Ng', 'Gas generator Ng'),
        t('13 % ODER MEHR', '13 % OR MORE'),
        tel('n2', 13),
      ),
      item(
        'conditionGroundIdle',
        t('Condition-Hebel', 'Condition lever'),
        t('GROUND IDLE', 'GROUND IDLE'),
        is('condition', 'groundIdle'),
      ),
      item(
        'itt',
        t('ITT', 'ITT'),
        t('ÜBERWACHEN (höchstens 1000 °C für 5 s)', 'MONITOR (1000 °C max for 5 s)'),
        all(tel('engineRunning', 1), tel('itt', undefined, 1000)),
      ),
      item(
        'idleNg',
        t('Ng im Leerlauf', 'Ng at ground idle'),
        t('STABIL, 60 % ODER MEHR', 'STABLE, 60 % OR MORE'),
        tel('n2', 60),
      ),
      item(
        'starterOff',
        t('Anlasser', 'Starter'),
        t('AUS (Anzeige erloschen)', 'OFF (annunciator out)'),
        tel('engineStarting', undefined, 0),
      ),
      item(
        'oilPressure',
        t('Öldruck', 'Oil pressure'),
        t('60 psi ODER MEHR', '60 PSI MINIMUM'),
        tel('oilPressure', 60),
      ),
      generatorsOn,
      item(
        'busCharging',
        t('Bordnetz', 'Bus voltage'),
        t('LÄDT (27–29 V)', 'CHARGING (27–29 V)'),
        tel('busVolts', 27, 29.5),
      ),
      pumpsAuto,
      item('avionicsOn', t('Avionik', 'Avionics'), ON, is('avionics', 1)),
    ],
  },
  {
    id: 'beforeTaxi',
    title: t('Vor dem Rollen', 'Before taxi'),
    kind: 'normal',
    items: [
      item('ecs', t('Klimaanlage (ECS)', 'Environmental control (ECS)'), ON, is('ecs', 1)),
      item(
        'pressurisation',
        t('Druckkabine', 'Pressurisation'),
        t('AUTO, Kabinenhöhe gesetzt', 'AUTO, cabin altitude set'),
        is('pressurisation', 'auto'),
      ),
      item(
        'altimeter',
        t('Höhenmesser', 'Altimeters'),
        t('AUF QNH', 'SET to QNH'),
        tel('baroStd', undefined, 0),
      ),
      item('flightPlan', t('Flugplan, Avionik', 'Flight plan and avionics'), SET),
      item('xpdr', t('Transponder', 'Transponder'), t('CODE GESETZT', 'CODE SET')),
      item('flaps', t('Landeklappen', 'Flaps'), t('15°', '15°'), is('flaps', '15')),
      item(
        'trims',
        t('Trimmungen (Höhe, Quer, Seite)', 'Trims (pitch, roll, yaw)'),
        t('START', 'TAKEOFF'),
        all(
          range('trim', -0.2, 0.2),
          range('aileronTrim', -0.1, 0.1),
          range('rudderTrim', -0.1, 0.1),
        ),
      ),
      item('navLights', t('Positionslichter', 'Navigation lights'), ON, is('lightNav', 1)),
      item('taxiLight', t('Rollscheinwerfer', 'Taxi light'), ON, is('lightTaxi', 1)),
      item(
        'brakes',
        t('Bremsen', 'Brakes'),
        t('LÖSEN und PRÜFEN', 'RELEASE and CHECK'),
        is('parkingBrake', 0),
      ),
    ],
  },
  {
    id: 'beforeTakeoff',
    title: t('Vor dem Start', 'Before takeoff'),
    kind: 'normal',
    items: [
      item(
        'controls',
        t('Steuerung', 'Flight controls'),
        t('FREI und RICHTIG', 'FREE and CORRECT'),
      ),
      item('flaps', t('Landeklappen', 'Flaps'), t('15°', '15°'), is('flaps', '15')),
      item(
        'trim',
        t('Höhenrudertrimmung', 'Pitch trim'),
        t('START (grün)', 'TAKEOFF (green)'),
        range('trim', -0.2, 0.2),
      ),
      conditionFlightIdle,
      pumpsAuto,
      item(
        'ignition',
        t('Zündung', 'Ignition'),
        t('AUTO (ON bei Nässe)', 'AUTO (ON on wet runway)'),
        is('ignition', ['auto', 'on']),
      ),
      item(
        'separator',
        t('Trägheitsabscheider', 'Inertial separator'),
        t('NACH BEDARF', 'AS REQUIRED'),
      ),
      item('probeHeat', t('Sondenheizung', 'Probe heat'), ON, is('pitotHeat', 1)),
      item('autopilot', t('Autopilot, Yaw Damper', 'Autopilot and yaw damper'), t('AUS', 'OFF')),
      item('xpdrAlt', t('Transponder', 'Transponder'), t('ALT', 'ALT'), is('xpdrMode', 'alt')),
      item('strobe', t('Blitzlichter (STROBE)', 'Strobe lights'), ON, is('lightStrobe', 1)),
      item('landingLight', t('Landescheinwerfer', 'Landing lights'), ON, is('lightLanding', 1)),
      item('annunciators', t('Warnanzeigen (CAS)', 'CAS messages'), t('KEINE', 'NONE')),
    ],
  },
  {
    id: 'takeoff',
    title: t('Start', 'Takeoff'),
    kind: 'normal',
    items: [
      item(
        'brakesOff',
        t('Parkbremse', 'Parking brake'),
        t('GELÖST', 'RELEASED'),
        is('parkingBrake', 0),
      ),
      item(
        'power',
        t('Leistungshebel', 'Power control lever'),
        t('STARTLEISTUNG (höchstens 44,3 psi, 820 °C)', 'TAKEOFF POWER (44.3 PSI, 820 °C max)'),
        all(range('throttle', 0.8), tel('torque', 0.85, 1.02), tel('itt', undefined, 820)),
      ),
      item(
        'propRpm',
        t('Propellerdrehzahl', 'Propeller speed'),
        t('1700 U/min', '1700 RPM'),
        tel('propRpm', 1650, 1750),
      ),
      item('rotate', t('Rotieren', 'Rotate'), t('83 KIAS', '83 KIAS'), tel('iasKt', 83)),
      item(
        'gearUp',
        t('Fahrwerk (positive Steigrate)', 'Landing gear (positive rate)'),
        UP,
        all(AIRBORNE, is('gear', 0)),
      ),
      item(
        'flapsUp',
        t('Landeklappen (über 110 KIAS)', 'Flaps (above 110 KIAS)'),
        UP,
        is('flaps', '0'),
      ),
      item('yawDamper', t('Yaw Damper', 'Yaw damper'), ON),
    ],
  },
  {
    id: 'climb',
    title: t('Steigflug', 'Climb'),
    kind: 'normal',
    items: [
      item(
        'gear',
        t('Fahrwerk', 'Landing gear'),
        UP,
        all(is('gear', 0), tel('gear', undefined, 0.01)),
      ),
      item('flaps', t('Landeklappen', 'Flaps'), UP, is('flaps', '0')),
      item(
        'power',
        t('Leistung', 'Power'),
        t('STEIGLEISTUNG (ITT höchstens 820 °C)', 'CLIMB POWER (ITT 820 °C max)'),
        all(tel('torque', undefined, 1.0), tel('itt', undefined, 820)),
      ),
      item(
        'airspeed',
        t('Fahrt', 'Airspeed'),
        t('130–160 KIAS', '130–160 KIAS'),
        tel('iasKt', 125, 165),
      ),
      item(
        'cabin',
        t('Druckkabine', 'Pressurisation'),
        t('PRÜFEN (Kabine steigt)', 'CHECK (cabin climbing)'),
        tel('cabinAltitudeFt', undefined, 10_000),
      ),
      item(
        'lights',
        t('Landescheinwerfer (über 10 000 ft)', 'Landing lights (above 10 000 ft)'),
        AS_REQUIRED,
      ),
      item(
        'altimeter',
        t(
          'Höhenmesser (über 7000 ft, Übergangshöhe)',
          'Altimeters (above 7000 ft, transition altitude)',
        ),
        t('STD', 'STD'),
        tel('baroStd', 1),
      ),
    ],
  },
  {
    id: 'cruise',
    title: t('Reiseflug', 'Cruise'),
    kind: 'normal',
    items: [
      item(
        'power',
        t('Leistung', 'Power'),
        t('REISELEISTUNG (Tabelle)', 'CRUISE POWER (per table)'),
        all(tel('torque', undefined, 1.0), tel('itt', undefined, 820)),
      ),
      item(
        'propRpm',
        t('Propellerdrehzahl', 'Propeller speed'),
        t('1700 U/min', '1700 RPM'),
        tel('propRpm', 1650, 1750),
      ),
      item('fuel', t('Treibstoff, Ausgleich', 'Fuel quantity and balance'), CHECK),
      item(
        'cabin',
        t('Druckkabine', 'Pressurisation'),
        CHECK,
        tel('cabinAltitudeFt', undefined, 10_000),
      ),
      item('iceProtection', t('Enteisung', 'Ice protection'), AS_REQUIRED),
    ],
  },
  {
    id: 'descent',
    title: t('Sinkflug', 'Descent'),
    kind: 'normal',
    items: [
      item('atis', t('ATIS, Anflugbriefing', 'ATIS and approach briefing'), COMPLETE),
      item(
        'cabinAltitude',
        t('Kabinenhöhe', 'Cabin altitude'),
        t('PLATZHÖHE + 500 ft', 'FIELD ELEVATION + 500 FT'),
      ),
      item(
        'altimeter',
        t('Höhenmesser (unter der Übergangsfläche)', 'Altimeters (below transition level)'),
        t('AUF QNH', 'SET to QNH'),
        tel('baroStd', undefined, 0),
      ),
      item(
        'power',
        t('Leistung', 'Power'),
        t('NACH BEDARF (höchstens 240 KIAS)', 'AS REQUIRED (240 KIAS max)'),
        tel('iasKt', undefined, 240),
      ),
      item('iceProtection', t('Enteisung', 'Ice protection'), AS_REQUIRED),
      item('landingLights', t('Landescheinwerfer', 'Landing lights'), ON, is('lightLanding', 1)),
    ],
  },
  {
    id: 'beforeLanding',
    title: t('Vor der Landung', 'Before landing'),
    kind: 'normal',
    items: [
      item('seats', t('Sitze, Gurte', 'Seats and seat belts'), t('GESICHERT', 'SECURE')),
      gearDown,
      pumpsAuto,
      conditionFlightIdle,
      item(
        'flaps',
        t('Landeklappen', 'Flaps'),
        t('40° (unter 117 KIAS)', '40° (below 117 KIAS)'),
        is('flaps', '40'),
      ),
      item('autopilot', t('Autopilot, Yaw Damper', 'Autopilot and yaw damper'), t('AUS', 'OFF')),
      item(
        'approachSpeed',
        t('Anfluggeschwindigkeit', 'Approach speed'),
        t('85 KIAS (Klappen 40°)', '85 KIAS (flaps 40°)'),
        tel('iasKt', 80, 95),
      ),
    ],
  },
  {
    id: 'afterLanding',
    title: t('Nach der Landung', 'After landing'),
    kind: 'normal',
    items: [
      item(
        'reverse',
        t('Umkehrschub (Beta)', 'Reverse (beta)'),
        t('NACH BEDARF, dann AUS', 'AS REQUIRED, then OFF'),
        is('reverse', 0),
      ),
      item('flapsUp', t('Landeklappen', 'Flaps'), UP, is('flaps', '0')),
      item(
        'conditionGroundIdle',
        t('Condition-Hebel', 'Condition lever'),
        t('GROUND IDLE', 'GROUND IDLE'),
        is('condition', 'groundIdle'),
      ),
      item('strobe', t('Blitzlichter (STROBE)', 'Strobe lights'), OFF, is('lightStrobe', 0)),
      item('landingLight', t('Landescheinwerfer', 'Landing lights'), OFF, is('lightLanding', 0)),
      item(
        'probeHeat',
        t('Sondenheizung, Enteisung', 'Probe heat and ice protection'),
        OFF,
        all(is('pitotHeat', 0), is('propDeice', 0), is('bootsDeice', 'off')),
      ),
      item('xpdr', t('Transponder', 'Transponder'), t('STBY', 'STBY'), is('xpdrMode', 'standby')),
    ],
  },
  {
    id: 'shutdown',
    title: t('Abstellen', 'Shutdown'),
    kind: 'normal',
    items: [
      parkingBrakeSet,
      pclIdle,
      item('cool', t('ITT', 'ITT'), t('2 MIN STABIL IM LEERLAUF', 'STABILISED 2 MIN AT IDLE')),
      item('avionicsOff', t('Avionik', 'Avionics'), OFF, is('avionics', 0)),
      item('ecsOff', t('Klimaanlage (ECS)', 'Environmental control (ECS)'), OFF, is('ecs', 0)),
      conditionCutoff,
      item(
        'engineStopped',
        t('Triebwerk', 'Engine'),
        t('STEHT (Ng unter 10 %)', 'STOPPED (Ng below 10 %)'),
        all(tel('engineRunning', undefined, 0), tel('n2', undefined, 10)),
      ),
      item(
        'generatorsOff',
        t('Generatoren 1 und 2', 'Generators 1 and 2'),
        OFF,
        all(is('generator1', 0), is('generator2', 0)),
      ),
      item(
        'lights',
        t('Aussenlichter', 'Exterior lights'),
        OFF,
        all(is('lightBeacon', 0), is('lightNav', 0), is('lightTaxi', 0)),
      ),
      item(
        'eps',
        t('Notstromversorgung (EPS)', 'Emergency power supply (EPS)'),
        OFF,
        is('eps', 'off'),
      ),
      item(
        'batteries',
        t('Batterien 1 und 2', 'Batteries 1 and 2'),
        OFF,
        all(is('battery', 0), is('battery2', 0)),
      ),
    ],
  },
  // ---- emergencies ----
  {
    id: 'engineFailure',
    title: t('Triebwerkausfall im Flug', 'Engine failure in flight'),
    kind: 'emergency',
    trigger: tel('engineRunning', undefined, 0),
    // Feathering and the glide come before any thought of a restart.
    priority: 2,
    items: [
      pclIdle,
      conditionCutoff,
      item(
        'feathered',
        t('Propeller', 'Propeller'),
        t('SEGELSTELLUNG', 'FEATHERED'),
        tel('propRpm', undefined, 400),
      ),
      glide,
      item(
        'restart',
        t('Wiederanlassen', 'Air start'),
        t('ERWÄGEN (Checkliste Anlassen im Flug)', 'CONSIDER (air start checklist)'),
      ),
      item('field', t('Landefeld', 'Landing area'), t('AUSGEWÄHLT', 'SELECT')),
      item('mayday', t('Notruf 121,500', 'MAYDAY 121.5'), AS_REQUIRED),
      xpdr7700,
      item(
        'fuelShutoffClosed',
        t('Brandhahn (ohne Wiederanlassen)', 'Fuel firewall shutoff (no restart)'),
        t('ZU', 'CLOSED'),
      ),
      item(
        'gearForced',
        t('Fahrwerk', 'Landing gear'),
        t('AUSFAHREN, wenn das Feld erreicht ist', 'DOWN when the field is made'),
      ),
    ],
  },
  {
    id: 'airStart',
    title: t('Anlassen im Flug (mit Anlasser)', 'Air start (starter assisted)'),
    kind: 'emergency',
    trigger: all(tel('engineRunning', undefined, 0), tel('aglFt', 2000)),
    priority: 1,
    requires: 'engineFailure',
    items: [
      item(
        'envelope',
        t('Höhe', 'Altitude'),
        t('20 000 ft ODER TIEFER', '20 000 FT OR BELOW'),
        tel('altitudeFt', undefined, 20_000),
      ),
      pclIdle,
      conditionCutoff,
      fuelShutoffOpen,
      pumpsOn,
      item('ignition', t('Zündung', 'Ignition'), ON, is('ignition', 'on')),
      item(
        'starter',
        t('Anlasser', 'Starter'),
        t('DRÜCKEN', 'PRESS'),
        any(tel('engineStarting', 1), tel('n2', 15)),
      ),
      item(
        'ng13',
        t('Gasgenerator Ng', 'Gas generator Ng'),
        t('13 % ODER MEHR', '13 % OR MORE'),
        tel('n2', 13),
      ),
      conditionFlightIdle,
      item(
        'itt',
        t('ITT', 'ITT'),
        t('ÜBERWACHEN (höchstens 1000 °C)', 'MONITOR (1000 °C max)'),
        all(tel('engineRunning', 1), tel('itt', undefined, 1000)),
      ),
      generatorsOn,
      item('ignitionAuto', t('Zündung', 'Ignition'), AUTO, is('ignition', 'auto')),
      item('power', t('Leistungshebel', 'Power control lever'), AS_REQUIRED),
    ],
  },
  {
    id: 'generatorFailure',
    title: t('Generatorausfall', 'Generator failure'),
    kind: 'emergency',
    trigger: any(tel('generatorsOff', 1), tel('lowVolts', 1)),
    items: [
      item(
        'genReset',
        t('Generator 1', 'Generator 1'),
        t('AUS, dann EIN (Rücksetzen)', 'OFF, then ON (reset)'),
        is('generator1', 1),
      ),
      item('gen2', t('Generator 2', 'Generator 2'), ON, is('generator2', 1)),
      item(
        'restored',
        t('Generatoren', 'Generators'),
        t('AM NETZ', 'ON LINE'),
        tel('generatorsOff', undefined, 0),
      ),
      item(
        'loads',
        t('Verbraucher (bleibt er aus)', 'Electrical loads (if not restored)'),
        t('REDUZIEREN', 'REDUCE'),
      ),
      item(
        'windshield',
        t('Scheibenheizung, Propellerenteisung', 'Windshield heat and propeller de-ice'),
        t('AUS, wenn nicht nötig', 'OFF unless required'),
      ),
      item('land', t('Landung', 'Landing'), t('BALDMÖGLICHST', 'AS SOON AS PRACTICAL')),
    ],
  },
  {
    id: 'emergencyDescent',
    title: t('Druckverlust: Notabstieg', 'Loss of pressurisation: emergency descent'),
    kind: 'emergency',
    trigger: any(tel('cabinAltitudeWarning', 1), tel('cabinAltitudeFt', 10_000)),
    items: [
      item(
        'oxygen',
        t('Sauerstoff', 'Oxygen'),
        t('MASKEN AUF, 100 %', 'MASKS ON, 100 %'),
        is('oxygen', 1),
      ),
      pclIdle,
      item('autopilot', t('Autopilot', 'Autopilot'), t('AUS', 'DISCONNECT')),
      item(
        'gear',
        t('Fahrwerk (unter 180 KIAS)', 'Landing gear (below 180 KIAS)'),
        DOWN,
        is('gear', 1),
      ),
      item(
        'descend',
        t('Sinkflug', 'Descent'),
        t('180 KIAS, Fahrwerk aus', '180 KIAS, gear down'),
        all(AIRBORNE, tel('verticalSpeedFpm', undefined, -2000)),
      ),
      item(
        'mayday',
        t('Notruf, Transponder', 'MAYDAY, transponder'),
        t('7700', '7700'),
        range('xpdrCode', 7700, 7700),
      ),
      item(
        'level',
        t('Höhe', 'Altitude'),
        t('10 000 ft ODER MSA', '10 000 FT OR MSA'),
        tel('altitudeFt', undefined, 10_000),
      ),
      item(
        'cabin',
        t('Kabinenhöhe', 'Cabin altitude'),
        t('UNTER 10 000 ft', 'BELOW 10 000 FT'),
        tel('cabinAltitudeFt', undefined, 10_000),
      ),
    ],
  },
  {
    id: 'icing',
    title: t('Vereisung', 'Icing encounter'),
    kind: 'emergency',
    trigger: any(tel('airframeIce', 0.1), tel('pitotBlocked', 1)),
    items: [
      item('probeHeat', t('Sondenheizung', 'Probe heat'), ON, is('pitotHeat', 1)),
      item(
        'separator',
        t('Trägheitsabscheider', 'Inertial separator'),
        t('OFFEN', 'OPEN'),
        is('inertialSeparator', 1),
      ),
      item('ignition', t('Zündung', 'Ignition'), ON, is('ignition', 'on')),
      item('propDeice', t('Propellerenteisung', 'Propeller de-ice'), ON, is('propDeice', 1)),
      item('windshield', t('Scheibenheizung', 'Windshield heat'), ON, is('windshieldHeat', 1)),
      item(
        'boots',
        t('Enteisungsmatten (Boots)', 'De-ice boots'),
        t('3 MIN (1 MIN bei starkem Eis)', '3 MIN (1 MIN in heavy ice)'),
        is('bootsDeice', ['3min', '1min']),
      ),
      item('iceLight', t('Eislicht (nachts)', 'Ice light (at night)'), AS_REQUIRED),
      item('leave', t('Vereisungszone', 'Icing conditions'), t('VERLASSEN', 'LEAVE')),
      item(
        'speed',
        t('Anfluggeschwindigkeit mit Resteis', 'Approach speed with residual ice'),
        t('ERHÖHEN, Klappen höchstens 15°', 'INCREASE, flaps 15° max'),
      ),
    ],
  },
  {
    id: 'gearFailure',
    title: t('Fahrwerk fährt nicht aus', 'Landing gear fails to extend'),
    kind: 'emergency',
    // No failure of the gear is simulated: the list is opened by hand.
    items: [
      item(
        'speed',
        t('Fahrt', 'Airspeed'),
        t('UNTER 180 KIAS', 'BELOW 180 KIAS'),
        tel('iasKt', undefined, 180),
      ),
      item('lever', t('Fahrwerkhebel', 'Landing gear lever'), DOWN, is('gear', 1)),
      item(
        'breakers',
        t('Sicherungen Fahrwerk', 'Landing gear circuit breakers'),
        t('DRIN', 'CHECK IN'),
      ),
      item(
        'handPump',
        t('Notausfahrpumpe', 'Emergency hand pump'),
        t('PUMPEN bis 3 GRÜN', 'PUMP until 3 GREEN'),
      ),
      item(
        'locked',
        t('Fahrwerk', 'Landing gear'),
        t('3 GRÜN', '3 GREEN'),
        all(tel('gear', 0.99), tel('gearUnsafe', undefined, 0)),
      ),
      item(
        'noGreen',
        t('Ohne 3 Grün', 'If not 3 green'),
        t(
          'LANDUNG MIT KLAPPEN 40°, Triebwerk vor dem Aufsetzen ab',
          'LAND flaps 40°, engine shut down before touchdown',
        ),
      ),
    ],
  },
];
