/**
 * The checklists of the F/A-18C Hornet in the manner of the NATOPS flight manual's pocket
 * checklist, condensed to what the simulated cockpit has (no weapons, no sensors, no carrier).
 * Control names are those of FA18_CONTROLS; engine 0 is the left one, engine 1 the right.
 *
 * Figures: the right engine starts first, off the APU; throttle to IDLE at 25 % N2 (the
 * crank alone gets it there); throttles 0.75 = MIL, above it the afterburner; gear limit
 * 250 KIAS; on-speed angle of attack 8.1° (the indexer's donut, 7.4–8.8°). Engine start EGT
 * limit 870 °C and the out-of-control ejection height of 6000 ft AGL are from memory of
 * NATOPS, not checked against a copy.
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

const LEFT = 0;
const RIGHT = 1;
const IDLE = t('LEERLAUF', 'IDLE');
const MIL = all(range('throttle1', 0.7, 0.76), range('throttle2', 0.7, 0.76));
const ON_SPEED = tel('alphaDeg', 7.4, 8.8);

const parkingBrakeSet = item(
  'parkingBrake',
  t('Parkbremse', 'Parking brake'),
  SET,
  is('parkingBrake', 1),
);

export const FA18_CHECKLISTS: readonly ChecklistDef[] = [
  {
    id: 'preStart',
    title: t('Vor dem Anlassen (Innenkontrolle)', 'Before engine start (interior check)'),
    kind: 'normal',
    phase: 'preflight',
    items: [
      item(
        'seatSafe',
        t('Schleudersitz', 'Ejection seat'),
        t('GESICHERT', 'SAFE'),
        is('seatArmed', 0),
      ),
      item('oxygen', t('Sauerstoff', 'Oxygen'), ON, is('oxygen', 1)),
      parkingBrakeSet,
      item(
        'throttles',
        t('Leistungshebel', 'Throttles'),
        OFF,
        all(is('fuelCutoff1', 0), is('fuelCutoff2', 0)),
      ),
      item(
        'gearHandle',
        t('Fahrwerkhebel', 'Landing gear handle'),
        t('AUSGEFAHREN', 'DOWN'),
        is('gear', 1),
      ),
      item('hook', t('Fanghaken', 'Arresting hook'), UP, is('hook', 0)),
      item('launchBar', t('Katapultstange', 'Launch bar'), UP, is('launchBar', 0)),
      item('masterArm', t('Master Arm', 'Master arm'), t('SAFE', 'SAFE'), is('masterArm', 0)),
      item('fuelDump', t('Treibstoffablass', 'Fuel dump'), OFF, is('fuelDump', 0)),
      item('battery', t('Batterie', 'Battery'), ON, is('battery', 'on')),
      item(
        'generators',
        t('Generatoren links und rechts', 'Left and right generators'),
        ON,
        all(is('generatorLeft', 1), is('generatorRight', 1)),
      ),
      item('canopy', t('Kabinendach', 'Canopy'), AS_REQUIRED),
    ],
  },
  {
    id: 'engineStart',
    title: t('Anlassen (rechts, dann links)', 'Engine start (right, then left)'),
    kind: 'normal',
    items: [
      item(
        'apu',
        t('APU', 'APU'),
        t('EIN, READY-Licht abwarten', 'ON, wait for READY light'),
        is('apu', 1),
      ),
      item(
        'crankRight',
        t('Anlasserschalter', 'Engine crank switch'),
        t('RECHTS', 'RIGHT'),
        is('engineCrank', 'right'),
      ),
      item(
        'n2Right25',
        t('Rechts: N2', 'Right: N2'),
        t('25 % ODER MEHR', '25 % OR MORE'),
        tel('n2', 25, undefined, RIGHT),
      ),
      item(
        'throttleRight',
        t('Rechter Leistungshebel', 'Right throttle'),
        IDLE,
        is('fuelCutoff2', 1),
      ),
      item(
        'egtRight',
        t('Rechts: EGT', 'Right: EGT'),
        t('ÜBERWACHEN (höchstens 870 °C)', 'MONITOR (870 °C max)'),
        all(tel('engineRunning', 1, undefined, RIGHT), tel('itt', undefined, 870, RIGHT)),
      ),
      item(
        'idleRight',
        t('Rechts: Leerlauf', 'Right: idle'),
        t('STABIL (N2 60 % ODER MEHR)', 'STABLE (N2 60 % OR MORE)'),
        tel('n2', 60, undefined, RIGHT),
      ),
      item(
        'crankLeft',
        t('Anlasserschalter', 'Engine crank switch'),
        t('LINKS', 'LEFT'),
        is('engineCrank', 'left'),
      ),
      item(
        'n2Left25',
        t('Links: N2', 'Left: N2'),
        t('25 % ODER MEHR', '25 % OR MORE'),
        tel('n2', 25, undefined, LEFT),
      ),
      item('throttleLeft', t('Linker Leistungshebel', 'Left throttle'), IDLE, is('fuelCutoff1', 1)),
      item(
        'egtLeft',
        t('Links: EGT', 'Left: EGT'),
        t('ÜBERWACHEN (höchstens 870 °C)', 'MONITOR (870 °C max)'),
        all(tel('engineRunning', 1, undefined, LEFT), tel('itt', undefined, 870, LEFT)),
      ),
      item(
        'idleLeft',
        t('Links: Leerlauf', 'Left: idle'),
        t('STABIL (N2 60 % ODER MEHR)', 'STABLE (N2 60 % OR MORE)'),
        tel('n2', 60, undefined, LEFT),
      ),
      item('crankOff', t('Anlasserschalter', 'Engine crank switch'), OFF, is('engineCrank', 'off')),
      item('apuOff', t('APU', 'APU'), OFF, is('apu', 0)),
      item(
        'displays',
        t('DDI und MPCD', 'DDIs and MPCD'),
        ON,
        all(
          is('ddiLeftPage', ['hsi', 'fcs', 'engine', 'adi', 'checklist', 'fuel']),
          is('ddiRightPage', ['hsi', 'fcs', 'engine', 'adi', 'checklist', 'fuel']),
        ),
      ),
    ],
  },
  {
    id: 'beforeTaxi',
    title: t('Vor dem Rollen (FCS-Prüfung)', 'Before taxi (FCS checks)'),
    kind: 'normal',
    items: [
      item(
        'fcsPage',
        t('DDI: FCS-Seite', 'DDI: FCS page'),
        t('ANGEWÄHLT', 'SELECTED'),
        any(is('ddiLeftPage', 'fcs'), is('ddiRightPage', 'fcs')),
      ),
      item(
        'fcsReset',
        t('FCS RESET', 'FCS reset'),
        t('DRÜCKEN, keine X auf der FCS-Seite', 'PRESS, no X on the FCS page'),
      ),
      item(
        'fcsBit',
        t('FCS-Selbsttest (BIT)', 'FCS built-in test'),
        t('DURCHGEFÜHRT, GO', 'RUN, GO'),
      ),
      item(
        'controls',
        t('Steuerflächen (Knüppel, Pedale)', 'Control surfaces (stick, pedals)'),
        t('FREI, RICHTIG, auf der FCS-Seite geprüft', 'FREE and CORRECT, checked on the FCS page'),
      ),
      item(
        'takeoffTrim',
        t('T/O TRIM', 'T/O trim'),
        t('DRÜCKEN, TRIM-Anzeige', 'PRESS, TRIM advisory'),
      ),
      item('flaps', t('Landeklappen', 'Flaps'), t('HALF', 'HALF'), is('flaps', 'half')),
      item(
        'spinSwitch',
        t('Spin Recovery', 'Spin recovery switch'),
        t('NORM', 'NORM'),
        is('spinRecovery', 0),
      ),
      item('antiSkid', t('Antiblockiersystem', 'Anti-skid'), ON, is('antiSkid', 1)),
      item('pitotHeat', t('Sondenheizung', 'Pitot heat'), AS_REQUIRED),
      item(
        'altimeter',
        t('Höhenmesser', 'Altimeter'),
        t('AUF QNH', 'SET to QNH'),
        tel('baroStd', undefined, 0),
      ),
      item('xpdr', t('IFF / Transponder', 'IFF / transponder'), t('CODE GESETZT', 'CODE SET')),
      item('navLights', t('Positionslichter', 'Position lights'), ON, is('lightNav', 1)),
      item(
        'taxiLight',
        t('Rollscheinwerfer', 'Taxi light'),
        t('TAXI', 'TAXI'),
        is('lightLanding', 'taxi'),
      ),
      item('canopy', t('Kabinendach', 'Canopy'), t('ZU', 'CLOSED'), is('canopy', 'close')),
      item(
        'seatArmed',
        t('Schleudersitz', 'Ejection seat'),
        t('SCHARF', 'ARMED'),
        is('seatArmed', 1),
      ),
      item(
        'parkingBrakeOff',
        t('Parkbremse', 'Parking brake'),
        t('GELÖST', 'RELEASED'),
        is('parkingBrake', 0),
      ),
      item('nws', t('Bugradsteuerung', 'Nosewheel steering'), CHECK),
    ],
  },
  {
    id: 'beforeTakeoff',
    title: t('Vor dem Start (auf der Piste)', 'Before takeoff (on the runway)'),
    kind: 'normal',
    items: [
      item('flaps', t('Landeklappen', 'Flaps'), t('HALF', 'HALF'), is('flaps', 'half')),
      item('trim', t('Trimmung', 'Trim'), t('START', 'TAKEOFF'), range('trim', -0.15, 0.15)),
      item('xpdrAlt', t('Transponder', 'Transponder'), t('ALT', 'ALT'), is('xpdrMode', 'alt')),
      item('strobe', t('Blitzlichter', 'Strobe lights'), ON, is('lightStrobe', 1)),
      item(
        'landingLight',
        t('Landescheinwerfer', 'Landing light'),
        ON,
        is('lightLanding', 'landing'),
      ),
      item(
        'speedbrake',
        t('Bremsklappe', 'Speed brake'),
        t('EINGEFAHREN', 'IN'),
        is('speedbrake', 0),
      ),
      item(
        'runup',
        t('Triebwerke auf 80 %', 'Engines at 80 %'),
        t('INSTRUMENTE PRÜFEN', 'CHECK INSTRUMENTS'),
      ),
    ],
  },
  {
    id: 'takeoff',
    title: t('Start', 'Takeoff'),
    kind: 'normal',
    items: [
      item(
        'power',
        t('Leistungshebel', 'Throttles'),
        t('MIL oder MAX (Nachbrenner)', 'MIL or MAX (afterburner)'),
        all(range('throttle1', 0.74), range('throttle2', 0.74)),
      ),
      item(
        'engines',
        t('Triebwerke', 'Engines'),
        t('GLEICH, IM GRÜNEN', 'MATCHED, IN THE GREEN'),
        all(tel('n2', 85, undefined, LEFT), tel('n2', 85, undefined, RIGHT)),
      ),
      item(
        'rotate',
        t('Rotieren', 'Rotate'),
        t('BEI 140–150 KIAS', 'AT 140–150 KIAS'),
        tel('iasKt', 140),
      ),
      item(
        'gearUp',
        t('Fahrwerk (vor 250 KIAS)', 'Landing gear (before 250 KIAS)'),
        UP,
        all(AIRBORNE, is('gear', 0)),
      ),
      item('flapsAuto', t('Landeklappen', 'Flaps'), t('AUTO', 'AUTO'), is('flaps', 'auto')),
      item(
        'afterburnerOut',
        t('Nachbrenner', 'Afterburner'),
        t('AUS (MIL)', 'OUT (MIL)'),
        all(range('throttle1', undefined, 0.76), range('throttle2', undefined, 0.76)),
      ),
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
      item(
        'climbSchedule',
        t('Steigplan', 'Climb schedule'),
        t('350 KIAS, dann M 0,85', '350 KIAS, then M .85'),
        any(tel('iasKt', 320, 380), tel('mach', 0.8, 0.9)),
      ),
      item(
        'baroStd',
        t('Höhenmesser (über 7000 ft)', 'Altimeter (above 7000 ft)'),
        t('STD', 'STD'),
        tel('baroStd', 1),
      ),
      item(
        'oxygen',
        t('Sauerstoff, Kabinendruck', 'Oxygen and cabin pressure'),
        CHECK,
        is('oxygen', 1),
      ),
      item('landingLight', t('Landescheinwerfer', 'Landing light'), OFF, is('lightLanding', 'off')),
    ],
  },
  {
    id: 'cruise',
    title: t('Reiseflug', 'Cruise'),
    kind: 'normal',
    items: [
      item(
        'mach',
        t('Reisegeschwindigkeit', 'Cruise speed'),
        t('M 0,80–0,85', 'M .80–.85'),
        tel('mach', 0.75, 0.9),
      ),
      item('fuel', t('Treibstoff (BINGO)', 'Fuel (bingo)'), CHECK),
      item('engines', t('Triebwerkinstrumente', 'Engine instruments'), CHECK),
      item('antiIce', t('Triebwerkenteisung', 'Engine anti-ice'), AS_REQUIRED),
    ],
  },
  {
    id: 'descent',
    title: t('Sinkflug und Anflug', 'Descent and approach'),
    kind: 'normal',
    items: [
      item('atis', t('ATIS, Anflugbriefing', 'ATIS and approach briefing'), COMPLETE),
      item(
        'baroQnh',
        t('Höhenmesser (unter der Übergangsfläche)', 'Altimeter (below transition level)'),
        t('AUF QNH', 'SET to QNH'),
        tel('baroStd', undefined, 0),
      ),
      item('minimums', t('Radarhöhenmesser-Warnung', 'Radar altimeter warning'), SET),
      item(
        'ils',
        t('ILS', 'ILS'),
        t('EIN, Frequenz gerastet', 'ON, frequency tuned'),
        is('ilsOn', 1),
      ),
      item(
        'speed',
        t('Fahrt unter FL 100', 'Speed below FL 100'),
        t('250 KIAS HÖCHSTENS', '250 KIAS MAX'),
        tel('iasKt', undefined, 255),
      ),
    ],
  },
  {
    id: 'landing',
    title: t('Landung', 'Landing'),
    kind: 'normal',
    items: [
      item(
        'speedbrake',
        t('Bremsklappe', 'Speed brake'),
        t('EINGEFAHREN', 'IN'),
        is('speedbrake', 0),
      ),
      item(
        'gearDown',
        t('Fahrwerk (unter 250 KIAS)', 'Landing gear (below 250 KIAS)'),
        t('AUSGEFAHREN, 3 GRÜN', 'DOWN, 3 GREEN'),
        all(is('gear', 1), tel('gear', 0.99)),
      ),
      item('flapsFull', t('Landeklappen', 'Flaps'), t('FULL', 'FULL'), is('flaps', 'full')),
      item(
        'hook',
        t('Fanghaken', 'Hook'),
        t('EINGEFAHREN (Landung auf Piste)', 'UP (field landing)'),
        is('hook', 0),
      ),
      item('antiSkid', t('Antiblockiersystem', 'Anti-skid'), ON, is('antiSkid', 1)),
      item(
        'landingLight',
        t('Landescheinwerfer', 'Landing light'),
        ON,
        is('lightLanding', 'landing'),
      ),
      item(
        'onSpeed',
        t('Anstellwinkel', 'Angle of attack'),
        t('ON SPEED (8,1°)', 'ON SPEED (8.1°)'),
        all(AIRBORNE, ON_SPEED),
      ),
      item(
        'touchdown',
        t('Aufsetzen', 'Touchdown'),
        t('LEISTUNGSHEBEL LEERLAUF', 'THROTTLES IDLE'),
        all(
          tel('onGround', 1),
          range('throttle1', undefined, 0.03),
          range('throttle2', undefined, 0.03),
        ),
      ),
      item(
        'braking',
        t('Bremsen', 'Braking'),
        t('NACH BEDARF (unter 100 kt)', 'AS REQUIRED (below 100 KT)'),
      ),
    ],
  },
  {
    id: 'afterLanding',
    title: t('Nach der Landung', 'After landing'),
    kind: 'normal',
    items: [
      item('flaps', t('Landeklappen', 'Flaps'), t('HALF', 'HALF'), is('flaps', 'half')),
      item(
        'seatSafe',
        t('Schleudersitz', 'Ejection seat'),
        t('GESICHERT', 'SAFE'),
        is('seatArmed', 0),
      ),
      item(
        'speedbrake',
        t('Bremsklappe', 'Speed brake'),
        t('EINGEFAHREN', 'IN'),
        is('speedbrake', 0),
      ),
      item(
        'taxiLight',
        t('Rollscheinwerfer', 'Taxi light'),
        t('TAXI', 'TAXI'),
        is('lightLanding', 'taxi'),
      ),
      item('strobe', t('Blitzlichter', 'Strobe lights'), OFF, is('lightStrobe', 0)),
      item('pitotHeat', t('Sondenheizung', 'Pitot heat'), OFF, is('pitotHeat', 0)),
      item('xpdr', t('Transponder', 'Transponder'), t('STBY', 'STBY'), is('xpdrMode', 'standby')),
    ],
  },
  {
    id: 'shutdown',
    title: t('Abstellen', 'Shutdown'),
    kind: 'normal',
    items: [
      parkingBrakeSet,
      item('canopy', t('Kabinendach', 'Canopy'), t('OFFEN', 'OPEN'), is('canopy', 'open')),
      item(
        'throttles',
        t('Leistungshebel', 'Throttles'),
        OFF,
        all(is('fuelCutoff1', 0), is('fuelCutoff2', 0)),
      ),
      item(
        'enginesStopped',
        t('Triebwerke', 'Engines'),
        t('STEHEN', 'STOPPED'),
        tel('enginesRunning', undefined, 0),
      ),
      item(
        'displays',
        t('Anzeigen', 'Displays'),
        OFF,
        all(is('ddiLeftPage', 'off'), is('ddiRightPage', 'off'), is('mpcdPage', 'off')),
      ),
      item(
        'lights',
        t('Aussenlichter', 'Exterior lights'),
        OFF,
        all(is('lightNav', 0), is('lightLanding', 'off')),
      ),
      item('oxygen', t('Sauerstoff', 'Oxygen'), OFF, is('oxygen', 0)),
      item('battery', t('Batterie', 'Battery'), OFF, is('battery', 'off')),
    ],
  },
  // ---- emergencies ----
  {
    id: 'singleEngine',
    title: t('Flug mit einem Triebwerk', 'Single-engine operation'),
    kind: 'emergency',
    trigger: tel('enginesRunning', undefined, 1),
    items: [
      item(
        'goodEngine',
        t('Leistungshebel des guten Triebwerks', 'Throttle of the good engine'),
        t('MIL oder MAX nach Bedarf', 'MIL or MAX as required'),
      ),
      item(
        'failedOff',
        t('Leistungshebel des ausgefallenen Triebwerks', 'Throttle of the failed engine'),
        t('OFF', 'OFF'),
        any(is('fuelCutoff1', 0), is('fuelCutoff2', 0)),
      ),
      item(
        'relight',
        t('Wiederzünden', 'Relight'),
        t(
          'ERWÄGEN (Anlasserschalter, über 350 KIAS ohne APU)',
          'CONSIDER (crank switch; windmill above 350 KIAS)',
        ),
      ),
      item(
        'speedbrake',
        t('Bremsklappe', 'Speed brake'),
        t('EINGEFAHREN', 'IN'),
        is('speedbrake', 0),
      ),
      item('atc', t('ATC', 'ATC'), t('PAN PAN, Landung verlangen', 'PAN PAN, request landing')),
      item('flaps', t('Landeklappen für die Landung', 'Flaps for landing'), t('HALF', 'HALF')),
      item('land', t('Landung', 'Landing'), t('BALDMÖGLICHST', 'AS SOON AS PRACTICAL')),
    ],
  },
  {
    id: 'outOfControl',
    title: t('Unkontrollierter Flugzustand', 'Out-of-control recovery'),
    kind: 'emergency',
    trigger: any(
      tel('alphaDeg', 35),
      tel('alphaDeg', undefined, -15),
      all(tel('iasKt', undefined, 100), tel('aglFt', 3000)),
    ),
    priority: 2,
    items: [
      item('feet', t('Füsse', 'Feet'), t('WEG VON DEN PEDALEN', 'OFF RUDDERS')),
      item('stick', t('Knüppel', 'Stick'), t('LOSLASSEN / NEUTRAL', 'RELEASE / NEUTRAL')),
      item(
        'speedbrake',
        t('Bremsklappe', 'Speed brake'),
        t('EINGEFAHREN', 'IN'),
        is('speedbrake', 0),
      ),
      item('throttles', t('Leistungshebel', 'Throttles'), t('MIL', 'MIL'), MIL),
      item(
        'altitude',
        t('Höhe', 'Altitude'),
        t('PRÜFEN: unter 6000 ft AGL AUSSTEIGEN', 'CHECK: below 6000 FT AGL EJECT'),
        tel('aglFt', 6000),
      ),
      item(
        'spin',
        t('Spin Recovery (wenn im Trudeln)', 'Spin recovery switch (if spinning)'),
        t('RCVY, Pfeilen folgen', 'RCVY, follow the arrows'),
      ),
      item(
        'recovered',
        t('Ausgeleitet', 'Recovered'),
        t('ANSTELLWINKEL UNTER 25°', 'AOA BELOW 25°'),
        all(tel('alphaDeg', -5, 25), tel('iasKt', 150)),
      ),
      item(
        'spinNorm',
        t('Spin Recovery', 'Spin recovery switch'),
        t('NORM', 'NORM'),
        is('spinRecovery', 0),
      ),
    ],
  },
  {
    id: 'flameoutApproach',
    title: t('Ausfall beider Triebwerke', 'Dual engine flameout'),
    kind: 'emergency',
    trigger: tel('enginesRunning', undefined, 0),
    priority: 1,
    items: [
      item(
        'throttles',
        t('Leistungshebel', 'Throttles'),
        t('OFF, dann IDLE (Wiederzünden)', 'OFF, then IDLE (relight)'),
        all(is('fuelCutoff1', 1), is('fuelCutoff2', 1)),
      ),
      item(
        'airspeed',
        t('Fahrt', 'Airspeed'),
        t('350 KIAS ODER MEHR (Fahrtwind-Anlassen)', '350 KIAS OR MORE (windmill relight)'),
        tel('iasKt', 340),
      ),
      item(
        'apuStart',
        t('APU-Anlassen (unter 10 000 ft)', 'APU start (below 10 000 ft)'),
        t('APU EIN, Anlasserschalter', 'APU ON, crank switch'),
      ),
      item(
        'relit',
        t('Ein Triebwerk', 'One engine'),
        t('LÄUFT', 'RUNNING'),
        tel('enginesRunning', 1),
      ),
      item(
        'mayday',
        t('Notruf, Transponder', 'MAYDAY, transponder'),
        t('7700', '7700'),
        range('xpdrCode', 7700, 7700),
      ),
      item(
        'field',
        t('Flugplatz', 'Airfield'),
        t('IN GLEITWEITE? sonst Gebiet zum Aussteigen', 'WITHIN GLIDE? else select ejection area'),
      ),
      item(
        'eject',
        t('Ohne Wiederzündung', 'No relight'),
        t('AUSSTEIGEN (über 6000 ft AGL)', 'EJECT (above 6000 FT AGL)'),
      ),
    ],
  },
];
