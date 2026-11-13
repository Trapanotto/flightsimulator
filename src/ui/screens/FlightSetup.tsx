import { useSignal } from '@preact/signals';
import { AIRCRAFT, type AircraftInfo } from '@sim';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { type AirportOption, type SeasonChoice, type WeatherChoice, game, settings } from '../api';
import { Field, Segmented, Slider } from '../components/controls';
import {
  IconBack,
  IconClimb,
  IconCloud,
  IconFair,
  IconLive,
  IconOvercast,
  IconPlane,
  IconRunway,
  IconSun,
} from '../components/icons';
import { arrowNav, useDialog } from '../focus';
import {
  altitudeUnit,
  convertAltitude,
  formatClock,
  formatSpeed,
  groupThousands,
  runwayHeading,
  speedUnit,
} from '../format';
import { type MessageKey, lang, t } from '../i18n';
import { actions, nav } from '../nav';
import { browserStorage, readJson, writeJson } from '../persist';
import {
  AIR_START_HEIGHTS,
  DRAFT_KEY,
  type SetupDraft,
  SEASON_CHOICES,
  WEATHER_CHOICES,
  draftToPlan,
  planProblem,
  sanitizeDraft,
} from '../plan';
import { dayGradient, sunTimes, swissNowHours } from '../sun';
import { SwissMap } from './SwissMap';

const WEATHER_ICON: Record<WeatherChoice, () => preact.JSX.Element> = {
  live: () => <IconLive size={22} />,
  clear: () => <IconSun size={22} />,
  fair: () => <IconFair size={22} />,
  cloudy: () => <IconCloud size={22} />,
  overcast: () => <IconOvercast size={22} />,
};

/** Height in the current units, rounded the way a pilot would say it. */
export function heightLabel(m: number): string {
  const units = settings.units.value;
  const v = convertAltitude(m, units);
  const r = units === 'aviation' ? Math.round(v / 100) * 100 : Math.round(v / 50) * 50;
  return `${groupThousands(r, lang.value)} ${altitudeUnit(units)}`;
}

function AirportList(props: {
  airports: AirportOption[];
  selected: string;
  onSelect: (icao: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  if (!props.airports.length)
    return (
      <div class="empty">
        <p class="empty-title">{t('setup.noAirports')}</p>
        <p class="empty-hint">{t('setup.noAirports.hint')}</p>
      </div>
    );
  const anySelected = props.airports.some((a) => a.icao === props.selected);
  return (
    <div
      ref={ref}
      class="apt-list"
      role="radiogroup"
      aria-label={t('setup.airports')}
      onKeyDown={(e) => arrowNav(e, ref.current, '[role="radio"]', 'both')?.click()}
    >
      {props.airports.map((a, i) => {
        const on = a.icao === props.selected;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (!anySelected && i === 0) ? 0 : -1}
            data-autofocus={on ? '' : undefined}
            class={`apt${on ? ' is-on' : ''}`}
            key={a.icao}
            onClick={() => props.onSelect(a.icao)}
          >
            <span class="apt-icao">{a.icao}</span>
            <span class="apt-name">{a.name}</span>
            <span class="apt-meta num">
              {heightLabel(a.elevation)}
              <span class="apt-sep" aria-hidden="true">
                ·
              </span>
              {runwaySummary(a.runways)}
            </span>
          </button>
        );
      })}
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

/** Two strips or fewer by name (14/32), more as a count, so the list row never overflows. */
function runwaySummary(ends: string[]): string {
  const strips = pairRunways(ends).split('  ').filter(Boolean);
  return strips.length > 2 ? `${strips.length} ${t('setup.runways')}` : strips.join(' · ');
}

function AircraftCard({
  info,
  on,
  onSelect,
}: {
  info: AircraftInfo;
  on: boolean;
  onSelect?: () => void;
}) {
  const units = settings.units.value;
  const stats: [MessageKey, MessageKey, string, string][] = [
    ['aircraft.vs0', 'aircraft.vs0.sub', formatSpeed(info.vs0, units), speedUnit(units)],
    ['aircraft.vne', 'aircraft.vne.sub', formatSpeed(info.vne, units), speedUnit(units)],
    ['aircraft.mtom', 'aircraft.mtom.sub', groupThousands(info.maxTakeoffMass, lang.value), 'kg'],
  ];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      tabIndex={on ? 0 : -1}
      class={`craft${on ? ' is-on' : ''}`}
      onClick={onSelect}
    >
      <span class="craft-head">
        <IconPlane size={22} />
        <span class="craft-name">{info.name}</span>
        <span class="craft-meta">
          {info.engines === 1
            ? t('aircraft.engine.one')
            : t('aircraft.engine.many', { n: info.engines })}
          {' · '}
          {t(info.retractableGear ? 'aircraft.gear.retract' : 'aircraft.gear.fixed')}
        </span>
      </span>
      <span class="craft-stats">
        {stats.map(([label, sub, value, unit]) => (
          <span class="stat" key={label}>
            <span class="stat-label">{t(label)}</span>
            <span class="stat-value num">
              {value}
              <span class="stat-unit">{unit}</span>
            </span>
            <span class="stat-sub">{t(sub)}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

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
  return (
    <div
      ref={ref}
      class="craft-list"
      role="radiogroup"
      aria-label={t('setup.aircraft')}
      onKeyDown={(e) => arrowNav(e, ref.current, '[role="radio"]', 'both')?.click()}
    >
      {props.aircraft.map((a) => (
        <AircraftCard
          key={a.id}
          info={a}
          on={a.id === props.selected}
          onSelect={() => props.onSelect(a.id)}
        />
      ))}
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

/** The flight setup: where, how, with what, when and in which weather, on one page. */
export function FlightSetup() {
  const ref = useRef<HTMLDivElement>(null);
  const airports = game.airports.value;
  const aircraft = AIRCRAFT;
  const storage = browserStorage();
  const draft = useSignal<SetupDraft>(
    sanitizeDraft(readJson(storage, DRAFT_KEY), airports, aircraft),
  );
  const back = () => (nav.page.value = 'main');
  useDialog(ref, back);

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

  // Let the app show the choice in the menu scene; debounced so a dragged slider is cheap.
  const planKey = JSON.stringify(plan);
  useEffect(() => {
    if (!plan || !actions.preview) return;
    const id = setTimeout(() => actions.preview?.(plan), 250);
    return () => clearTimeout(id);
  }, [planKey]);

  const start = () => {
    if (!plan) return;
    game.plan.value = plan;
    actions.startFlight(plan);
  };

  const timeText = d.time === 'now' ? t('setup.time.now') : formatClock(d.time);
  const startText =
    d.start === 'air'
      ? t('briefing.air', { h: heightLabel(AIR_START_HEIGHTS[d.airHeight] ?? 0) })
      : t('briefing.runway', { rwy: d.runway });

  return (
    <div
      ref={ref}
      class="setup enter"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-title"
    >
      <header class="setup-head">
        <button
          type="button"
          class="btn btn--ghost setup-back"
          aria-label={t('setup.back')}
          onClick={back}
        >
          <IconBack />
          <span class="setup-back-text">{t('setup.backShort')}</span>
        </button>
        <h1 id="setup-title" class="setup-title">
          {t('setup.title')}
        </h1>
      </header>

      <div class="setup-body">
        <div class="setup-col setup-where">
          <Field label={t('setup.departure')} id="setup-departure">
            <div class="setup-map-wrap">
              <SwissMap
                airports={airports}
                selected={d.airport}
                onSelect={(icao) => set({ airport: icao, runway: '' })}
                label={t('setup.map')}
              />
              {airport && (
                <div class="map-callout" aria-hidden="true">
                  <span class="map-callout-icao">{airport.icao}</span>
                  <span class="map-callout-name">{airport.name}</span>
                </div>
              )}
            </div>
            <AirportList
              airports={airports}
              selected={d.airport}
              onSelect={(icao) => set({ airport: icao, runway: '' })}
            />
          </Field>
        </div>

        <div class="setup-col setup-how">
          <div class="start-grid">
            <Field label={t('setup.start')} id="setup-start">
              <Segmented<'runway' | 'air'>
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
                ]}
              />
            </Field>
            {airport && airport.runways.length > 0 && (
              <Field label={t('setup.runway')} id="setup-runway">
                <Segmented<string>
                  label={t('setup.runway')}
                  class="rwy-seg"
                  value={d.runway}
                  onChange={(v) => set({ runway: v })}
                  options={airport.runways.map((r) => ({
                    value: r,
                    label: r,
                    sub: `${String(runwayHeading(r)).padStart(3, '0')}°`,
                  }))}
                />
              </Field>
            )}
            {d.start === 'air' && (
              <div class="start-height">
                <Field label={t('setup.height')} id="setup-height">
                  <Segmented<number>
                    label={t('setup.height')}
                    value={d.airHeight}
                    onChange={(v) => set({ airHeight: v })}
                    options={AIR_START_HEIGHTS.map((h, i) => ({ value: i, label: heightLabel(h) }))}
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
                <span class="summary-icao">{airport.icao}</span>
                <span class="summary-name">{airport.name}</span>
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
            {t(problem === 'noAirport' ? 'setup.problem.noAirport' : 'setup.problem.noAircraft')}
          </span>
        )}
      </footer>
    </div>
  );
}
