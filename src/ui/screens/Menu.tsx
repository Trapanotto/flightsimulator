import { useSignal } from '@preact/signals';
import { AIRCRAFT } from '@sim';
import type { VNode } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { game } from '../api';
import { Segmented } from '../components/controls';
import {
  IconArrowRight,
  IconGlobe,
  IconHangar,
  IconLogbook,
  IconPlane,
  IconSchool,
  IconSettings,
} from '../components/icons';
import { arrowNav } from '../focus';
import { type Lang, lang, setLang, t } from '../i18n';
import { actions, nav } from '../nav';
import { status } from '../state';
import { FlightSchool } from './FlightSchool';
import { FlightSetup } from './FlightSetup';
import { Hangar } from './Hangar';
import { Logbook } from './Logbook';

/** Wordmark: stays in exactly the same place from the loading screen to the menu. */
function Brand({ compact }: { compact?: boolean }) {
  return (
    <div class={`brand${compact ? ' brand--compact' : ''}`}>
      <div class="brand-line">
        <span class="brand-mark" aria-hidden="true" />
        <span class="brand-name">{t('app.brand')}</span>
      </div>
      <h1 class="brand-title">{t('app.product')}</h1>
      <p class="brand-tagline">{t('app.tagline')}</p>
    </div>
  );
}

function LoadingBlock() {
  const p = Math.max(0, Math.min(1, game.loadProgress.value));
  const pct = Math.round(p * 100);
  return (
    <div class="loading-block">
      <div class="loading-row">
        <span class="loading-text">
          {t('loading.status')}
          <span class="loading-dots" aria-hidden="true" />
        </span>
        <span class="loading-pct num">{pct}%</span>
      </div>
      <div
        class="progress"
        role="progressbar"
        aria-label={t('loading.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span class="progress-fill" style={{ transform: `scaleX(${p})` }} />
      </div>
    </div>
  );
}

function MenuItem(props: {
  label: string;
  sub: string;
  icon: VNode;
  primary?: boolean;
  soon?: boolean;
  onClick?: () => void;
  autofocus?: boolean;
  /** Position in the list, for the staggered entrance. */
  index: number;
}) {
  // A "soon" entry is not a dead button: it says when it is chosen that it comes later.
  const told = useSignal(false);
  useEffect(() => {
    if (!told.value) return;
    const id = setTimeout(() => (told.value = false), 2600);
    return () => clearTimeout(id);
  }, [told.value]);
  return (
    <button
      type="button"
      class={`menu-item${props.primary ? ' is-primary' : ''}${props.soon ? ' is-soon' : ''}`}
      aria-disabled={props.soon ? 'true' : undefined}
      data-autofocus={props.autofocus ? '' : undefined}
      style={{ '--i': props.index }}
      onClick={() => (props.soon ? (told.value = true) : props.onClick?.())}
    >
      <span class="menu-item-icon">{props.icon}</span>
      <span class="menu-item-text">
        <span class="menu-item-label">{props.label}</span>
        <span class="menu-item-sub" aria-live={props.soon ? 'polite' : undefined}>
          {told.value ? t('menu.soon.hint') : props.sub}
        </span>
      </span>
      {props.soon && <span class="badge">{t('menu.soon')}</span>}
      {props.primary && (
        <span class="menu-item-go">
          <IconArrowRight />
        </span>
      )}
    </button>
  );
}

function MainMenu() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Focus the first entry so keyboard and (later) gamepad users can start right away.
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
    if (first && !document.activeElement?.closest('.menu-list'))
      first.focus({ preventScroll: true });
  }, []);
  return (
    <nav
      ref={ref}
      class="menu-list"
      aria-label={t('menu.label')}
      onKeyDown={(e) => arrowNav(e, ref.current, '.menu-item', 'vertical')}
    >
      <MenuItem
        index={0}
        primary
        autofocus
        label={t('menu.fly')}
        sub={t('menu.fly.sub')}
        icon={<IconPlane size={22} />}
        onClick={() => (nav.page.value = 'setup')}
      />
      {/* A hangar of one would only repeat the aircraft the menu already shows. */}
      <MenuItem
        index={1}
        soon={AIRCRAFT.length < 2}
        label={t('menu.hangar')}
        sub={t('menu.hangar.sub')}
        icon={<IconHangar />}
        onClick={() => (nav.page.value = 'hangar')}
      />
      {/* Without the app's lessons there is nothing to start: the entry says it comes later. */}
      <MenuItem
        index={2}
        soon={!actions.startLesson}
        label={t('menu.school')}
        sub={t('menu.school.sub')}
        icon={<IconSchool />}
        onClick={() => (nav.page.value = 'school')}
      />
      <MenuItem
        index={3}
        label={t('menu.logbook')}
        sub={t('menu.logbook.sub')}
        icon={<IconLogbook />}
        onClick={() => (nav.page.value = 'logbook')}
      />
      <MenuItem
        index={4}
        label={t('menu.settings')}
        sub={t('menu.settings.sub')}
        icon={<IconSettings />}
        onClick={() => (nav.settingsOpen.value = true)}
      />
    </nav>
  );
}

function LanguageSwitch() {
  return (
    <div class="lang-switch">
      <IconGlobe size={18} />
      <Segmented<Lang>
        label={t('menu.language')}
        value={lang.value}
        onChange={setLang}
        options={[
          { value: 'de', label: t('lang.de') },
          { value: 'en', label: t('lang.en') },
        ]}
      />
    </div>
  );
}

/**
 * The loading screen and the main menu share one stage, so the wordmark does not move when
 * loading ends: only what is below it changes, and the opaque backdrop fades to reveal the
 * live scene.
 */
export function MenuStage() {
  const loading = game.screen.value === 'loading';
  const page = loading ? 'main' : nav.page.value;
  const hangar = page === 'hangar';
  // The flight school and the logbook are sheets like the setup and share its stage.
  const sheet = page === 'setup' || page === 'school' || page === 'logbook';
  const away = sheet || hangar;
  return (
    <div
      class={`menu-stage${loading ? ' is-loading' : ''}${sheet ? ' is-setup' : ''}${hangar ? ' is-hangar' : ''}`}
    >
      <div class="menu-backdrop" aria-hidden="true" />
      <div class="menu-scrim" aria-hidden="true" />
      <div class="menu-col" inert={away}>
        <Brand />
        <div class="menu-main">{loading ? <LoadingBlock /> : <MainMenu />}</div>
        {!loading && (
          <div class="menu-foot fade-in">
            <LanguageSwitch />
          </div>
        )}
      </div>
      {!loading && (
        <footer class="menu-credits fade-in" inert={away}>
          <span>{t('menu.attribution')}</span>
          {status.version.value && (
            <span class="menu-version num">{t('menu.version', { v: status.version.value })}</span>
          )}
        </footer>
      )}
      {page === 'setup' && <FlightSetup />}
      {hangar && <Hangar />}
      {page === 'school' && <FlightSchool />}
      {page === 'logbook' && <Logbook />}
    </div>
  );
}
