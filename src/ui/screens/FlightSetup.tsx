import { useSignal } from '@preact/signals';
import { AIRCRAFT, type AircraftInfo } from '@sim';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { type AirportOption, type WeatherChoice, game, settings } from '../api';
import { Brand, Version } from '../components/Brand';
import { Credits } from '../components/Credits';
import { Segmented } from '../components/controls';
import {
  CategoryIcon,
  IconApproach,
  IconBack,
  IconChevronDown,
  IconClimb,
  IconClose,
  IconCloud,
  IconFair,
  IconGlobe,
  IconLive,
  IconOvercast,
  IconPlane,
  IconRunway,
  IconSearch,
  IconSettings,
  IconStratus,
  IconSun,
} from '../components/icons';
import { airportEligibility, categoryOf, shortName, typeDefaults } from '../fleet';
import { eligibilityText } from '../fleetText';
import { arrowNav, useDialog } from '../focus';
import { altitudeUnit, convertAltitude, formatSpec, groupThousands } from '../format';
import { type MessageKey, lang, setLang, t } from '../i18n';
import { actions, nav } from '../nav';
import { browserStorage, readJson, writeJson } from '../persist';
import {
  DRAFT_KEY,
  type SetupDraft,
  type StartKind,
  WEATHER_CHOICES,
  draftToPlan,
  planProblem,
  sanitizeDraft,
  usableEnds,
} from '../plan';
import {
  type SectionKey,
  airportFacts,
  isMainAirport,
  labelPriority,
  mapAirports,
  orderAirports,
  placeLabel,
  readRecent,
  rememberAirport,
} from '../airportPick';
import { SwissMap } from './SwissMap';

const WEATHER_ICON: Record<WeatherChoice, () => preact.JSX.Element> = {
  live: () => <IconLive size={24} />,
  clear: () => <IconSun size={24} />,
  fair: () => <IconFair size={24} />,
  cloudy: () => <IconCloud size={24} />,
  overcast: () => <IconOvercast size={24} />,
  lowStratus: () => <IconStratus size={24} />,
};

/** Times of day on offer: the calendar's now, or a moment that reads as a part of the day. */
export const TIME_CHOICES = [
  { key: 'now', time: 'now' },
  { key: 'morning', time: 8 },
  { key: 'noon', time: 12 },
  { key: 'evening', time: 18.5 },
  { key: 'night', time: 23 },
] as const;

/** The aircraft's name as the picker shows it: the maker's long name gives way to the type. */
function displayName(info: AircraftInfo): string {
  return info.name.replace(/^McDonnell Douglas /, '');
}

/** Height in the current units, rounded the way a pilot would say it. */
export function heightLabel(m: number): string {
  const units = settings.units.value;
  const v = convertAltitude(m, units);
  const r = units === 'aviation' ? Math.round(v / 100) * 100 : Math.round(v / 50) * 50;
  return `${groupThousands(r, lang.value)} ${altitudeUnit(units)}`;
}

const SECTION_TITLE: Record<SectionKey, MessageKey> = {
  recent: 'setup.group.recent',
  large: 'setup.group.large',
  other: 'setup.group.other',
  hits: 'setup.group.hits',
  off: 'setup.group.off',
};

/** Elevation, longest runway with its surface, military: what tells fields apart. */
function AirportFactsLine({ a }: { a: AirportOption }) {
  const f = airportFacts(a);
  const len = f.longest ? formatSpec('length', f.longest, settings.units.value, lang.value) : null;
  const sep = (
    <span class="apt-sep" aria-hidden="true">
      ·
    </span>
  );
  return (
    <>
      {heightLabel(a.elevation)}
      {len && (
        <>
          {sep}
          {len.value} {len.unit} {t(f.paved ? 'setup.paved' : 'setup.grass')}
        </>
      )}
      {f.military && (
        <>
          {sep}
          {t('setup.military')}
        </>
      )}
    </>
  );
}

/**
 * The airports as a searchable list in sections: recently flown, airports, other airfields,
 * and last those the chosen type may not use, with the reason. One radio group: arrows move
 * through all of it, Enter in the search picks the first hit, the arrow down goes from the
 * search into the list.
 */
function AirportList(props: {
  airports: AirportOption[];
  selected: string;
  onSelect: (icao: string) => void;
  /** The chosen type: airports it may not use are greyed out with the reason. */
  info?: AircraftInfo;
  recent: readonly string[];
  hovered: string | null;
  onHover: (icao: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const query = useSignal('');
  if (!props.airports.length)
    return (
      <div class="empty">
        <p class="empty-title">{t('setup.noAirports')}</p>
        <p class="empty-hint">{t('setup.noAirports.hint')}</p>
      </div>
    );
  const category = categoryOf(props.info);
  const sections = orderAirports(props.airports, category, props.recent, query.value);
  const shown = sections.flatMap((s) => s.airports);
  const anySelected = shown.some((a) => a.icao === props.selected);
  const firstUsable = sections.find((s) => s.key !== 'off')?.airports[0];
  const radios = () =>
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])');
  const typeName = props.info ? shortName(props.info) : '';
  return (
    <div class="apt-pick">
      <div class="apt-search">
        <IconSearch size={18} />
        <input
          type="search"
          class="apt-search-input"
          aria-label={t('setup.search')}
          aria-controls="setup-apt-list"
          placeholder={t('setup.search.placeholder')}
          autocomplete="off"
          spellcheck={false}
          value={query.value}
          onInput={(e) => (query.value = (e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && firstUsable) {
              e.preventDefault();
              props.onSelect(firstUsable.icao);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const list = radios();
              const on = [...(list ?? [])].find((el) => el.getAttribute('aria-checked') === 'true');
              (on ?? list?.[0])?.focus();
            } else if (e.key === 'Escape' && query.value) {
              // Clears the search instead of closing the setup.
              e.preventDefault();
              e.stopPropagation();
              query.value = '';
            }
          }}
        />
        {query.value && (
          <button
            type="button"
            class="apt-search-clear"
            aria-label={t('setup.search.clear')}
            title={t('setup.search.clear')}
            onClick={() => (query.value = '')}
          >
            <IconClose size={16} />
          </button>
        )}
      </div>
      <div
        ref={ref}
        id="setup-apt-list"
        class="apt-list"
        role="radiogroup"
        aria-label={t('setup.airports')}
        onKeyDown={(e) =>
          arrowNav(e, ref.current, '[role="radio"]:not([aria-disabled="true"])', 'both')?.click()
        }
      >
        {!shown.length && (
          <p class="apt-none" role="status">
            {t('setup.search.none', { q: query.value.trim() })}
          </p>
        )}
        {sections.map((s) => (
          <section class={`apt-section is-${s.key}`} key={s.key} aria-labelledby={`apt-h-${s.key}`}>
            <h3 class="caps apt-section-title" id={`apt-h-${s.key}`}>
              {t(SECTION_TITLE[s.key], { type: typeName })}
            </h3>
            <div class="apt-grid">
              {s.airports.map((a) => {
                const on = a.icao === props.selected;
                const e = airportEligibility(a, category);
                const off = !e.ok;
                const first = !anySelected && a === shown[0];
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-disabled={off ? 'true' : undefined}
                    title={off ? eligibilityText(e, props.info, 'long') : undefined}
                    tabIndex={on || first ? 0 : -1}
                    data-autofocus={on ? '' : undefined}
                    class={`apt${on ? ' is-on' : ''}${off ? ' is-off' : ''}${props.hovered === a.icao ? ' is-hover' : ''}`}
                    key={a.icao}
                    onClick={() => !off && props.onSelect(a.icao)}
                    onMouseEnter={() => props.onHover(a.icao)}
                    onMouseLeave={() => props.onHover(null)}
                  >
                    <span class="apt-name">{a.name}</span>
                    <span class="apt-icao">{a.icao}</span>
                    <span class="apt-meta num">
                      {off ? (
                        <span class="apt-why">
                          <span class="visually-hidden">
                            {eligibilityText(e, props.info, 'long')}
                          </span>
                          <span aria-hidden="true">{eligibilityText(e, props.info, 'short')}</span>
                        </span>
                      ) : (
                        <AirportFactsLine a={a} />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** A small choice inside a sentence: the native select, so phones show their own picker. */
function MiniSelect<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label class="mini-select">
      <span class="visually-hidden">{props.label}</span>
      <select
        value={String(props.value)}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLSelectElement).value;
          const hit = props.options.find((o) => String(o.value) === raw);
          if (hit) props.onChange(hit.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={16} />
    </label>
  );
}

/**
 * The choice of the airport in a dialog of its own: search and list (recent first), and the map
 * with place names where there is room for it (beside the list on a large screen, above it on a
 * tall phone). Picking closes it.
 */
function AirportPicker(props: {
  airports: AirportOption[];
  selected: string;
  info?: AircraftInfo;
  recent: readonly string[];
  onPick: (icao: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useSignal<string | null>(null);
  useDialog(ref, props.onClose);
  const category = categoryOf(props.info);
  const usable = useMemo(() => mapAirports(props.airports, category), [props.airports, category]);
  return (
    <div
      class="modal-layer picker-layer fade-in"
      onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        ref={ref}
        class="picker glass enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
      >
        <header class="picker-head">
          <button
            type="button"
            class="btn btn--icon btn--ghost picker-back"
            aria-label={t('panel.close')}
            onClick={props.onClose}
          >
            <IconBack />
          </button>
          <h2 id="picker-title" class="picker-title">
            {t('phone.airport')}
          </h2>
          <button
            type="button"
            class="btn btn--icon btn--ghost picker-close"
            aria-label={t('panel.close')}
            onClick={props.onClose}
          >
            <IconClose />
          </button>
        </header>
        <div class="picker-body">
          <div class="picker-map setup-map-wrap">
            <SwissMap
              airports={usable}
              selected={props.selected}
              onSelect={props.onPick}
              isMain={isMainAirport}
              labelPriority={labelPriority}
              labelOf={placeLabel}
              hovered={hovered.value}
              onHover={(icao) => (hovered.value = icao)}
              zoomable
              zoomLabels={{ in: t('map.zoomIn'), out: t('map.zoomOut'), reset: t('map.reset') }}
              label={t('setup.map')}
            />
          </div>
          <div class="picker-list">
            <AirportList
              airports={props.airports}
              selected={props.selected}
              info={props.info}
              recent={props.recent}
              hovered={hovered.value}
              onHover={(icao) => (hovered.value = icao)}
              onSelect={props.onPick}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The home screen: the game opens here and every flight ends here. One calm card with the few
 * choices a flight needs: the aircraft, the airport (in a picker of its own), how to start, the
 * weather and the time of day, and the start button. The same on every screen, only laid out
 * to fit it; the season is the calendar's, the runway the airport's first unless changed.
 */
export function FlightSetup() {
  const ref = useRef<HTMLElement>(null);
  const airports = game.airports.value;
  const aircraft = AIRCRAFT;
  const storage = browserStorage();
  const draft = useSignal<SetupDraft>(
    sanitizeDraft(readJson(storage, DRAFT_KEY), airports, aircraft),
  );
  const picking = useSignal(false);
  // Read once per visit: the list must not reshuffle while the pilot is choosing.
  const recent = useMemo(() => readRecent(storage), []);

  // The app may deliver airports after the page opened: fit the remembered choice to them.
  useEffect(() => {
    draft.value = sanitizeDraft(readJson(storage, DRAFT_KEY) ?? draft.value, airports, aircraft);
  }, [airports, aircraft.length]);

  const set = (patch: Partial<SetupDraft>) => {
    draft.value = sanitizeDraft({ ...draft.value, ...patch }, airports, aircraft);
    writeJson(storage, DRAFT_KEY, draft.value);
  };
  // What is no longer chosen here: the season is the calendar's, an air start is above the
  // airport (a place on the map from an older version is forgotten).
  useEffect(() => {
    const d = draft.value;
    if (d.season !== 'now' || d.airPlace !== 'airport') set({ season: 'now', airPlace: 'airport' });
  }, []);

  const d = draft.value;
  const plan = draftToPlan(d, airports, aircraft);
  const problem = planProblem(d, airports, aircraft);
  const airport = airports.find((a) => a.icao === d.airport);
  const info = aircraft.find((a) => a.id === d.aircraft);
  const category = categoryOf(info);
  const defaults = typeDefaults(info);
  const runways = airport ? usableEnds(airport, category) : [];

  // The app may show the choice somewhere; debounced so quick taps are cheap.
  const planKey = JSON.stringify(plan);
  useEffect(() => {
    if (!plan || !actions.preview) return;
    const id = setTimeout(() => actions.preview?.(plan), 250);
    return () => clearTimeout(id);
  }, [planKey]);

  const start = () => {
    if (!plan) return;
    if (plan.airport) rememberAirport(storage, plan.airport);
    game.plan.value = plan;
    actions.startFlight(plan);
  };

  const runwayChoice = runways.length > 0 && (
    <MiniSelect<string>
      label={t('setup.runway')}
      value={d.runway}
      options={runways.map((r) => ({ value: r, label: t('briefing.runway', { rwy: r }) }))}
      onChange={(v) => set({ runway: v })}
    />
  );
  const timeKey = TIME_CHOICES.find((c) => c.time === d.time)?.key;

  return (
    <>
      <main ref={ref} class="home-card enter" aria-labelledby="home-title" inert={picking.value}>
        <header class="home-head">
          <Brand id="home-title" />
          <div class="home-tools">
            <button
              type="button"
              class="btn btn--ghost home-lang"
              aria-label={t('menu.language')}
              title={t('menu.language')}
              onClick={() => setLang(lang.value === 'de' ? 'en' : 'de')}
            >
              <IconGlobe size={18} />
              <span>{lang.value === 'de' ? 'DE' : 'EN'}</span>
            </button>
            <button
              type="button"
              class="btn btn--icon btn--ghost home-settings"
              aria-label={t('menu.settings')}
              title={t('menu.settings')}
              onClick={() => (nav.settingsOpen.value = true)}
            >
              <IconSettings />
            </button>
          </div>
        </header>

        <div class="home-body">
          <section class="home-field home-field--airport" aria-labelledby="home-airport">
            <h2 class="caps home-label" id="home-airport">
              {t('phone.airport')}
            </h2>
            <button
              type="button"
              class="airport-field"
              aria-haspopup="dialog"
              onClick={() => (picking.value = true)}
            >
              {airport ? (
                <>
                  <span class="airport-field-place">{placeLabel(airport)}</span>
                  <span class="airport-field-code">{airport.icao}</span>
                  {airport.name !== placeLabel(airport) && (
                    <span class="airport-field-name">{airport.name}</span>
                  )}
                </>
              ) : (
                <span class="airport-field-name">{t('setup.problem.noAirport')}</span>
              )}
              <span class="airport-field-go">{t('phone.change')}</span>
            </button>
          </section>

          <section class="home-field home-field--aircraft" aria-labelledby="home-aircraft">
            <h2 class="caps home-label" id="home-aircraft">
              {t('setup.aircraft')}
            </h2>
            <AircraftTiles
              aircraft={aircraft}
              selected={d.aircraft}
              onSelect={(id) => set({ aircraft: id })}
            />
          </section>

          <section class="home-field home-field--start" aria-labelledby="home-start">
            <div class="home-label-row">
              <h2 class="caps home-label" id="home-start">
                {t('setup.start')}
              </h2>
              <span class="home-detail">
                {runwayChoice}
                {d.start === 'air' && (
                  <MiniSelect<number>
                    label={t('setup.height')}
                    value={d.airHeight}
                    options={defaults.airHeights.map((h, i) => ({
                      value: i,
                      label: t('phone.above', { h: heightLabel(h) }),
                    }))}
                    onChange={(v) => set({ airHeight: v })}
                  />
                )}
                {d.start === 'approach' && (
                  <MiniSelect<number>
                    label={t('setup.approachDistance')}
                    value={d.approachNm}
                    options={defaults.approachDistances.map((n) => ({
                      value: n,
                      label: t('phone.final', { n }),
                    }))}
                    onChange={(v) => set({ approachNm: v })}
                  />
                )}
              </span>
            </div>
            <Segmented<StartKind>
              label={t('setup.start')}
              class="home-seg"
              value={d.start}
              onChange={(v) => set({ start: v })}
              options={[
                { value: 'runway', label: t('phone.start.runway'), icon: <IconRunway size={18} /> },
                { value: 'air', label: t('phone.start.air'), icon: <IconClimb size={18} /> },
                {
                  value: 'approach',
                  label: t('phone.start.approach'),
                  icon: <IconApproach size={18} />,
                },
              ]}
            />
          </section>

          <section class="home-field home-field--weather" aria-labelledby="home-weather">
            <h2 class="caps home-label" id="home-weather">
              {t('setup.weather')}
            </h2>
            <WeatherIcons value={d.weather} onChange={(v) => set({ weather: v })} />
          </section>

          <section class="home-field home-field--time" aria-labelledby="home-time">
            <h2 class="caps home-label" id="home-time">
              {t('setup.time')}
            </h2>
            <Segmented<string>
              label={t('setup.time')}
              class="home-seg home-seg--time"
              value={timeKey ?? ''}
              onChange={(k) => {
                const c = TIME_CHOICES.find((x) => x.key === k);
                if (c) set({ time: c.time });
              }}
              options={TIME_CHOICES.map((c) => ({ value: c.key, label: t(`phone.time.${c.key}`) }))}
            />
          </section>
        </div>

        <footer class="home-foot">
          <button
            type="button"
            class="btn btn--primary home-go"
            disabled={!plan}
            aria-describedby={problem ? 'setup-problem' : undefined}
            onClick={start}
          >
            {t('setup.go')}
            <IconPlane size={20} />
          </button>
          {problem && (
            <span id="setup-problem" class="visually-hidden">
              {t(
                problem === 'noAirport'
                  ? 'setup.problem.noAirport'
                  : problem === 'runway'
                    ? 'setup.problem.runway'
                    : 'setup.problem.noAircraft',
              )}
            </span>
          )}
          <p class="home-credits">
            <Credits />
            <Version />
          </p>
        </footer>
      </main>
      {picking.value && (
        <AirportPicker
          airports={airports}
          selected={d.airport}
          info={info}
          recent={recent}
          onPick={(icao) => {
            set({ airport: icao, runway: '' });
            // Closed a moment later: a tap on the map picks when the finger lifts, and the
            // click that follows would land on whatever lies under the vanished picker
            // (the airport field, which would open it again).
            setTimeout(() => (picking.value = false), 60);
          }}
          onClose={() => (picking.value = false)}
        />
      )}
    </>
  );
}

/** The four types as large tiles: icon and name (the short name where room is scarce). */
function AircraftTiles(props: {
  aircraft: AircraftInfo[];
  selected: string;
  onSelect: (id: AircraftInfo['id']) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  if (!props.aircraft.length)
    return (
      <div class="empty empty--row">
        <IconPlane size={22} />
        <div>
          <p class="empty-title">{t('setup.noAircraft')}</p>
          <p class="empty-hint">{t('setup.noAircraft.hint')}</p>
        </div>
      </div>
    );
  const chosen = props.aircraft.some((a) => a.id === props.selected);
  return (
    <div
      ref={ref}
      class="craft-names"
      role="radiogroup"
      aria-label={t('setup.aircraft')}
      onKeyDown={(e) => arrowNav(e, ref.current, '[role="radio"]', 'both')?.click()}
    >
      {props.aircraft.map((a, i) => {
        const on = a.id === props.selected;
        return (
          <button
            type="button"
            role="radio"
            key={a.id}
            aria-checked={on}
            aria-label={a.name}
            title={a.name}
            tabIndex={on || (!chosen && i === 0) ? 0 : -1}
            class={`craft-name-tile${on ? ' is-on' : ''}`}
            onClick={() => props.onSelect(a.id)}
          >
            <CategoryIcon category={categoryOf(a)} size={24} />
            <span class="craft-name-text craft-name-long" aria-hidden="true">
              {displayName(a)}
            </span>
            <span class="craft-name-text craft-name-short" aria-hidden="true">
              {shortName(a)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The weather as a row of icons; only the chosen one says its name. */
function WeatherIcons(props: { value: WeatherChoice; onChange: (v: WeatherChoice) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      class="weather-icons"
      role="radiogroup"
      aria-label={t('setup.weather')}
      onKeyDown={(e) => arrowNav(e, ref.current, '[role="radio"]', 'horizontal')?.click()}
    >
      {WEATHER_CHOICES.map((w) => {
        const on = w === props.value;
        return (
          <button
            type="button"
            role="radio"
            key={w}
            aria-checked={on}
            aria-label={t(`weather.${w}`)}
            title={t(`weather.${w}`)}
            tabIndex={on ? 0 : -1}
            class={`weather-icon${on ? ' is-on' : ''}`}
            onClick={() => props.onChange(w)}
          >
            {WEATHER_ICON[w]()}
            {on && (
              <span class="weather-name" aria-hidden="true">
                {t(`weather.${w}`)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
