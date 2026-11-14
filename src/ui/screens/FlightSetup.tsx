import { useSignal } from '@preact/signals';
import { AIRCRAFT, type AircraftInfo, type FailureId } from '@sim';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { type AirportOption, type SeasonChoice, type WeatherChoice, game, settings } from '../api';
import { Field, Segmented, Slider, Toggle } from '../components/controls';
import {
  IconApproach,
  IconBack,
  IconChevronDown,
  IconCircuit,
  IconClimb,
  IconCloud,
  IconFair,
  IconLive,
  IconMountain,
  IconNight,
  IconOvercast,
  IconPlane,
  IconRunway,
  IconStratus,
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
  APPROACH_DISTANCES,
  DRAFT_KEY,
  FAILURE_IDS,
  FAILURE_MINUTES,
  type FailureMode,
  type Scenario,
  type ScenarioId,
  type SetupDraft,
  SEASON_CHOICES,
  type StartKind,
  WEATHER_CHOICES,
  availableScenarios,
  draftToPlan,
  planProblem,
  sanitizeDraft,
  scenarioDraft,
} from '../plan';
import { dayGradient, sunTimes, swissNowHours } from '../sun';
import { SwissMap } from './SwissMap';

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

const SCENARIO_ICON: Record<ScenarioId, () => preact.JSX.Element> = {
  ilsZurich: () => <IconStratus size={22} />,
  bernCircuit: () => <IconCircuit size={22} />,
  alpsSamedan: () => <IconMountain size={22} />,
  nightGeneva: () => <IconNight size={22} />,
};

/** Ready-made flights: one click and the briefing starts. */
function ScenarioGrid(props: { onStart: (s: Scenario) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const list = availableScenarios(game.airports.value);
  const airports = game.airports.value;
  return (
    <div class="scenarios">
      <p class="field-hint">{t('setup.scenarios.hint')}</p>
      <div
        ref={ref}
        class="scenario-grid"
        onKeyDown={(e) => arrowNav(e, ref.current, '.scenario', 'both')}
      >
        {list.map((s, i) => {
          const d = s.draft;
          const apt = airports.find((a) => a.icao === d.airport);
          const dest = d.destination && d.destination !== d.airport ? d.destination : null;
          return (
            <button
              type="button"
              key={s.id}
              class={`scenario${i === 0 ? ' is-featured' : ''}`}
              data-autofocus={i === 0 ? '' : undefined}
              onClick={() => props.onStart(s)}
            >
              <span class="scenario-icon">{SCENARIO_ICON[s.id]()}</span>
              <span class="scenario-text">
                <span class="scenario-title">{t(`scenario.${s.id}`)}</span>
                <span class="scenario-sub">{t(`scenario.${s.id}.sub`)}</span>
              </span>
              <span class="scenario-meta num">
                <span class="scenario-icao">{apt?.icao}</span>
                {dest && <span aria-hidden="true">→</span>}
                {dest && <span class="scenario-icao">{dest}</span>}
                <span class="scenario-dot" aria-hidden="true">
                  ·
                </span>
                {typeof d.time === 'number' && formatClock(d.time)}
                <span class="scenario-dot" aria-hidden="true">
                  ·
                </span>
                {d.weather && t(`weather.${d.weather}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Destination, ATC, cold start and failures: closed until asked for. */
function Advanced(props: {
  draft: SetupDraft;
  airports: AirportOption[];
  set: (patch: Partial<SetupDraft>) => void;
}) {
  const open = useSignal(false);
  const { draft: d, airports, set } = props;
  const dest = airports.find((a) => a.icao === d.destination);
  const extras = advancedSummary(d);
  return (
    <section class={`adv${open.value ? ' is-open' : ''}`}>
      <button
        type="button"
        class="adv-head"
        aria-expanded={open.value}
        aria-controls="setup-advanced"
        onClick={() => (open.value = !open.value)}
      >
        <span class="adv-text">
          <span class="caps adv-title">{t('setup.advanced')}</span>
          <span class="adv-sub">{extras || t('setup.advanced.sub')}</span>
        </span>
        <IconChevronDown size={18} />
      </button>
      {open.value && (
        <div id="setup-advanced" class="adv-body fade-in">
          <Field label={t('setup.destination')} id="setup-dest">
            <div class="setup-map-wrap adv-map">
              <SwissMap
                airports={airports}
                selected={d.destination}
                route={dest ? { from: d.airport, to: d.destination } : undefined}
                onSelect={(icao) => set({ destination: icao, destinationRunway: '' })}
                label={t('setup.destination.map')}
              />
            </div>
            <Segmented<string>
              label={t('setup.destination')}
              class="dest-seg"
              value={d.destination}
              onChange={(v) => set({ destination: v, destinationRunway: '' })}
              options={[
                { value: '', label: t('setup.destination.none') },
                ...airports.map((a) => ({ value: a.icao, label: a.icao })),
              ]}
            />
            {dest && dest.runways.length > 0 && (
              <div class="sub-field">
                <span class="sub-label" id="setup-dest-rwy">
                  {t('setup.destination.runway')}
                </span>
                <Segmented<string>
                  label={t('setup.destination.runway')}
                  class="rwy-seg"
                  value={d.destinationRunway}
                  onChange={(v) => set({ destinationRunway: v })}
                  options={dest.runways.map((r) => ({
                    value: r,
                    label: r,
                    sub: `${String(runwayHeading(r)).padStart(3, '0')}°`,
                  }))}
                />
              </div>
            )}
          </Field>
          <div class="toggle-list adv-toggles">
            <Toggle
              label={t('setup.atc')}
              hint={t('setup.atc.hint')}
              checked={d.atc}
              onChange={(v) => set({ atc: v })}
            />
            <Toggle
              label={t('setup.coldStart')}
              hint={
                d.start === 'runway' ? t('setup.coldStart.hint') : t('setup.coldStart.runwayOnly')
              }
              checked={d.coldStart && d.start === 'runway'}
              disabled={d.start !== 'runway'}
              onChange={(v) => set({ coldStart: v })}
            />
          </div>
          <Field label={t('setup.failures')} id="setup-failures">
            <Segmented<FailureMode>
              label={t('setup.failures')}
              value={d.failureMode}
              onChange={(v) => set({ failureMode: v })}
              options={(['none', 'random', 'chosen'] as const).map((m) => ({
                value: m,
                label: t(`setup.failures.${m}`),
              }))}
            />
            {d.failureMode === 'random' && (
              <p class="field-hint">{t('setup.failures.random.hint')}</p>
            )}
            {d.failureMode === 'chosen' && (
              <>
                <div class="sub-field">
                  <span class="sub-label">{t('setup.failures.which')}</span>
                  <Segmented<FailureId>
                    label={t('setup.failures.which')}
                    class="seg--wrap failure-seg"
                    value={d.failureId}
                    onChange={(v) => set({ failureId: v })}
                    options={FAILURE_IDS.map((f) => ({ value: f, label: t(`failure.${f}`) }))}
                  />
                </div>
                <div class="sub-field">
                  <span class="sub-label">{t('setup.failures.when')}</span>
                  <Segmented<number>
                    label={t('setup.failures.when')}
                    value={d.failureAfterMin}
                    onChange={(v) => set({ failureAfterMin: v })}
                    options={FAILURE_MINUTES.map((m) => ({
                      value: m,
                      label: t('setup.minutes', { n: m }),
                    }))}
                  />
                </div>
              </>
            )}
          </Field>
        </div>
      )}
    </section>
  );
}

/** What the advanced part changes from the defaults, as a short line ('' when nothing). */
function advancedSummary(d: SetupDraft): string {
  const parts: string[] = [];
  if (d.destination) parts.push(`${t('setup.destination')} ${d.destination}`);
  if (!d.atc) parts.push(t('setup.summary.atcOff'));
  if (d.coldStart && d.start === 'runway') parts.push(t('setup.summary.cold'));
  if (d.failureMode !== 'none') parts.push(t('setup.summary.failure'));
  return parts.join(' · ');
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
  const mode = useSignal<'free' | 'scenarios'>('free');
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

  const fly = (from: SetupDraft) => {
    // A random failure is drawn anew for every flight.
    const rolled = { ...from, failureSeed: Math.floor(Math.random() * 1_000_000) };
    const p = draftToPlan(rolled, airports, aircraft);
    if (!p) return;
    draft.value = rolled;
    writeJson(storage, DRAFT_KEY, rolled);
    game.plan.value = p;
    actions.startFlight(p);
  };
  const start = () => fly(d);
  const startScenario = (s: Scenario) => {
    const sd = scenarioDraft(s, d, airports, aircraft);
    if (sd) fly(sd);
  };

  const timeText = d.time === 'now' ? t('setup.time.now') : formatClock(d.time);
  const startText =
    d.start === 'air'
      ? t('briefing.air', { h: heightLabel(AIR_START_HEIGHTS[d.airHeight] ?? 0) })
      : d.start === 'approach'
        ? `${t('briefing.runway', { rwy: d.runway })} · ${t('briefing.approach', { d: t('setup.nm', { n: d.approachNm }) })}`
        : t('briefing.runway', { rwy: d.runway });
  const extras = advancedSummary(d);
  const scenarios = mode.value === 'scenarios';

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
        {availableScenarios(airports).length > 0 && (
          <Segmented<'free' | 'scenarios'>
            label={t('setup.mode')}
            class="setup-mode"
            value={mode.value}
            onChange={(v) => (mode.value = v)}
            options={[
              { value: 'free', label: t('setup.mode.free') },
              { value: 'scenarios', label: t('setup.mode.scenarios') },
            ]}
          />
        )}
      </header>

      {scenarios ? (
        <div class="setup-body setup-body--scenarios">
          <ScenarioGrid onStart={startScenario} />
        </div>
      ) : (
        <div class="setup-body">
          <div class="setup-col setup-where">
            <Field
              label={d.start === 'approach' ? t('setup.airport') : t('setup.departure')}
              id="setup-departure"
            >
              <div class="setup-map-wrap">
                <SwissMap
                  airports={airports}
                  selected={d.airport}
                  route={d.destination ? { from: d.airport, to: d.destination } : undefined}
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
                      options={AIR_START_HEIGHTS.map((h, i) => ({
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
                      options={APPROACH_DISTANCES.map((n) => ({
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

            <Advanced draft={d} airports={airports} set={set} />
          </div>
        </div>
      )}

      <footer class="setup-foot" hidden={scenarios}>
        <div class="setup-summary" aria-live="polite">
          {airport ? (
            <>
              <span class="summary-main">
                <span class="summary-icao">{airport.icao}</span>
                {d.destination && d.destination !== airport.icao && (
                  <span class="summary-dest">
                    <span aria-hidden="true">→ </span>
                    <span class="visually-hidden">{t('setup.destination')} </span>
                    {d.destination}
                  </span>
                )}
                <span class="summary-name">{airport.name}</span>
              </span>
              <span class="summary-sub">
                {startText} · {timeText} · {t(`weather.${d.weather}`)}
                {extras && ` · ${extras}`}
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
