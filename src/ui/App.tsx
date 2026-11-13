import { game } from './api';
import { lang } from './i18n';
import { crashed, debugOn, nav, showTouch } from './nav';
import { Briefing } from './screens/Briefing';
import { DebugOverlay } from './screens/Debug';
import { Hud } from './screens/Hud';
import { MenuStage } from './screens/Menu';
import { PauseMenu } from './screens/Pause';
import { SettingsDialog } from './screens/Settings';
import { TouchControls } from './screens/TouchControls';

/** The whole interface: one layer per screen of `game.screen`, plus dialogs on top. */
export function App() {
  const screen = game.screen.value;
  const inFlight = screen === 'flight' || screen === 'paused';
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
      {screen === 'flight' && showTouch.value && !crashed.value && <TouchControls />}
      {screen === 'paused' && <PauseMenu />}
      {nav.settingsOpen.value && screen !== 'loading' && <SettingsDialog />}
      {debugOn.value && <DebugOverlay />}
    </div>
  );
}
