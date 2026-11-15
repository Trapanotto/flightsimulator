import { t } from '../i18n';

/**
 * Where the geodata comes from, as its terms ask: swisstopo's credit line in the form of the
 * federal map viewer ("© Data: swisstopo", linked), and OpenStreetMap's for the runway lines.
 */
export function Credits() {
  return (
    <>
      <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener noreferrer">
        {t('credits.swisstopo')}
      </a>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        {t('credits.osm')}
      </a>
    </>
  );
}

/** The same line, small, over the flight: the data is on screen there too. */
export function FlightCredits() {
  return (
    <div class="flight-credits">
      <Credits />
    </div>
  );
}
