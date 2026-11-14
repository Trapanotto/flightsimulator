import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RadioVoice,
  pickVoices,
  type RadioKeying,
  type SpeechEngine,
  type SpeechRequest,
  type Speaker,
  type VoiceInfo,
} from '../src/audio/RadioVoice';
import { squelchBurst, staticLevel } from '../src/audio/RadioSquelch';

const v = (name: string, lang: string, localService = true): VoiceInfo => ({
  name,
  lang,
  localService,
});

/** A synthesiser that speaks only when the test says so. */
class FakeSpeech implements SpeechEngine {
  list: VoiceInfo[];
  spoken: SpeechRequest[] = [];
  current: SpeechRequest | undefined;
  cancels = 0;
  private listeners: (() => void)[] = [];
  constructor(list: VoiceInfo[]) {
    this.list = list;
  }
  voices() {
    return this.list;
  }
  onVoicesChanged(l: () => void) {
    this.listeners.push(l);
  }
  setVoices(list: VoiceInfo[]) {
    this.list = list;
    for (const l of this.listeners) l();
  }
  speak(r: SpeechRequest) {
    if (r.volume === 0 && r.text.trim() === '') return; // the unlock primer
    this.spoken.push(r);
    this.current = r;
  }
  cancel() {
    this.cancels++;
    const c = this.current;
    this.current = undefined;
    c?.onError('interrupted');
  }
  start() {
    this.current!.onStart();
  }
  end() {
    const c = this.current!;
    this.current = undefined;
    c.onEnd();
  }
}

class FakeKeying implements RadioKeying {
  log: string[] = [];
  keyOn(s: Speaker) {
    this.log.push(`on:${s}`);
  }
  keyOff(s: Speaker) {
    this.log.push(`off:${s}`);
  }
}

const VOICES = [
  v('Google Deutsch', 'de-DE'),
  v('Microsoft David', 'en-US'),
  v('Microsoft Zira', 'en-US'),
  v('Cloud English', 'en-AU', false),
];

describe('voice choice', () => {
  it('picks two different English voices, local ones first', () => {
    const { atc, pilot } = pickVoices(VOICES);
    expect(atc?.name).toBe('Microsoft David');
    expect(pilot?.name).toBe('Microsoft Zira');
  });

  it('uses the one voice twice, reads Android tags, and has none without English', () => {
    expect(pickVoices([v('en', 'en_GB')]).pilot?.name).toBe('en');
    expect(pickVoices([v('de', 'de-CH')]).atc).toBeUndefined();
    expect(pickVoices([]).atc).toBeUndefined();
  });
});

describe('radio voice queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (list = VOICES) => {
    const speech = new FakeSpeech(list);
    const keying = new FakeKeying();
    const radio = new RadioVoice(speech, keying, { gap: 0.4 });
    radio.unlock();
    return { speech, keying, radio };
  };

  it('speaks one transmission at a time with a gap, keying the receiver around each', async () => {
    const { speech, keying, radio } = setup();
    const a = radio.say('cessna one two three, taxi to holding point', 'atc');
    const b = radio.say('taxi to holding point, one two three', 'pilot');
    expect(speech.spoken).toHaveLength(1);
    speech.start();
    expect(radio.speaking).toBe(true);
    speech.end();
    expect(await a).toBe(true);
    // The squelch tail gets its silence before the reply.
    expect(speech.spoken).toHaveLength(1);
    vi.advanceTimersByTime(399);
    expect(speech.spoken).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(speech.spoken).toHaveLength(2);
    speech.start();
    speech.end();
    expect(await b).toBe(true);
    expect(keying.log).toEqual(['on:atc', 'off:atc', 'on:pilot', 'off:pilot']);
    expect(speech.spoken[0]!.voice?.name).toBe('Microsoft David');
    expect(speech.spoken[1]!.voice?.name).toBe('Microsoft Zira');
    // Controllers talk briskly.
    expect(speech.spoken[0]!.rate).toBeGreaterThan(1);
  });

  it('cancels the current transmission and everything waiting', async () => {
    const { speech, keying, radio } = setup();
    const a = radio.say('one');
    const b = radio.say('two');
    speech.start();
    radio.cancel();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(keying.log).toEqual(['on:atc', 'off:atc']);
    expect(radio.pending).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(speech.spoken).toHaveLength(1);
  });

  it('reports a message as unspoken without a synthesiser, an English voice, or the unlock', async () => {
    expect(await new RadioVoice(undefined).say('hello')).toBe(false);
    expect(new RadioVoice(undefined).available).toBe(false);
    const { radio } = setup([v('de', 'de-DE')]);
    expect(radio.available).toBe(false);
    const german = radio.say('hello');
    vi.advanceTimersByTime(2000);
    expect(await german).toBe(false);
    const locked = new RadioVoice(new FakeSpeech(VOICES));
    expect(await locked.say('hello')).toBe(false);
  });

  it('waits for a voice list that arrives late, then gives up after a while', async () => {
    const speech = new FakeSpeech([]);
    const radio = new RadioVoice(speech, undefined, { voiceWait: 1000 });
    radio.unlock();
    const a = radio.say('hello');
    expect(speech.spoken).toHaveLength(0);
    speech.setVoices(VOICES);
    expect(speech.spoken).toHaveLength(1);
    speech.start();
    speech.end();
    expect(await a).toBe(true);

    const never = new RadioVoice(new FakeSpeech([]), undefined, { voiceWait: 1000 });
    never.unlock();
    const b = never.say('hello');
    vi.advanceTimersByTime(1000);
    expect(await b).toBe(false);
  });

  it('follows the volume, and mute cuts a transmission short and skips the next', async () => {
    const { speech, keying, radio } = setup();
    radio.setVolume(0.4, false);
    const a = radio.say('one');
    expect(speech.spoken[0]!.volume).toBeCloseTo(0.4, 9);
    speech.start();
    radio.setVolume(0.4, true);
    expect(await a).toBe(false);
    expect(keying.log).toEqual(['on:atc', 'off:atc']);
    vi.advanceTimersByTime(1000);
    expect(await radio.say('two')).toBe(false);
    expect(speech.spoken).toHaveLength(1);
  });

  it('does not let a synthesiser that never starts or never ends block the frequency', async () => {
    const { speech, radio } = setup();
    const a = radio.say('one');
    const b = radio.say('two');
    vi.advanceTimersByTime(5000);
    expect(await a).toBe(false);
    vi.advanceTimersByTime(500);
    expect(speech.spoken).toHaveLength(2);
    speech.start();
    // Chrome sometimes drops the end event: the watchdog ends it as spoken.
    vi.advanceTimersByTime(20_000);
    expect(await b).toBe(true);
  });

  it('tells controller and pilot apart by pitch when there is one voice', () => {
    const { speech, radio } = setup([v('Only', 'en-US')]);
    void radio.say('one', 'atc');
    speech.start();
    speech.end();
    vi.advanceTimersByTime(500);
    void radio.say('two', 'pilot');
    expect(speech.spoken[0]!.pitch).toBeLessThan(speech.spoken[1]!.pitch);
  });

  it('ignores late events of a cancelled utterance', async () => {
    const { speech, keying, radio } = setup();
    const a = radio.say('one');
    const stale = speech.current!;
    speech.start();
    radio.cancel();
    stale.onEnd();
    stale.onStart();
    expect(await a).toBe(false);
    expect(keying.log).toEqual(['on:atc', 'off:atc']);
  });
});

describe('squelch', () => {
  it('opens with a short pop and closes with a tail of about 0.2 s; own calls only click', () => {
    const on = squelchBurst('atc', 'on');
    const off = squelchBurst('atc', 'off');
    expect(on[on.length - 1]!.time).toBeLessThan(0.05);
    expect(off[off.length - 1]!.time).toBeGreaterThan(0.15);
    expect(off[off.length - 1]!.time).toBeLessThan(0.3);
    expect(squelchBurst('pilot', 'off')[2]!.time).toBeLessThan(0.02);
    for (const env of [on, off]) {
      expect(env[0]!.value).toBe(0);
      expect(env[env.length - 1]!.value).toBe(0);
      // Every edge is a ramp of at least a millisecond: a click by design, never a step.
      for (let i = 1; i < env.length; i++)
        expect(env[i]!.time - env[i - 1]!.time).toBeGreaterThanOrEqual(0.001);
    }
    expect(staticLevel('pilot')).toBeLessThan(staticLevel('atc'));
  });
});
