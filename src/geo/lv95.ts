import proj4 from 'proj4';

/**
 * Official Swiss LV95 projection definition (EPSG:2056).
 * Accuracy is around one metre, which is more than enough for scenery,
 * runway placement and elevation lookups.
 */
const LV95_PROJ =
  '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 ' +
  '+k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel ' +
  '+towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs';

proj4.defs('EPSG:2056', LV95_PROJ);

export interface Lv95Point {
  easting: number;
  northing: number;
}

export function lv95ToWgs84(easting: number, northing: number) {
  const [lon, lat] = proj4('EPSG:2056', 'EPSG:4326', [easting, northing]);
  return { lon, lat };
}

export function wgs84ToLv95(lon: number, lat: number): Lv95Point {
  const [easting, northing] = proj4('EPSG:4326', 'EPSG:2056', [lon, lat]);
  return { easting, northing };
}
