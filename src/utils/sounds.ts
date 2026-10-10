// Cyberpunk Web Audio API Sound Synthesizer
let audioCtx: AudioContext | null = null;

function safeNum(val: any, fallback: number = 0): number {
  const n = typeof val === "number" ? val : parseFloat(val);
  return typeof n === "number" && isFinite(n) && !isNaN(n) ? n : fallback;
}

let soundVolume = Math.max(
  0,
  Math.min(1, safeNum(localStorage.getItem("hapstore_sound_volume"), 0.7))
);
let musicVolume = Math.max(
  0,
  Math.min(1, safeNum(localStorage.getItem("hapstore_music_volume"), 0.4))
);
let isMusicEnabled = localStorage.getItem("hapstore_music_enabled") === "true";
let isSoundEnabled = localStorage.getItem("hapstore_sound_enabled") !== "false"; // Default true

let themeAudio: HTMLAudioElement | null = null;
const THEME_SRC = "/music/sound.mp3?v=1";

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function safeSetValue(param: AudioParam, value: number, time: number, fallbackVal: number = 0.001) {
  const v = safeNum(value, fallbackVal);
  const t = safeNum(time, 0);
  try {
    param.setValueAtTime(v, t);
  } catch {
    // Web Audio rejects values scheduled in the past; safe to skip.
  }
}

function safeExpRamp(param: AudioParam, value: number, time: number, fallbackVal: number = 0.001) {
  const v = Math.max(0.0001, safeNum(value, fallbackVal));
  const t = safeNum(time, 0);
  try {
    param.exponentialRampToValueAtTime(v, t);
  } catch {
    // Ramp target must stay positive; skip rather than break playback.
  }
}

function safeLinearRamp(
  param: AudioParam,
  value: number,
  time: number,
  fallbackVal: number = 0.001
) {
  const v = safeNum(value, fallbackVal);
  const t = safeNum(time, 0);
  try {
    param.linearRampToValueAtTime(v, t);
  } catch {
    // Same as above: scheduling failures must not interrupt the game.
  }
}

// Global unlock listener for browser audio autoplay policy
function unlockAudioContext() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx
      .resume()
      .then(() => {
        if (isMusicEnabled) {
          startMusic();
        }
      })
      .catch(() => {});
  }
}

if (typeof window !== "undefined") {
  const events = ["pointerdown", "touchstart", "click", "keydown"];
  const unlock = () => {
    unlockAudioContext();
    if (audioCtx && audioCtx.state === "running") {
      events.forEach((evt) => window.removeEventListener(evt, unlock));
    }
  };
  events.forEach((evt) => window.addEventListener(evt, unlock, { passive: true }));
}

export function getSoundEnabled(): boolean {
  return isSoundEnabled;
}

export function setSoundEnabled(enabled: boolean) {
  isSoundEnabled = enabled;
  localStorage.setItem("hapstore_sound_enabled", enabled ? "true" : "false");
  if (!enabled) {
    stopMusic();
  } else if (isMusicEnabled) {
    startMusic();
  }
  window.dispatchEvent(new Event("sound_settings_changed"));
}

export function getSoundVolume(): number {
  return soundVolume;
}

export function setSoundVolume(vol: number) {
  soundVolume = Math.max(0, Math.min(1, safeNum(vol, 0.7)));
  localStorage.setItem("hapstore_sound_volume", soundVolume.toString());
}

export function getMusicVolume(): number {
  return musicVolume;
}

export function setMusicVolume(vol: number) {
  musicVolume = Math.max(0, Math.min(1, safeNum(vol, 0.4)));
  localStorage.setItem("hapstore_music_volume", musicVolume.toString());
  if (themeAudio) themeAudio.volume = musicVolume;
}

export function getMusicEnabled(): boolean {
  return isMusicEnabled;
}

export function setMusicEnabled(enabled: boolean) {
  isMusicEnabled = enabled;
  localStorage.setItem("hapstore_music_enabled", enabled ? "true" : "false");
  if (enabled) {
    startMusic();
  } else {
    stopMusic();
  }
}

export function startMusic() {
  if (!isMusicEnabled || !isSoundEnabled) return;
  if (!themeAudio) {
    themeAudio = new Audio(THEME_SRC);
    themeAudio.loop = true;
  }
  themeAudio.volume = musicVolume;
  const play = () => themeAudio && themeAudio.play().catch(() => {});
  play();
}

export function stopMusic() {
  if (themeAudio) {
    themeAudio.pause();
  }
}

/** Play the soundtrack baked into a background video (login / rules). */
export function bindVideoSoundtrack(el: HTMLVideoElement | null): () => void {
  if (!el) return () => {};
  stopMusic();
  el.loop = true;
  el.playsInline = true;
  el.volume = musicVolume;
  el.muted = false;
  const tryLoud = () => el.play().catch(() => {});
  void tryLoud();
  const unlock = () => {
    el.muted = false;
    el.volume = musicVolume;
    void el.play().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("touchstart", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("touchstart", unlock);
    window.removeEventListener("keydown", unlock);
    el.pause();
  };
}

// Auto-initialize background loop on user actions
if (isMusicEnabled) {
  setTimeout(() => {
    startMusic();
  }, 500);
}

export function playSound(
  type:
    | "click"
    | "roll"
    | "success"
    | "error"
    | "laser"
    | "level_up"
    | "teleport"
    | "danger"
    | "bonus"
    | "win"
) {
  if (soundVolume <= 0 || !isSoundEnabled) return; // Muted

  try {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.HapticFeedback) {
      if (type === "click" || type === "laser") tg.HapticFeedback.impactOccurred("light");
      if (type === "roll") tg.HapticFeedback.impactOccurred("rigid");
      if (type === "success" || type === "level_up")
        tg.HapticFeedback.notificationOccurred("success");
      if (type === "error") tg.HapticFeedback.notificationOccurred("error");
    }

    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = safeNum(ctx.currentTime, 0);

    const mainGain = ctx.createGain();
    safeSetValue(mainGain.gain, soundVolume, now);
    mainGain.connect(ctx.destination);

    switch (type) {
      case "click": {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square"; // cyberpunk digital click
        safeSetValue(osc.frequency, 1200, now);
        safeExpRamp(osc.frequency, 300, now + 0.05);
        safeSetValue(gain.gain, 0.25, now);
        safeExpRamp(gain.gain, 0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(mainGain);
        osc.start(now);
        osc.stop(now + 0.05);
        break;
      }
      case "roll": {
        // Cool high-tech digital roulette rolling sound
        for (let i = 0; i < 16; i++) {
          const delay = Math.pow(i / 15, 2) * 0.8; // Exponential slowdown
          const t = now + delay;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          safeSetValue(osc.frequency, 600 + Math.random() * 400 - i * 20, t); // Decreasing pitch
          safeSetValue(gain.gain, 0.15, t);
          safeExpRamp(gain.gain, 0.001, t + 0.03);

          const filter = ctx.createBiquadFilter();
          filter.type = "bandpass";
          safeSetValue(filter.frequency, 1200, t);

          osc.connect(filter);
          filter.connect(gain);
          gain.connect(mainGain);
          osc.start(t);
          osc.stop(t + 0.03);
        }

        // Final "ping" when dice lands
        const tFinal = now + 0.9;
        const oscF = ctx.createOscillator();
        const gainF = ctx.createGain();
        oscF.type = "sine";
        safeSetValue(oscF.frequency, 1200, tFinal);
        safeExpRamp(oscF.frequency, 800, tFinal + 0.5);
        safeSetValue(gainF.gain, 0.4, tFinal);
        safeExpRamp(gainF.gain, 0.001, tFinal + 0.5);
        oscF.connect(gainF);
        gainF.connect(mainGain);
        oscF.start(tFinal);
        oscF.stop(tFinal + 0.5);

        break;
      }
      case "success": {
        // Cyberpunk synth chord
        const freqs = [440, 523.25, 659.25, 880]; // A4, C5, E5, A5
        freqs.forEach((f, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          safeSetValue(osc.frequency, f, now + idx * 0.08);
          safeExpRamp(osc.frequency, f * 0.98, now + idx * 0.08 + 0.3);
          safeSetValue(gain.gain, 0.25, now + idx * 0.08);
          safeExpRamp(gain.gain, 0.001, now + idx * 0.08 + 0.3);

          const filter = ctx.createBiquadFilter();
          filter.type = "lowpass";
          safeSetValue(filter.frequency, 2000, now);

          osc.connect(filter);
          filter.connect(gain);
          gain.connect(mainGain);
          osc.start(now + idx * 0.08);
          osc.stop(now + idx * 0.08 + 0.3);
        });
        break;
      }
      case "error": {
        // Glitching low buzz
        for (let i = 0; i < 3; i++) {
          const t = now + i * 0.1;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sawtooth";
          safeSetValue(osc.frequency, 100 + Math.random() * 50, t);
          safeLinearRamp(osc.frequency, 50, t + 0.08);
          safeSetValue(gain.gain, 0.3, t);
          safeExpRamp(gain.gain, 0.001, t + 0.08);
          osc.connect(gain);
          gain.connect(mainGain);
          osc.start(t);
          osc.stop(t + 0.08);
        }
        break;
      }
      case "laser": {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        safeSetValue(osc.frequency, 2000, now);
        safeExpRamp(osc.frequency, 200, now + 0.15);
        safeSetValue(gain.gain, 0.25, now);
        safeExpRamp(gain.gain, 0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(mainGain);
        osc.start(now);
        osc.stop(now + 0.15);
        break;
      }
      case "level_up": {
        // Arpeggiated tech synth
        const steps = [440, 554.37, 659.25, 880, 1108.73, 1318.51];
        steps.forEach((f, idx) => {
          const t = now + idx * 0.06;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          safeSetValue(osc.frequency, f, t);
          safeSetValue(gain.gain, 0.25, t);
          safeExpRamp(gain.gain, 0.001, t + 0.15);
          osc.connect(gain);
          gain.connect(mainGain);
          osc.start(t);
          osc.stop(t + 0.15);
        });
        break;
      }
      case "bonus": {
        // Cheerful major arpeggio
        const steps = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
        steps.forEach((f, idx) => {
          const t = now + idx * 0.08;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          safeSetValue(osc.frequency, f, t);
          safeSetValue(gain.gain, 0.3, t);
          safeExpRamp(gain.gain, 0.001, t + 0.2);
          osc.connect(gain);
          gain.connect(mainGain);
          osc.start(t);
          osc.stop(t + 0.2);
        });
        break;
      }
      case "danger": {
        // Deep menacing buzz
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        safeSetValue(osc.frequency, 80, now);
        safeLinearRamp(osc.frequency, 40, now + 0.4);
        safeSetValue(gain.gain, 0.35, now);
        safeExpRamp(gain.gain, 0.001, now + 0.4);
        osc.connect(gain);
        gain.connect(mainGain);
        osc.start(now);
        osc.stop(now + 0.4);
        break;
      }
      case "teleport": {
        // Fast upward sweep
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        safeSetValue(osc.frequency, 200, now);
        safeExpRamp(osc.frequency, 1200, now + 0.3);
        safeSetValue(gain.gain, 0.25, now);
        safeExpRamp(gain.gain, 0.001, now + 0.3);
        osc.connect(gain);
        gain.connect(mainGain);
        osc.start(now);
        osc.stop(now + 0.3);
        break;
      }
      case "win": {
        // Epic victory chord
        const freqs = [523.25, 659.25, 783.99, 1046.5, 1318.51];
        freqs.forEach((f) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          safeSetValue(osc.frequency, f, now);
          safeSetValue(gain.gain, 0.35, now);
          safeExpRamp(gain.gain, 0.001, now + 1.5);
          osc.connect(gain);
          gain.connect(mainGain);
          osc.start(now);
          osc.stop(now + 1.5);
        });
        break;
      }
    }
  } catch (e) {
    console.warn("Audio Context blocked or not supported:", e);
  }
}
