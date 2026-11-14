import { AIRCRAFT } from '@sim';
import type { JSX } from 'preact';
import { type WeatherChoice, type WeatherReport, game, settings } from '../api';
import { Keycap } from '../components/controls';
import {
  IconClimb,
  IconClock,
  IconCloud,
  IconFair,
  IconLive,
  IconOvercast,
  IconPlane,
  IconRunway,
  IconSun,
} from '../components/icons';
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
  lowStratus: (s) => <IconOvercast size={s} />,
};

/** Keys shown in the briefing: the few that get an aircraft off the ground. */
export const KEY_ROWS: { label: MessageKey; keys: (string | MessageKey)[][] }[] = [
  {
    label: 'keys.pitch',
    keys: [
      ['W', 'S'],
      ['key.up', 'key.down'],
    ],
  },
  {
    label: 'keys.roll',
    keys: [
      ['A', 'D'],
      ['key.left', 'key.right'],
    ],
  },
  { label: 'keys.yaw', keys: [['Q', 'E']] },
  {
    label: 'keys.throttle',
    keys: [
      ['key.shift', 'key.ctrl'],
      ['key.pgup', 'key.pgdn'],
    ],
  },
  { label: 'keys.flapsDown', keys: [['F']] },
  { label: 'keys.flapsUp', keys: [['V']] },
  { label: 'keys.gear', keys: [['G']] },
  { label: 'keys.brake', keys: [['B']] },
  { label: 'keys.view', keys: [['C']] },
  { label: 'keys.pause', keys: [['P'], ['key.esc']] },
];

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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div class="fact">
      <dt class="caps">{label}</dt>
      <dd class="num">{value}</dd>
    </div>
  );
}

function TouchHints() {
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
    </ul>
  );
}

/** Shown while the world loads for the chosen flight: where, what, weather, controls. */
export function Briefing() {
  const plan = game.plan.value;
  const airport = game.airports.value.find(
    (a) =>
      a.icao === plan?.airport || (plan?.start.kind === 'runway' && a.icao === plan.start.airport),
  );
  const info = AIRCRAFT.find((a) => a.id === plan?.aircraft);
  const report = game.weather.value;
  const p = Math.max(0, Math.min(1, game.loadProgress.value));
  const units = settings.units.value;

  const start = plan?.start;
  const startText = !start
    ? ''
    : start.kind === 'air'
      ? t('briefing.air', { h: heightLabel(start.altitude - (airport?.elevation ?? 0)) })
      : t('briefing.runway', { rwy: start.runway });
  const heading =
    start?.kind === 'air' ? start.headingDeg : start ? parseInt(start.runway, 10) * 10 : NaN;
  const time =
    !plan || plan.time === 'now'
      ? t('briefing.time.now', { clock: formatClock(swissNowHours(new Date())) })
      : formatClock(plan.time);
  const weather = plan?.weather ?? 'live';
  // Rotation speed is about 1.15 times the clean stall speed (55 kt for the C172).
  const vr = info
    ? `${Math.round(convertSpeed(info.vs * 1.15, units) / 5) * 5} ${speedUnit(units)}`
    : '';

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
                  {start?.kind === 'air' ? <IconClimb size={18} /> : <IconRunway size={18} />}
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
                  airports={game.airports.value}
                  selected={airport.icao}
                  label={t('setup.map')}
                />
              </div>
            )}
            <p class="briefing-tip">
              {start?.kind === 'air'
                ? t('briefing.tip.air')
                : t('briefing.tip.runway', { v: vr || '–' })}
            </p>
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
                </div>
                <div class="brief-fact">
                  <dt class="caps">
                    <IconClock size={14} /> {t('briefing.time')}
                  </dt>
                  <dd class="brief-big num">{time}</dd>
                </div>
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
              </dl>
            </div>

            <div class="brief-card glass brief-controls">
              <h2 class="caps brief-card-title">{t('briefing.controls')}</h2>
              {showTouch.value ? (
                <TouchHints />
              ) : (
                <dl class="key-list key-list--compact">
                  {KEY_ROWS.slice(0, 8).map((row) => (
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
