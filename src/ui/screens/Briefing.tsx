import { AIRCRAFT } from '@sim';
import { WEATHER_PRESETS } from '@sky';
import type { JSX } from 'preact';
import { type WeatherChoice, type WeatherReport, game, settings } from '../api';
import { Keycap } from '../components/controls';
import {
  IconApproach,
  IconClimb,
  IconClock,
  IconCloud,
  IconFair,
  IconLive,
  IconOvercast,
  IconPlane,
  IconRadio,
  IconRoute,
  IconRunway,
  IconStratus,
  IconSun,
  IconWarning,
} from '../components/icons';
import { approachSpeed, categoryOf, rotateSpeed, typeFeatures } from '../fleet';
import { KEY_ROWS, flyingKeyRows } from '../fleetText';
import { positionLabel } from '../cockpitMeta';
import { routeNm } from '../plan';
import { formatFrequency } from '../radio';
import {
  altitudeUnit,
  convertAltitude,
  convertSpeed,
  formatClock,
  formatHeading,
  formatSpeed,
  groupThousands,
  speedUnit,
} from '../format';
import { type MessageKey, lang, t } from '../i18n';
import { showTouch } from '../nav';
import { swissNowHours } from '../sun';
import { heightLabel } from './FlightSetup';
import { SwissMap } from './SwissMap';

export const WEATHER_ICONS: Record<WeatherChoice, (size?: number) => JSX.Element> = {
  live: (s) => <IconLive size={s} />,
  clear: (s) => <IconSun size={s} />,
  fair: (s) => <IconFair size={s} />,
  cloudy: (s) => <IconCloud size={s} />,
  overcast: (s) => <IconOvercast size={s} />,
  lowStratus: (s) => <IconStratus size={s} />,
};

/** Every key, as the settings list them (see fleetText.ts). */
export { KEY_ROWS };

const ARROWS: Record<string, string> = {
  'key.up': '↑',
  'key.down': '↓',
  'key.left': '←',
  'key.right': '→',
};

/** A key as shown on a cap: arrows as symbols (with their name for screen readers). */
export function KeyName({ k }: { k: string }) {
  if (k in ARROWS)
    return (
      <Keycap>
        <span aria-hidden="true">{ARROWS[k]}</span>
        <span class="visually-hidden">{t(k as MessageKey)}</span>
      </Keycap>
    );
  return <Keycap>{k.startsWith('key.') ? t(k as MessageKey) : k}</Keycap>;
}

export function KeyCombo({ keys }: { keys: (string | MessageKey)[][] }) {
  return (
    <span class="key-combo">
      {keys.map((group, gi) => (
        <span class="key-group" key={gi}>
          {gi > 0 && <span class="key-or">{t('settings.or')}</span>}
          {group.map((k) => (
            <KeyName k={k} key={k} />
          ))}
        </span>
      ))}
    </span>
  );
}

function windText(w: WeatherReport): string {
  const units = settings.units.value;
  if (w.windSpeed < 0.5) return t('briefing.wind.calm');
  const speed = Math.round(convertSpeed(w.windSpeed, units));
  return `${formatHeading(w.windFromDeg)}° / ${speed} ${speedUnit(units)}`;
}

function cloudText(w: WeatherReport): string {
  const oktas = Math.round(w.cloudCover * 8);
  if (oktas === 0) return t('briefing.clouds.none');
  const units = settings.units.value;
  const base = convertAltitude(w.cloudBase, units);
  const rounded = units === 'aviation' ? Math.round(base / 100) * 100 : Math.round(base / 50) * 50;
  return `${oktas}/8 · ${groupThousands(rounded, lang.value)} ${altitudeUnit(units)}`;
}

function visibilityText(w: WeatherReport): string {
  const km = w.visibility / 1000;
  if (km >= 10) return '≥ 10 km';
  return km < 1 ? `${Math.round(w.visibility / 50) * 50} m` : `${km.toFixed(1)} km`;
}

/** Altitude above sea level, rounded as a forecast would say it. */
function levelText(m: number): string {
  const units = settings.units.value;
  const v = convertAltitude(m, units);
  const r = units === 'aviation' ? Math.round(v / 100) * 100 : Math.round(v / 10) * 10;
  return `${groupThousands(r, lang.value)} ${altitudeUnit(units)}`;
}

export function stratusText(w: WeatherReport): string | null {
  const s = w.stratus;
  if (!s) return null;
  const km = s.visibilityBelow / 1000;
  const vis =
    km >= 1 ? `${Number(km.toFixed(1))} km` : `${Math.round(s.visibilityBelow / 50) * 50} m`;
  return t('briefing.stratus', { base: levelText(s.base), top: levelText(s.top), vis });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div class="fact">
      <dt class="caps">{label}</dt>
      <dd class="num">{value}</dd>
    </div>
  );
}

function TouchHints({ features }: { features: ReturnType<typeof typeFeatures> }) {
  return (
    <ul class="touch-hints">
      <li>
        <span class="hint-glyph hint-glyph--stick" aria-hidden="true" />
        {t('touch.hint.stick')}
      </li>
      <li>
        <span class="hint-glyph hint-glyph--lever" aria-hidden="true" />
        {t('touch.hint.throttle')}
      </li>
      <li>
        <span class="hint-glyph hint-glyph--rudder" aria-hidden="true" />
        {t('touch.hint.rudder')}
      </li>
      <li>
        <span class="hint-glyph hint-glyph--buttons" aria-hidden="true" />
        {t('touch.hint.buttons')}
      </li>
      {features.speedbrake && (
        <li>
          <span class="hint-glyph hint-glyph--lever" aria-hidden="true" />
          {t('touch.hint.speedbrake')}
        </li>
      )}
      {features.reverse && (
        <li>
          <span class="hint-glyph hint-glyph--buttons" aria-hidden="true" />
          {t('touch.hint.reverse')}
        </li>
      )}
    </ul>
  );
}

/** The flap settings as the lever's notches read: '0° · 15° · 30° · 40°' (or 1 · 2 · 3 · FULL). */
export function flapText(): string {
  const flaps = game.controls.value.find((c) => c.id === 'flaps');
  if (!flaps?.positions?.length) return '';
  const all = flaps.positions;
  return all.map((p) => positionLabel('flaps', p, all).toUpperCase()).join(' · ');
}

/** The tip for the start: by how the flight starts and what kind of aircraft flies it. */
function startTip(
  start: FlightPlanStart | undefined,
  cold: boolean,
  category: ReturnType<typeof categoryOf>,
  vr: string,
  vapp: string,
): string {
  if (cold) return t('briefing.tip.cold');
  if (start?.kind === 'air') return t('briefing.tip.air');
  if (start?.kind === 'approach')
    return category === 'piston'
      ? t('briefing.tip.approach')
      : t(`briefing.tip.approach.${category}`, { v: vapp || '–' });
  return category === 'piston'
    ? t('briefing.tip.runway', { v: vr || '–' })
    : t(`briefing.tip.runway.${category}`, { v: vr || '–' });
}

type FlightPlanStart = NonNullable<ReturnType<typeof game.plan.peek>>['start'];

/** The weather to brief: the app's report, or the preset's own values while there is none. */
function briefedWeather(weather: WeatherChoice): WeatherReport | null {
  return game.weather.value ?? (weather === 'live' ? null : WEATHER_PRESETS[weather]);
}

/** Shown while the world loads for the chosen flight: where, what, weather, controls. */
export function Briefing() {
  const plan = game.plan.value;
  const airports = game.airports.value;
  const start = plan?.start;
  const startIcao = start && start.kind !== 'air' ? start.airport : undefined;
  const airport = airports.find((a) => a.icao === plan?.airport || a.icao === startIcao);
  const dest = airports.find((a) => a.icao === plan?.destination?.airport);
  const info = AIRCRAFT.find((a) => a.id === plan?.aircraft);
  const weather = plan?.weather ?? 'live';
  const report = briefedWeather(weather);
  const p = Math.max(0, Math.min(1, game.loadProgress.value));
  const units = settings.units.value;
  const frequencies = game.frequencies.value;

  const startText = !start
    ? ''
    : start.kind === 'air'
      ? t('briefing.air', { h: heightLabel(start.altitude - (airport?.elevation ?? 0)) })
      : start.kind === 'approach'
        ? `${t('briefing.runway', { rwy: start.runway })} · ${t('briefing.approach', { d: t('setup.nm', { n: start.distanceNm }) })}`
        : t('briefing.runway', { rwy: start.runway });
  const heading =
    start?.kind === 'air' ? start.headingDeg : start ? parseInt(start.runway, 10) * 10 : NaN;
  const time =
    !plan || plan.time === 'now'
      ? t('briefing.time.now', { clock: formatClock(swissNowHours(new Date())) })
      : formatClock(plan.time);
  // Speeds a pilot says aloud are rounded to 5 kt (55 kt rotation for the C172).
  const speedText = (ms: number) =>
    `${Math.round(convertSpeed(ms, units) / 5) * 5} ${speedUnit(units)}`;
  const vr = info ? speedText(rotateSpeed(info)) : '';
  const vapp = info ? speedText(approachSpeed(info)) : '';
  const category = categoryOf(info);
  const features = typeFeatures(info);
  const flaps = flapText();
  const typeRows = flyingKeyRows(info).filter((r) =>
    ['keys.gear', 'keys.speedbrake', 'keys.reverse'].includes(r.label),
  );
  const tip = startTip(start, !!plan?.coldStart, category, vr, vapp);

  // The route: through the plan's waypoints if it has any, else straight.
  const routeText = (() => {
    if (!dest || !airport) return null;
    // An approach to its own airport has no route to speak of; a start and return is a circuit.
    if (dest === airport) return start?.kind === 'approach' ? null : t('briefing.circuit');
    const points = [airport, ...(plan?.route ?? []), dest];
    const via = (plan?.route ?? []).map((w) => w.ident);
    const nm = Math.round(routeNm(points));
    return [airport.icao, ...via, dest.icao].join(' → ') + ` · ${nm} NM`;
  })();
  const failures = plan?.failures?.length ?? 0;
  const flags = [
    plan?.coldStart ? t('briefing.coldStart') : null,
    plan?.atc === false ? t('briefing.atcOff') : null,
  ].filter((f): f is string => !!f);
  const stratus = report ? stratusText(report) : null;

  return (
    <div class="briefing" role="region" aria-labelledby="briefing-title">
      <div class="briefing-backdrop" aria-hidden="true" />
      <div class="briefing-inner">
        <div class="briefing-main">
          <section class="briefing-left enter">
            <header class="briefing-head">
              <p class="caps briefing-kicker">{t('briefing.title')}</p>
              <h1 id="briefing-title" class="briefing-title">
                {airport?.name ?? plan?.airport ?? '–'}
              </h1>
              <p class="briefing-sub">
                {airport && <span class="briefing-icao">{airport.icao}</span>}
                <span class="briefing-start">
                  {start?.kind === 'air' ? (
                    <IconClimb size={18} />
                  ) : start?.kind === 'approach' ? (
                    <IconApproach size={18} />
                  ) : (
                    <IconRunway size={18} />
                  )}
                  {startText}
                </span>
                {Number.isFinite(heading) && (
                  <span class="briefing-start num">
                    {t('briefing.heading', { hdg: formatHeading(heading) })}
                  </span>
                )}
              </p>
            </header>
            {airport && (
              <div class="briefing-map">
                <SwissMap
                  airports={airports}
                  selected={airport.icao}
                  route={dest ? { from: airport.icao, to: dest.icao } : undefined}
                  label={t('setup.map')}
                />
              </div>
            )}
            <p class="briefing-tip">{tip}</p>
          </section>

          <section class="briefing-right enter">
            <div class="brief-card glass">
              <dl class="brief-facts">
                <div class="brief-fact">
                  <dt class="caps">
                    <IconPlane size={14} /> {t('briefing.aircraft')}
                  </dt>
                  <dd class="brief-big">{info?.name ?? '–'}</dd>
                  {info && (
                    <dd class="brief-dim num">
                      {t('aircraft.vs0')} {formatSpeed(info.vs0, units)} · {t('aircraft.vne')}{' '}
                      {formatSpeed(info.vne, units)} {speedUnit(units)}
                    </dd>
                  )}
                  {info && (
                    <dd class="brief-type">
                      <span class="brief-type-fact num">
                        <span class="brief-type-label">{t('briefing.vr')}</span> {vr}
                      </span>
                      <span class="brief-type-fact num">
                        <span class="brief-type-label">{t('briefing.vapp')}</span> {vapp}
                      </span>
                      {flaps && (
                        <span class="brief-type-fact num">
                          <span class="brief-type-label">{t('briefing.flaps')}</span> {flaps}
                        </span>
                      )}
                      <span class="brief-type-fact">
                        {t(info.retractableGear ? 'aircraft.gear.retract' : 'aircraft.gear.fixed')}
                      </span>
                    </dd>
                  )}
                </div>
                <div class="brief-fact">
                  <dt class="caps">
                    <IconClock size={14} /> {t('briefing.time')}
                  </dt>
                  <dd class="brief-big num">{time}</dd>
                </div>
                {/* What this type has beyond the Cessna, with its keys, where keys are used. */}
                {info && !showTouch.value && typeRows.length > 0 && (
                  <div class="brief-fact brief-fact--wide">
                    <dt class="caps">{t('briefing.typeKeys')}</dt>
                    <dd class="brief-keys">
                      {typeRows.map((row) => (
                        <span class="brief-key" key={row.label}>
                          {t(row.label)}
                          <KeyCombo keys={row.keys} />
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {routeText && dest && (
                  <div class="brief-fact brief-fact--wide">
                    <dt class="caps">
                      <IconRoute size={14} /> {t('briefing.destination')}
                    </dt>
                    <dd class="brief-big">
                      {dest.name}
                      {plan?.destination?.runway && (
                        <span class="brief-dim">
                          {' '}
                          · {t('briefing.runway', { rwy: plan.destination.runway })}
                        </span>
                      )}
                    </dd>
                    <dd class="brief-route num">{routeText}</dd>
                  </div>
                )}
                <div class="brief-fact brief-fact--wide">
                  <dt class="caps">
                    {WEATHER_ICONS[weather](14)} {t('briefing.weather')}
                  </dt>
                  <dd class="brief-big">
                    {t(`weather.${weather}`)}
                    {weather === 'live' && !report && (
                      <span class="brief-dim"> · {t('weather.live.sub')}</span>
                    )}
                  </dd>
                  {stratus && <dd class="brief-stratus">{stratus}</dd>}
                  {report && (
                    <dd>
                      <dl class="facts">
                        <Fact label={t('briefing.wind')} value={windText(report)} />
                        <Fact label={t('briefing.visibility')} value={visibilityText(report)} />
                        <Fact label={t('briefing.clouds')} value={cloudText(report)} />
                        <Fact
                          label={t('briefing.temperature')}
                          value={`${Math.round(report.temperature)} °C`}
                        />
                      </dl>
                    </dd>
                  )}
                </div>
                {frequencies.length > 0 && (
                  <div class="brief-fact brief-fact--wide">
                    <dt class="caps">
                      <IconRadio size={14} /> {t('briefing.frequencies')}
                    </dt>
                    <dd>
                      <ul class="brief-freqs">
                        {frequencies.map((f) => (
                          <li key={f.name}>
                            <span class="brief-freq-name">{f.name}</span>
                            <span class="brief-freq num">{frequencyText(f.frequency)}</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
                {(flags.length > 0 || failures > 0) && (
                  <div class="brief-fact brief-fact--wide brief-flags">
                    {flags.map((f) => (
                      <dd class="brief-flag" key={f}>
                        {f}
                      </dd>
                    ))}
                    {failures > 0 && (
                      <dd
                        class="brief-flag brief-flag--failure"
                        title={t('briefing.failures.hint')}
                      >
                        <IconWarning size={14} />
                        {failures === 1
                          ? t('briefing.failures.one')
                          : t('briefing.failures.many', { n: failures })}
                        <span class="brief-dim"> · {t('briefing.failures.hint')}</span>
                      </dd>
                    )}
                  </div>
                )}
              </dl>
            </div>

            <div class="brief-card glass brief-controls">
              <h2 class="caps brief-card-title">{t('briefing.controls')}</h2>
              {showTouch.value ? (
                <TouchHints features={features} />
              ) : (
                <dl class="key-list key-list--compact">
                  {flyingKeyRows(info).map((row) => (
                    <div class="key-row" key={row.label}>
                      <dt>{t(row.label)}</dt>
                      <dd>
                        <KeyCombo keys={row.keys} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </section>
        </div>

        <div class="briefing-progress">
          <div class="loading-row">
            <span class="loading-text">
              {t('briefing.loading')}
              <span class="loading-dots" aria-hidden="true" />
            </span>
            <span class="loading-pct num">{Math.round(p * 100)}%</span>
          </div>
          <div
            class="progress"
            role="progressbar"
            aria-label={t('briefing.loading')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p * 100)}
          >
            <span class="progress-fill" style={{ transform: `scaleX(${p})` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A frequency in its band's usual form: COM with three decimals, NAV two, NDB in kHz. */
function frequencyText(khz: number): string {
  if (khz < 2000) return `${formatFrequency(khz, 'adf')} kHz`;
  return formatFrequency(khz, khz < 118_000 ? 'nav' : 'com');
}
