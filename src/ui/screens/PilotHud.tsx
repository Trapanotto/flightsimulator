import { useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { game, settings } from '../api';
import { IconParachute, IconPause, IconRestart } from '../components/icons';
import { categoryOf } from '../fleet';
import {
  altitudeUnit,
  formatAltitude,
  formatHeading,
  formatSpeed,
  formatVerticalSpeed,
  speedUnit,
  verticalSpeedUnit,
} from '../format';
import { lang, t } from '../i18n';
import { actions, flownAircraft, showTouch } from '../nav';
import { leaveKey, pilotAction, pilotHint, pullUrgent } from '../pilot';

/**
 * The button of the "more" sheet that gets the pilot out: on the ground out of the door, in
 * flight a jump, in the fighter the ejection seat. Shown only when the app offers it; the key
 * is X.
 */
export function LeaveButton({ onDone }: { onDone?: () => void }) {
  const onGround = useComputed(() => !!game.telemetry.value?.onGround);
  if (!actions.leaveAircraft) return null;
  const label = t(leaveKey(onGround.value, categoryOf(flownAircraft.value) === 'fighter'));
  return (
    <button
      type="button"
      class="more-btn more-btn--leave"
      onClick={() => {
        onDone?.();
        actions.leaveAircraft?.();
      }}
    >
      <IconParachute size={24} />
      <span class="more-label">{label}</span>
      <kbd class="more-key">X</kbd>
    </button>
  );
}

const STATE_KEY = {
  freefall: 'pilot.state.freefall',
  canopy: 'pilot.state.canopy',
  walk: 'pilot.state.walk',
} as const;

/**
 * Out of the aircraft: the height above the ground large, then sink rate, ground speed and
 * heading, and one line that says what to do now. On touch a big button does the one thing
 * the state calls for (pull, flare, get in); the stick of the touch controls steers.
 */
export function PilotHud() {
  const p = game.pilot.value;
  const paused = game.screen.value === 'paused';
  const touch = showTouch.value;
  // Keep focus off the buttons: Space is the chute and must not press a focused button.
  useEffect(() => {
    if (paused) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.ui'))
      document.activeElement.blur();
  }, [paused]);
  if (!p) return null;
  const units = settings.units.value;
  const act = pilotAction(p);
  const urgent = pullUrgent(p);
  const low = urgent || (p.state === 'canopy' && p.agl < 150);
  return (
    <div
      class={`hud pilot-hud is-${p.state}${touch ? ' is-touch' : ''}${paused ? ' is-paused' : ''}`}
      inert={paused}
      role="region"
      aria-label={t('pilot.label')}
    >
      <div class="pilot-top">
        <div class={`pilot-card hud-card${low ? ' is-low' : ''}`}>
          <span class="pilot-state caps">{t(STATE_KEY[p.state])}</span>
          {p.state !== 'walk' && (
            <span class="pilot-agl">
              <span class="pilot-agl-value num">
                {formatAltitude(Math.max(0, p.agl), units, lang.value)}
              </span>
              <span class="pilot-agl-unit">
                {altitudeUnit(units)} <span class="pilot-agl-what">{t('pilot.agl')}</span>
              </span>
            </span>
          )}
          <dl class="pilot-figs num">
            {p.state !== 'walk' && (
              <div>
                <dt>{t('pilot.vs')}</dt>
                <dd>
                  {formatVerticalSpeed(p.verticalSpeed, units, lang.value)}
                  <small>{verticalSpeedUnit(units)}</small>
                </dd>
              </div>
            )}
            <div>
              <dt>{t('pilot.speed')}</dt>
              <dd>
                {formatSpeed(p.speed, units)}
                <small>{speedUnit(units)}</small>
              </dd>
            </div>
            <div>
              <dt>{t('pilot.heading')}</dt>
              <dd>
                {formatHeading(p.headingDeg)}
                <small>°</small>
              </dd>
            </div>
          </dl>
        </div>
        <button
          type="button"
          class="btn btn--icon btn--glass hud-btn"
          aria-label={t('hud.pause')}
          onClick={() => actions.pause()}
        >
          <IconPause />
        </button>
      </div>

      <div class="pilot-foot">
        <p
          class={`pilot-hint${(p.aircraftLost && p.state === 'walk') || urgent ? ' is-lost' : ''}${urgent ? ' is-urgent' : ''}`}
          role="status"
        >
          {t(pilotHint(p, touch))}
        </p>
        {p.state === 'walk' && p.aircraftLost && (
          <button
            type="button"
            class="btn btn--primary pilot-new"
            onClick={() => actions.restart()}
          >
            <IconRestart />
            {t('pilot.newFlight')}
          </button>
        )}
      </div>

      {touch && act && (
        <button
          type="button"
          class={`pilot-act is-${act}${urgent ? ' is-urgent' : ''}`}
          onClick={() => (act === 'enter' ? actions.leaveAircraft?.() : actions.pullChute?.())}
        >
          {act === 'enter' ? t('pilot.enter') : act === 'pull' ? t('pilot.pull') : t('pilot.flare')}
        </button>
      )}
    </div>
  );
}
