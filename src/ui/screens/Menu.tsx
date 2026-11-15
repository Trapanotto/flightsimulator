import { game } from '../api';
import { Brand, Version } from '../components/Brand';
import { Credits } from '../components/Credits';
import { t } from '../i18n';
import { FlightSetup } from './FlightSetup';

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

/**
 * The home of the game: there is no menu any more, the flight planning is the first thing to
 * see, over a quiet dark backdrop (no 3D scene behind it). While the app is still starting,
 * the title and the progress stand alone in the middle.
 */
export function MenuStage() {
  const loading = game.screen.value === 'loading';
  return (
    <div class={`home${loading ? ' is-loading' : ''}`}>
      <div class="home-backdrop" aria-hidden="true" />
      {loading ? (
        <div class="home-loading">
          <Brand />
          <LoadingBlock />
        </div>
      ) : (
        <>
          <FlightSetup />
          <footer class="home-credits home-credits--outer fade-in">
            <Credits />
            <Version />
          </footer>
        </>
      )}
    </div>
  );
}
