// Hand-kept navigation facts the open sources do not carry, or carry wrongly. Used by
// tools/nav/build.mjs. Every entry says where the value comes from and how sure it is, so that
// a wrong one is easy to find and fix against the current AIP.
//
// Licence note: the FlightGear / X-Plane navigation data (GPL, Robin Peel's 2013 cycle) was only
// read to cross-check single published facts (a frequency, an angle); nothing is copied from it
// wholesale. Where a value below rests on it, the entry says so.

/**
 * Instrument landing systems. Frequencies in kHz, glide path angle in degrees. Courses are
 * derived from the runway in airports.generated.ts unless `course` (degrees TRUE) is given for
 * a published offset approach. Antenna positions come from OpenStreetMap where mapped, else the
 * build places them by rule (localizer 300 m beyond the far end on the centre line, glide slope
 * 300 m past the threshold and 120 m beside it).
 */
export const ILS = [
  // Zürich. OSM tags 108.30 on LOC 14 and LOC 16 at 110.50, LOC 34 at 110.75; FlightGear's
  // 2013 data agrees on all four. High confidence.
  { icao: 'LSZH', runway: '14', ident: 'IKL', freq: 108300, gs: 3.0, conf: 'high (OSM, FG)' },
  { icao: 'LSZH', runway: '16', ident: 'IZH', freq: 110500, gs: 3.0, conf: 'high (OSM, FG)' },
  // OSM tags LOC 28 with 108.30 as well, which would clash with IKL next to it: a copy error.
  // 109.75 from FlightGear and the Swiss AIP as remembered; 3.3 degrees from FlightGear.
  {
    icao: 'LSZH',
    runway: '28',
    ident: 'IZW',
    freq: 109750,
    gs: 3.3,
    conf: 'medium-high (FG, memory)',
  },
  { icao: 'LSZH', runway: '34', ident: 'IZS', freq: 110750, gs: 3.3, conf: 'high (OSM, FG)' },
  // Genève. Runways renumbered 05/23 -> 04/22 (FlightGear still has 05/23). ILS 22 got new
  // equipment on a new frequency, 108.70 instead of 109.90, from 2020-08-13 (vACC Switzerland
  // NOTAM summary, Navigraph forum); ILS 04 unchanged at 110.90 (vACC chart, FG).
  {
    icao: 'LSGG',
    runway: '04',
    ident: 'INE',
    freq: 110900,
    gs: 3.0,
    conf: 'high (FG, vACC chart)',
  },
  {
    icao: 'LSGG',
    runway: '22',
    ident: 'ISW',
    freq: 108700,
    gs: 3.0,
    conf: 'medium-high (vACC, Navigraph; FG has the old 109.90)',
  },
  // Basel-Mulhouse: French idents have no leading I. MH 111.55 and BLU 109.35 in the IVAO
  // MANEX and FlightGear (FG writes IBLU); 3.5 degrees on 33 from FlightGear.
  { icao: 'LFSB', runway: '15', ident: 'MH', freq: 111550, gs: 3.0, conf: 'high (FG, IVAO MANEX)' },
  {
    icao: 'LFSB',
    runway: '33',
    ident: 'BLU',
    freq: 109350,
    gs: 3.5,
    conf: 'high for the frequency, medium for the angle',
  },
  // Bern: frequency and ident from FlightGear and the task's list; OSM maps the localizer.
  // The steep 4 degree glide path from FlightGear only (medium).
  {
    icao: 'LSZB',
    runway: '14',
    ident: 'IBE',
    freq: 110100,
    gs: 4.0,
    conf: 'high frequency, medium angle',
  },
  // Lugano: IGS (steep, 6.65 degrees, vACC chart) aligned with the runway (chart shows no
  // offset; a 2025 Navigraph thread on AIRAC 2512 confirms ILU 108.90 and course 017 M).
  // FlightGear's 2013 data still has 111.50.
  {
    icao: 'LSZA',
    runway: '01',
    ident: 'ILU',
    freq: 108900,
    gs: 6.65,
    conf: 'medium (forum + chart, no AIP)',
  },
  // St. Gallen-Altenrhein: FlightGear only (108.75, 4.0 degrees); OSM maps both antennas.
  // FlightGear's course is 1 degree off the runway: not verifiable, modelled aligned.
  { icao: 'LSZR', runway: '10', ident: 'IAL', freq: 108750, gs: 4.0, conf: 'medium (FG only)' },
  // Sion: IGS 25, offset 6.5 degrees from the runway, 6 degree glide path (pilotnav, FG course
  // 246.5 T; frequency 110.70 on the airport's pilot page). Guidance ends at 7 DME, the rest
  // is visual: the course does not meet the threshold.
  {
    icao: 'LSGS',
    runway: '25',
    ident: 'ISI',
    freq: 110700,
    gs: 6.0,
    course: 246.5,
    conf: 'medium (airport site, pilotnav, FG)',
  },
  // Military airfields with civil use, FlightGear only (medium): Payerne 3.7, Emmen 4.0 degrees.
  { icao: 'LSMP', runway: '23', ident: 'IPY', freq: 109300, gs: 3.7, conf: 'medium (FG only)' },
  { icao: 'LSME', runway: '22', ident: 'IEM', freq: 110350, gs: 4.0, conf: 'medium (FG only)' },
  // Friedrichshafen: both directions on one frequency (only one is switched on at a time),
  // no paired DME (the FHD DME serves both). FlightGear; OSM maps the four antennas.
  {
    icao: 'EDNY',
    runway: '06',
    ident: 'IFHE',
    freq: 111900,
    gs: 3.1,
    dme: false,
    conf: 'medium (FG, OSM positions)',
  },
  {
    icao: 'EDNY',
    runway: '24',
    ident: 'IFHW',
    freq: 111900,
    gs: 3.0,
    dme: false,
    conf: 'medium (FG, OSM positions)',
  },
];

/**
 * Stations missing from OurAirports' navaids.csv. Positions from OpenStreetMap (which also
 * confirms the frequency unless noted); elevations are the nearby airfield's, good to ~50 m.
 */
export const EXTRA_NAVAIDS = [
  // OSM maps the Grenchen VOR-DME without a frequency; 115.45 from FlightGear only (medium-low,
  // vACC lists a VOR/DME approach 24 at Grenchen, so the station is in service).
  {
    ident: 'GRE',
    name: 'Grenchen',
    type: 'VOR-DME',
    freq: 115450,
    lon: 7.41818,
    lat: 47.18314,
    elev: 430,
    power: 'LOW',
    conf: 'medium-low',
  },
  {
    ident: 'SCS',
    name: 'Aosta',
    type: 'VOR-DME',
    freq: 109250,
    lon: 7.33878,
    lat: 45.74554,
    elev: 545,
    power: 'MEDIUM',
    conf: 'medium (OSM, FG)',
  },
  {
    ident: 'LPS',
    name: 'Les Eplatures',
    type: 'NDB',
    freq: 403,
    lon: 6.79328,
    lat: 47.08344,
    elev: 1020,
    power: 'LOW',
    conf: 'medium (OSM, FG)',
  },
  {
    ident: 'ALG',
    name: 'Allgäu',
    type: 'NDB',
    freq: 341,
    lon: 10.26223,
    lat: 47.99742,
    elev: 630,
    power: 'LOW',
    conf: 'medium (OSM, FG)',
  },
  {
    ident: 'AT',
    name: 'Annecy',
    type: 'NDB',
    freq: 384,
    lon: 6.02034,
    lat: 45.86162,
    elev: 460,
    power: 'LOW',
    conf: 'medium (OSM, FG)',
  },
  {
    ident: 'CH',
    name: 'Chambéry',
    type: 'NDB',
    freq: 346,
    lon: 5.88367,
    lat: 45.5922,
    elev: 235,
    power: 'LOW',
    conf: 'medium (OSM, FG)',
  },
];

/**
 * Corrections to OurAirports rows, by ident and OA type. Each is a case where OurAirports
 * disagrees with itself (frequency vs. DME channel) or with OpenStreetMap.
 */
export const NAVAID_FIXES = {
  // OA frequency 112.25 contradicts its own DME channel 107X (116.00); OSM says 116.
  'LIN VOR-DME': { freq: 116000 },
  // OA 117.25 contradicts its channel 055X (111.80); OSM says 111.8.
  'TZO VOR-DME': { freq: 111800 },
  // OA 11495 is a typo; its channel 073X means 112.60, FlightGear has both (112.60 DME,
  // 114.95 VOR). 112.60 follows the channel (low confidence).
  'BEG VOR-DME': { freq: 112600 },
  // OSM (DFS operator, channel 21X) says 108.40; OA and FlightGear 2013 have 109.60. OSM's tag
  // is the more recent edit (medium-low).
  'KPT VOR-DME': { freq: 108400 },
  // OSM notes the old VOR antenna at Trasadingen was removed; OA lists a DME only. Kept as a
  // DME on the published 114.30.
};

/** Navaid types of OurAirports kept, and what a civil receiver makes of them. */
export const OA_TYPES = {
  VOR: 'VOR',
  'VOR-DME': 'VOR-DME',
  VORTAC: 'VOR-DME',
  DME: 'DME',
  // A TACAN's distance part answers civil DME interrogators on the paired VHF channel.
  TACAN: 'DME',
  NDB: 'NDB',
  'NDB-DME': 'NDB',
};

/** Spoken callsign prefix of an airport's stations, where it differs from the airport name. */
export const CALLSIGNS = {
  LSZH: 'Zurich',
  LSGG: 'Geneva',
  LSZB: 'Bern',
  LFSB: 'Basel',
  LSZR: 'Altenrhein',
  LSGC: 'Les Eplatures',
  LSZC: 'Buochs',
  LSGL: 'Lausanne',
  LSPH: 'Winterthur',
  LSZF: 'Birrfeld',
  LSZT: 'Lommis',
  LSME: 'Emmen',
  LSMP: 'Payerne',
};

/**
 * Flight information service, from OurAirports (Zurich Information 124.70 at LSZF, LSZR, LSZT,
 * ...; Geneva Information 126.35 at LSGP, LSGY, LFLI). The split between the two is an
 * approximation of the published sector line (low accuracy, ~10 km): west and south of the
 * line is Geneva.
 */
export const FIS = [
  { name: 'Zurich Information', freq: 124700 },
  { name: 'Geneva Information', freq: 126350 },
];
/** Line from north to south: points west of it belong to Geneva Information. */
export const FIS_LINE = [
  [6.95, 47.6],
  [7.1, 47.2],
  [7.3, 46.95],
  [7.65, 46.55],
  [8.1, 46.3],
  [8.5, 45.8],
];

/**
 * Airspace classes. The FOCA data has no class; Swiss CTRs are class D, the TMAs of Zürich,
 * Geneva and Basel class C, the others class D (from the AIP as remembered, medium confidence;
 * a few lower sectors of the big TMAs are class D in reality). The Samedan FIZ is uncontrolled.
 */
export const TMA_CLASS_C = ['LSZH', 'LSGG', 'LFSB'];

/**
 * Named IFR fixes whose role I know from the STAR charts; positions from FlightGear's 2013
 * fix.dat (single published facts). Medium confidence: fixes rarely move, but they get renamed.
 */
export const IFR_FIXES = [
  // The three Zürich arrival holdings (north, east, west).
  { ident: 'RILAX', airport: 'LSZH', role: 'iaf', lon: 8.51361, lat: 47.94278 },
  { ident: 'AMIKI', airport: 'LSZH', role: 'iaf', lon: 9.03755, lat: 47.57369 },
  { ident: 'GIPOL', airport: 'LSZH', role: 'iaf', lon: 8.04083, lat: 47.50528 },
  // Geneva STAR entry points (names from the vACC chart list).
  { ident: 'AKITO', airport: 'LSGG', role: 'star', lon: 6.64889, lat: 47.21333 },
  { ident: 'BENOT', airport: 'LSGG', role: 'star', lon: 7.17278, lat: 47.05778 },
  { ident: 'ULMES', airport: 'LSGG', role: 'star', lon: 7.2925, lat: 46.955 },
  { ident: 'LUSAR', airport: 'LSGG', role: 'star', lon: 5.17944, lat: 46.66889 },
  { ident: 'BANKO', airport: 'LSGG', role: 'star', lon: 7.055, lat: 45.82 },
  { ident: 'BELUS', airport: 'LSGG', role: 'star', lon: 5.59389, lat: 45.67528 },
  { ident: 'KINES', airport: 'LSGG', role: 'star', lon: 6.75528, lat: 45.33139 },
];

/**
 * Airports whose VFR reporting points are generated. The published points (Bern: Whiskey,
 * Echo, Sierra, ...) could not be verified from an open source (the Swiss VFR Manual needs a
 * login, openAIP's API a key): the build places November, Echo, Sierra and Whiskey where the
 * line from the airport due north, east, south and west leaves the control zone. Same names as
 * on the chart where they exist, but the positions are approximate (often several km off).
 */
export const VFR_AIRPORTS = ['LSZH', 'LSGG', 'LSZB', 'LSZG', 'LSZA', 'LSGS', 'LSZR', 'LSGC'];
