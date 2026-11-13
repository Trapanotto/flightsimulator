/**
 * app – puts the packages together: renderer, loop, input, the flow from menu to flight.
 * Depends on: every other package.
 */
export { type AppDebug, startApp } from './App';
export { type DeviceClass, type DeviceProfile, PROFILES, detectDevice } from './device';
