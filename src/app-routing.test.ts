import { describe, it, expect } from "vitest";

/**
 * Mirrors the render decision made in App.tsx.
 *
 * A regression introduced during the audit made these two rules interact
 * badly: the socket only connects when a session token exists, and the app
 * showed a loading screen until the first state broadcast arrived. Together
 * they left a first-time visitor — who has no token yet — stuck on the
 * loading screen with no way to reach the login form.
 */
type Render = "LoginScreen" | "LoadingScreen" | "Board";

interface Session {
  token: string | null;
  cachedId: string | null;
  /** Server state, delivered only once the socket is connected. */
  gameState: object | null;
}

export function decideRender(s: Session): { render: Render; cleared: boolean } {
  // loadFromLocal(): a stored session with no token predates token auth and
  // can never connect, so it is discarded rather than restored.
  if (s.cachedId && !s.token) {
    return { render: "LoginScreen", cleared: true };
  }

  const screen = s.cachedId && s.token ? "board" : "login";

  // The socket is only created when a token is present.
  const state = s.token ? s.gameState : null;

  if (!state && screen === "login") return { render: "LoginScreen", cleared: false };
  if (!state) return { render: "LoadingScreen", cleared: false };
  return { render: "Board", cleared: false };
}

describe("App render decision", () => {
  it("shows the login form to a first-time visitor", () => {
    expect(decideRender({ token: null, cachedId: null, gameState: null }).render).toBe(
      "LoginScreen"
    );
  });

  it("discards a pre-token session instead of hanging on the loader", () => {
    const r = decideRender({ token: null, cachedId: "p_1", gameState: null });
    expect(r.render).toBe("LoginScreen");
    expect(r.cleared).toBe(true);
  });

  it("shows the loader only while a signed-in client awaits state", () => {
    expect(decideRender({ token: "t", cachedId: "p_1", gameState: null }).render).toBe(
      "LoadingScreen"
    );
  });

  it("shows the board once state arrives", () => {
    expect(decideRender({ token: "t", cachedId: "p_1", gameState: {} }).render).toBe("Board");
  });

  it("never shows the loader without a token", () => {
    for (const cachedId of [null, "p_1"]) {
      for (const gameState of [null, {}]) {
        const r = decideRender({ token: null, cachedId, gameState });
        expect(r.render).not.toBe("LoadingScreen");
      }
    }
  });
});

/**
 * Telegram-specific session restore.
 *
 * Inside Telegram the app reads its session from CloudStorage, not
 * localStorage. That branch requested every field except the session token,
 * so a returning player was restored onto the board while the socket had no
 * token to connect with — the endless loading screen reported from the field.
 */
interface CloudRestore {
  /** Values returned by CloudStorage.getItems, or null when it failed. */
  values: Record<string, string> | null;
  /** CloudStorage never called back (observed in some Telegram clients). */
  timedOut?: boolean;
}

export function restoreFromCloud(r: CloudRestore): "restored" | "fallback-to-local" {
  if (r.timedOut) return "fallback-to-local";
  const id = r.values?.["hapstore_userId"];
  const token = r.values?.["hapstore_token"];
  // Both are required: without the token the socket can never connect.
  if (!id || !token) return "fallback-to-local";
  return "restored";
}

describe("Telegram CloudStorage restore", () => {
  it("restores a session that has both id and token", () => {
    expect(restoreFromCloud({ values: { hapstore_userId: "p_1", hapstore_token: "t" } })).toBe(
      "restored"
    );
  });

  it("refuses a session whose token is missing", () => {
    expect(restoreFromCloud({ values: { hapstore_userId: "p_1" } })).toBe("fallback-to-local");
  });

  it("falls back when CloudStorage never answers", () => {
    expect(restoreFromCloud({ values: null, timedOut: true })).toBe("fallback-to-local");
  });

  it("falls back when CloudStorage returns nothing", () => {
    expect(restoreFromCloud({ values: {} })).toBe("fallback-to-local");
  });

  it("never restores a session that cannot open a socket", () => {
    const broken = [
      { values: { hapstore_userId: "p_1" } },
      { values: { hapstore_token: "t" } },
      { values: {} },
      { values: null },
    ];
    for (const c of broken) {
      expect(restoreFromCloud(c)).toBe("fallback-to-local");
    }
  });
});
