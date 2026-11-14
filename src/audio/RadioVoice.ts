/**
 * The voices on the radio: air traffic control and the pilot's own calls, spoken by the
 * platform's speech synthesiser one transmission at a time. The synthesiser sits behind
 * `SpeechEngine` so the queue can be tested with a fake; `browserSpeech()` is the real one.
 * Speech synthesis cannot be routed through Web Audio, so the radio character (key clicks,
 * squelch, static, ducking) comes from a `RadioKeying` that follows the utterance events.
 */

export type Speaker = 'atc' | 'pilot';

export interface VoiceInfo {
  name: string;
  /** BCP 47 tag; Android reports 'en_US', which `pickVoices` normalises. */
  lang: string;
  /** Runs on the device (no network round trip, no length limit of cloud voices). */
  localService: boolean;
}

/** One utterance handed to the synthesiser. */
export interface SpeechRequest {
  text: string;
  voice: VoiceInfo | undefined;
  rate: number;
  pitch: number;
  /** 0..1 */
  volume: number;
  onStart(): void;
  onEnd(): void;
  onError(error: string): void;
}

/** What the queue needs from a speech synthesiser. */
export interface SpeechEngine {
  voices(): readonly VoiceInfo[];
  /** Called when the voice list changes (browsers fill it asynchronously). */
  onVoicesChanged(listener: () => void): void;
  speak(request: SpeechRequest): void;
  /** Stops the current utterance and drops anything the engine itself has queued. */
  cancel(): void;
}

/** The sound around a transmission: the receiver keys on when speech starts, off at its end. */
export interface RadioKeying {
  keyOn(speaker: Speaker): void;
  keyOff(speaker: Speaker): void;
}

export interface RadioVoiceOptions {
  /** Speaking rates: controllers talk fast. */
  atcRate?: number;
  pilotRate?: number;
  /** Seconds of silence between two transmissions (the squelch tail fits in it). */
  gap?: number;
  /** How long to wait for a voice list before deciding there is none, ms. */
  voiceWait?: number;
  /** How long an utterance may take to start before it counts as failed, ms. */
  startTimeout?: number;
}

interface Pending {
  text: string;
  speaker: Speaker;
  resolve: (spoken: boolean) => void;
}

/** Voices for both speakers; the same one twice when the platform has only one. */
export function pickVoices(voices: readonly VoiceInfo[]): {
  atc: VoiceInfo | undefined;
  pilot: VoiceInfo | undefined;
} {
  const lang = (v: VoiceInfo) => v.lang.replace('_', '-').toLowerCase();
  const english = voices.filter((v) => lang(v).startsWith('en'));
  const score = (v: VoiceInfo) =>
    // Local voices start at once and have no length limit; US and UK accents are the ones
    // heard on the frequency in Europe.
    (v.localService ? 4 : 0) +
    (/^en-(us|gb)/.test(lang(v)) ? 2 : 0) +
    // Natural voices (Edge, recent Windows) sound far less robotic.
    (/natural/i.test(v.name) ? 1 : 0);
  const ranked = english
    .map((v, i) => ({ v, s: score(v), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.v);
  const atc = ranked[0];
  // A second voice of a different name; prefer one of the same quality class (local or not).
  const pilot =
    ranked.find((v) => v !== atc && v.localService === atc?.localService) ??
    ranked.find((v) => v !== atc) ??
    atc;
  return { atc, pilot };
}

/**
 * Queue of radio transmissions. `say()` resolves true once a message has been spoken to its
 * end, false when it was not (no synthesiser, no English voice, muted, cancelled, not yet
 * unlocked, or an error): the interface shows every message as text anyway.
 */
export class RadioVoice {
  private readonly queue: Pending[] = [];
  private current: Pending | undefined;
  /** Bumped for every utterance, so late events of a cancelled one are ignored. */
  private token = 0;
  private keyed = false;
  private busy = false;
  private unlocked = false;
  private volume = 0.7;
  private muted = false;
  private voices: { atc: VoiceInfo | undefined; pilot: VoiceInfo | undefined } = {
    atc: undefined,
    pilot: undefined,
  };
  private voicesSettled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: Required<RadioVoiceOptions>;

  constructor(
    private readonly engine: SpeechEngine | undefined,
    private readonly keying?: RadioKeying,
    options: RadioVoiceOptions = {},
  ) {
    this.opts = {
      atcRate: 1.15,
      pilotRate: 1.1,
      gap: 0.45,
      voiceWait: 2000,
      startTimeout: 5000,
      ...options,
    };
    if (!engine) {
      this.voicesSettled = true;
      return;
    }
    const refresh = () => {
      this.voices = pickVoices(engine.voices());
      if (this.voices.atc) this.settle();
    };
    engine.onVoicesChanged(refresh);
    refresh();
    // Chrome fills the list later, Firefox on Linux may never: stop waiting after a while.
    if (!this.voicesSettled) setTimeout(() => this.settle(), this.opts.voiceWait);
  }

  /** A synthesiser with an English voice exists (false until the voice list has arrived). */
  get available(): boolean {
    return this.engine !== undefined && this.voices.atc !== undefined;
  }

  /** A transmission is being spoken right now. */
  get speaking(): boolean {
    return this.keyed;
  }

  /** Messages waiting, including the one being spoken. */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /**
   * Call from the first user gesture, inside its handler: Chrome refuses speech before one
   * and iOS Safari only speaks after an utterance started from a gesture. Until then every
   * message resolves unspoken.
   */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    // Priming with silence costs nothing where it is not needed.
    this.engine?.speak({
      text: ' ',
      voice: undefined,
      rate: 1,
      pitch: 1,
      volume: 0,
      onStart: () => {},
      onEnd: () => {},
      onError: () => {},
    });
  }

  /** The output volume (0..1) and mute; mute cuts a running transmission short. */
  setVolume(volume: number, muted: boolean) {
    this.volume = Math.min(1, Math.max(0, volume));
    if (muted && !this.muted && this.current) this.interrupt();
    this.muted = muted;
  }

  /** Queues a transmission. Text arrives ready to speak ('one four', not '14'). */
  say(text: string, speaker: Speaker = 'atc'): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push({ text, speaker, resolve });
      this.pump();
    });
  }

  /** Stops the transmission being spoken and drops all waiting ones. */
  cancel() {
    for (const p of this.queue.splice(0)) p.resolve(false);
    this.interrupt();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.busy = false;
  }

  private settle() {
    if (this.voicesSettled) return;
    this.voicesSettled = true;
    this.pump();
  }

  private interrupt() {
    const cur = this.current;
    if (!cur) return;
    this.token++;
    this.engine?.cancel();
    this.finish(cur, false);
  }

  private pump() {
    if (this.busy || this.current || !this.voicesSettled) return;
    const next = this.queue.shift();
    if (!next) return;
    const voice = next.speaker === 'atc' ? this.voices.atc : this.voices.pilot;
    if (!this.engine || !voice || !this.unlocked || this.muted || this.volume <= 0) {
      next.resolve(false);
      this.pump();
      return;
    }
    this.current = next;
    const token = ++this.token;
    const live = () => token === this.token && this.current === next;
    const oneVoice = this.voices.atc === this.voices.pilot;
    let started = false;
    // An utterance that never starts (a cloud voice offline, a stuck synthesiser) must not
    // block the frequency.
    const startTimer = setTimeout(() => {
      if (!live() || started) return;
      this.token++;
      this.engine?.cancel();
      this.finish(next, false);
    }, this.opts.startTimeout);
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const rate = next.speaker === 'atc' ? this.opts.atcRate : this.opts.pilotRate;
    this.engine.speak({
      text: next.text,
      voice,
      rate,
      // With a single voice, pitch at least tells controller and pilot apart.
      pitch: oneVoice ? (next.speaker === 'atc' ? 0.9 : 1.1) : 1,
      volume: this.volume,
      onStart: () => {
        if (!live() || started) return;
        started = true;
        clearTimeout(startTimer);
        this.keyed = true;
        this.keying?.keyOn(next.speaker);
        // Chrome sometimes never sends the end event: give up after twice the expected time.
        const expected = 1500 + (next.text.length * 75) / rate;
        endTimer = setTimeout(() => {
          if (!live()) return;
          this.token++;
          this.engine?.cancel();
          this.finish(next, true);
        }, expected * 2);
      },
      onEnd: () => {
        if (!live()) return;
        clearTimeout(startTimer);
        if (endTimer !== undefined) clearTimeout(endTimer);
        this.finish(next, started);
      },
      onError: () => {
        if (!live()) return;
        clearTimeout(startTimer);
        if (endTimer !== undefined) clearTimeout(endTimer);
        this.finish(next, false);
      },
    });
  }

  private finish(p: Pending, spoken: boolean) {
    if (this.current !== p) return;
    this.current = undefined;
    if (this.keyed) {
      this.keyed = false;
      this.keying?.keyOff(p.speaker);
    }
    p.resolve(spoken);
    // A short silence between transmissions, as on a real frequency.
    this.busy = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.busy = false;
      this.pump();
    }, this.opts.gap * 1000);
  }
}
