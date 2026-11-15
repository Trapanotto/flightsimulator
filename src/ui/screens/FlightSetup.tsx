import { useSignal } from '@preact/signals';
import { AIRCRAFT, type AircraftInfo } from '@sim';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { type AirportOption, type SeasonChoice, type WeatherChoice, game, settings } from '../api';
import { Brand, LanguageSwitch, Version } from '../components/Brand';
import { Credits } from '../components/Credits';
import { Field, Segmented, Slider } from '../components/controls';
import {
  CategoryIcon,
  IconApproach,
  IconClimb,
  IconClose,
  IconCloud,
  IconFair,
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
import { arrowNav } from '../focus';
import {
  altitudeUnit,
  convertAltitude,
  formatClock,
  formatSpec,
  groupThousands,
  runwayHeading,
} from '../format';
import { type MessageKey, lang, t } from '../i18n';
import { actions, nav } from '../nav';
import { browserStorage, readJson, writeJson } from '../persist';
import {
  DRAFT_KEY,
  type SetupDraft,
  SEASON_CHOICES,
  type StartKind,
  WEATHER_CHOICES,
  airAltitudeRange,
  draftToPlan,
  nearestAirport,
  planProblem,
  sanitizeDraft,
  usableEnds,
} from '../plan';
import { dayGradient, sunTimes, swissNowHours } from '../sun';
import {
  type SectionKey,
  airportFacts,
  isMainAirport,
  labelPriority,
  mapAirports,
  orderAirports,
  readRecent,
  rememberAirport,
} from '../airportPick';
import { SwissMap } from './SwissMap';

/** The aircraft's name as the picker shows it: the maker's long name gives way to the type. */
function displayName(info: AircraftInfo): string {
  return info.name.replace(/^McDonnell Douglas /, '');
}

const WEATHER_ICON: Record<WeatherChoice, () => preact.JSX.Element> = {
  live: () => <IconLive size={22} />,
  clear: () => <IconSun size={22} />,
  fair: () => <IconFair size={22} />,
  cloudy: () => <IconCloud size={22} />,
  overcast: () => <IconOvercast size={22} />,
  lowStratus: () => <IconStratus size={22} />,
};

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
/** An altitude above sea level as a pilot sets it: feet in hundreds, metres in fifties. */
function altitudeLabel(m: number): string {
  return heightLabel(m);
}

/** The altitude slider's step: 500 ft, or 100 m. */
function altitudeStep(): number {
  return settings.units.value === 'aviation' ? 500 * 0.3048 : 100;
}

function zoomLabels() {
  return { in: t('map.zoomIn'), out: t('map.zoomOut'), reset: t('map.reset') };
}

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

/** ['14', '32', '10', '28'] → '14/32 10/28': opposite ends belong to one strip. */
export function pairRunways(ends: string[]): string {
  const left = [...ends];
  const out: string[] = [];
  while (left.length) {
    const a = left.shift()!;
    const h = runwayHeading(a);
    const suffix = a.replace(/^\d+/, '');
    const opp = { L: 'R', R: 'L', C: 'C' }[suffix] ?? '';
    const want = String(((h / 10 + 18 - 1) % 36) + 1).padStart(2, '0') + opp;
    const j = left.indexOf(want);
    if (j >= 0) {
      left.splice(j, 1);
      out.push(h <= runwayHeading(want) ? `${a}/${want}` : `${want}/${a}`);
    } else out.push(a);
  }
  return out.join('  ');
}

/**
 * The aircraft as a row of choices, each with its icon and its name: nothing else is needed
 * to choose, and the four always fit (two by two on a phone).
 */
function AircraftPicker(props: {
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
            title={a.name}
            tabIndex={on || (!chosen && i === 0) ? 0 : -1}
            class={`craft-name-tile${on ? ' is-on' : ''}`}
            onClick={() => props.onSelect(a.id)}
          >
            <CategoryIcon category={categoryOf(a)} size={22} />
            <span class="craft-name-text">{displayName(a)}</span>
          </button>
        );
      })}
    </div>
  );
}

function TimePicker(props: {
  draft: SetupDraft;
  airport?: AirportOption;
  onChange: (time: 'now' | number) => void;
}) {
  const lat = props.airport?.lat ?? 46.91;
  const lon = props.airport?.lon ?? 7.5;
  const today = new Date();
  const dayKey = today.toDateString();
  const gradient = useMemo(() => dayGradient(today, lat, lon), [lat, lon, dayKey]);
  const sun = useMemo(() => sunTimes(today, lat, lon), [lat, lon, dayKey]);
  const now = props.draft.time === 'now';
  const value = now ? swissNowHours(today) : (props.draft.time as number);
  return (
    <Field
      label={t('setup.time')}
      id="setup-time"
      aside={
        sun && (
          <span class="sun-times num">
            <span title={t('setup.sunrise')}>
              <span class="visually-hidden">{t('setup.sunrise')} </span>↑ {formatClock(sun.sunrise)}
            </span>
            <span title={t('setup.sunset')}>
              <span class="visually-hidden">{t('setup.sunset')} </span>↓ {formatClock(sun.sunset)}
            </span>
          </span>
        )
      }
    >
      <div class="time-row">
        <Segmented<'now' | 'set'>
          label={t('setup.time')}
          class="time-mode"
          value={now ? 'now' : 'set'}
          onChange={(m) => props.onChange(m === 'now' ? 'now' : Math.round(value * 4) / 4)}
          options={[
            { value: 'now', label: t('setup.time.now') },
            { value: 'set', label: t('setup.time.set') },
          ]}
        />
        <Slider
          id="setup-time-slider"
          class={`time-slider${now ? ' is-now' : ''}`}
          label={t('setup.time.slider')}
          min={0}
          max={24}
          step={0.25}
          value={value}
          valueText={formatClock(value)}
          trackStyle={`--day:${gradient}`}
          onInput={(v) => props.onChange(v)}
        />
        <output class={`time-value num${now ? ' is-now' : ''}`} for="setup-time-slider">
          {formatClock(value)}
        </output>
      </div>
    </Field>
  );
}

/**
 * The home screen: the game opens here and every flight ends here. One sheet under the title:
 * where (map, search, list), how (start, runway), with what, when and in which weather.
 */
export function FlightSetup() {
  const ref = useRef<HTMLDivElement>(null);
  const airports = game.airports.value;
  const aircraft = AIRCRAFT;
  const storage = browserStorage();
  const draft = useSignal<SetupDraft>(
    sanitizeDraft(readJson(storage, DRAFT_KEY), airports, aircraft),
  );
  const hovered = useSignal<string | null>(null);
  // Read once per visit: the list must not reshuffle while the pilot is choosing.
  const recent = useMemo(() => readRecent(storage), []);

  // The app may deliver airports after the page opened: fit the remembered choice to them.
  useEffect(() => {
    draft.value = sanitizeDraft(readJson(storage, DRAFT_KEY) ?? draft.value, airports, aircraft);
  }, [airports, aircraft.length]);

  const d = draft.value;
  const set = (patch: Partial<SetupDraft>) => {
    draft.value = sanitizeDraft({ ...draft.value, ...patch }, airports, aircraft);
    writeJson(storage, DRAFT_KEY, draft.value);
  };

  const plan = draftToPlan(d, airports, aircraft);
  const problem = planProblem(d, airports, aircraft);
  const airport = airports.find((a) => a.icao === d.airport);
  const info = aircraft.find((a) => a.id === d.aircraft);
  const category = categoryOf(info);
  const defaults = typeDefaults(info);
  const runways = airport ? usableEnds(airport, category) : [];
  // Only what the chosen type can use is drawn on the map.
  const usable = useMemo(() => mapAirports(airports, category), [airports, category]);

  // The app may show the choice somewhere (it used to in the menu scene); debounced so a
  // dragged slider is cheap.
  const planKey = JSON.stringify(plan);
  useEffect(() => {
    if (!plan || !actions.preview) return;
    const id = setTimeout(() => actions.preview?.(plan), 250);
    return () => clearTimeout(id);
  }, [planKey]);

  const fly = (from: SetupDraft) => {
    const p = draftToPlan(from, airports, aircraft);
    if (!p) return;
    if (p.airport) rememberAirport(storage, p.airport);
    game.plan.value = p;
    actions.startFlight(p);
  };
  const start = () => fly(d);
  // An air start put on the map; the map taps place it instead of picking an airport.
  const placing = d.start === 'air' && d.airPlace === 'map';
  const place =
    placing && d.airLon !== null && d.airLat !== null
      ? { lon: d.airLon, lat: d.airLat, heading: d.airHeading }
      : null;
  const near = place ? nearestAirport(airports, place.lon, place.lat) : undefined;
  const altRange = airAltitudeRange(category);
  const selectAirport = (icao: string) => {
    const a = airports.find((x) => x.icao === icao);
    // With a place on the map, choosing an airport moves the place over it.
    if (placing && a) set({ airport: icao, runway: '', airLon: a.lon, airLat: a.lat });
    else set({ airport: icao, runway: '' });
  };
  const setAirPlace = (p: 'airport' | 'map') => {
    // The first time on the map: above the chosen airport, lined up with its runway.
    if (p === 'map' && d.airLon === null && airport)
      set({
        airPlace: p,
        airLon: airport.lon,
        airLat: airport.lat,
        airHeading: runways[0] ? runwayHeading(runways[0]) % 360 : 0,
        airAltitude: Math.max(
          d.airAltitude,
          airport.elevation + (defaults.airHeights[d.airHeight] ?? 900),
        ),
      });
    else set({ airPlace: p });
  };

  const timeText = d.time === 'now' ? t('setup.time.now') : formatClock(d.time);
  const startText =
    d.start === 'air' && place
      ? `${t('setup.start.air')} · ${altitudeLabel(d.airAltitude)} · ${String(d.airHeading).padStart(3, '0')}°`
      : d.start === 'air'
        ? t('briefing.air', { h: heightLabel(defaults.airHeights[d.airHeight] ?? 0) })
        : d.start === 'approach'
          ? `${t('briefing.runway', { rwy: d.runway })} · ${t('briefing.approach', { d: t('setup.nm', { n: d.approachNm }) })}`
          : t('briefing.runway', { rwy: d.runway });

  return (
    <main ref={ref} class="setup setup--home enter" aria-labelledby="home-title">
      <header class="setup-head home-head">
        <Brand id="home-title" />
        <div class="home-tools">
          <LanguageSwitch />
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

      <div class="setup-body">
        <div class="setup-col setup-where">
          <Field
            label={d.start === 'approach' ? t('setup.airport') : t('setup.departure')}
            id="setup-departure"
          >
            <div class={`setup-map-wrap setup-map-main${placing ? ' is-placing' : ''}`}>
              <SwissMap
                airports={usable}
                selected={d.airport}
                onSelect={placing ? undefined : selectAirport}
                onPlace={placing ? (lon, lat) => set({ airLon: lon, airLat: lat }) : undefined}
                place={place}
                isMain={isMainAirport}
                labelPriority={labelPriority}
                hovered={hovered.value}
                onHover={(icao) => (hovered.value = icao)}
                zoomable
                zoomLabels={zoomLabels()}
                label={t(placing ? 'setup.map.place' : 'setup.map')}
              />
              {placing ? (
                <div class="map-callout" aria-hidden="true">
                  <span class="map-callout-icao">{t('setup.start.air')}</span>
                  <span class="map-callout-name">
                    {near ? t('setup.air.near', { name: near.name }) : t('setup.air.hint')}
                  </span>
                </div>
              ) : (
                airport && (
                  <div class="map-callout" aria-hidden="true">
                    <span class="map-callout-icao">{airport.icao}</span>
                    <span class="map-callout-name">{airport.name}</span>
                  </div>
                )
              )}
            </div>
            {placing && (
              <div class="air-controls">
                <label class="air-control">
                  <span class="sub-label">{t('setup.altitude')}</span>
                  <output class="air-value num">{altitudeLabel(d.airAltitude)}</output>
                  <Slider
                    label={t('setup.altitude')}
                    min={altRange[0]}
                    max={altRange[1]}
                    step={altitudeStep()}
                    value={d.airAltitude}
                    valueText={altitudeLabel(d.airAltitude)}
                    onInput={(v) => set({ airAltitude: v })}
                  />
                </label>
                <label class="air-control">
                  <span class="sub-label">{t('setup.heading')}</span>
                  <output class="air-value num">
                    <span
                      class="air-arrow"
                      aria-hidden="true"
                      style={{ transform: `rotate(${d.airHeading}deg)` }}
                    >
                      ↑
                    </span>
                    {String(d.airHeading).padStart(3, '0')}°
                  </output>
                  <Slider
                    label={t('setup.heading')}
                    min={0}
                    max={355}
                    step={5}
                    value={d.airHeading}
                    valueText={`${d.airHeading}°`}
                    onInput={(v) => set({ airHeading: v })}
                  />
                </label>
              </div>
            )}
            <AirportList
              airports={airports}
              selected={d.airport}
              info={info}
              recent={recent}
              hovered={hovered.value}
              onHover={(icao) => (hovered.value = icao)}
              onSelect={selectAirport}
            />
          </Field>
        </div>

        <div class="setup-col setup-how">
          <div class="start-grid">
            <Field label={t('setup.start')} id="setup-start">
              <Segmented<StartKind>
                label={t('setup.start')}
                class="start-seg"
                value={d.start}
                onChange={(v) => set({ start: v })}
                options={[
                  {
                    value: 'runway',
                    label: t('setup.start.runway'),
                    icon: <IconRunway size={18} />,
                  },
                  { value: 'air', label: t('setup.start.air'), icon: <IconClimb size={18} /> },
                  {
                    value: 'approach',
                    label: t('setup.start.approach'),
                    icon: <IconApproach size={18} />,
                  },
                ]}
              />
            </Field>
            {runways.length > 0 && !placing && (
              <Field label={t('setup.runway')} id="setup-runway">
                <Segmented<string>
                  label={t('setup.runway')}
                  class="rwy-seg"
                  value={d.runway}
                  onChange={(v) => set({ runway: v })}
                  options={runways.map((r) => ({
                    value: r,
                    label: r,
                    sub: `${String(runwayHeading(r)).padStart(3, '0')}°`,
                  }))}
                />
              </Field>
            )}
            {d.start === 'air' && (
              <div class="start-height">
                <Field label={t('setup.air.place')} id="setup-air-place">
                  <Segmented<'airport' | 'map'>
                    label={t('setup.air.place')}
                    value={d.airPlace}
                    onChange={setAirPlace}
                    options={[
                      { value: 'airport', label: t('setup.air.overAirport') },
                      { value: 'map', label: t('setup.air.onMap') },
                    ]}
                  />
                  {placing && <p class="field-hint">{t('setup.air.hint')}</p>}
                </Field>
              </div>
            )}
            {d.start === 'air' && !placing && (
              <div class="start-height">
                <Field label={t('setup.height')} id="setup-height">
                  <Segmented<number>
                    label={t('setup.height')}
                    value={d.airHeight}
                    onChange={(v) => set({ airHeight: v })}
                    options={defaults.airHeights.map((h, i) => ({
                      value: i,
                      label: heightLabel(h),
                    }))}
                  />
                </Field>
              </div>
            )}
            {d.start === 'approach' && (
              <div class="start-height">
                <Field label={t('setup.approachDistance')} id="setup-approach">
                  <Segmented<number>
                    label={t('setup.approachDistance')}
                    value={d.approachNm}
                    onChange={(v) => set({ approachNm: v })}
                    options={defaults.approachDistances.map((n) => ({
                      value: n,
                      label: t('setup.nm', { n }),
                    }))}
                  />
                </Field>
              </div>
            )}
          </div>

          <Field label={t('setup.aircraft')} id="setup-aircraft">
            <AircraftPicker
              aircraft={aircraft}
              selected={d.aircraft}
              onSelect={(id) => set({ aircraft: id })}
            />
          </Field>

          <TimePicker draft={d} airport={airport} onChange={(time) => set({ time })} />

          <Field label={t('setup.weather')} id="setup-weather">
            <Segmented<WeatherChoice>
              label={t('setup.weather')}
              variant="tiles"
              value={d.weather}
              onChange={(v) => set({ weather: v })}
              options={WEATHER_CHOICES.map((w) => ({
                value: w,
                label: t(`weather.${w}`),
                icon: WEATHER_ICON[w](),
              }))}
            />
          </Field>

          <Field label={t('setup.season')} id="setup-season">
            <Segmented<SeasonChoice>
              label={t('setup.season')}
              value={d.season}
              onChange={(v) => set({ season: v })}
              options={SEASON_CHOICES.map((v) => ({ value: v, label: t(`season.${v}`) }))}
            />
          </Field>
        </div>
      </div>

      <footer class="setup-foot">
        <div class="setup-summary" aria-live="polite">
          {airport ? (
            <>
              <span class="summary-main">
                <span class="summary-icao">{(near ?? airport).icao}</span>
                <span class="summary-name">{(near ?? airport).name}</span>
              </span>
              <span class="summary-sub">
                {startText} · {timeText} · {t(`weather.${d.weather}`)}
              </span>
            </>
          ) : (
            <span class="summary-sub">{t('setup.problem.noAirport')}</span>
          )}
        </div>
        <button
          type="button"
          class="btn btn--primary setup-go"
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
        <p class="home-credits home-credits--inner">
          <Credits />
          <Version />
        </p>
      </footer>
    </main>
  );
}
