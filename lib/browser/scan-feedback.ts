// C4 — the sound a scan makes. A warehouse is noisy and the person is
// looking at the dress, not the screen: a good scan chirps once, a refused
// one buzzes twice (and vibrates where the phone can — not on iPhones).
// Browsers only allow sound after a tap or key press; a scanner's Enter is
// a key press, the camera button a tap, so by the first scan it's allowed.

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

function tone(ac: AudioContext, freq: number, start: number, length: number, type: OscillatorType) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.18, ac.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + start + length);
  osc.connect(gain).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + length);
}

export function scanFeedback(ok: boolean): void {
  try {
    const ac = audio();
    if (ac) {
      if (ac.state === "suspended") void ac.resume();
      if (ok) tone(ac, 1760, 0, 0.09, "sine");
      else {
        tone(ac, 220, 0, 0.22, "square");
        tone(ac, 220, 0.3, 0.22, "square");
      }
    }
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav && typeof nav.vibrate === "function") nav.vibrate(ok ? 40 : [120, 80, 120]);
  } catch {
    // Sound is a nicety; the screen still shows the result.
  }
}
