/**
 * audio – engines, wind, cockpit sounds, navigation tones and radio.
 * Depends on: sim.
 */
export { AudioEngine } from './AudioEngine';
export {
  AircraftSound,
  C172_SOUND,
  type AircraftSoundInput,
  type SoundProfile,
} from './AircraftSound';
export { CockpitSound, DISCONNECT_TONE, type CockpitSoundInput } from './CockpitSound';
export { NavAudio, type NavAudioInput } from './NavAudio';
export {
  RadioVoice,
  pickVoices,
  type RadioKeying,
  type RadioVoiceOptions,
  type SpeechEngine,
  type SpeechRequest,
  type Speaker,
  type VoiceInfo,
} from './RadioVoice';
export { RadioSquelch, squelchBurst, staticLevel } from './RadioSquelch';
export { browserSpeech } from './browserSpeech';
export {
  IDENT_HZ,
  IDENT_REPEAT,
  IDENT_WPM,
  MARKERS,
  MORSE,
  PatternKeyer,
  identPattern,
  keyedEnvelope,
  morseTones,
  morseUnit,
  type KeyPattern,
  type MarkerId,
  type Tone,
} from './keying';
export {
  brakeSquealLevel,
  engineLevel,
  engineMode,
  firingShare,
  groundRollLevel,
  gyroSpin,
  rainLevel,
  surfaceSound,
  touchdownLevel,
  windLevel,
  type EngineMode,
} from './levels';
