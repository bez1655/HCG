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

let synthInterval: any = null;
let currentSynthStep = 0;
let masterMusicGain: GainNode | null = null;

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
        if (isMusicEnabled && !synthInterval) {
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
  if (masterMusicGain && audioCtx) {
    try {
      safeSetValue(masterMusicGain.gain, musicVolume, audioCtx.currentTime);
    } catch {
      // Volume changes are best-effort while the context is suspended.
    }
  }
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

// Procedural Synthwave Bass & Beat Loop Generator
function playMusicStep() {
  try {
    const ctx = getAudioContext();
    if (!ctx || ctx.state === "suspended") return;
    const now = safeNum(ctx.currentTime, 0);

    const safeVol = Math.max(0, Math.min(1, safeNum(musicVolume, 0.4)));

    if (!masterMusicGain) {
      masterMusicGain = ctx.createGain();
      safeSetValue(masterMusicGain.gain, safeVol, now);
      masterMusicGain.connect(ctx.destination);
    } else {
      safeSetValue(masterMusicGain.gain, safeVol, now);
    }

    const step = currentSynthStep % 16;

    // Synth-wave Bass Pattern (A minor progression: A, F, C, G)
    let rootFreq = 55.0; // A1
    if (currentSynthStep >= 32 && currentSynthStep < 48) {
      rootFreq = 43.65; // F1
    } else if (currentSynthStep >= 48 && currentSynthStep < 64) {
      rootFreq = 65.41; // C2
    } else if (currentSynthStep >= 64 && currentSynthStep < 80) {
      rootFreq = 49.0; // G1
    }

    // Bass synth note on eighth notes (steps)
    if (step % 2 === 0) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";

      // Octave jump for retro arcade feel
      const octaveMultiplier = step % 4 === 0 ? 1 : 2;
      safeSetValue(osc.frequency, rootFreq * octaveMultiplier, now);

      // Decay envelope
      safeSetValue(gain.gain, 0.25, now);
      safeExpRamp(gain.gain, 0.001, now + 0.12);

      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      safeSetValue(filter.frequency, 400, now);
      safeExpRamp(filter.frequency, 120, now + 0.12);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(masterMusicGain);
      osc.start(now);
      osc.stop(now + 0.15);
    }

    // Minimal drum hit (hi-hat simulation on odd steps, snare on 4, 12)
    if (step === 4 || step === 12) {
      // Procedural Snare
      const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.1), ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseBuffer.length; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.value = 1000;

      const noiseGain = ctx.createGain();
      safeSetValue(noiseGain.gain, 0.15, now);
      safeExpRamp(noiseGain.gain, 0.001, now + 0.08);

      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterMusicGain);
      noise.start(now);
      noise.stop(now + 0.1);
    } else if (step % 4 === 2) {
      // Procedural Cyber Hi-Hat
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      safeSetValue(osc.frequency, 8000, now);
      safeSetValue(gain.gain, 0.08, now);
      safeExpRamp(gain.gain, 0.001, now + 0.03);

      osc.connect(gain);
      gain.connect(masterMusicGain);
      osc.start(now);
      osc.stop(now + 0.04);
    }

    // Lead retro arpeggio overlay on specific step ranges
    const leadPattern = [0, 4, 7, 12, 7, 4];
    if (currentSynthStep % 32 >= 16 && step % 3 === 0) {
      const notes = [110, 130.81, 164.81, 220, 261.63, 329.63]; // Amin arpeggio freqs
      const noteFreq = notes[leadPattern[step % 6]] || 220;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      safeSetValue(osc.frequency, noteFreq * 2, now);

      safeSetValue(gain.gain, 0.18, now);
      safeExpRamp(gain.gain, 0.001, now + 0.2);

      const delay = ctx.createDelay();
      delay.delayTime.value = 0.1;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.3;

      osc.connect(gain);
      gain.connect(masterMusicGain);

      // Delay effect for ambient retro look
      gain.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(masterMusicGain);

      osc.start(now);
      osc.stop(now + 0.25);
    }

    currentSynthStep = (currentSynthStep + 1) % 96;
  } catch (e) {
    console.warn("Synth loop error:", e);
  }
}

export function startMusic() {
  if (synthInterval) clearInterval(synthInterval);
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  synthInterval = setInterval(playMusicStep, 150); // 120 BPM sixteenth steps (150ms)
}

export function stopMusic() {
  if (synthInterval) {
    clearInterval(synthInterval);
    synthInterval = null;
  }
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
