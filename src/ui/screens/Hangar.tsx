import { signal, useSignal } from '@preact/signals';
import { AIRCRAFT, type AircraftId, type AircraftInfo } from '@sim';
import { useEffect, useRef } from 'preact/hooks';
import { settings } from '../api';
import { CategoryIcon, IconArrowRight, IconBack, IconChevronDown } from '../components/icons';
import { approachSpeed, categoryOf, rotateSpeed, shortName } from '../fleet';
import { arrowNav, useDialog } from '../focus';
import { type SpecKind, formatSpec } from '../format';
import { type MessageKey, isMessageKey, lang, t } from '../i18n';
import { actions, nav } from '../nav';
import { browserStorage, readJson, writeJson } from '../persist';
import { DRAFT_KEY } from '../plan';

/** A figure as the card shows it: a label, a value and its unit. */
interface Figure {
  label: MessageKey;
  value: string;
  unit?: string;
  wide?: boolean;
}

function spec(label: MessageKey, kind: SpecKind, si: number | undefined): Figure | null {
  if (si === undefined || !Number.isFinite(si)) return null;
  const f = formatSpec(kind, si, settings.units.value, lang.value);
  return { label, value: f.value, unit: f.unit };
}

/** The published figures of a type in groups, leaving out what the type does not state. */
export function figureGroups(info: AircraftInfo): { title: MessageKey; figures: Figure[] }[] {
  const s = info.specs;
  const keep = (list: (Figure | null)[]) => list.filter((f): f is Figure => !!f);
  const groups: { title: MessageKey; figures: Figure[] }[] = [
    {
      title: 'spec.group.size',
      figures: keep([
        spec('spec.span', 'length', s?.span),
        spec('spec.length', 'length', s?.length),
        spec('spec.height', 'length', s?.height),
        s ? { label: 'spec.seats', value: String(s.seats) } : null,
      ]),
    },
    {
      title: 'spec.group.mass',
      figures: keep([
        spec('spec.emptyMass', 'mass', s?.emptyMass),
        spec('spec.mtom', 'mass', info.maxTakeoffMass),
      ]),
    },
    {
      title: 'spec.group.power',
      figures: s ? [{ label: 'spec.group.power', value: s.powerplant, wide: true }] : [],
    },
    {
      title: 'spec.group.performance',
      figures: keep([
        spec('spec.cruise', 'speed', s?.cruiseSpeed),
        spec('spec.maxSpeed', 'speed', s?.maxSpeed),
        s?.maxMach ? { label: 'spec.maxMach', value: `M ${s.maxMach.toFixed(2)}` } : null,
        spec('spec.ceiling', 'altitude', s?.ceiling),
        spec('spec.range', 'range', s?.range),
        spec('spec.climb', 'climb', s?.climbRate),
      ]),
    },
    {
      title: 'spec.group.field',
      figures: keep([
        spec('spec.takeoffRoll', 'length', s?.takeoffRoll),
        spec('spec.landingRoll', 'length', s?.landingRoll),
      ]),
    },
  ];
  return groups.filter((g) => g.figures.length > 0);
}

/**
 * The handbook speeds: stall clean and with flaps, rotation, approach, and the limit (VNE on a
 * piston single, VMO on the others).
 */
export function handbookSpeeds(info: AircraftInfo): { key: MessageKey; sub: string; ms: number }[] {
  const limit = categoryOf(info) === 'piston' ? 'NE' : 'MO';
  return [
    { key: 'speed.vs', sub: 'S', ms: info.vs },
    { key: 'speed.vs0', sub: 'S0', ms: info.vs0 },
    { key: 'speed.vr', sub: 'R', ms: rotateSpeed(info) },
    { key: 'speed.vapp', sub: 'APP', ms: approachSpeed(info) },
    { key: 'speed.vne', sub: limit, ms: info.vne },
  ];
}

function aboutText(info: AircraftInfo): string {
  const key = `hangar.about.${info.id}`;
  return isMessageKey(key) ? t(key) : '';
}

function SpeedStrip({ info }: { info: AircraftInfo }) {
  const units = settings.units.value;
  return (
    <section class="hangar-speeds" aria-labelledby="hangar-speeds-title">
      <h3 class="caps" id="hangar-speeds-title">
        {t('spec.group.speeds')}
      </h3>
      <dl class="hangar-speed-list">
        {handbookSpeeds(info).map((v) => {
          const f = formatSpec('speed', v.ms, units, lang.value);
          return (
            <div class="hangar-speed" key={v.key} title={t(v.key)}>
              <dt>
                <span aria-hidden="true">
                  V<sub>{v.sub}</sub>
                </span>
                <span class="visually-hidden">{t(v.key)}</span>
              </dt>
              <dd class="num">
                {f.value}
                <span class="hangar-unit">{f.unit}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function Figures({ info }: { info: AircraftInfo }) {
  return (
    <div class="hangar-figures-body" id="hangar-figures-body">
      {figureGroups(info).map((g) => (
        <section class="hangar-group" key={g.title} aria-labelledby={`hg-${g.title}`}>
          <h3 class="caps" id={`hg-${g.title}`}>
            {t(g.title)}
          </h3>
          <dl class="hangar-grid">
            {g.figures.map((f) => (
              <div class={`hangar-fig${f.wide ? ' is-wide' : ''}`} key={f.label}>
                {!f.wide && <dt>{t(f.label)}</dt>}
                {f.wide && <dt class="visually-hidden">{t(f.label)}</dt>}
                <dd class={f.wide ? '' : 'num'}>
                  {f.value}
                  {f.unit && <span class="hangar-unit">{f.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Horizontal swipes on the hangar's own surfaces step through the types. */
function useSwipe(ref: { current: HTMLElement | null }, onStep: (dir: 1 | -1) => void) {
  const latest = useRef(onStep);
  latest.current = onStep;
  useEffect(() => {
    const step = (dir: 1 | -1) => latest.current(dir);
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const quick = e.timeStamp - start.t < 700;
      start = null;
      // A clear sideways flick; a scroll of the figures or a tap is left alone.
      if (quick && Math.abs(dx) > 48 && Math.abs(dx) > 1.6 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    };
    const cancel = () => (start = null);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
    };
  }, []);
}

/** A phone in landscape (the same break as the CSS). */
const SHORT = '(max-height: 560px) and (orientation: landscape)';
const shortScreen = signal(typeof matchMedia !== 'undefined' && matchMedia(SHORT).matches);
if (typeof matchMedia !== 'undefined')
  matchMedia(SHORT).addEventListener('change', (e) => (shortScreen.value = e.matches));

/** The type the hangar opens on: the one last chosen for a flight, else the first. */
function initialType(): AircraftId | undefined {
  const draft = readJson(browserStorage(), DRAFT_KEY) as { aircraft?: unknown } | null;
  return (AIRCRAFT.find((a) => a.id === draft?.aircraft) ?? AIRCRAFT[0])?.id;
}

/**
 * The hangar: every type of `AIRCRAFT`, one at a time. The menu's 3D scene behind shows the
 * chosen type flying (the app does that on `showAircraft`); the interface keeps to the edges
 * so the aircraft stays the hero: the story on the left, the figures on the right, the types
 * as a strip of cards at the bottom.
 */
export function Hangar() {
  const ref = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const selected = useSignal<AircraftId | undefined>(initialType());
  const figuresOpen = useSignal(false);
  const back = () => (nav.page.value = 'main');
  useDialog(ref, back);

  const list = AIRCRAFT;
  const index = Math.max(
    0,
    list.findIndex((a) => a.id === selected.value),
  );
  const info = list[index];

  useEffect(() => {
    if (info) actions.showAircraft?.(info.id);
  }, [info?.id]);
  useEffect(() => () => actions.showAircraft?.(null), []);

  const step = (dir: 1 | -1) => {
    if (!list.length) return;
    selected.value = list[(index + dir + list.length) % list.length]!.id;
  };
  useSwipe(ref, step);

  // Arrow keys step through the types wherever focus is in the hangar; in the strip the radio
  // group moves focus along with the choice.
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (stripRef.current?.contains(e.target as Node)) {
      arrowNav(e, stripRef.current, '[role="radio"]', 'horizontal')?.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const fly = () => {
    if (!info) return;
    const storage = browserStorage();
    const draft = readJson(storage, DRAFT_KEY);
    const base = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
    // The setup fits the rest to the type (an airport it may use, its approach distances).
    writeJson(storage, DRAFT_KEY, { ...base, aircraft: info.id });
    nav.page.value = 'setup';
  };

  if (!info) return null;
  const category = categoryOf(info);
  // Phones in landscape: the figures fold away behind a tab so the aircraft keeps its room.
  const compact = shortScreen.value;
  const firstFlight = info.specs?.firstFlight;
  return (
    <div
      ref={ref}
      class="hangar"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hangar-title"
      onKeyDown={onKey}
    >
      <div class="hangar-scrim" aria-hidden="true" />
      <header class="hangar-top">
        <button
          type="button"
          class="btn btn--ghost setup-back"
          aria-label={t('setup.back')}
          onClick={back}
        >
          <IconBack />
          <span class="setup-back-text">{t('setup.backShort')}</span>
        </button>
        <h1 id="hangar-title" class="setup-title hangar-title">
          {t('hangar.title')}
        </h1>
        <span class="hangar-count num" aria-live="polite">
          {t('hangar.count', { i: index + 1, n: list.length })}
        </span>
      </header>

      <div class="hangar-sheet">
        <div class="hangar-scroll">
          <section class="hangar-info" key={info.id} aria-live="polite">
            <p class="caps hangar-maker">
              {info.specs?.maker ?? t(`category.${category}`)}
              {firstFlight !== undefined && (
                <span class="hangar-first">
                  {' · '}
                  {t('spec.firstFlight')} {firstFlight}
                </span>
              )}
            </p>
            <h2 class="hangar-name">{info.name}</h2>
            <p class="hangar-tags">
              <span class="hangar-tag">
                <CategoryIcon category={category} size={16} />
                {t(`category.${category}`)}
              </span>
              <span class="hangar-tag">
                {info.engines === 1
                  ? t('aircraft.engine.one')
                  : t('aircraft.engine.many', { n: info.engines })}
              </span>
              <span class="hangar-tag">
                {t(info.retractableGear ? 'aircraft.gear.retract' : 'aircraft.gear.fixed')}
              </span>
            </p>
            {aboutText(info) && <p class="hangar-about">{aboutText(info)}</p>}
            <SpeedStrip info={info} />
          </section>

          <section
            class={`hangar-figures glass${figuresOpen.value ? ' is-open' : ''}`}
            aria-labelledby="hangar-figures-title"
          >
            {compact ? (
              <button
                type="button"
                class="hangar-figures-head"
                aria-expanded={figuresOpen.value}
                aria-controls="hangar-figures-body"
                onClick={() => (figuresOpen.value = !figuresOpen.value)}
              >
                <span class="caps" id="hangar-figures-title">
                  {t('hangar.figures')}
                </span>
                <IconChevronDown size={18} />
              </button>
            ) : (
              <header class="hangar-figures-head">
                <h2 class="caps" id="hangar-figures-title">
                  {t('hangar.figures')}
                </h2>
                <span class="hangar-figures-type">{shortName(info)}</span>
              </header>
            )}
            {(!compact || figuresOpen.value) && <Figures info={info} />}
          </section>
        </div>
        <button type="button" class="btn btn--primary hangar-fly" onClick={fly}>
          {t('hangar.fly')}
          <IconArrowRight size={20} />
        </button>
      </div>

      <nav class="hangar-strip" aria-label={t('hangar.types')}>
        {list.length > 1 && (
          <button
            type="button"
            class="btn btn--icon btn--glass hangar-step"
            aria-label={t('hangar.prev')}
            onClick={() => step(-1)}
          >
            <IconBack />
          </button>
        )}
        <div ref={stripRef} class="hangar-cards" role="radiogroup" aria-label={t('hangar.types')}>
          {list.map((a) => {
            const on = a.id === info.id;
            const c = categoryOf(a);
            return (
              <button
                type="button"
                role="radio"
                key={a.id}
                aria-checked={on}
                aria-label={`${a.name}, ${t(`category.${c}`)}`}
                tabIndex={on ? 0 : -1}
                data-autofocus={on ? '' : undefined}
                class={`hangar-card${on ? ' is-on' : ''}`}
                onClick={() => (selected.value = a.id)}
              >
                <CategoryIcon category={c} size={22} />
                <span class="hangar-card-name">{shortName(a)}</span>
                <span class="hangar-card-kind">{t(`category.${c}`)}</span>
              </button>
            );
          })}
        </div>
        {list.length > 1 && (
          <button
            type="button"
            class="btn btn--icon btn--glass hangar-step is-next"
            aria-label={t('hangar.next')}
            onClick={() => step(1)}
          >
            <IconBack />
          </button>
        )}
      </nav>
    </div>
  );
}
