/**
 * audio – engines, wind, cockpit sounds, navigation tones and radio.
 * Depends on: sim.
 */
export { AudioEngine } from './AudioEngine';
export { AircraftSound, type AircraftSoundInput } from './AircraftSound';
export {
  A320_SOUND,
  C172_SOUND,
  FA18_SOUND,
  MAX_ENGINES,
  PC12_SOUND,
  soundProfileFor,
  type AirframeSpec,
  type CabinSpec,
  type EngineKind,
  type Position,
  type SoundProfile,
  type TurbineSpec,
  type WarningSpec,
} from './profiles';
export {
  bladePassHz,
  cabinWeighted,
  coreFromFan,
  coreHz,
  coreTarget,
  fanFromCore,
  fanTipMach,
  featherTarget,
  jetVelocity,
  lightOffRumble,
  readTurbine,
  roarCornerHz,
  spoolCore,
  turbineMode,
  turbineVoice,
  voiceLoudness,
  SOUND_SPEED,
  type EngineVoice,
  type TurbineMode,
  type TurbineReading,
  type VoiceMemory,
} from './turbine';
export {
  airframeWind,
  buffetLevel,
  dopplerFactor,
  gearRoarLevel,
  listening,
  shockLevel,
  soundSpeedAt,
  type CameraRelative,
  type Listening,
} from './airframe';
export { CLACKER_HZ, SHAKER_HZ } from './warnings';
export {
  CAVALRY_CHARGE,
  CockpitSound,
  DISCONNECT_TONE,
  type CockpitSoundInput,
} from './CockpitSound';
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
export {
  CrashSound,
  EXPLOSION_DELAY,
  synthCrash,
  synthExplosion,
  type CrashSoundOptions,
} from './CrashSound';
