import { useSignal } from '@preact/signals';
import { AIRCRAFT } from '@sim';
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { type LandingRecord, type LogEntry, game, settings } from '../api';
import {
  IconArrowRight,
  IconBack,
  IconCheck,
  IconClose,
  IconSchool,
  IconTrash,
  IconWarning,
} from '../components/icons';
import { shortName } from '../fleet';
import { arrowNav, useDialog } from '../focus';
import { formatSpec, formatSpeed, speedUnit } from '../format';
import { type MessageKey, lang, t, tr } from '../i18n';
import {
  formatDistance,
  formatFlightTime,
  formatHours,
  formatRunwayLength,
  formatSinkRate,
  logbookTotals,
  newestFirst,
  touchdownRating,
} from '../logbook';
import { actions, nav } from '../nav';
import { SwissMap } from './SwissMap';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang.value === 'de' ? 'de-CH' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

function typeName(e: LogEntry): string {
  const info = AIRCRAFT.find((a) => a.id === e.aircraft);
  return info ? shortName(info) : e.aircraft.toUpperCase();
}

function routeText(e: LogEntry): string {
  const from = e.from ?? '–';
  return e.to && e.to !== e.from ? `${from} → ${e.to}` : from;
}

const OUTCOME: Record<LogEntry['outcome'], MessageKey> = {
  landed: 'logbook.outcome.landed',
  crashed: 'logbook.outcome.crashed',
  ended: 'logbook.outcome.ended',
};

function lessonTitle(id: string | undefined): string {
  if (!id) return '';
  return tr(game.lessons.value.find((l) => l.id === id)?.title) || id;
}

/** A value and its unit, the unit set smaller. */
function Value({ v }: { v: { value: string; unit: string } }) {
  return (
    <>
      {v.value}
      <span class="log-unit">{v.unit}</span>
    </>
  );
}

function Totals({ entries }: { entries: readonly LogEntry[] }) {
  const s = logbookTotals(entries);
  return (
    <dl class="log-totals">
      <div>
        <dt>{t('logbook.flights')}</dt>
        <dd class="num">{s.flights}</dd>
      </div>
      <div>
        <dt>{t('logbook.hours')}</dt>
        <dd class="num">
          {formatHours(s.airTime)}
          <span class="log-unit">h</span>
        </dd>
      </div>
      <div>
        <dt>{t('logbook.landings')}</dt>
        <dd class="num">{s.landings}</dd>
      </div>
    </dl>
  );
}

function LessonMark({ e }: { e: LogEntry }) {
  if (!e.lesson) return null;
  const ok = !!e.lessonPassed;
  const text = `${t('logbook.lesson')}: ${lessonTitle(e.lesson)}, ${t(ok ? 'logbook.lesson.passed' : 'logbook.lesson.failed')}`;
  return (
    <span class={`log-lesson${ok ? ' is-ok' : ' is-bad'}`} title={text}>
      <IconSchool size={15} />
      {ok ? <IconCheck size={13} /> : <IconClose size={13} />}
      <span class="visually-hidden">{text}</span>
    </span>
  );
}

function Row({ e, on, onPick }: { e: LogEntry; on: boolean; onPick: () => void }) {
  const units = settings.units.value;
  const dist = formatDistance(e.distance, units, lang.value);
  return (
    <li>
      <button
        type="button"
        class={`log-row${on ? ' is-on' : ''}`}
        aria-current={on ? 'true' : undefined}
        data-autofocus={on ? '' : undefined}
        data-id={e.id}
        onClick={onPick}
      >
        <span class="log-row-top">
          <span class="log-route">{routeText(e)}</span>
          <LessonMark e={e} />
          <span class={`log-outcome is-${e.outcome}`}>{t(OUTCOME[e.outcome])}</span>
        </span>
        <span class="log-row-sub num">
          {formatDate(e.date)} · {typeName(e)}
        </span>
        <span class="log-row-sub num">
          {formatFlightTime(e.duration)} · {dist.value} {dist.unit} ·{' '}
          {e.landings.length === 1
            ? t('logbook.landings.one')
            : t('logbook.landings.many', { n: e.landings.length })}
        </span>
      </button>
    </li>
  );
}

const RATING_KEY = {
  soft: 'rating.soft',
  normal: 'rating.normal',
  firm: 'rating.firm',
  hard: 'rating.hard',
} as const;

function Landing({ l, n }: { l: LandingRecord; n: number }) {
  const units = settings.units.value;
  const rating = touchdownRating(l.sinkRate);
  const where = l.airport
    ? `${l.airport}${l.runway ? ` ${l.runway}` : ''}`
    : t('logbook.offRunway');
  const side =
    l.centreline === undefined
      ? null
      : Math.abs(l.centreline) < 0.5
        ? t('logbook.onLine')
        : `${formatRunwayLength(l.centreline, units, lang.value).value} ${formatRunwayLength(l.centreline, units, lang.value).unit} ${t(l.centreline > 0 ? 'logbook.right' : 'logbook.left')}`;
  return (
    <li class="landing">
      <header class="landing-head">
        <span class="landing-title">
          {t('logbook.landing', { n })}
          <span class="landing-where">{where}</span>
        </span>
        <span class="landing-at num">
          {t('logbook.landing.at', { t: formatFlightTime(l.time) })}
        </span>
        <span class={`rating is-${rating}`}>{t(RATING_KEY[rating])}</span>
      </header>
      <dl class="landing-grid">
        <div>
          <dt>{t('logbook.sink')}</dt>
          <dd class="num">
            <Value v={formatSinkRate(l.sinkRate, units, lang.value)} />
          </dd>
        </div>
        <div>
          <dt>{t('logbook.speed')}</dt>
          <dd class="num">
            {formatSpeed(l.speed, units)}
            <span class="log-unit">{speedUnit(units)}</span>
          </dd>
        </div>
        {side !== null && (
          <div>
            <dt>{t('logbook.centreline')}</dt>
            <dd class="num">{side}</dd>
          </div>
        )}
        {l.pastThreshold !== undefined && (
          <div>
            <dt>{t('logbook.threshold')}</dt>
            <dd class="num">
              <Value v={formatRunwayLength(l.pastThreshold, units, lang.value)} />
            </dd>
          </div>
        )}
        {l.load !== undefined && (
          <div>
            <dt>{t('logbook.load')}</dt>
            <dd class="num">
              {l.load.toFixed(1)}
              <span class="log-unit">g</span>
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function Fact({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class={wide ? 'is-wide' : undefined}>
      <dt>{label}</dt>
      <dd class="num">{children}</dd>
    </div>
  );
}

function Detail({ e, onDelete }: { e: LogEntry; onDelete?: () => void }) {
  const units = settings.units.value;
  const involved = new Set([e.from, e.to, ...e.landings.map((l) => l.airport)]);
  // Only the airports of this flight: every label of the country would bury the track.
  const airports = game.airports.value.filter((a) => involved.has(a.icao));
  return (
    <div class="log-detail" key={e.id}>
      <div class="setup-map-wrap log-map">
        <SwissMap
          airports={airports}
          selected={e.from ?? ''}
          route={e.from && e.to ? { from: e.from, to: e.to } : undefined}
          track={e.track}
          label={t('logbook.map')}
        />
      </div>
      <header class="log-detail-head">
        <div class="log-detail-title">
          <h2 class="log-detail-route">{routeText(e)}</h2>
          <p class="log-detail-sub num">
            {formatDate(e.date)} · {AIRCRAFT.find((a) => a.id === e.aircraft)?.name ?? typeName(e)}
          </p>
        </div>
        {onDelete && (
          <button type="button" class="btn log-delete" onClick={onDelete}>
            <IconTrash size={18} />
            <span class="log-delete-text">{t('logbook.delete')}</span>
          </button>
        )}
      </header>
      <dl class="log-facts">
        <Fact label={t('logbook.duration')}>{formatFlightTime(e.duration)}</Fact>
        <Fact label={t('logbook.airTime')}>{formatFlightTime(e.airTime)}</Fact>
        <Fact label={t('logbook.distance')}>
          <Value v={formatDistance(e.distance, units, lang.value)} />
        </Fact>
        <Fact label={t('logbook.maxAlt')}>
          <Value v={formatSpec('altitude', e.maxAltitude, units, lang.value)} />
        </Fact>
        <Fact label={t('logbook.outcome')}>
          <span class={`log-outcome is-${e.outcome}`}>{t(OUTCOME[e.outcome])}</span>
        </Fact>
        {e.lesson && (
          <Fact label={t('logbook.lesson')} wide>
            <span class="log-fact-lesson">
              {lessonTitle(e.lesson)}{' '}
              <span class={e.lessonPassed ? 'is-ok' : 'is-bad'}>
                ({t(e.lessonPassed ? 'logbook.lesson.passed' : 'logbook.lesson.failed')})
              </span>
            </span>
          </Fact>
        )}
      </dl>
      <section class="log-landings" aria-labelledby="log-landings-title">
        <h3 class="caps" id="log-landings-title">
          {t('logbook.landings')}
        </h3>
        {e.landings.length ? (
          <ol class="landing-list">
            {e.landings.map((l, i) => (
              <Landing key={i} l={l} n={i + 1} />
            ))}
          </ol>
        ) : (
          <p class="field-hint">{t('logbook.noLandings')}</p>
        )}
      </section>
    </div>
  );
}

/** Asks before something that cannot be undone. */
function Confirm(props: { title: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, props.onCancel);
  return (
    <div
      class="modal-layer fade-in"
      onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}
    >
      <div
        ref={ref}
        class="confirm glass enter"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-hint"
      >
        <span class="confirm-icon" aria-hidden="true">
          <IconWarning size={22} />
        </span>
        <h2 id="confirm-title" class="confirm-title">
          {props.title}
        </h2>
        <p id="confirm-hint" class="confirm-hint">
          {t('logbook.confirmHint')}
        </p>
        <div class="confirm-actions">
          <button type="button" class="btn" data-autofocus onClick={props.onCancel}>
            {t('logbook.cancel')}
          </button>
          <button type="button" class="btn btn--danger" onClick={props.onConfirm}>
            <IconTrash size={18} />
            {t('logbook.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The logbook: totals, the flights newest first, and the chosen flight with its track on the
 * map and every touchdown. Two columns where there is room; on a phone the list and the
 * flight take turns, with a way back to the list.
 */
export function Logbook() {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const picked = useSignal<string | null>(null);
  const detailOpen = useSignal(false);
  const confirm = useSignal<'one' | 'all' | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const back = () => (nav.page.value = 'main');
  // While the confirmation is up, Escape belongs to it.
  useDialog(ref, confirm.value ? undefined : back);

  const entries = newestFirst(game.logbook.value);
  const current = entries.find((e) => e.id === picked.value) ?? entries[0];

  const pick = (e: LogEntry) => {
    picked.value = e.id;
    detailOpen.value = true;
  };
  const ask = (what: 'one' | 'all') => {
    opener.current = document.activeElement as HTMLElement | null;
    confirm.value = what;
  };
  const closeConfirm = () => {
    confirm.value = null;
    // Focus goes back to the button that asked, or (when that went with the deleted flight)
    // to the flight now chosen, once the sheet is no longer inert.
    setTimeout(() => {
      const candidates = [
        opener.current,
        ...(ref.current?.querySelectorAll<HTMLElement>(
          '.log-delete, .log-row.is-on, .btn--primary',
        ) ?? []),
      ];
      // The first one still there and shown (on a phone the list or the flight is hidden).
      candidates
        .find((el) => el?.isConnected && el.getClientRects().length > 0)
        ?.focus({ preventScroll: true });
    });
  };
  const doDelete = () => {
    if (confirm.value === 'all') actions.clearLogbook?.();
    else if (current) {
      // The next flight down the list takes the place of the deleted one.
      const i = entries.indexOf(current);
      picked.value = (entries[i + 1] ?? entries[i - 1])?.id ?? null;
      actions.deleteLogEntry?.(current.id);
    }
    closeConfirm();
  };

  return (
    <>
      <div
        ref={ref}
        class="setup logbook enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logbook-title"
        inert={confirm.value !== null}
      >
        <header class="setup-head">
          <button
            type="button"
            class="btn btn--ghost setup-back"
            aria-label={t('setup.back')}
            onClick={back}
            data-autofocus={entries.length ? undefined : ''}
          >
            <IconBack />
            <span class="setup-back-text">{t('setup.backShort')}</span>
          </button>
          <h1 id="logbook-title" class="setup-title">
            {t('logbook.title')}
          </h1>
          {actions.clearLogbook && entries.length > 0 && (
            <button
              type="button"
              class="btn btn--ghost log-clear"
              aria-label={t('logbook.clear')}
              onClick={() => ask('all')}
            >
              <IconTrash size={18} />
              <span class="log-clear-text">{t('logbook.clear')}</span>
            </button>
          )}
        </header>
        {entries.length === 0 || !current ? (
          <div class="log-empty">
            <div class="empty">
              <span class="empty-title">{t('logbook.empty')}</span>
              <span class="empty-hint">{t('logbook.empty.hint')}</span>
            </div>
            <button
              type="button"
              class="btn btn--primary"
              onClick={() => (nav.page.value = 'setup')}
            >
              {t('logbook.fly')}
              <IconArrowRight size={20} />
            </button>
          </div>
        ) : (
          <div class="setup-body log-body" data-view={detailOpen.value ? 'detail' : 'list'}>
            <div class="setup-col log-side">
              <Totals entries={entries} />
              <ul
                ref={listRef}
                class="log-list"
                aria-label={t('logbook.list')}
                onKeyDown={(e) => {
                  // Arrows choose; on a phone only a tap or Enter opens the flight.
                  const id = arrowNav(e, listRef.current, '.log-row', 'vertical')?.dataset.id;
                  if (id) picked.value = id;
                }}
              >
                {entries.map((e) => (
                  <Row key={e.id} e={e} on={e === current} onPick={() => pick(e)} />
                ))}
              </ul>
            </div>
            <div class="setup-col log-main">
              <button
                type="button"
                class="btn btn--ghost log-back"
                onClick={() => (detailOpen.value = false)}
              >
                <IconBack />
                {t('logbook.back')}
              </button>
              <Detail
                e={current}
                onDelete={actions.deleteLogEntry ? () => ask('one') : undefined}
              />
            </div>
          </div>
        )}
      </div>
      {confirm.value && (
        <Confirm
          title={
            confirm.value === 'all'
              ? t('logbook.confirmClear', { n: entries.length })
              : t('logbook.confirmDelete')
          }
          onConfirm={doDelete}
          onCancel={closeConfirm}
        />
      )}
    </>
  );
}
