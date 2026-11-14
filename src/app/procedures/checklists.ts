/**
 * The checklists of the Cessna 172S, after section 4 (normal procedures) and section 3
 * (emergency procedures) of the Pilot's Operating Handbook, shortened to what the cockpit of
 * the simulator has. The preflight inspection keeps only its cockpit part. The simulated
 * engine has carburettor heat (the real 172S is fuel-injected), so the carburettor items of
 * the carburetted 172 are in where the handbook of that model has them.
 *
 * Items with a `check` tick themselves when the cockpit or the telemetry shows them done;
 * the others the pilot ticks by hand. Control names are those of C172_CONTROLS.
 */

export type TelemetryKey =
  | 'rpm'
  | 'iasKt'
  | 'aglFt'
  | 'groundSpeedKt'
  | 'verticalSpeedFpm'
  | 'onGround'
  | 'engineRunning'
  | 'busVolts'
  | 'batteryAmps'
  | 'oilPressure'
  | 'vacuum'
  | 'lowVolts'
  | 'lowVacuum';

export type Check =
  /** A toggle (0/1) or a selector by its position name, or one of several positions. */
  | { control: string; is: number | string | readonly string[] }
  /** A lever or knob within a range. */
  | { control: string; min?: number; max?: number }
  | { telemetry: TelemetryKey; min?: number; max?: number }
  | { all: readonly Check[] };

export interface Text {
  de: string;
  en: string;
}

export interface ChecklistItemDef {
  id: string;
  label: Text;
  expect: Text;
  check?: Check;
}

export interface ChecklistDef {
  id: string;
  title: Text;
  kind: 'normal' | 'emergency';
  items: readonly ChecklistItemDef[];
}

const t = (de: string, en: string): Text => ({ de, en });
const item = (id: string, label: Text, expect: Text, check?: Check): ChecklistItemDef =>
  check ? { id, label, expect, check } : { id, label, expect };

const ON = t('EIN', 'ON');
const OFF = t('AUS', 'OFF');
const CHECK = t('PRÜFEN', 'CHECK');
const SET = t('GESETZT', 'SET');
const RICH = t('REICH', 'RICH');
const BOTH = t('BEIDE', 'BOTH');
const UP = t('EINGEFAHREN', 'UP');
const COMPLETE = t('ERLEDIGT', 'COMPLETE');

// Reused items: the same switch in several lists says the same thing.
const parkingBrakeSet = item('parkingBrake', t('Parkbremse', 'Parking brake'), SET, {
  control: 'parkingBrake',
  is: 1,
});
const fuelBoth = item('fuelSelector', t('Tankwahlschalter', 'Fuel selector valve'), BOTH, {
  control: 'fuelSelector',
  is: 'both',
});
const fuelShutoffOn = item(
  'fuelShutoff',
  t('Brandhahn', 'Fuel shutoff valve'),
  t('EIN (gedrückt)', 'ON (push full in)'),
  { control: 'fuelShutoff', is: 1 },
);
const mixtureRich = item('mixture', t('Gemisch', 'Mixture'), RICH, {
  control: 'mixture',
  min: 0.95,
});
const trimTakeoff = item('trim', t('Höhenrudertrimmung', 'Elevator trim'), t('START', 'TAKEOFF'), {
  control: 'trim',
  min: -0.15,
  max: 0.15,
});

export const C172_CHECKLISTS: readonly ChecklistDef[] = [
  {
    id: 'preflight',
    title: t('Vorflugkontrolle (Cockpit)', 'Preflight inspection (cabin)'),
    kind: 'normal',
    items: [
      item('documents', t('Bordpapiere', 'Documents'), t('AN BORD', 'ON BOARD')),
      item('controlLock', t('Steuersperre', 'Control wheel lock'), t('ENTFERNT', 'REMOVE')),
      parkingBrakeSet,
      item('magnetos', t('Zündschalter', 'Magnetos'), OFF, { control: 'magnetos', is: 'off' }),
      item('avionics', t('Avionik-Schalter', 'Avionics switch'), OFF, {
        control: 'avionics',
        is: 0,
      }),
      item('batteryOn', t('Hauptschalter (BAT)', 'Master switch (BAT)'), ON, {
        control: 'battery',
        is: 1,
      }),
      item('fuelQuantity', t('Treibstoffmenge', 'Fuel quantity'), CHECK),
      item('annunciators', t('Warnleuchten (LOW FUEL)', 'Low fuel annunciators'), CHECK),
      item('batteryOff', t('Hauptschalter (BAT)', 'Master switch (BAT)'), OFF, {
        control: 'battery',
        is: 0,
      }),
      trimTakeoff,
      fuelBoth,
      fuelShutoffOn,
    ],
  },
  {
    id: 'beforeStart',
    title: t('Vor dem Anlassen', 'Before starting engine'),
    kind: 'normal',
    items: [
      item('preflight', t('Vorflugkontrolle', 'Preflight inspection'), COMPLETE),
      item('briefing', t('Passagierbriefing', 'Passenger briefing'), COMPLETE),
      item(
        'seats',
        t('Sitze, Gurte', 'Seats and seat belts'),
        t('EINGESTELLT, GESCHLOSSEN', 'ADJUST and LOCK'),
      ),
      item('brakes', t('Bremsen', 'Brakes'), t('PRÜFEN und SETZEN', 'TEST and SET'), {
        control: 'parkingBrake',
        is: 1,
      }),
      item('breakers', t('Sicherungen', 'Circuit breakers'), t('ALLE DRIN', 'CHECK IN')),
      item('avionics', t('Avionik-Schalter', 'Avionics switch'), OFF, {
        control: 'avionics',
        is: 0,
      }),
      fuelBoth,
      fuelShutoffOn,
    ],
  },
  {
    id: 'engineStart',
    title: t('Anlassen', 'Starting engine'),
    kind: 'normal',
    items: [
      item('throttle', t('Leistungshebel', 'Throttle'), t('1/4 ZOLL OFFEN', 'OPEN 1/4 INCH'), {
        control: 'throttle',
        min: 0.02,
        max: 0.15,
      }),
      item('mixtureCutoff', t('Gemisch', 'Mixture'), t('LEERLAUF-ABSTELLEN', 'IDLE CUTOFF'), {
        control: 'mixture',
        max: 0.05,
      }),
      item('propArea', t('Propellerbereich', 'Propeller area'), t('FREI', 'CLEAR')),
      item('master', t('Hauptschalter (ALT und BAT)', 'Master switch (ALT and BAT)'), ON, {
        all: [
          { control: 'battery', is: 1 },
          { control: 'alternator', is: 1 },
        ],
      }),
      item('beacon', t('Blitzlicht (BEACON)', 'Beacon light'), ON, {
        control: 'lightBeacon',
        is: 1,
      }),
      item('pumpOn', t('Hilfspumpe', 'Auxiliary fuel pump'), ON, { control: 'fuelPump', is: 1 }),
      item(
        'prime',
        t('Vorpumpen', 'Prime'),
        t('Gemisch 3–5 s REICH, dann LEERLAUF-ABSTELLEN', 'Mixture RICH 3–5 s, then IDLE CUTOFF'),
      ),
      item('pumpOff', t('Hilfspumpe', 'Auxiliary fuel pump'), OFF, { control: 'fuelPump', is: 0 }),
      item(
        'start',
        t('Zündschalter', 'Magnetos'),
        t('START (loslassen, wenn der Motor läuft)', 'START (release when engine starts)'),
        { telemetry: 'engineRunning', min: 1 },
      ),
      item(
        'mixtureAdvance',
        t('Gemisch', 'Mixture'),
        t('LANGSAM AUF REICH', 'ADVANCE smoothly to RICH'),
        {
          control: 'mixture',
          min: 0.95,
        },
      ),
      item(
        'oilPressure',
        t('Öldruck', 'Oil pressure'),
        t('IM GRÜNEN BEREICH', 'CHECK (green arc)'),
        {
          telemetry: 'oilPressure',
          min: 20,
        },
      ),
      item('ammeter', t('Amperemeter', 'Ammeter'), t('LÄDT', 'CHECK charging'), {
        telemetry: 'busVolts',
        min: 26,
      }),
      item('avionicsOn', t('Avionik-Schalter', 'Avionics switch'), ON, {
        control: 'avionics',
        is: 1,
      }),
      item(
        'navLights',
        t('Positionslichter', 'Navigation lights'),
        t('NACH BEDARF', 'AS REQUIRED'),
      ),
    ],
  },
  {
    id: 'beforeTakeoff',
    title: t('Vor dem Start', 'Before takeoff'),
    kind: 'normal',
    items: [
      parkingBrakeSet,
      item('doors', t('Kabinentüren', 'Cabin doors'), t('ZU und VERRIEGELT', 'CLOSED and LOCKED')),
      item(
        'controls',
        t('Steuerung', 'Flight controls'),
        t('FREI und RICHTIG', 'FREE and CORRECT'),
      ),
      item('instruments', t('Fluginstrumente', 'Flight instruments'), CHECK),
      item('altimeter', t('Höhenmesser', 'Altimeter'), t('AUF QNH', 'SET to QNH')),
      fuelBoth,
      mixtureRich,
      trimTakeoff,
      item('runup', t('Leistungshebel', 'Throttle'), t('1800 U/min', '1800 RPM'), {
        telemetry: 'rpm',
        min: 1700,
        max: 1900,
      }),
      item(
        'magCheck',
        t('Zündung', 'Magnetos'),
        t('PRÜFEN (Abfall höchstens 150 U/min)', 'CHECK (drop 150 RPM max)'),
      ),
      item('vacuum', t('Unterdruck', 'Vacuum gauge'), t('4,5–5,5 inHg', '4.5–5.5 in Hg'), {
        telemetry: 'vacuum',
        min: 4.5,
        max: 5.5,
      }),
      item(
        'engineInstr',
        t('Motorinstrumente, Amperemeter', 'Engine instruments and ammeter'),
        CHECK,
      ),
      item(
        'idle',
        t('Leistungshebel', 'Throttle'),
        t('LEERLAUF, dann 1000 U/min oder weniger', 'CHECK IDLE, then 1000 RPM or less'),
        {
          telemetry: 'rpm',
          max: 1000,
        },
      ),
      item('xpdr', t('Transponder', 'Transponder'), t('ALT', 'ALT'), {
        control: 'xpdrMode',
        is: 'alt',
      }),
      item('strobe', t('Blitzlichter (STROBE)', 'Strobe lights'), ON, {
        control: 'lightStrobe',
        is: 1,
      }),
      item('flaps', t('Landeklappen', 'Wing flaps'), t('0–10°', 'UP–10°'), {
        control: 'flaps',
        is: ['0', '10'],
      }),
      item('releaseBrake', t('Parkbremse', 'Brakes'), t('GELÖST', 'RELEASE'), {
        control: 'parkingBrake',
        is: 0,
      }),
    ],
  },
  {
    id: 'takeoff',
    title: t('Start', 'Takeoff'),
    kind: 'normal',
    items: [
      item('flaps', t('Landeklappen', 'Wing flaps'), t('0–10°', 'UP–10°'), {
        control: 'flaps',
        is: ['0', '10'],
      }),
      item('carbHeat', t('Vergaservorwärmung', 'Carburettor heat'), t('KALT', 'COLD'), {
        control: 'carbHeat',
        max: 0.05,
      }),
      item('landingLight', t('Landescheinwerfer', 'Landing light'), ON, {
        control: 'lightLanding',
        is: 1,
      }),
      item('throttleFull', t('Leistungshebel', 'Throttle'), t('VOLLGAS', 'FULL'), {
        control: 'throttle',
        min: 0.95,
      }),
      mixtureRich,
      item(
        'rotate',
        t('Höhensteuer', 'Elevator control'),
        t('BUGRAD BEI 55 KIAS ANHEBEN', 'LIFT NOSE WHEEL at 55 KIAS'),
        {
          telemetry: 'iasKt',
          min: 55,
        },
      ),
      item('climbSpeed', t('Steiggeschwindigkeit', 'Climb speed'), t('70–80 KIAS', '70–80 KIAS'), {
        all: [
          { telemetry: 'onGround', max: 0 },
          { telemetry: 'iasKt', min: 65, max: 85 },
        ],
      }),
    ],
  },
  {
    id: 'climb',
    title: t('Steigflug', 'Enroute climb'),
    kind: 'normal',
    items: [
      item('flapsUp', t('Landeklappen', 'Wing flaps'), UP, { control: 'flaps', is: '0' }),
      item('airspeed', t('Fahrt', 'Airspeed'), t('75–85 KIAS', '75–85 KIAS'), {
        telemetry: 'iasKt',
        min: 70,
        max: 90,
      }),
      item('throttle', t('Leistungshebel', 'Throttle'), t('VOLLGAS', 'FULL'), {
        control: 'throttle',
        min: 0.95,
      }),
      item(
        'mixture',
        t('Gemisch', 'Mixture'),
        t(
          'REICH (über 3000 ft auf max. Drehzahl abmagern)',
          'RICH (above 3000 ft, lean for max RPM)',
        ),
      ),
    ],
  },
  {
    id: 'cruise',
    title: t('Reiseflug', 'Cruise'),
    kind: 'normal',
    items: [
      item('power', t('Leistung', 'Power'), t('2100–2700 U/min', '2100–2700 RPM'), {
        telemetry: 'rpm',
        min: 2100,
        max: 2700,
      }),
      item('trim', t('Höhenrudertrimmung', 'Elevator trim'), t('EINGESTELLT', 'ADJUST')),
      item('mixture', t('Gemisch', 'Mixture'), t('ABGEMAGERT', 'LEAN')),
      item('fuel', t('Treibstoff', 'Fuel'), CHECK),
    ],
  },
  {
    id: 'descent',
    title: t('Sinkflug', 'Descent'),
    kind: 'normal',
    items: [
      item('atis', t('ATIS, Anflugbriefing', 'ATIS and approach briefing'), COMPLETE),
      item('altimeter', t('Höhenmesser', 'Altimeter'), t('AUF QNH', 'SET to QNH')),
      item('power', t('Leistung', 'Power'), t('NACH BEDARF', 'AS DESIRED')),
      item('mixture', t('Gemisch', 'Mixture'), t('NACH BEDARF ANREICHERN', 'ENRICHEN as required')),
      fuelBoth,
      item(
        'carbHeat',
        t('Vergaservorwärmung', 'Carburettor heat'),
        t('NACH BEDARF', 'AS REQUIRED'),
      ),
    ],
  },
  {
    id: 'beforeLanding',
    title: t('Vor der Landung', 'Before landing'),
    kind: 'normal',
    items: [
      item('seats', t('Sitze, Gurte', 'Seats and seat belts'), t('GESICHERT', 'SECURE')),
      fuelBoth,
      mixtureRich,
      item('landingLight', t('Landescheinwerfer', 'Landing light'), ON, {
        control: 'lightLanding',
        is: 1,
      }),
      item('carbHeat', t('Vergaservorwärmung', 'Carburettor heat'), t('WARM', 'ON'), {
        control: 'carbHeat',
        min: 0.95,
      }),
      item('autopilot', t('Autopilot', 'Autopilot'), OFF),
      item(
        'flaps',
        t('Landeklappen', 'Wing flaps'),
        t('NACH BEDARF (unter 110 KIAS)', 'AS REQUIRED (below 110 KIAS)'),
      ),
    ],
  },
  {
    id: 'afterLanding',
    title: t('Nach der Landung', 'After landing'),
    kind: 'normal',
    items: [
      item('flapsUp', t('Landeklappen', 'Wing flaps'), UP, { control: 'flaps', is: '0' }),
      item('carbHeat', t('Vergaservorwärmung', 'Carburettor heat'), t('KALT', 'COLD'), {
        control: 'carbHeat',
        max: 0.05,
      }),
      item('strobe', t('Blitzlichter (STROBE)', 'Strobe lights'), OFF, {
        control: 'lightStrobe',
        is: 0,
      }),
      item('landingLight', t('Landescheinwerfer', 'Landing light'), OFF, {
        control: 'lightLanding',
        is: 0,
      }),
    ],
  },
  {
    id: 'securing',
    title: t('Abstellen', 'Securing airplane'),
    kind: 'normal',
    items: [
      parkingBrakeSet,
      item('throttleIdle', t('Leistungshebel', 'Throttle'), t('LEERLAUF', 'IDLE'), {
        control: 'throttle',
        max: 0.05,
      }),
      item('equipment', t('Elektrische Verbraucher', 'Electrical equipment'), OFF),
      item('avionics', t('Avionik-Schalter', 'Avionics switch'), OFF, {
        control: 'avionics',
        is: 0,
      }),
      item('mixtureCutoff', t('Gemisch', 'Mixture'), t('LEERLAUF-ABSTELLEN', 'IDLE CUTOFF'), {
        control: 'mixture',
        max: 0.05,
      }),
      item('engineStopped', t('Motor', 'Engine'), t('STEHT', 'STOPPED'), {
        telemetry: 'engineRunning',
        max: 0,
      }),
      item('magnetos', t('Zündschalter', 'Magnetos'), OFF, { control: 'magnetos', is: 'off' }),
      item('master', t('Hauptschalter (ALT und BAT)', 'Master switch (ALT and BAT)'), OFF, {
        all: [
          { control: 'battery', is: 0 },
          { control: 'alternator', is: 0 },
        ],
      }),
      item(
        'fuelSelector',
        t('Tankwahlschalter', 'Fuel selector valve'),
        t('LINKS oder RECHTS', 'LEFT or RIGHT'),
        {
          control: 'fuelSelector',
          is: ['left', 'right'],
        },
      ),
    ],
  },
  // ---- emergencies ----
  {
    id: 'engineFailure',
    title: t('Motorausfall im Flug: Notlandung', 'Engine failure in flight: emergency landing'),
    kind: 'emergency',
    items: [
      item('glide', t('Fahrt', 'Airspeed'), t('68 KIAS (bestes Gleiten)', '68 KIAS (best glide)'), {
        telemetry: 'iasKt',
        min: 63,
        max: 73,
      }),
      item('field', t('Landefeld', 'Landing area'), t('AUSGEWÄHLT', 'SELECT')),
      item('seats', t('Sitze, Gurte', 'Seats and seat belts'), t('GESICHERT', 'SECURE')),
      item(
        'mayday',
        t('Notruf 121,500 / Transponder 7700', 'MAYDAY 121.5 / transponder 7700'),
        t('NACH BEDARF', 'AS REQUIRED'),
      ),
      item('mixtureCutoff', t('Gemisch', 'Mixture'), t('LEERLAUF-ABSTELLEN', 'IDLE CUTOFF'), {
        control: 'mixture',
        max: 0.05,
      }),
      item(
        'fuelShutoff',
        t('Brandhahn', 'Fuel shutoff valve'),
        t('AUS (gezogen)', 'OFF (pull full out)'),
        {
          control: 'fuelShutoff',
          is: 0,
        },
      ),
      item('magnetos', t('Zündschalter', 'Magnetos'), OFF, { control: 'magnetos', is: 'off' }),
      item(
        'flaps',
        t('Landeklappen', 'Wing flaps'),
        t('NACH BEDARF (30° empfohlen)', 'AS REQUIRED (30° recommended)'),
      ),
      item(
        'master',
        t('Hauptschalter (ALT und BAT)', 'Master switch (ALT and BAT)'),
        t('AUS (Landung gesichert)', 'OFF (when landing is assured)'),
        {
          all: [
            { control: 'battery', is: 0 },
            { control: 'alternator', is: 0 },
          ],
        },
      ),
    ],
  },
  {
    id: 'engineRestart',
    title: t('Motorausfall im Flug: Wiederanlassen', 'Engine failure during flight: restart'),
    kind: 'emergency',
    items: [
      item('glide', t('Fahrt', 'Airspeed'), t('68 KIAS (bestes Gleiten)', '68 KIAS (best glide)'), {
        telemetry: 'iasKt',
        min: 63,
        max: 73,
      }),
      fuelShutoffOn,
      fuelBoth,
      item('pumpOn', t('Hilfspumpe', 'Auxiliary fuel pump'), ON, { control: 'fuelPump', is: 1 }),
      item(
        'mixtureRich',
        t('Gemisch', 'Mixture'),
        t('REICH (wenn er nicht wieder anspringt)', 'RICH (if restart has not occurred)'),
        {
          control: 'mixture',
          min: 0.95,
        },
      ),
      item('carbHeat', t('Vergaservorwärmung', 'Carburettor heat'), t('WARM', 'ON'), {
        control: 'carbHeat',
        min: 0.95,
      }),
      item(
        'magnetos',
        t('Zündschalter', 'Magnetos'),
        t('BEIDE (START bei stehendem Propeller)', 'BOTH (or START if propeller is stopped)'),
        {
          control: 'magnetos',
          is: ['both', 'start'],
        },
      ),
      item('running', t('Motor', 'Engine'), t('LÄUFT', 'RUNNING'), {
        telemetry: 'engineRunning',
        min: 1,
      }),
      item('pumpOff', t('Hilfspumpe', 'Auxiliary fuel pump'), OFF, { control: 'fuelPump', is: 0 }),
    ],
  },
  {
    id: 'lowVoltage',
    title: t('Stromversorgung: Warnung LOW VOLTS', 'Electrical: low voltage annunciator'),
    kind: 'emergency',
    items: [
      item('avionicsOff', t('Avionik-Schalter', 'Avionics switch'), OFF, {
        control: 'avionics',
        is: 0,
      }),
      item('breaker', t('Sicherung ALT FIELD', 'ALT FIELD circuit breaker'), t('DRIN', 'CHECK IN')),
      item('altOff', t('Hauptschalter (nur ALT)', 'Master switch (ALT only)'), OFF, {
        control: 'alternator',
        is: 0,
      }),
      item('altOn', t('Hauptschalter (nur ALT)', 'Master switch (ALT only)'), ON, {
        control: 'alternator',
        is: 1,
      }),
      item(
        'annunciator',
        t('Warnleuchte LOW VOLTS', 'Low voltage annunciator'),
        t('AUS', 'CHECK OFF'),
        {
          telemetry: 'lowVolts',
          max: 0,
        },
      ),
      item('avionicsOn', t('Avionik-Schalter', 'Avionics switch'), ON, {
        control: 'avionics',
        is: 1,
      }),
      item(
        'stillOn',
        t('Leuchtet sie weiter', 'If the annunciator stays on'),
        t(
          'ALT AUS, Verbraucher AUS, baldmöglichst landen',
          'ALT OFF, nonessential equipment OFF, land as soon as practical',
        ),
      ),
    ],
  },
  {
    id: 'vacuumFailure',
    title: t('Ausfall der Unterdruckpumpe', 'Vacuum system failure'),
    kind: 'emergency',
    items: [
      item('gauge', t('Unterdruckanzeige', 'Vacuum gauge'), CHECK),
      item(
        'attitude',
        t('Künstlicher Horizont', 'Attitude indicator'),
        t('NICHT BENUTZEN, Wendezeiger', 'DO NOT USE, fly by turn coordinator'),
      ),
      item(
        'heading',
        t('Kurskreisel', 'Directional gyro'),
        t('NICHT BENUTZEN, Magnetkompass', 'DO NOT USE, use magnetic compass'),
      ),
      item('land', t('Landung', 'Landing'), t('BALDMÖGLICHST', 'AS SOON AS PRACTICAL')),
    ],
  },
  {
    id: 'icing',
    title: t('Unbeabsichtigte Vereisung', 'Inadvertent icing encounter'),
    kind: 'emergency',
    items: [
      item('pitotHeat', t('Staurohrheizung', 'Pitot heat'), ON, { control: 'pitotHeat', is: 1 }),
      item(
        'turnBack',
        t('Umkehren oder Höhe wechseln', 'Turn back or change altitude'),
        t('SOFORT', 'IMMEDIATELY'),
      ),
      item(
        'cabinHeat',
        t('Kabinenheizung, Scheibenheizung', 'Cabin heat and defroster'),
        t('VOLL', 'FULL'),
      ),
      item('carbHeat', t('Vergaservorwärmung', 'Carburettor heat'), t('WARM', 'ON'), {
        control: 'carbHeat',
        min: 0.95,
      }),
      item(
        'rpm',
        t('Leistung', 'Throttle'),
        t('ERHÖHEN (Eis vom Propeller)', 'INCREASE (to shed ice from the propeller)'),
      ),
      item('airport', t('Landung', 'Landing'), t('NÄCHSTER FLUGPLATZ', 'NEAREST AIRPORT')),
      item('flaps', t('Landeklappen', 'Wing flaps'), t('EINGEFAHREN LASSEN', 'LEAVE RETRACTED'), {
        control: 'flaps',
        is: '0',
      }),
    ],
  },
];
