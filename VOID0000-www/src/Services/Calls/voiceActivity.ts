import type { BrowserWindowWithAudioContext } from './callTypes';

const SPEAKING_THRESHOLD = 0.035;

export function createVoiceActivityWatcher(
  stream: MediaStream,
  onSpeakingChange: (speaking: boolean) => void,
) {
  const AudioContextCtor =
    window.AudioContext || (window as BrowserWindowWithAudioContext).webkitAudioContext;
  if (!AudioContextCtor) {
    return () => onSpeakingChange(false);
  }

  const audioContext = new AudioContextCtor();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(stream);
  const samples = new Uint8Array(analyser.fftSize);
  let frameId = 0;
  let lastSpeaking = false;
  let stopped = false;

  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.78;
  source.connect(analyser);

  const tick = () => {
    if (stopped) return;

    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    const speaking = rms > SPEAKING_THRESHOLD;

    if (speaking !== lastSpeaking) {
      lastSpeaking = speaking;
      onSpeakingChange(speaking);
    }

    frameId = window.requestAnimationFrame(tick);
  };

  void audioContext.resume().catch(() => {});
  tick();

  return () => {
    stopped = true;
    window.cancelAnimationFrame(frameId);
    source.disconnect();
    void audioContext.close().catch(() => {});
    onSpeakingChange(false);
  };
}
