import type { SpeechEngine, VoiceInfo } from './RadioVoice';

/**
 * The browser's speech synthesiser as a `SpeechEngine`, or undefined where there is none
 * (some Linux builds, embedded web views).
 */
export function browserSpeech(): SpeechEngine | undefined {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return undefined;
  const byInfo = new Map<VoiceInfo, SpeechSynthesisVoice>();
  let infos: VoiceInfo[] = [];
  const read = () => {
    byInfo.clear();
    infos = synth.getVoices().map((v) => {
      const info = { name: v.name, lang: v.lang, localService: v.localService };
      byInfo.set(info, v);
      return info;
    });
  };
  read();
  const listeners: (() => void)[] = [];
  synth.addEventListener('voiceschanged', () => {
    read();
    for (const l of listeners) l();
  });
  // Chrome drops the events of an utterance the garbage collector has taken: keep a hold.
  const live = new Set<SpeechSynthesisUtterance>();
  return {
    voices: () => infos,
    onVoicesChanged: (l) => listeners.push(l),
    speak(r) {
      const u = new SpeechSynthesisUtterance(r.text);
      const voice = r.voice && byInfo.get(r.voice);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else u.lang = 'en-US';
      u.rate = r.rate;
      u.pitch = r.pitch;
      u.volume = r.volume;
      live.add(u);
      u.onstart = () => r.onStart();
      u.onend = () => {
        live.delete(u);
        r.onEnd();
      };
      u.onerror = (e) => {
        live.delete(u);
        r.onError(e.error);
      };
      // Chrome can be left paused after the tab was hidden; speaking then stays silent.
      if (synth.paused) synth.resume();
      synth.speak(u);
    },
    cancel: () => synth.cancel(),
  };
}
