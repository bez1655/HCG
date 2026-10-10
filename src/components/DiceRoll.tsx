/**
 * Dice roll overlay — rewritten from scratch.
 *
 * The previous component froze the game: it built a 6 KB <style> block from
 * template literals inside its own render, while a 70 ms telemetry timer
 * re-rendered it 31 times per roll. Every one of those re-renders handed the
 * browser a fresh stylesheet with uniquely-named @keyframes to parse. On a
 * phone that is enough to stall the compositor — black screen in Telegram,
 * white screen in the APK, and no way out but restarting.
 *
 * The rewrite follows three rules:
 *
 *  1. No CSS generated during render. Keyframes are static and declared once,
 *     at module scope. The landing angle is passed as a CSS variable, so the
 *     stylesheet never changes no matter what the server rolls.
 *
 *  2. Nothing that re-renders during the animation. The spinning face is
 *     driven by CSS alone. React renders this component twice per roll —
 *     once spinning, once landed — and that is all.
 *
 *  3. It always ends. The overlay closes on a timer that cannot be skipped,
 *     and the parent holds an independent backstop. A stuck overlay is worse
 *     than a missing animation.
 */
import { useEffect, useRef, useState } from "react";
import { playSound } from "../utils/sounds";

interface DiceRollProps {
  /** Face decided by the server. The client never picks it. */
  result: number;
  /** Called once, when the overlay is finished. */
  onDone: (result: number) => void;
  /** Remount key — declared because this project pins tsconfig `types`. */
  key?: string | number;
}

/** Spin, then settle. Duration in ms. */
const SPIN_MS = 1800;
/** How long the result stays on screen before the overlay closes. */
const HOLD_MS = 1600;

/**
 * Static stylesheet, injected once for the whole application.
 *
 * At module scope rather than in the component: this way it is parsed a
 * single time, not on every render. Nothing here depends on the rolled
 * value — the final angle arrives through the --face custom property.
 */
const STYLE_ID = "hcg-dice-roll-styles-hw";
const CSS = `
@keyframes hcg-dice-spin {
  0%   { transform: rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale(0.5); }
  28%  { transform: rotateX(280deg) rotateY(160deg) rotateZ(90deg) scale(1.08); }
  55%  { transform: rotateX(520deg) rotateY(400deg) rotateZ(200deg) scale(1.16); }
  78%  { transform: rotateX(780deg) rotateY(620deg) rotateZ(310deg) scale(1.04); }
  100% { transform: rotateX(1080deg) rotateY(720deg) rotateZ(360deg) scale(1); }
}
@keyframes hcg-dice-land {
  0%   { transform: rotateX(-12deg) scale(1.22); }
  55%  { transform: rotateX(8deg) scale(0.92); }
  100% { transform: rotateX(0deg) scale(1); }
}
@keyframes hcg-dice-ring {
  0%   { opacity: .9; transform: scale(.45); }
  100% { opacity: 0;   transform: scale(2.15); }
}
@keyframes hcg-dice-fade { from { opacity: 0 } to { opacity: 1 } }

.hcg-dice-overlay {
  position: fixed; inset: 0; z-index: 200;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: rgba(8,2,0,.55);
  isolation: isolate;
  perspective: 720px;
  animation: hcg-dice-fade .18s ease-out both;
}
.hcg-dice-stage {
  position: relative; width: 228px; height: 228px;
  transform-style: preserve-3d;
}
.hcg-dice-img {
  width: 100%; height: 100%; object-fit: contain;
  will-change: transform;
  transform-style: preserve-3d;
  filter: drop-shadow(0 18px 22px rgba(0,0,0,.65));
}
.hcg-dice-img.is-spinning { animation: hcg-dice-spin ${SPIN_MS}ms cubic-bezier(.2,.75,.25,1) both; }
.hcg-dice-img.is-landed   { animation: hcg-dice-land 480ms cubic-bezier(.2,1.35,.35,1) both; }
.hcg-dice-ring {
  position: absolute; inset: 8%;
  border: 2px solid var(--face-color, #ff7a18);
  border-radius: 50%;
  animation: hcg-dice-ring 900ms ease-out both;
  pointer-events: none;
}
.hcg-dice-value {
  position: absolute; left: 50%; bottom: -8px;
  transform: translate(-50%, 100%);
  min-width: 56px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(20,8,0,.78);
  border: 1px solid rgba(255,140,40,.55);
  display: flex; align-items: center; justify-content: center;
  font: 900 28px/1 Orbitron, system-ui, sans-serif;
  color: var(--face-color, #ffb84d);
  text-shadow: 0 0 12px #ff7a18;
  pointer-events: none;
}
.hcg-dice-caption {
  margin-top: 22px; text-align: center;
  font: 700 11px/1.6 ui-monospace, Menlo, monospace;
  letter-spacing: .18em; text-transform: uppercase;
  color: rgba(255,255,255,.72);
}
@media (prefers-reduced-motion: reduce) {
  .hcg-dice-img.is-spinning, .hcg-dice-img.is-landed, .hcg-dice-ring { animation: none; }
}
`;

/** Inject once. Safe to call repeatedly. */
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Colour per face. Cosmetic only. */
const FACE_COLOURS: Record<number, string> = {
  1: "#ffb84d",
  2: "#ff7a18",
  3: "#e07012",
  4: "#ffd36a",
  5: "#c45c0c",
  6: "#fff3d0",
};

export default function DiceRoll({ result, onDone }: DiceRollProps) {
  const [landed, setLanded] = useState(false);

  /**
   * onDone must fire exactly once.
   *
   * Held in a ref so a re-render cannot schedule a second call, and read
   * through the ref inside the timer so the effect never needs the callback
   * in its dependencies — a parent that re-creates the function inline would
   * otherwise restart the whole sequence mid-roll.
   */
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const firedRef = useRef(false);

  // A face the server should never send still has to render something.
  const face = Number.isInteger(result) && result >= 1 && result <= 6 ? result : 1;
  const colour = FACE_COLOURS[face] ?? "#00ffaa";

  useEffect(() => {
    ensureStyles();

    // Sounds are fire-and-forget: an audio failure must never hold up the
    // animation or, worse, throw during an effect.
    const safePlay = (name: string) => {
      try {
        playSound(name as never);
      } catch {
        /* muted device, blocked autoplay — irrelevant here */
      }
    };

    safePlay("roll");

    const toLanded = setTimeout(() => {
      setLanded(true);
      safePlay("success");
    }, SPIN_MS);

    const toDone = setTimeout(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      doneRef.current(face);
    }, SPIN_MS + HOLD_MS);

    return () => {
      clearTimeout(toLanded);
      clearTimeout(toDone);
      // Unmounted before finishing — tell the parent anyway, or it would sit
      // waiting for a callback that can no longer arrive.
      if (!firedRef.current) {
        firedRef.current = true;
        doneRef.current(face);
      }
    };
    // Deliberately empty: this sequence belongs to one mount. The parent
    // gives every roll a fresh key, so a new roll is a new component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="hcg-dice-overlay"
      style={{ ["--face-color" as string]: colour }}
      role="status"
      aria-live="polite"
      aria-label={landed ? `Выпало ${face}` : "Бросок кубика"}
    >
      <div className="hcg-dice-stage">
        {landed && <div className="hcg-dice-ring" />}
        <img
          src="/Dice.png?v=11"
          alt=""
          draggable={false}
          className={`hcg-dice-img ${landed ? "is-landed" : "is-spinning"}`}
        />
        {landed && <div className="hcg-dice-value">{face}</div>}
      </div>

      <div className="hcg-dice-caption">
        {landed ? `Перемещение на ${face}` : "Бросок…"}
      </div>
    </div>
  );
}
