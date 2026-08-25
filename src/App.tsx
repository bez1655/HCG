import React, { useState, useEffect } from "react";
import { io, Socket } from "socket.io-client";
import { GameState } from "./types";
import { playSound } from "./utils/sounds";
import { setLocale, detectLocale } from "./i18n";
import { apiFetch, socketUrl, TELEGRAM_LOGIN_ENABLED } from "./config/api";
import LoginScreen from "./components/LoginScreen";
import RulesScreen from "./components/RulesScreen";
import BoardView from "./components/BoardView";
import AdminConsole from "./components/AdminConsole";
import PopupCard from "./components/PopupCard";
import TurnOutcomeCard, { TurnOutcome } from "./components/TurnOutcomeCard";
import ToastManager from "./components/ToastManager";
import CrashGuard from "./components/CrashGuard";

/**
 * Persist a session to localStorage and, where available, Telegram
 * CloudStorage.
 *
 * Defined once at module scope because two entry points now create sessions —
 * the password form and the Telegram handshake — and having each keep its own
 * copy of the key list is how the token came to be written but never read
 * back, which stranded the app on the loading screen.
 */
function persistSession(
  id: string,
  name: string,
  role: "admin" | "player",
  color: string,
  token: string | undefined,
  screen: string
) {
  if (token) localStorage.setItem("hapstore_token", token);
  localStorage.setItem("hapstore_userId", id);
  localStorage.setItem("hapstore_userName", name);
  localStorage.setItem("hapstore_userRole", role);
  localStorage.setItem("hapstore_userColor", color);
  localStorage.setItem("hapstore_screen", screen);
  // Remove any password persisted by an earlier version of the app.
  localStorage.removeItem("hapstore_adminPassword");

  const tg = (window as any).Telegram?.WebApp;
  try {
    if (tg?.CloudStorage && tg.isVersionAtLeast?.("6.9")) {
      tg.CloudStorage.setItem("hapstore_userId", id);
      tg.CloudStorage.setItem("hapstore_userName", name);
      tg.CloudStorage.setItem("hapstore_userRole", role);
      tg.CloudStorage.setItem("hapstore_userColor", color);
      tg.CloudStorage.setItem("hapstore_screen", screen);
      if (token) tg.CloudStorage.setItem("hapstore_token", token);
      tg.CloudStorage.removeItem?.("hapstore_adminPassword");
    }
  } catch (e) {
    console.warn("CloudStorage not supported", e);
  }
}

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [screen, setScreen] = useState<"login" | "rules" | "board" | "admin">("login");
  const [activePopup, setActivePopup] = useState<{
    title: string;
    description: string;
    playerName: string;
    type: string;
  } | null>(null);
  /*
   * Результат последнего броска — свой, не чужой.
   *
   * Показывается после КАЖДОГО хода. Отдельно от activePopup: тот описывает
   * событие клетки и существует только для особых клеток, а этот отвечает на
   * вопрос «что мне выпало», который возникает у игрока всегда.
   */
  const [turnOutcome, setTurnOutcome] = useState<TurnOutcome | null>(null);
  // Dice value decided by the server for this client (drives the 3D animation).
  const [pendingRoll, setPendingRoll] = useState<number | null>(null);
  // Последняя ошибка от сервера. Показывается плашкой поверх игры вместо
  // alert(), который в Telegram блокирует всё приложение.
  const [serverError, setServerError] = useState<string | null>(null);

  // Auth details
  const [userId, setUserId] = useState<string | null>(null);
  const [_userName, setUserName] = useState<string>("");
  const [userRole, setUserRole] = useState<"admin" | "player">("player");
  const [_userColor, setUserColor] = useState<string>("#39FF14");
  // Explanation shown on the login form after a failed Telegram sign-in
  // (most often: the account is not registered yet).
  const [loginNotice, setLoginNotice] = useState<string>("");

  // Restore session from LocalStorage
  useEffect(() => {
    // Pick the UI language from Telegram or the browser before first paint.
    setLocale(detectLocale());

    // Telegram Mini App initialization
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      tg.disableVerticalSwipes?.();
      tg.setHeaderColor?.("#060412");
      tg.setBackgroundColor?.("#060412");
    }

    // -----------------------------------------------------------------------
    // Password-free entry inside Telegram.
    //
    // `initData` is signed by Telegram with the bot token, so the server can
    // verify who the visitor is without any credential typed here. A player
    // who was approved by an administrator therefore never sees the password
    // field again — pressing "ИГРАТЬ" is enough.
    //
    // This runs before the cached-session logic and takes priority over it:
    // it is authoritative and repairs a stale or expired stored token.
    // Every failure path falls back to the old behaviour, because being
    // dropped on the loading screen is the worst possible outcome.
    // -----------------------------------------------------------------------
    // The standalone app is launched from the home screen, never from
    // Telegram, so there is no signed initData to verify.
    const initData: string | undefined = TELEGRAM_LOGIN_ENABLED ? tg?.initData : undefined;
    if (initData && initData.length > 0) {
      void signInWithTelegram(initData);
      return;
    }

    restoreCachedSession();

    async function signInWithTelegram(payload: string) {
      // The request must not be able to hang: an unreachable server would
      // otherwise leave the app on the spinner indefinitely.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);

      try {
        const res = await apiFetch("/api/telegram/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData: payload }),
          signal: abort.signal,
        });
        clearTimeout(timer);

        const data = await res.json().catch(() => ({}));

        if (res.ok && data?.token && data?.id) {
          persistSession(data.id, data.name, data.role, data.color, data.token, "rules");
          setUserId(data.id);
          setUserName(data.name);
          setUserRole(data.role === "admin" ? "admin" : "player");
          setUserColor(data.color || "#39FF14");
          setScreen("rules");
          return;
        }

        // Known Telegram user, but no player record yet: send them to the
        // form, where the registration request button lives.
        if (data?.needsRegistration) {
          localStorage.clear();
          setLoginNotice(
            "Вы ещё не зарегистрированы. Отправьте боту команду /register — администратор подтвердит заявку."
          );
          setScreen("login");
          return;
        }

        // Anything else (bad signature, misconfigured server): fall back to a
        // stored session if there is one, otherwise the login form.
        restoreCachedSession();
      } catch {
        clearTimeout(timer);
        restoreCachedSession();
      }
    }

    function restoreCachedSession() {
      if (tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9")) {
        // CloudStorage is asynchronous and, inside Telegram, occasionally never
        // invokes its callback at all. Without a deadline the app would sit on
        // the loading screen forever, so fall back to localStorage after 3s.
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        const timeout = setTimeout(() => {
          finish(() => {
            console.warn("[Session] CloudStorage timed out; using localStorage.");
            loadFromLocal();
          });
        }, 3000);

        try {
          tg.CloudStorage.getItems(
            [
              "hapstore_userId",
              "hapstore_userName",
              "hapstore_userRole",
              "hapstore_userColor",
              "hapstore_screen",
              // Must be requested too: the socket cannot connect without it.
              // Restoring a session while leaving the token behind produced an
              // endless loading screen inside Telegram.
              "hapstore_token",
            ],
            (err: any, values: any) => {
              clearTimeout(timeout);
              finish(() => {
                const id = values?.["hapstore_userId"];
                const token = values?.["hapstore_token"];

                // A session without its token can never open a socket.
                if (err || !id || !token) {
                  loadFromLocal();
                  return;
                }

                // Mirror into localStorage: the socket effect reads it from there.
                localStorage.setItem("hapstore_token", token);
                localStorage.setItem("hapstore_userId", id);

                setUserId(id);
                setUserName(values["hapstore_userName"] || "");
                setUserRole((values["hapstore_userRole"] as "admin" | "player") || "player");
                setUserColor(values["hapstore_userColor"] || "#39FF14");
                setScreen((values["hapstore_screen"] as any) || "board");
              });
            }
          );
        } catch (e) {
          clearTimeout(timeout);
          finish(loadFromLocal);
        }
      } else {
        loadFromLocal();
      }

      function loadFromLocal() {
        const cachedId = localStorage.getItem("hapstore_userId");
        const cachedName = localStorage.getItem("hapstore_userName");
        const cachedRole = localStorage.getItem("hapstore_userRole");
        const cachedColor = localStorage.getItem("hapstore_userColor");
        const cachedScreen = localStorage.getItem("hapstore_screen");
        const cachedToken = localStorage.getItem("hapstore_token");

        // Sessions saved before token authentication existed have an id but no
        // token. Restoring one would land the user on the board with a socket
        // that can never connect — an endless loading screen. Send them to the
        // login form instead.
        if (cachedId && !cachedToken) {
          localStorage.clear();
          setScreen("login");
          return;
        }

        if (cachedId && cachedName) {
          setUserId(cachedId);
          setUserName(cachedName);
          setUserRole((cachedRole as "admin" | "player") || "player");
          setUserColor(cachedColor || "#39FF14");

          if (cachedScreen) {
            setScreen(cachedScreen as any);
          } else {
            setScreen("board");
          }
        }
      }
    }
  }, []);

  // Initialize Socket.io Connection
  useEffect(() => {
    // The socket is authenticated with the signed session token issued by
    // /api/login. Without a token the server rejects the handshake.
    const token = localStorage.getItem("hapstore_token");
    if (!token) return;

    // socketUrl() is undefined in the browser build (same origin) and the
    // absolute server origin in the standalone app, which has no server of
    // its own to connect back to.
    const newSocket = io(socketUrl(), {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      auth: { token },
    });

    setSocket(newSocket);

    const applyState = (updatedState: GameState | null | undefined) => {
      if (!updatedState || typeof updatedState !== "object") return;
      const safe: GameState = {
        ...updatedState,
        players: Array.isArray(updatedState.players) ? updatedState.players : [],
        cells: Array.isArray(updatedState.cells) ? updatedState.cells : [],
        logs: Array.isArray(updatedState.logs) ? updatedState.logs : [],
        chatMessages: Array.isArray(updatedState.chatMessages) ? updatedState.chatMessages : [],
      };
      setGameState((prev) => {
        const incoming = safe.revision ?? 0;
        const have = prev?.revision ?? 0;
        if (prev && incoming > 0 && incoming < have) return prev;
        return safe;
      });
    };

    // Full snapshot: sent once on connect, and after bulk operations.
    newSocket.on("state:update", (updatedState: GameState) => {
      clearTimeout(stateDeadline);
      applyState(updatedState);
    });

    // Incremental update: only the slices that actually changed. Merged into
    // the current state so a routine roll transfers ~1.4 KB instead of ~68 KB.
    newSocket.on("state:patch", (patch: Partial<GameState>) => {
      setGameState((prev) => {
        if (!prev) {
          // Patch arrived before the first snapshot — ask again, do not drop
          // the session. Applying a partial patch as the whole state blanks
          // the board (no cells).
          if (newSocket.connected) newSocket.emit("client:resync");
          return prev;
        }
        const incoming = patch.revision ?? 0;
        const have = prev.revision ?? 0;
        if (incoming > 0 && incoming < have) return prev;
        return { ...prev, ...patch };
      });
    });

    const askResync = () => {
      if (document.visibilityState === "hidden") return;
      if (newSocket.connected) newSocket.emit("client:resync");
    };
    document.addEventListener("visibilitychange", askResync);
    window.addEventListener("focus", askResync);

    // Authoritative dice result from the server.
    newSocket.on("roll:result", (data: { steps: number }) => {
      if (typeof data?.steps === "number") setPendingRoll(data.steps);
    });

    /*
     * Результат хода — приходит после КАЖДОГО броска, включая обычные клетки.
     *
     * Сервер шлёт его адресно, в персональную комнату игрока, поэтому чужих
     * результатов здесь быть не может и фильтровать нечего.
     *
     * Показываем с задержкой: событие приходит мгновенно, а кубик на экране
     * ещё крутится. Без паузы карточка накрыла бы анимацию, ради которой
     * бросок и выглядит броском.
     */
    newSocket.on("turn:outcome", (data: TurnOutcome) => {
      if (!data || typeof data.title !== "string") return;
      window.setTimeout(() => {
        setTurnOutcome(data);
        playSound(data.tone === "bad" ? "error" : "level_up");
      }, 1400);
    });

    // Last-resort deadline. Do NOT wipe the session: Telegram Mini App would
    // bounce back to the login form after a slow WebView, which looks like a
    // crash. Pull a public snapshot over HTTP instead.
    const stateDeadline = setTimeout(() => {
      setGameState((current) => {
        if (current) return current;
        console.warn("[Session] No socket state after 8s; HTTP fallback.");
        void apiFetch("/api/state")
          .then((r) => r.json())
          .then((data) => applyState(data as GameState))
          .catch(() => undefined);
        return current;
      });
    }, 8000);

    newSocket.on("connect_error", (err: Error) => {
      if (err?.message === "UNAUTHORIZED") {
        clearTimeout(stateDeadline);
        localStorage.removeItem("hapstore_token");
        setLoginNotice("Сессия истекла. Нажмите «ИГРАТЬ» в боте ещё раз.");
        setUserId(null);
        setUserName("");
        setUserRole("player");
        setScreen("login");
      }
    });

    newSocket.on("event:trigger", (popupData: any) => {
      const currentUserId = localStorage.getItem("hapstore_userId");
      if (popupData.playerId && currentUserId && popupData.playerId !== currentUserId) {
        return; // Filter out popups meant for other players
      }
      setActivePopup(popupData);
      playSound("level_up");
      const tg = (window as any).Telegram?.WebApp;
      if (tg && tg.HapticFeedback) {
        tg.HapticFeedback.notificationOccurred("warning");
      }
    });
    newSocket.on("error", (msg: string) => {
      /*
       * Никакого alert().
       *
       * В webview Telegram модальное окно блокирует поток отрисовки: экран
       * замирает, а если диалог не отрисовался поверх Mini App — закрыть его
       * нечем, и приложение выглядит намертво зависшим. Показываем ошибку
       * средствами самой игры.
       *
       * И обязательно снимаем ожидание броска: отказ сервера означает, что
       * roll:result не придёт никогда, а без сброса оверлей висел бы до
       * перезапуска.
       */
      console.error("[HCG] Ошибка сервера:", msg);
      setPendingRoll(null);
      setServerError(msg);
      playSound("error");
    });

    return () => {
      clearTimeout(stateDeadline);
      newSocket.disconnect();
    };
    // Re-create the connection once the user logs in (a token becomes available).
  }, [userId]);

  // Synchronize player/admin connection with socket reactively
  useEffect(() => {
    if (!socket) return;

    const syncOnline = () => {
      if (userId) {
        // Identity comes from the session token supplied during the handshake,
        // so no id or password needs to be sent here any more.
        socket.emit("player:online");
        if (userRole === "admin") {
          socket.emit("auth:admin");
        }
      }
    };

    if (socket.connected) {
      syncOnline();
    }

    socket.on("connect", syncOnline);

    return () => {
      socket.off("connect", syncOnline);
    };
  }, [socket, userId, userRole]);

  const handleLogin = (
    name: string,
    role: "admin" | "player",
    color: string,
    token?: string,
    forceId?: string
  ) => {
    // The server is authoritative for the id; it always returns one on success.
    const id = forceId || (role === "admin" ? "admin_user" : "p_" + Date.now());

    setUserId(id);
    setUserName(name);
    setUserRole(role);
    setUserColor(color);

    // Stores the short-lived session token instead of the admin password.
    persistSession(id, name, role, color, token, "rules");

    // Take user to Rules Screen on first visit
    setScreen("rules");
  };

  const handleProceedFromRules = () => {
    setScreen("board");
    localStorage.setItem("hapstore_screen", "board");
  };

  const visibleScreen =
    screen === "admin" && userRole !== "admin" ? "board" : screen;

  // The server picks the dice value and replies with "roll:result".
  const handleRoll = () => {
    if (socket && userId) {
      socket.emit("roll:request");
    }
  };

  const handleSendMessage = (text: string) => {
    if (socket && userId) {
      // Sender identity is resolved server-side from the session token.
      socket.emit("chat:send", { text });
    }
  };

  const handleLogout = () => {
    localStorage.clear();
    setUserId(null);
    setUserName("");
    setUserRole("player");
    setScreen("login");
    playSound("click");
  };

  // Admin Socket operations
  const handleUpdatePlayer = (player: {
    id: string;
    cell: number;
    color: string;
    name: string;
  }) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:update_player", player);
    }
  };

  const handleRegisterPlayer = (reg: { name: string; color: string; password?: string }) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:register_player", reg);
    }
  };

  const handleDeletePlayer = (pId: string) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:delete_player", pId);
    }
  };

  const handleResetGame = (options: { clearPlayers: boolean }) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:reset_game", options);
    }
  };

  const handleCalibrateCell = (cal: { cellId: number; x: number; y: number }) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:calibrate_cell", cal);
    }
  };

  const handleSetBoardImage = (image: string | null) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:set_board_image", image);
    }
  };

  const handleSetLoginBackground = (image: string | null) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:set_login_background", image);
    }
  };

  const handleSetRulesBackground = (image: string | null) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:set_rules_background", image);
    }
  };

  const handleSetTokenTimeout = (hours: number) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:set_token_timeout", hours);
    }
  };

  const handleToggleCalibration = (mode: boolean) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:toggle_calibration", mode);
    }
  };

  const handleSelectCalibrationCell = (cellId: number | null) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:select_calibration_cell", cellId);
    }
  };

  // turns: how many rolls the player needs at once (several purchases).
  const handleSendTurnRequest = (turns?: number) => {
    if (socket && userId) {
      socket.emit("player:request_turn", turns ?? 1);
    }
  };

  const _handleConfirmTurn = (confirmBonus?: boolean) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:confirm_turn", confirmBonus);
    }
  };

  const handleApprovePlayerTurn = (pId: string, confirmBonus?: boolean, turns?: number) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:approve_player_turn", pId, confirmBonus, turns);
    }
  };

  const handleConsumeBonus = (pId: string) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:consume_bonus", pId);
    }
  };

  const handleRejectPlayerTurn = (pId: string) => {
    if (socket && userRole === "admin") {
      socket.emit("admin:reject_player_turn", pId);
    }
  };

  const handleRestartLap = (pId: string) => {
    if (socket) {
      socket.emit("player:restart_lap", pId);
    }
  };

  // Not signed in yet: show the login form immediately.
  //
  // The socket only connects once a session token exists, so gameState stays
  // null until after login. Waiting for it here left a first-time visitor
  // stuck on the loading screen forever, with no way to reach the form.
  if (!gameState && screen === "login") {
    return <LoginScreen backgroundUrl={null} onLogin={handleLogin} notice={loginNotice} />;
  }

  // Signed in, but the first state broadcast has not arrived yet.
  if (!gameState) {
    return (
      <div className="min-h-screen bg-[#060412] text-white flex flex-col items-center justify-center p-4 font-sans">
        <div className="relative w-24 h-24 flex items-center justify-center">
          <div className="absolute inset-0 border-4 border-t-[#00FFFF] border-r-[#FF00FF] border-b-transparent border-l-transparent rounded-full animate-spin"></div>
          <div className="text-[10px] font-mono tracking-widest text-[#00FFFF] uppercase animate-pulse">
            CONNECT
          </div>
        </div>
        <p className="text-sm font-mono text-gray-500 mt-6 uppercase tracking-widest">
          Инициализация защищенного шлюза Hapstore...
        </p>
        <button
          onClick={() => {
            // A stale or rejected token would otherwise spin here forever.
            localStorage.clear();
            window.location.reload();
          }}
          className="mt-8 text-[11px] font-mono text-gray-600 hover:text-[#00FFFF] underline underline-offset-4"
        >
          Долго грузится? Войти заново
        </button>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full bg-[#060412] text-white overflow-hidden">
      <ToastManager socket={socket} />

      {serverError && (
        <div
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[300] max-w-[92vw] px-4 py-3
                     rounded-xl border border-red-500/50 bg-[#2a0b14]/95 text-red-100
                     font-mono text-[12px] leading-snug shadow-lg cursor-pointer"
          onClick={() => setServerError(null)}
          role="alert"
        >
          {serverError}
          <div className="mt-1 text-[10px] text-red-300/70">нажмите, чтобы закрыть</div>
        </div>
      )}
      <PopupCard
        popup={activePopup}
        onClose={() => setActivePopup(null)}
        onRestartLap={handleRestartLap}
        userId={userId}
      />

      {/* Результат хода — поверх всего, после каждого броска */}
      <TurnOutcomeCard outcome={turnOutcome} onClose={() => setTurnOutcome(null)} />

      {visibleScreen === "login" && (
        <LoginScreen
          backgroundUrl={gameState.loginBackground}
          onLogin={handleLogin}
          notice={loginNotice}
        />
      )}
      {visibleScreen === "rules" && (
        <RulesScreen backgroundUrl={gameState.rulesBackground} onProceed={handleProceedFromRules} />
      )}
      {visibleScreen === "board" && (
        <CrashGuard area="board">
          <BoardView
            gameState={gameState}
            onRoll={handleRoll}
            pendingRoll={pendingRoll}
            onRollAnimationDone={() => setPendingRoll(null)}
            onCalibrateCell={handleCalibrateCell}
            onSelectCalibrationCell={handleSelectCalibrationCell}
            onSendMessage={handleSendMessage}
            onLogout={handleLogout}
            openAdminPanel={() => {
              setScreen("admin");
              localStorage.setItem("hapstore_screen", "admin");
            }}
            openRules={() => {
              setScreen("rules");
              localStorage.setItem("hapstore_screen", "rules");
            }}
            userRole={userRole}
            userId={userId || ""}

            onSendTurnRequest={handleSendTurnRequest}
            onApprovePlayerTurn={handleApprovePlayerTurn}
            onRejectPlayerTurn={handleRejectPlayerTurn}
            onConsumeBonus={handleConsumeBonus}
          />
        </CrashGuard>
      )}
      {visibleScreen === "admin" && userRole === "admin" && (
        <AdminConsole
          gameState={gameState}
          socket={socket}
          onUpdatePlayer={handleUpdatePlayer}
          onRegisterPlayer={handleRegisterPlayer}
          onDeletePlayer={handleDeletePlayer}
          onResetGame={handleResetGame}
          onSetBoardImage={handleSetBoardImage}
          onSetLoginBackground={handleSetLoginBackground}
          onSetRulesBackground={handleSetRulesBackground}
          onToggleCalibration={handleToggleCalibration}
          onSetTokenTimeout={handleSetTokenTimeout}
          onApprovePlayerTurn={handleApprovePlayerTurn}
          onRejectPlayerTurn={handleRejectPlayerTurn}
          onConsumeBonus={handleConsumeBonus}
          onClose={() => {
            setScreen("board");
            localStorage.setItem("hapstore_screen", "board");
          }}
        />
      )}
    </div>
  );
}
