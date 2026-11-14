// Hand-kept facts the open sources do not carry (or carry inconsistently). Kept small and
// explicit so that a wrong entry is easy to find and fix. Used by tools/airports/build.mjs.

/**
 * Airports outside Switzerland that Swiss flying uses: border airports one departs from or
 * diverts to, within the area where the terrain is streamed in full detail.
 */
export const BORDER_AIRPORTS = [
  'LFSB', // EuroAirport Basel-Mulhouse-Freiburg (Swiss sector, Basel's airport)
  'EDNY', // Friedrichshafen, across Lake Constance from Altenrhein
  'EDTZ', // Konstanz, on the Swiss border
  'LFLI', // Annemasse, next to Geneva
  'LOIH', // Hohenems-Dornbirn, in the Rhine valley opposite Altenrhein
  'LFGB', // Mulhouse-Habsheim, north of Basel
];

/** Names as Swiss pilots say them (the sources have English or long official names). */
export const NAMES = {
  LSZH: 'Zürich',
  LSGG: 'Genève',
  LSZB: 'Bern-Belp',
  LSGS: 'Sion',
  LSZS: 'Samedan',
  LSZA: 'Lugano',
  LSZR: 'St. Gallen-Altenrhein',
  LSZG: 'Grenchen',
  LSGC: 'Les Eplatures',
  LFSB: 'Basel-Mulhouse',
  EDNY: 'Friedrichshafen',
  EDTZ: 'Konstanz',
  LFLI: 'Annemasse',
  LOIH: 'Hohenems-Dornbirn',
  LFGB: 'Mulhouse-Habsheim',
  LSMP: 'Payerne',
  LSME: 'Emmen',
  LSMD: 'Dübendorf',
  LSMM: 'Meiringen',
  LSMA: 'Alpnach',
  LSPR: 'Lodrino',
  LSZC: 'Buochs',
  LSGL: 'Lausanne-Blécherette',
  LSGE: 'Ecuvillens',
  LSGK: 'Saanen',
  LSGN: 'Neuchâtel',
  LSGY: 'Yverdon-les-Bains',
  LSGT: 'La Gruyère',
  LSGP: 'La Côte',
  LSGB: 'Bex',
  LSGR: 'Reichenbach',
  LSZF: 'Birrfeld',
  LSZL: 'Locarno',
  LSZM: 'Mollis',
  LSZN: 'Hausen am Albis',
  LSZO: 'Luzern-Beromünster',
  LSZP: 'Biel-Kappelen',
  LSZQ: 'Bressaucourt',
  LSZT: 'Lommis',
  LSZU: 'Buttwil',
  LSZV: 'Sitterdorf',
  LSZW: 'Thun',
  LSZX: 'Schänis',
  LSZE: 'Bad Ragaz',
  LSZI: 'Fricktal-Schupfart',
  LSZJ: 'Courtelary',
  LSZK: 'Speck-Fehraltorf',
  LSPA: 'Amlikon',
  LSPD: 'Dittingen',
  LSPF: 'Schmerlat',
  LSPG: 'Kägiswil',
  LSPH: 'Winterthur',
  LSPL: 'Langenthal',
  LSPM: 'Ambri',
  LSPN: 'Triengen',
  LSPO: 'Olten',
  LSPU: 'Münster',
  LSPV: 'Wangen-Lachen',
  LSTA: 'Raron',
  LSTB: 'Bellechasse',
  LSTO: 'Môtiers',
  LSTR: 'Montricher',
  LSTS: 'St. Stephan',
  LSTZ: 'Zweisimmen',
};

/**
 * Runway ends with a published instrument approach (ILS, LOC or RNP), from the Swiss and
 * neighbouring AIPs as of 2025. Precision approaches (ILS) are marked 'ils'; the others 'npa'.
 * Neither OurAirports nor OpenStreetMap carries this reliably, so it is kept by hand.
 */
export const INSTRUMENT = {
  LSZH: { 14: 'ils', 16: 'ils', 28: 'ils', 34: 'ils', 10: 'npa', 32: 'npa' },
  LSGG: { '04': 'ils', 22: 'ils' },
  LFSB: { 15: 'ils', 33: 'ils', '08': 'npa', 26: 'npa' },
  LSZB: { 14: 'ils', 32: 'npa' },
  LSZA: { '01': 'npa' },
  LSGS: { 25: 'npa', '07': 'npa' },
  LSZR: { 10: 'ils', 28: 'npa' },
  LSZS: { 21: 'npa' },
  LSZG: { '06': 'ils', 24: 'npa' },
  LSGC: { 24: 'npa' },
  LSMP: { 23: 'ils', '05': 'npa' },
  LSME: { 22: 'ils' },
  LSMD: { 29: 'ils' },
  LSZC: { 24: 'ils' },
  EDNY: { 24: 'ils', '06': 'ils' },
  LFLI: { 12: 'npa', 30: 'npa' },
};
