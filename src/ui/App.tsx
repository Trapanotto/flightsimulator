import { game } from './api';
import { FlightCredits } from './components/Credits';
import { lang } from './i18n';
import { crashed, debugOn, lessonEnded, nav, showTouch } from './nav';
import { Briefing } from './screens/Briefing';
import { DebugOverlay } from './screens/Debug';
import { Hud } from './screens/Hud';
import { MenuStage } from './screens/Menu';
import { PauseMenu } from './screens/Pause';
import { PhotoMode } from './screens/Photo';
import { ReplayBar } from './screens/Replay';
import { SettingsDialog } from './screens/Settings';
import { TouchControls } from './screens/TouchControls';

/** The whole interface: one layer per screen of `game.screen`, plus dialogs on top. */
export function App() {
  const screen = game.screen.value;
  const inFlight = screen === 'flight' || screen === 'paused';
  // Photo mode hides everything but its own panel: nothing else may end up in the picture.
  const photo = screen === 'photo';
  return (
    <div
      class="ui"
      data-screen={screen}
      data-touch={showTouch.value ? '' : undefined}
      lang={lang.value}
    >
      {(screen === 'loading' || screen === 'menu') && <MenuStage />}
      {screen === 'briefing' && <Briefing />}
      {inFlight && <Hud />}
      {(inFlight || screen === 'replay') && <FlightCredits />}
      {screen === 'flight' && showTouch.value && !crashed.value && !lessonEnded.value && (
        <TouchControls />
      )}
      {screen === 'paused' && <PauseMenu />}
      {screen === 'replay' && <ReplayBar />}
      {photo && <PhotoMode />}
      {nav.settingsOpen.value && screen !== 'loading' && !photo && <SettingsDialog />}
      {debugOn.value && !photo && <DebugOverlay />}
    </div>
  );
}
