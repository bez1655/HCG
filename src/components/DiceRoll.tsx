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
const STYLE_ID = "hcg-dice-roll-styles";
const CSS = `
@keyframes hcg-dice-spin {
  0%   { transform: rotate(0deg)   scale(0.55); }
  55%  { transform: rotate(620deg) scale(1.12); }
  100% { transform: rotate(1080deg) scale(1); }
}
@keyframes hcg-dice-land {
  0%   { transform: scale(1.18); }
  60%  { transform: scale(0.94); }
  100% { transform: scale(1); }
}
@keyframes hcg-dice-ring {
  0%   { opacity: .85; transform: scale(.5); }
  100% { opacity: 0;   transform: scale(2.1); }
}
@keyframes hcg-dice-fade { from { opacity: 0 } to { opacity: 1 } }

.hcg-dice-overlay {
  position: fixed; inset: 0; z-index: 200;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: rgba(0,0,0,.42);
  isolation: isolate;
  animation: hcg-dice-fade .18s ease-out both;
  /* The board keeps painting underneath; no backdrop-filter, which is what
     made the compositor give up last time. */
}
.hcg-dice-stage { position: relative; width: 208px; height: 208px; }
.hcg-dice-img {
  width: 100%; height: 100%; object-fit: contain;
  will-change: transform;
}
.hcg-dice-img.is-spinning { animation: hcg-dice-spin ${SPIN_MS}ms cubic-bezier(.25,.9,.3,1) both; }
.hcg-dice-img.is-landed   { animation: hcg-dice-land 420ms cubic-bezier(.2,1.4,.4,1) both; }
.hcg-dice-ring {
  position: absolute; inset: 12%;
  border: 2px solid var(--face-color, #00ffaa);
  border-radius: 50%;
  animation: hcg-dice-ring 900ms ease-out both;
  pointer-events: none;
}
.hcg-dice-value {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font: 900 92px/1 Orbitron, system-ui, sans-serif;
  color: var(--face-color, #00ffaa);
  text-shadow: 0 0 18px var(--face-color, #00ffaa), 0 0 46px var(--face-color, #00ffaa);
  -webkit-text-stroke: 1px rgba(255,255,255,.85);
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
  1: "#00ffaa",
  2: "#4da3ff",
  3: "#c77dff",
  4: "#ffb84d",
  5: "#ff6b9d",
  6: "#ffffff",
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
          src="/Dice.png?v=6"
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
