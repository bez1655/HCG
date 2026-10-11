import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { GameState, Player, Cell, CellType } from "../types";
import {
  playSound,
  getSoundVolume,
  setSoundVolume,
  getSoundEnabled,
  setSoundEnabled,
  getMusicVolume,
  setMusicVolume,
  getMusicEnabled,
  setMusicEnabled,
} from "../utils/sounds";
import {
  MessageSquare,
  Send,
  Sliders,
  LogOut,
  Users,
  X,
  Check,
  Volume2,
  Music,
  Gift,
  Search,
  Award,
  Menu,
  BookOpen,
  HelpCircle,
  Shield,
  Clock,
} from "lucide-react";
import HelpScreen from "./HelpScreen";
import CellComponent from "./CellComponent";
import DiceRoll from "./DiceRoll";
import PlayerToken from "./PlayerToken";
import PlayerStatusBadge from "./PlayerStatusBadge";
import CyberParticles from "./CyberParticles";
import PlayerAvatarWithBadges from "./PlayerAvatarWithBadges";
import PlayerAchievementBadges from "./PlayerAchievementBadges";
import CellParticleEffect, { CellBurst } from "./CellParticleEffect";
import ActiveTurnIndicator from "./ActiveTurnIndicator";
import StatsSidebar from "./StatsSidebar";
import { turnsLeft, pluralizeTurns } from "../game/rules";
import { isTokenVisible } from "../game/presence";
import { describeEffect } from "../game/cellGuide";
import PlayerCabinet from "./PlayerCabinet";

interface BoardViewProps {
  gameState: GameState;
  onRoll: () => void;
  /** Dice value pushed by the server for this client, or null when idle. */
  pendingRoll: number | null;
  /** Clears pendingRoll once the animation has been consumed. */
  onRollAnimationDone: () => void;
  onSendMessage: (text: string, replyToId?: string) => void;
  onLogout: () => void;
  openAdminPanel: () => void;
  onCalibrateCell: (cal: { cellId: number; x: number; y: number }) => void;
  onSelectCalibrationCell?: (cellId: number | null) => void;
  openRules: () => void;
  userRole: "admin" | "player";
  userId: string;
  /** turns: how many rolls the player asks for at once. */
  onSendTurnRequest?: (turns?: number) => void;
  onApprovePlayerTurn?: (pId: string, confirmBonus?: boolean, turns?: number) => void;
  onRejectPlayerTurn?: (pId: string) => void;
  onConsumeBonus?: (pId: string) => void;
}

export default function BoardView({
  gameState,
  onRoll,
  pendingRoll,
  onRollAnimationDone,
  onSendMessage,
  onLogout,
  openAdminPanel,
  onCalibrateCell,
  onSelectCalibrationCell,
  openRules,
  userRole,
  userId,
  onSendTurnRequest,
  onApprovePlayerTurn,
  onRejectPlayerTurn,
  onConsumeBonus,
}: BoardViewProps) {
  const [activeChatTab, setActiveChatTab] = useState<"chat" | "logs">("chat");
  const [chatInput, setChatInput] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; senderName: string; text: string } | null>(
    null
  );
  const [selectedCell, setSelectedCell] = useState<Cell | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  // Фоновое видео доски. Останавливается на время броска: декодирование
  // видео и анимация кубика вместе кладут композитор мобильного webview.
  const boardVideoRef = useRef<HTMLVideoElement | null>(null);
  // Счётчик бросков: служит key для DiceRoll, чтобы каждый бросок начинался
  // с чистого компонента, а не с доигравшего предыдущего.
  const rollSessionRef = useRef(0);
  // Актуальный колбэк завершения. Через ref, чтобы эффекты не зависели от
  // функции, которую родитель пересоздаёт на каждом рендере.
  const doneRef = useRef(onRollAnimationDone);
  doneRef.current = onRollAnimationDone;
  const [rolledNumber, setRolledNumber] = useState<number | null>(null);
  const [_pulseKey, setPulseKey] = useState(0);
  const [_showHud, setShowHud] = useState(false);

  useEffect(() => {
    if (gameState.currentPlayerId) {
      setPulseKey((prev) => prev + 1);
      setShowHud(true);
      const t = setTimeout(() => setShowHud(false), 2500);
      return () => clearTimeout(t);
    }
  }, [gameState.currentPlayerId]);

  const [_isStatusOpen, _setIsStatusOpen] = useState(false);
  const [visualCells, setVisualCells] = useState<Record<string, number>>({});
  const [bonusConfirmPlayer, setBonusConfirmPlayer] = useState<Player | null>(null);
  // Диалог «сколько ходов запросить» и выбранное в нём число.
  const [isTurnRequestOpen, setIsTurnRequestOpen] = useState(false);
  const [requestedTurns, setRequestedTurns] = useState(1);
  // Сколько ходов админ выдаёт игроку прямо с доски (по id игрока).
  const [grantTurns, setGrantTurns] = useState<Record<string, number>>({});

  // Drawer states
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isPlayersDrawerOpen, setIsPlayersDrawerOpen] = useState(false);
  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [isCabinetOpen, setIsCabinetOpen] = useState(false);
  const [playerSearch, setPlayerSearch] = useState("");

  // Audio Settings states
  const [isAudioSettingsOpen, setIsAudioSettingsOpen] = useState(false);
  // Справка по клеткам: что даёт каждая особая клетка на доске.
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [_diceImgFailed, _setDiceImgFailed] = useState(false);
  const [soundVol, setSoundVol] = useState(getSoundVolume());
  const [musicVol, setMusicVol] = useState(getMusicVolume());
  const [musicOn, setMusicOn] = useState(getMusicEnabled());
  const [soundOn, setSoundOn] = useState(getSoundEnabled());

  useEffect(() => {
    const handleSoundChange = () => setSoundOn(getSoundEnabled());
    window.addEventListener("sound_settings_changed", handleSoundChange);
    return () => window.removeEventListener("sound_settings_changed", handleSoundChange);
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  // Cell Particle Burst Effect State & Trigger
  const [cellBursts, setCellBursts] = useState<CellBurst[]>([]);

  const triggerCellBurst = (cellId: number, playerColor?: string) => {
    if (!gameState?.cells) return;
    const cell = gameState.cells.find((c) => c.id === cellId);
    if (!cell) return;

    const isSpecial = cell.type !== CellType.NORMAL && cell.type !== CellType.START;
    const newBurst: CellBurst = {
      id: `burst_${cellId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      x: cell.x,
      y: cell.y,
      cellType: cell.type,
      isSpecial,
      playerColor,
      timestamp: Date.now(),
    };

    setCellBursts((prev) => [...prev.slice(-15), newBurst]);
  };

  // Auto-cleanup expired particle bursts
  useEffect(() => {
    if (cellBursts.length === 0) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      setCellBursts((prev) => prev.filter((b) => now - b.timestamp < 1200));
    }, 400);
    return () => clearTimeout(timer);
  }, [cellBursts]);

  // Track previous player cell positions to trigger landing particle burst
  const prevPlayerCellsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!gameState?.players) return;
    for (const player of gameState.players) {
      if (player.role !== "player") continue;
      const prevCell = prevPlayerCellsRef.current[player.id];
      if (prevCell !== undefined && prevCell !== player.cell) {
        triggerCellBurst(player.cell, player.color);
      }
      prevPlayerCellsRef.current[player.id] = player.cell;
    }
  }, [gameState?.players]);

  // Walk tokens one cell at a time. Snap when the gap is large (admin move)
  // or when the WebView wakes: Telegram/Android freeze setInterval and the
  // chip stays on the old cell until the screen remounts.
  const snapVisualToServer = () => {
    setVisualCells((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const player of gameState.players) {
        if (player.role !== "player") continue;
        if (next[player.id] !== player.cell) {
          next[player.id] = player.cell;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  useEffect(() => {
    if (!gameState) return;

    setVisualCells((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const player of gameState.players) {
        if (player.role !== "player") continue;
        if (next[player.id] === undefined) {
          next[player.id] = player.cell;
          changed = true;
          continue;
        }
        if (Math.abs(next[player.id] - player.cell) > 6) {
          next[player.id] = player.cell;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [gameState?.players]);

  useEffect(() => {
    if (!gameState) return;

    const timer = setInterval(() => {
      setVisualCells((prev) => {
        let updated = false;
        const next = { ...prev };

        for (const player of gameState.players) {
          if (player.role !== "player") continue;
          const currentVisual = prev[player.id] !== undefined ? prev[player.id] : player.cell;
          const target = player.cell;

          if (currentVisual !== target) {
            const nextCellId = currentVisual < target ? currentVisual + 1 : currentVisual - 1;
            next[player.id] = nextCellId;
            updated = true;
            playSound("click");
            triggerCellBurst(nextCellId, player.color);
          }
        }

        return updated ? next : prev;
      });
    }, 350);

    const wake = () => {
      if (document.visibilityState === "visible") snapVisualToServer();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [gameState?.players]);

  // Auto-clear rolled number after 5 seconds
  useEffect(() => {
    if (rolledNumber !== null) {
      const timer = setTimeout(() => {
        setRolledNumber(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [rolledNumber]);

  const handleBoardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!gameState.calibrationMode || gameState.selectedCalibrationCellId === null) return;

    // Check if the click target is a cell or inside a cell
    const target = e.target as HTMLElement;
    if (target.closest(".cell-component-container")) {
      return;
    }

    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const xPercent = (clickX / rect.width) * 100;
    const yPercent = (clickY / rect.height) * 100;

    const boundedX = Math.max(0, Math.min(100, xPercent));
    const boundedY = Math.max(0, Math.min(100, yPercent));

    onCalibrateCell({
      cellId: gameState.selectedCalibrationCellId,
      x: parseFloat(boundedX.toFixed(2)),
      y: parseFloat(boundedY.toFixed(2)),
    });

    onSelectCalibrationCell?.(null);
  };

  const me = gameState.players.find((p) => p.id === userId);
  // Ходов осталось в текущей пачке. Одобрение открывает несколько бросков
  // сразу, поэтому «мой ход» — это не «окно открыто», а «остались броски».
  /*
   * Порог скрытия фишек приходит с сервера. undefined трактуем как «сутки»:
   * это состояние старой версии, где настройки ещё не было.
   */
  const hideAfterHours = gameState.hideTokensAfterHours ?? 24;

  const myTurnsLeft = me ? turnsLeft(me) : 0;
  const hasApprovedTurn = myTurnsLeft > 0;
  const isMyTurn = !!(hasApprovedTurn || me?.role === "admin");

  const activeTurnPlayer = gameState.players.find((p) => turnsLeft(p) > 0);
  const getTurnStatusText = () => {
    if (hasApprovedTurn) {
      return myTurnsLeft > 1 ? `ВАШИ ХОДЫ: ${myTurnsLeft}` : "ВАШ ХОД";
    }
    if (activeTurnPlayer) return `ХОД: ${activeTurnPlayer.name.toUpperCase()}`;
    return "ВРЕМЯ ХОДА";
  };

  /*
   * Обратный отсчёт удалён вместе с ограничением по времени.
   *
   * Секундный setInterval крутился всегда — даже когда ходов не было, — и
   * перерисовывал доску раз в секунду на телефоне. Показывать теперь нечего:
   * ход не сгорает.
   */

  // Ask the server for a roll; the dice animation starts when the server
  // answers with its authoritative result (see the effect below).
  const handleRoll = () => {
    if (isRolling || !isMyTurn || gameState.turnStatus !== "waiting_roll") {
      console.warn("[HCG] handleRoll: условия не выполнены", {
        isRolling,
        isMyTurn,
        turnStatus: gameState.turnStatus,
      });
      return;
    }
    console.info("[HCG] Отправляю roll:request");
    setRolledNumber(null);
    onRoll();
  };

  // Start the 3D animation as soon as the server result arrives.
  useEffect(() => {
    if (pendingRoll !== null) {
      rollSessionRef.current += 1;
      setIsRolling(true);
    }
  }, [pendingRoll]);

  /**
   * Аварийный выход из анимации.
   *
   * Оверлей закрывается по таймеру внутри DiceRoll. Если он не отработает —
   * зависший таймер в фоновой вкладке, сбой при монтировании, что угодно —
   * игрок остаётся перед затемнённым экраном без единой кнопки, и помогает
   * только перезапуск приложения. Это ровно тот симптом, о котором сообщили.
   *
   * Анимация длится 4 секунды; 8 — заведомо больше и при нормальной работе
   * не срабатывает никогда.
   */
  useEffect(() => {
    if (!isRolling) return;
    const bail = setTimeout(() => {
      console.warn("[HCG] Анимация броска не завершилась за 8 с — закрываю принудительно");
      setIsRolling(false);
      doneRef.current();
    }, 8000);
    return () => clearTimeout(bail);
    // Зависимость ТОЛЬКО от isRolling.
    //
    // Раньше здесь стоял ещё и onRollAnimationDone. Родитель передаёт его
    // стрелкой прямо в JSX, то есть на каждом рендере это новая функция —
    // эффект перезапускался, таймер сбрасывался и не срабатывал никогда.
    // Страховка, которая не может сработать, хуже её отсутствия: она
    // создаёт ложное ощущение защищённости.
  }, [isRolling]);

  /**
   * Freeze the board video while the dice overlay is up.
   *
   * Two looping videos decoding underneath a full-screen animation is what
   * made the roll button look like it hung the game: the compositor could
   * not keep up, nothing repainted, and the player saw a black screen. The
   * video is hidden behind the overlay anyway, so pausing it costs nothing
   * visually and frees the whole frame budget for the animation.
   *
   * play() returns a promise that rejects if the element is detached; the
   * catch keeps an unmount during a roll from surfacing as an unhandled
   * rejection.
   */
  useEffect(() => {
    const video = boardVideoRef.current;
    if (!video) return;
    if (isRolling) {
      video.pause();
    } else {
      // Старые WebView возвращают из play() undefined, а не промис: цепочка
      // .catch() там падает и уносит весь экран доски. Проверяем результат.
      const started = video.play() as Promise<void> | undefined;
      if (started && typeof started.catch === "function") started.catch(() => undefined);
    }
  }, [isRolling]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [gameState.chatMessages, isChatDrawerOpen]);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    onSendMessage(chatInput.trim(), replyTo?.id);
    setChatInput("");
    setReplyTo(null);
    playSound("click");
  };

  const getCellColor = (type: CellType) => {
    switch (type) {
      case CellType.SNAKE:
      case CellType.PENALTY:
        return "border-red-500 text-red-400 bg-red-950/90 shadow-[0_0_12px_#ef4444]";
      case CellType.BONUS:
      case CellType.BITCOIN:
      case CellType.FLASK:
        return "border-[#00ffaa] text-[#00ffaa] bg-emerald-950/90 shadow-[0_0_12px_#00ffaa]";
      default:
        return "border-purple-500 text-purple-300 bg-purple-950/90 shadow-[0_0_12px_#a855f7]";
    }
  };

  // Sort players by position for leaderboard
  const sortedPlayers = [...gameState.players]
    .filter((p) => p.role === "player")
    .sort((a, b) => b.cell - a.cell);

  return (
    <div
      id="app-shell"
      className="relative h-[100dvh] w-full bg-black text-ink-core font-sans overflow-hidden select-none flex items-center justify-center"
    >
      {/* Immersive Full-Screen Video/Image Background */}
      <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <video
          src="/BoardHAP.mp4?v=10"
          autoPlay
          loop
          muted
          playsInline
          poster="/BoardHAP.png?v=10"
          className="w-full h-full object-cover opacity-40 brightness-100 blur-[2px]"
          onError={(_e) => {
            console.error("App background video load error");
          }}
        />
      </div>

      {/* Decorative Grid Overlay for Matrix look */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(224,224,230,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(224,224,230,0.06)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none z-0" />

      {/* Floating Cyber-Dust / Neon Embers Particles */}
      <CyberParticles />

      {/* Expandable Player Stats Sidebar */}
      <StatsSidebar
        gameState={gameState}
        userId={userId}
        onSelectCell={(cellId) => {
          const cell = gameState.cells?.find((c) => c.id === cellId);
          if (cell) setSelectedCell(cell);
        }}
      />

      {/*
        Каждый бросок — новый компонент: key меняется, React монтирует его
        заново. Без этого второй бросок переиспользовал бы экземпляр с уже
        отработавшими таймерами, onDone не вызывался бы, и оверлей висел бы
        до перезапуска приложения.
      */}
      {isRolling && pendingRoll !== null && (
        <DiceRoll
          key={rollSessionRef.current}
          result={pendingRoll}
          onDone={(value) => {
            setIsRolling(false);
            setRolledNumber(value);
            onRollAnimationDone();
          }}
        />
      )}

      {/* --- TOP FLOATING OVERLAY HUD --- */}
      <div className="absolute top-4 left-4 right-4 flex items-center justify-between gap-2 z-40 pointer-events-none">
        {/* 1. МЕНЮ button with dropdown */}
        <div className="relative pointer-events-auto">
          <button
            onClick={() => {
              playSound("click");
              setIsMenuOpen(!isMenuOpen);
            }}
            className={`flex items-center gap-1.5 px-3 py-2 border rounded-xl text-[10px] font-black transition duration-200 cursor-pointer font-mono tracking-wider shadow-lg ${
              isMenuOpen
                ? "bg-[#00ffaa] text-black border-[#00ffaa] shadow-[0_0_15px_rgba(0,255,170,0.4)]"
                : "bg-black/90 border-[#00ffaa]/50 text-[#00ffaa] hover:bg-[#00ffaa]/15"
            }`}
          >
            <Menu size={14} />
            <span>МЕНЮ</span>
          </button>

          {/* Menu Dropdown Popup */}
          <AnimatePresence>
            {isMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="absolute left-0 top-12 z-50 w-52 bg-black/95 backdrop-blur-xl border-2 border-[#00ffaa]/40 rounded-2xl p-2 shadow-[0_0_25px_rgba(0,255,170,0.25)] flex flex-col gap-1 text-white font-mono text-xs select-none"
                >
                  <div className="px-3 py-1.5 text-[9px] font-black text-[#00ffaa]/70 uppercase tracking-widest border-b border-white/10 mb-1 flex justify-between items-center">
                    <span>ГЛАВНОЕ МЕНЮ</span>
                    <button
                      onClick={() => setIsMenuOpen(false)}
                      className="text-white/40 hover:text-white"
                    >
                      <X size={12} />
                    </button>
                  </div>

                  {/* 1. ИГРОКИ */}
                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      setIsPlayersDrawerOpen(true);
                      setIsChatDrawerOpen(false);
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[#00ffaa]/15 hover:text-[#00ffaa] transition text-left cursor-pointer font-bold tracking-wider"
                  >
                    <Users size={14} className="text-[#00ffaa]" />
                    <span>ИГРОКИ</span>
                  </button>

                  {/* 2. ПРАВИЛА */}
                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      openRules();
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[#f5c542]/15 hover:text-[#f5c542] transition text-left cursor-pointer font-bold tracking-wider"
                  >
                    <BookOpen size={14} className="text-[#f5c542]" />
                    <span>ПРАВИЛА</span>
                  </button>

                  {/* 3. СПРАВКА — что делает каждая клетка */}
                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      setIsHelpOpen(true);
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[#00ffaa]/15 hover:text-[#00ffaa] transition text-left cursor-pointer font-bold tracking-wider"
                  >
                    <HelpCircle size={14} className="text-[#00ffaa]" />
                    <span>СПРАВКА</span>
                  </button>

                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      setIsCabinetOpen(true);
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[#00ffaa]/15 hover:text-[#00ffaa] transition text-left cursor-pointer font-bold tracking-wider"
                  >
                    <Award size={14} className="text-[#00ffaa]" />
                    <span>МОИ ПРИЗЫ</span>
                  </button>

                  {/* 4. НАСТРОЙКИ */}
                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      setIsAudioSettingsOpen(true);
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-purple-500/15 hover:text-purple-400 transition text-left cursor-pointer font-bold tracking-wider"
                  >
                    <Sliders size={14} className="text-purple-400" />
                    <span>НАСТРОЙКИ</span>
                  </button>
                  {/* 5. АДМИНКА */}
                  {userRole === "admin" && (
                    <button
                      onClick={() => {
                        playSound("laser");
                        setIsMenuOpen(false);
                        openAdminPanel();
                      }}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-blue-500/15 hover:text-blue-400 transition text-left cursor-pointer font-bold tracking-wider"
                    >
                      <Shield size={14} className="text-blue-400" />
                      <span>АДМИНКА</span>
                    </button>
                  )}

                  <div className="border-t border-white/10 my-1"></div>

                  {/* 6. ВЫЙТИ */}
                  <button
                    onClick={() => {
                      playSound("click");
                      setIsMenuOpen(false);
                      onLogout();
                    }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-red-500/20 text-red-400 transition text-left cursor-pointer font-bold tracking-wider text-[11px]"
                  >
                    <LogOut size={14} />
                    <span>ВЫЙТИ</span>
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* 2. ЗАПРОСИТЬ ХОД button */}
        <div className="pointer-events-auto flex-1 max-w-[170px] flex justify-center">
          <button
            onClick={() => {
              playSound("click");
              // Открываем выбор количества: игроку с несколькими покупками
              // не нужно слать несколько запросов подряд.
              setIsTurnRequestOpen(true);
            }}
            disabled={!!me?.turnRequested || hasApprovedTurn || isMyTurn}
            className={`w-full py-2 px-2.5 border rounded-xl text-[10px] font-black transition-all duration-200 font-mono tracking-wider uppercase text-center shadow-lg truncate flex items-center justify-center gap-1 ${
              hasApprovedTurn || isMyTurn
                ? "bg-emerald-500/20 border-emerald-400/60 text-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.3)]"
                : me?.turnRequested
                  ? "bg-amber-500/20 border-amber-400/50 text-amber-300 animate-pulse"
                  : me?.activeBonus
                    ? "bg-yellow-500/20 border-yellow-400/80 text-yellow-300 hover:bg-yellow-500/30 cursor-pointer shadow-[0_0_15px_rgba(234,179,8,0.25)]"
                    : "bg-black/90 border-[#00ffaa]/50 text-[#00ffaa] hover:bg-[#00ffaa]/20 hover:border-[#00ffaa] cursor-pointer active:scale-95 shadow-[0_0_12px_rgba(0,255,170,0.15)]"
            }`}
          >
            {hasApprovedTurn
              ? myTurnsLeft > 1
                ? `ХОДОВ: ${myTurnsLeft}`
                : "ХОД ОДОБРЕН"
              : isMyTurn
                ? "ХОД ОДОБРЕН"
                : me?.turnRequested
                  ? me?.activeBonus
                    ? "ЖДЕТ СПИСАНИЯ 🎁"
                    : me?.turnsRequested && me.turnsRequested > 1
                      ? `ЗАПРОШЕНО: ${me.turnsRequested}`
                      : "ЗАПРОШЕНО"
                  : me?.activeBonus
                    ? "ЗАПРОС С БОНУСОМ 🎁"
                    : "ЗАПРОСИТЬ ХОД"}
          </button>
        </div>

        {/* 3. ЧАТ button */}
        <div className="pointer-events-auto">
          <button
            onClick={() => {
              playSound("click");
              setIsChatDrawerOpen(!isChatDrawerOpen);
              if (!isChatDrawerOpen) setIsPlayersDrawerOpen(false);
            }}
            className={`flex items-center gap-1.5 px-3 py-2 border rounded-xl text-[10px] font-black transition duration-200 cursor-pointer font-mono tracking-wider shadow-lg ${
              isChatDrawerOpen
                ? "bg-purple-500 text-white border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.4)]"
                : "bg-black/90 border-purple-500/50 text-purple-400 hover:bg-purple-500/15"
            }`}
          >
            <MessageSquare size={14} />
            <span>ЧАТ</span>
          </button>
        </div>
      </div>

      {/* --- PLAYERS SIDE DRAWER (Left Side Slide-in) --- */}
      <AnimatePresence>
        {isPlayersDrawerOpen && (
          <>
            <div
              className="absolute inset-0 bg-black/55 z-40 pointer-events-auto"
              onClick={() => setIsPlayersDrawerOpen(false)}
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 220 }}
              className="absolute left-0 top-0 bottom-0 w-[290px] bg-black/95 backdrop-blur-xl border-r border-[#00ffaa]/20 z-50 p-5 flex flex-col gap-5 select-none pointer-events-auto shadow-2xl"
            >
              <div className="flex justify-between items-center border-b border-white/10 pb-3.5">
                <span className="font-mono text-[10px] font-black text-[#00ffaa] uppercase tracking-[0.2em]">
                  АКТИВНЫЕ ИГРОКИ
                </span>
                <button
                  onClick={() => setIsPlayersDrawerOpen(false)}
                  className="text-white/60 hover:text-white cursor-pointer"
                >
                  <X size={15} />
                </button>
              </div>

              {/* Connected Player Cards */}
              <div className="relative">
                <Search size={12} className="absolute left-2 top-2.5 text-[#00ffaa]/70" />
                <input
                  value={playerSearch}
                  onChange={(e) => setPlayerSearch(e.target.value)}
                  placeholder="Найти игрока…"
                  className="w-full bg-black border border-[#00ffaa]/30 rounded-lg pl-7 pr-2 py-1.5 text-[11px] text-white font-mono focus:outline-none"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 scrollbar-none pr-1">
                {sortedPlayers
                  .filter((p) => {
                    const q = playerSearch.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      p.name.toLowerCase().includes(q) ||
                      (p.alias || "").toLowerCase().includes(q) ||
                      String(p.cell).includes(q)
                    );
                  })
                  .map((p, _idx) => {
                  const _isOnline = p.isOnline !== false;
                  const isCurrentTurn = gameState.currentPlayerId === p.id;
                  const playerCellObj = gameState.cells.find((c) => c.id === p.cell);
                  return (
                    <div
                      key={p.id}
                      onClick={() => {
                        playSound("click");
                        setSelectedCell(playerCellObj || null);
                      }}
                      className={`border p-3 flex flex-col gap-2 rounded-xl cursor-pointer transition-all hover:border-[#00ffaa]/50 ${
                        isCurrentTurn
                          ? "border-[#00ffaa] bg-[#00ffaa]/10 shadow-[0_0_12px_rgba(0,255,170,0.15)]"
                          : "border-white/10 bg-white/5"
                      }`}
                    >
                      <div className="flex items-center justify-between min-w-0 gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PlayerAvatarWithBadges player={p} gameState={gameState} size="md" />
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className="player-name font-mono text-xs font-black truncate"
                                style={{ color: p.color }}
                              >
                                {p.name}
                              </span>
                              <ActiveTurnIndicator
                                player={p}
                                gameState={gameState}
                                size="sm"
                                showTextLabel
                              />
                            </div>
                            <span className="text-[9px] font-mono opacity-50 truncate text-white">
                              {playerCellObj?.name || "Стартовая зона"}
                            </span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="player-score font-mono text-xs text-[#00ffaa] font-bold block">
                            {p.cell} кл.
                          </span>
                        </div>
                      </div>

                      {/* Achievement Badges */}
                      <PlayerAchievementBadges player={p} gameState={gameState} compact />

                      <PlayerStatusBadge
                        player={p}
                        gameState={gameState}
                        visualCells={visualCells}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Turn Approvals inside Drawer */}
              {userRole === "admin" &&
                (() => {
                  const requestingPlayers = gameState.players.filter(
                    (p) => p.turnRequested && p.role === "player"
                  );
                  if (requestingPlayers.length === 0) return null;
                  return (
                    <div className="border-t border-white/10 pt-4 mt-auto">
                      <div className="text-[9px] font-mono font-bold text-[#00ffaa] uppercase tracking-widest mb-3 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-[#00ffaa] rounded-full animate-pulse"></span>
                        ЗАПРОСЫ НА ХОД ({requestingPlayers.length})
                      </div>
                      <div className="space-y-2 max-h-[180px] overflow-y-auto scrollbar-none">
                        {requestingPlayers.map((p) => {
                          // Сколько выдать: правка админа, иначе просьба игрока.
                          const asked = Math.min(10, Math.max(1, p.turnsRequested || 1));
                          const give = grantTurns[p.id] ?? asked;
                          return (
                            <div
                              key={p.id}
                              className="flex flex-col gap-1 bg-black/40 p-2 border border-white/10 rounded-lg"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className="text-[10px] font-bold truncate max-w-[120px]"
                                  style={{ color: p.color }}
                                >
                                  {p.name}
                                </span>
                                <div className="flex gap-1.5 shrink-0">
                                  <button
                                    onClick={() => {
                                      if (p.activeBonus) {
                                        playSound("click");
                                        setBonusConfirmPlayer(p);
                                      } else {
                                        playSound("success");
                                        onApprovePlayerTurn?.(p.id, false, give);
                                      }
                                    }}
                                    className="bg-emerald-950/40 border border-emerald-500/50 hover:bg-emerald-500 hover:text-black p-1 text-emerald-400 text-[9px] cursor-pointer flex items-center gap-1"
                                    title={`Одобрить ${give} ${pluralizeTurns(give)}`}
                                  >
                                    <Check size={11} />
                                    <span className="text-[9px] font-black">{give}</span>
                                    {p.activeBonus && (
                                      <span className="text-[8px] font-bold text-yellow-400">
                                        🎁
                                      </span>
                                    )}
                                  </button>
                                  <button
                                    onClick={() => {
                                      playSound("click");
                                      onRejectPlayerTurn?.(p.id);
                                    }}
                                    className="bg-red-950/40 border border-red-500/50 hover:bg-red-500 hover:text-white p-1 text-red-400 text-[9px] cursor-pointer"
                                    title="Отклонить"
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                              </div>

                              {/* Сколько ходов выдать: просьба игрока и правка админа */}
                              <div className="flex items-center gap-1">
                                <span className="text-[8px] font-mono text-white/40 uppercase">
                                  просит {asked}
                                </span>
                                <div className="flex gap-1 ml-auto">
                                  {[1, 2, 3, 5].map((n) => (
                                    <button
                                      key={n}
                                      onClick={() => {
                                        playSound("click");
                                        setGrantTurns((prev) => ({ ...prev, [p.id]: n }));
                                      }}
                                      className={`w-5 h-5 rounded text-[9px] font-mono font-black border cursor-pointer transition ${
                                        give === n
                                          ? "bg-[#00ffaa] text-black border-[#00ffaa]"
                                          : "bg-black/50 text-[#00ffaa]/70 border-[#00ffaa]/25 hover:bg-[#00ffaa]/15"
                                      }`}
                                      title={`Выдать ${n} ${pluralizeTurns(n)}`}
                                    >
                                      {n}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {p.activeBonus && (
                                <div className="text-[8px] font-mono text-yellow-400/90 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                                  <span>🎁 БОНУС:</span>
                                  <span className="font-bold truncate">
                                    {p.activeBonus.extra || p.activeBonus.name}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* --- CHAT & LOGS SIDE DRAWER (Right Side Slide-in) --- */}
      <AnimatePresence>
        {isChatDrawerOpen && (
          <>
            <div
              className="absolute inset-0 bg-black/55 z-40 pointer-events-auto"
              onClick={() => setIsChatDrawerOpen(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 220 }}
              className="absolute right-0 top-0 bottom-0 w-[300px] bg-black/95 backdrop-blur-xl border-l border-purple-500/20 z-50 p-5 flex flex-col gap-4 select-none pointer-events-auto shadow-2xl"
            >
              <div className="flex justify-between items-center border-b border-white/10 pb-3.5">
                <div className="flex bg-black border border-white/10 p-0.5 rounded-lg font-mono text-[9px] font-bold">
                  <button
                    onClick={() => {
                      playSound("click");
                      setActiveChatTab("chat");
                    }}
                    className={`px-3 py-1.5 rounded-md transition duration-200 cursor-pointer ${activeChatTab === "chat" ? "bg-purple-500/20 text-white" : "text-gray-400"}`}
                  >
                    ЧАТ
                  </button>
                  <button
                    onClick={() => {
                      playSound("click");
                      setActiveChatTab("logs");
                    }}
                    className={`px-3 py-1.5 rounded-md transition duration-200 cursor-pointer ${activeChatTab === "logs" ? "bg-cyan-500/20 text-[#00FFFF]" : "text-gray-400"}`}
                  >
                    СОБЫТИЯ
                  </button>
                </div>
                <button
                  onClick={() => setIsChatDrawerOpen(false)}
                  className="text-white/60 hover:text-white cursor-pointer"
                >
                  <X size={15} />
                </button>
              </div>

              {activeChatTab === "chat" ? (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex-1 overflow-y-auto space-y-2.5 scrollbar-none pr-1">
                    {(gameState.chatMessages || []).map((msg) => (
                      <button
                        type="button"
                        key={msg.id}
                        onClick={() => {
                          playSound("click");
                          setReplyTo({
                            id: msg.id,
                            senderName: msg.senderName,
                            text: msg.text.slice(0, 80),
                          });
                        }}
                        className="text-left text-[11px] leading-relaxed break-words font-sans flex flex-col bg-white/5 p-2 rounded-xl cursor-pointer hover:bg-white/10"
                      >
                        <span
                          style={{ color: msg.senderColor }}
                          className="font-mono font-bold shrink-0 mb-0.5 text-[10px]"
                        >
                          {msg.senderName}
                        </span>
                        {msg.replyTo && (
                          <span className="mb-1 rounded-md border-l-2 border-orange-400/70 bg-black/40 px-2 py-1 text-[10px] text-gray-400">
                            <span className="font-bold text-orange-300/90">{msg.replyTo.senderName}</span>
                            <span className="block truncate">{msg.replyTo.text}</span>
                          </span>
                        )}
                        <span className="text-gray-200">{msg.text}</span>
                      </button>
                    ))}
                    <div ref={chatEndRef}></div>
                  </div>
                  <form
                    onSubmit={sendChat}
                    className="p-2 border-t border-purple-500/20 flex flex-col gap-1.5 mt-2"
                  >
                    {replyTo && (
                      <div className="flex items-start gap-1 rounded-md border-l-2 border-orange-400 bg-white/5 px-2 py-1">
                        <div className="min-w-0 flex-1 text-[10px] text-gray-400">
                          <span className="font-bold text-orange-300">Ответ {replyTo.senderName}</span>
                          <span className="block truncate">{replyTo.text}</span>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 text-gray-500 hover:text-white"
                          onClick={() => setReplyTo(null)}
                          aria-label="Отменить ответ"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                    <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={replyTo ? "Ваш ответ..." : "Сообщение..."}
                      className="flex-1 bg-black border border-white/10 rounded-lg text-xs text-white px-3 py-2 focus:outline-none focus:border-purple-500 font-sans"
                    />
                    <button
                      type="submit"
                      className="bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500 hover:text-white px-3 py-2 rounded-lg transition duration-200 cursor-pointer"
                    >
                      <Send size={12} />
                    </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-2 scrollbar-none text-[10px] leading-tight flex flex-col font-mono pr-1">
                  {/*
                    Newest first. addLog() unshifts, so gameState.logs already
                    arrives in that order — the .reverse() here undid it and
                    buried the latest event at the bottom of a long scroll.
                  */}
                  {(gameState.logs || []).map((log) => {
                    const isRoll = log.type === "roll" || log.type === "move";
                    const isSystem = log.type === "system";
                    const isChat = log.type === "chat";
                    const isError = log.type === "error";
                    const colorClass = isRoll
                      ? "text-amber-400 text-glow-yellow"
                      : isSystem
                        ? "text-emerald-400"
                        : isChat
                          ? "text-blue-400"
                          : isError
                            ? "text-red-400 font-bold"
                            : "text-gray-300";
                    const stamp = String(log.timestamp || "");
                    return (
                      <div
                        key={log.id}
                        className="bg-black border border-white/5 rounded-lg p-2 flex flex-col gap-0.5"
                      >
                        <div className="flex justify-between text-[7px] text-gray-500 mb-0.5 font-mono">
                          <span className="uppercase">{log.type}</span>
                          <span>{stamp.split(" ")[1] || stamp}</span>
                        </div>
                        <span className={`${colorClass} select-text leading-snug`}>
                          {log.message}
                        </span>
                      </div>
                    );
                  })}
                  {gameState.logs.length === 0 && (
                    <div className="text-center text-gray-500 text-[10px] py-6 uppercase tracking-widest text-white">
                      НЕТ СОБЫТИЙ
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* --- MAIN STAGE (Centered full height map container) --- */}
      <main className="h-full w-full flex items-center justify-center relative z-10 p-0 overflow-hidden">
        <div
          ref={boardRef}
          onClick={handleBoardClick}
          className="board-container relative h-full w-full max-w-[56.25vh] aspect-[9/16] bg-black shadow-[0_0_80px_rgba(0,0,0,0.9)] flex-shrink-0"
        >
          {/* Background Map video */}
          <video
            ref={boardVideoRef}
            src="/BoardHAP.mp4?v=10"
            autoPlay
            loop
            muted
            playsInline
            poster="/BoardHAP.png?v=10"
            className="absolute inset-0 w-full h-full object-fill opacity-100 pointer-events-none z-0"
          />

          {/* SEC_BOARD coordinate decorative text */}
          <div className="absolute bottom-3 right-3 font-mono text-[8px] opacity-40 uppercase tracking-widest text-white pointer-events-none z-20">
            SEC_BOARD_A1 :: LAT: 32.39 TOP: 92.83
          </div>

          {/* SVG Connection Lines */}
          {Boolean(gameState.calibrationMode && userRole === "admin") && (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-10"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <path
                d={gameState.cells
                  .map((cell, idx) => `${idx === 0 ? "M" : "L"} ${cell.x} ${cell.y}`)
                  .join(" ")}
                fill="none"
                stroke="rgba(0, 255, 170, 0.4)"
                strokeWidth="0.8"
                strokeDasharray="2 2"
                className="animate-[dash_10s_linear_infinite]"
              />
            </svg>
          )}

          {/* Cyber Particle Burst Overlay */}
          <CellParticleEffect bursts={cellBursts} />

          {/* Cells */}
          {gameState.cells.map((cell) => {
            const isSelected = selectedCell?.id === cell.id;
            const isCalibrationActive = Boolean(gameState.calibrationMode && userRole === "admin");
            const isDraggable =
              isCalibrationActive && gameState.selectedCalibrationCellId === cell.id;
            /*
             * Фишки рисуются ДВУМЯ слоями: этот список отдаётся клетке, а
             * ниже идёт отдельный слой «шагающих» фишек. Правило скрытия
             * обязано применяться в обоих — иначе фишка пропадала бы из
             * одного слоя и оставалась в другом.
             */
            const playersOnThisCell = gameState.players.filter(
              (p) =>
                p.role === "player" &&
                isTokenVisible(p, hideAfterHours) &&
                (visualCells[p.id] !== undefined ? visualCells[p.id] : p.cell) === cell.id
            );

            return (
              <CellComponent
                key={cell.id}
                cell={cell}
                hasPlayersOnCell={playersOnThisCell}
                isSelected={isSelected}
                isDraggable={isDraggable}
                getCellColor={getCellColor}
                calibrationMode={isCalibrationActive}
                onClick={() => {
                  playSound("click");
                  triggerCellBurst(cell.id);
                  if (isCalibrationActive) {
                    onSelectCalibrationCell?.(cell.id);
                  } else {
                    setSelectedCell(cell);
                  }
                }}
                onDragEnd={(e: any, info: any) => {
                  if (!isCalibrationActive) return;
                  if (!boardRef.current) return;
                  const rect = boardRef.current.getBoundingClientRect();
                  const xPercent = ((info.point.x - rect.left) / rect.width) * 100;
                  const yPercent = ((info.point.y - rect.top) / rect.height) * 100;

                  const boundedX = Math.max(0, Math.min(100, xPercent));
                  const boundedY = Math.max(0, Math.min(100, yPercent));

                  onCalibrateCell({
                    cellId: cell.id,
                    x: parseFloat(boundedX.toFixed(2)),
                    y: parseFloat(boundedY.toFixed(2)),
                  });
                }}
              />
            );
          })}

          {/* Smooth walking player tokens overlay */}
          {gameState.players
            /*
             * Показываем игроков партии, а не только тех, кто сейчас в сети:
             * фишка отмечает положение в игре и не исчезает, когда человек
             * закрыл приложение. Прежний фильтр по isOnline делал только что
             * зарегистрированного игрока невидимым до первого входа.
             *
             * Но и держать всех вечно нельзя: за несколько месяцев доска
             * зарастает фишками тех, кто давно ушёл. Тот, кто не появлялся
             * дольше заданного срока, скрывается — позиция при этом
             * сохраняется, и по возвращении фишка снова на месте.
             */
            .filter((p) => p.role === "player" && isTokenVisible(p, hideAfterHours))
            .map((player, pIdx) => {
              const currentCellId =
                visualCells[player.id] !== undefined ? visualCells[player.id] : player.cell;
              const cell = gameState.cells.find((c) => c.id === currentCellId);
              if (!cell) return null;

              // Должно совпадать с фильтром выше, иначе смещение фишек на
              // общей клетке считается не от того количества и они налезают
              // друг на друга.
              const playersOnSameCell = gameState.players.filter(
                (p) =>
                  p.role === "player" &&
                  isTokenVisible(p, hideAfterHours) &&
                  (visualCells[p.id] !== undefined ? visualCells[p.id] : p.cell) === currentCellId
              );
              const pIndexOnCell = playersOnSameCell.findIndex((p) => p.id === player.id);
              const offsetCount = playersOnSameCell.length;

              let offsetX = 0;
              let offsetY = 0;
              if (offsetCount > 1) {
                const angle = (pIndexOnCell * 2 * Math.PI) / offsetCount;
                offsetX = Math.cos(angle) * 3;
                offsetY = Math.sin(angle) * 3;
              }

              const isActionCell =
                cell.type === CellType.BONUS ||
                cell.type === CellType.PENALTY ||
                cell.type === CellType.SNAKE ||
                cell.type === CellType.BITCOIN;

              return (
                <motion.div
                  key={player.id}
                  className="absolute z-30 pointer-events-none"
                  style={{
                    left: `${cell.x}%`,
                    top: `${cell.y}%`,
                  }}
                  animate={{
                    left: `${cell.x + offsetX}%`,
                    top: `${cell.y + offsetY}%`,
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 90,
                    damping: 15,
                    mass: 0.9,
                  }}
                >
                  <div className="relative -translate-x-1/2 -translate-y-1/2">
                    <PlayerToken player={player} pIdx={pIdx} isActionCell={isActionCell} />
                  </div>
                </motion.div>
              );
            })}

          {/* --- BOTTOM GAME BOARD ACTION HUD PANEL --- */}
          {/* 1. Center: Active Prize Control Bonus Notice */}
          {me?.activeBonus && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex flex-col items-center">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-yellow-950/95 backdrop-blur-xl border-2 border-yellow-500/70 rounded-xl p-3 text-center w-full max-w-xs md:max-w-sm pointer-events-auto flex flex-col items-center gap-1.5 shadow-[0_0_20px_rgba(234,179,8,0.3)]"
              >
                <div className="flex items-center gap-1.5 font-syne text-[11px] text-yellow-400 font-extrabold uppercase tracking-wider">
                  <Gift size={16} className="text-yellow-400 animate-bounce" />
                  СИСТЕМА КОНТРОЛЯ ПРИЗОВ
                </div>
                <div className="text-[11px] font-mono font-bold text-yellow-300 bg-black/60 px-2.5 py-1 rounded border border-yellow-500/40">
                  🎁 {me.activeBonus.extra || me.activeBonus.name}
                </div>
                <p className="text-[10px] font-sans text-yellow-100/90 leading-tight">
                  Призовые суммы и бонусы <b>не суммируются</b>. Чтобы сделать новый бросок, вы
                  должны использовать данный бонус в Таблице Жизни и дождаться списания
                  администратором!
                </p>
              </motion.div>
            </div>
          )}

          {/* 2. Bottom-Left Corner: Compact Dice Roll Button with /Dice.png?v=3 */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="absolute bottom-2 left-2 md:bottom-3 md:left-3 z-40 pointer-events-auto flex flex-col items-center"
          >
            <button
              onClick={() => {
                if (!isMyTurn || gameState.turnStatus !== "waiting_roll" || isRolling) {
                  // Раньше отказ был полностью беззвучным: ни в интерфейсе,
                  // ни в консоли не оставалось следа, и «кнопка не работает»
                  // невозможно было отличить от «запрос ушёл и потерялся».
                  console.warn(
                    "[HCG] Бросок отклонён на клиенте:",
                    JSON.stringify({
                      isMyTurn,
                      turnStatus: gameState.turnStatus,
                      isRolling,
                      approvedUntil: me?.turnApprovedUntil ?? null,
                    })
                  );
                  playSound("click");
                  return;
                }
                const tg = (window as any).Telegram?.WebApp;
                if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("heavy");
                handleRoll();
              }}
              disabled={isRolling}
              className={`relative group flex flex-col items-center justify-center transition-all duration-300 ${
                isMyTurn && gameState.turnStatus === "waiting_roll"
                  ? "cursor-pointer hover:scale-105 active:scale-95"
                  : "cursor-not-allowed opacity-75"
              }`}
            >
              {/* Neon Aura Glow when active */}
              {isMyTurn && gameState.turnStatus === "waiting_roll" && (
                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-[#ff7a18] via-[#c45c0c] to-[#ffd36a] opacity-70 blur-md animate-pulse scale-110 pointer-events-none" />
              )}

              {/* Dice Graphic Box */}
              <div
                className={`relative w-12 h-12 md:w-14 md:h-14 transition-all duration-300 flex items-center justify-center ${
                  isMyTurn && gameState.turnStatus === "waiting_roll"
                    ? "drop-shadow-[0_0_12px_rgba(255,0,0,0.8)] animate-pulse"
                    : "drop-shadow-[0_0_6px_rgba(255,255,255,0.2)] grayscale-[30%]"
                }`}
              >
                <img
                  src="/Dice.png?v=11"
                  alt="Dice"
                  className="w-[44px] h-[44px] object-contain filter drop-shadow-[0_0_10px_rgba(255,122,24,0.85)]"
                  style={{ width: "44px", height: "44px" }}
                />
                <div className="absolute inset-0 rounded-xl bg-transparent" />
              </div>

              {/* 2-line Neat Compact Text Underneath */}
              <div className="mt-0.5 text-center font-syne font-black uppercase tracking-wider text-[9px] md:text-[10px] leading-tight select-none">
                <span
                  className={`${
                    isMyTurn && gameState.turnStatus === "waiting_roll"
                      ? "text-[#00ffaa] drop-shadow-[0_0_6px_rgba(0,255,170,0.9)] animate-pulse"
                      : "text-gray-300"
                  }`}
                >
                  {isRolling ? <>БРОСОК...</> : <>БРОСИТЬ КУБИК</>}
                </span>
                {/* Остаток пачки: игрок должен видеть, что ждать одобрения не нужно */}
                {myTurnsLeft > 1 && !isRolling && (
                  <span className="block text-[8px] md:text-[9px] text-[#00ffaa]/80 font-mono">
                    ОСТАЛОСЬ {myTurnsLeft}
                  </span>
                )}
              </div>
            </button>
          </motion.div>

          {/*
            3. Правый нижний угол: остаток ходов.

            Здесь был обратный отсчёт 12 часов. Ограничения по времени больше
            нет, а счётчик, который никуда не бежит, только пугает игрока —
            вместо него показываем то, что действительно имеет значение:
            сколько бросков осталось.
          */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="absolute bottom-2 right-2 md:bottom-3 md:right-3 z-40 pointer-events-auto flex flex-col items-center"
          >
            <div className="bg-black/90 backdrop-blur-md border border-cyan-500/50 rounded-xl px-2.5 py-1.5 shadow-[0_0_14px_rgba(6,182,212,0.35)] flex flex-col items-center gap-0.5 min-w-[85px] md:min-w-[100px]">
              <div className="flex items-center gap-1 font-mono text-[8px] md:text-[9px] text-cyan-400 font-extrabold uppercase tracking-widest">
                <Clock size={11} className="text-cyan-400" />
                <span>БЕЗ ЛИМИТА</span>
              </div>
              <div className="font-mono text-xs md:text-sm font-black text-white tracking-wider drop-shadow-[0_0_6px_rgba(6,182,212,0.8)]">
                {hasApprovedTurn ? `${myTurnsLeft} 🎲` : "—"}
              </div>
              <div className="text-[7px] md:text-[8px] font-sans text-cyan-200/80 font-bold tracking-normal uppercase">
                {getTurnStatusText()}
              </div>
            </div>
          </motion.div>
        </div>
      </main>

      {/* --- FLOATING CELL PREVIEW DRAWER --- */}
      <AnimatePresence>
        {selectedCell && (
          <div
            className="absolute inset-0 z-[45] flex items-center justify-center p-4 bg-black/70 pointer-events-auto"
            onClick={() => setSelectedCell(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-sm bg-black/95 border-2 border-[#00ffaa]/40 rounded-2xl overflow-hidden shadow-[0_0_30px_rgba(0,255,170,0.2)] p-5 flex flex-col gap-3 font-mono text-xs"
            >
              <div className="flex justify-between items-center border-b border-white/10 pb-2">
                <span className="text-[10px] font-black text-[#00ffaa] uppercase tracking-widest">
                  КЛЕТКА #{selectedCell.id}
                </span>
                <button
                  onClick={() => setSelectedCell(null)}
                  className="text-white/60 hover:text-white cursor-pointer"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="font-syne font-extrabold text-sm text-white uppercase tracking-wider">
                {selectedCell.name}
              </div>
              <div className="bg-white/5 p-3 rounded-lg border border-white/5 text-[11px] leading-relaxed text-gray-300 font-sans">
                <div className="text-[#00ffaa] font-bold mb-1">{describeEffect(selectedCell)}</div>
                {selectedCell.description || "Обычная клетка."}
              </div>
              <div className="flex justify-between text-[10px] text-white/40 font-mono mt-1 pt-2 border-t border-white/5">
                <span>ТИП: {selectedCell.type}</span>
                <span>
                  COORD: {selectedCell.x}, {selectedCell.y}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- СПРАВКА ПО КЛЕТКАМ --- */}
      <AnimatePresence>
        {isHelpOpen && (
          <HelpScreen cells={gameState.cells || []} onClose={() => setIsHelpOpen(false)} />
        )}
      </AnimatePresence>

      {/* --- AUDIO SETTINGS MODAL --- */}
      <AnimatePresence>
        {isAudioSettingsOpen && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center p-4 bg-black/90 pointer-events-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-sm bg-[#0B1426]/95 border-2 border-purple-500/40 rounded-3xl overflow-hidden shadow-[0_0_35px_rgba(168,85,247,0.25)] flex flex-col"
            >
              <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%)] bg-[size:100%_4px] opacity-25 z-0" />

              {/* Header */}
              <div className="relative z-10 border-b border-purple-500/20 p-4 bg-gradient-to-r from-purple-500/5 to-transparent flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Volume2 size={18} className="text-purple-400" />
                  <h3 className="text-white font-black text-sm tracking-widest font-sans uppercase">
                    НАСТРОЙКИ ЗВУКА
                  </h3>
                </div>
                <button
                  onClick={() => {
                    playSound("click");
                    setIsAudioSettingsOpen(false);
                  }}
                  className="p-1.5 bg-red-950/40 border border-red-500/40 rounded-full text-red-400 hover:bg-red-500 hover:text-white transition cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Content */}
              <div className="relative z-10 p-5 space-y-6">
                {/* Background Synth-wave Loop */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Music size={16} className="text-pink-400" />
                      <div>
                        <span className="text-xs font-bold text-white block uppercase tracking-wide">
                          Фоновый Синтвейв
                        </span>
                        <span className="text-[9px] text-gray-500 block font-mono">
                          120 BPM RETRO SYNTH LOOP
                        </span>
                      </div>
                    </div>
                    {/* Toggle Switch */}
                    <button
                      type="button"
                      onClick={() => {
                        playSound("click");
                        const nextState = !musicOn;
                        setMusicOn(nextState);
                        setMusicEnabled(nextState);
                      }}
                      className={`relative w-11 h-6 rounded-full p-1 transition-colors duration-300 cursor-pointer ${
                        musicOn
                          ? "bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.5)]"
                          : "bg-gray-800"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform duration-300 ${musicOn ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                  </div>

                  {musicOn && (
                    <div className="space-y-1.5 pl-6 animate-fadeIn">
                      <div className="flex justify-between text-[10px] font-mono text-gray-400">
                        <span>ГРОМКОСТЬ МУЗЫКИ</span>
                        <span className="text-purple-400 font-bold">
                          {Math.round(musicVol * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={musicVol}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          setMusicVol(val);
                          setMusicVolume(val);
                        }}
                        className="w-full accent-purple-500 bg-gray-800 rounded-lg appearance-none h-1.5 cursor-pointer"
                      />
                    </div>
                  )}
                </div>

                {/* Sound Effects Volume */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Volume2 size={16} className="text-cyan-400" />
                      <div>
                        <span className="text-xs font-bold text-white block uppercase tracking-wide">
                          Эффекты Действий
                        </span>
                        <span className="text-[9px] text-gray-500 block font-mono">
                          БРОСКИ, ШАГИ, КРИПТО-БОНУСЫ
                        </span>
                      </div>
                    </div>
                    {/* Toggle Switch */}
                    <button
                      type="button"
                      onClick={() => {
                        const nextState = !soundOn;
                        setSoundOn(nextState);
                        setSoundEnabled(nextState);
                        if (nextState) playSound("click");
                      }}
                      className={`relative w-11 h-6 rounded-full p-1 transition-colors duration-300 cursor-pointer ${
                        soundOn
                          ? "bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                          : "bg-gray-800"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform duration-300 ${soundOn ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                  </div>

                  {soundOn && (
                    <>
                      <div className="space-y-1.5 pl-6 animate-fadeIn">
                        <div className="flex justify-between text-[10px] font-mono text-gray-400">
                          <span>ГРОМКОСТЬ ЭФФЕКТОВ</span>
                          <span className="text-cyan-400 font-bold">
                            {Math.round(soundVol * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={soundVol}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setSoundVol(val);
                            setSoundVolume(val);
                          }}
                          className="w-full accent-cyan-500 bg-gray-800 rounded-lg appearance-none h-1.5 cursor-pointer"
                        />
                      </div>

                      <div className="pl-6 pt-1 animate-fadeIn">
                        <button
                          type="button"
                          onClick={() => {
                            playSound("laser");
                          }}
                          className="px-3 py-1.5 bg-cyan-950/40 border border-cyan-500/30 text-cyan-400 rounded-lg text-[9px] font-mono font-bold uppercase hover:bg-cyan-500/20 transition cursor-pointer"
                        >
                          🔊 Проверить лазер
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-purple-500/20 p-3 bg-black/60 text-center font-mono text-[8px] text-gray-500 uppercase tracking-widest">
                сохранено в локальной памяти хоста
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- ЗАПРОС НЕСКОЛЬКИХ ХОДОВ СРАЗУ --- */}
      {isTurnRequestOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 pointer-events-auto">
          <div className="relative w-full max-w-sm bg-[#151518] border-2 border-[#00ffaa]/40 rounded-2xl p-5 shadow-[0_0_40px_rgba(0,255,170,0.2)] font-sans text-[#e0e0e6] space-y-4">
            <div className="flex items-center justify-between border-b border-[#00ffaa]/20 pb-3">
              <span className="font-syne font-bold text-sm text-[#00ffaa] tracking-wider uppercase">
                Сколько ходов запросить
              </span>
              <button
                onClick={() => setIsTurnRequestOpen(false)}
                className="text-white/60 hover:text-white cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <p className="text-[11px] text-white/70 leading-relaxed font-mono">
              Если покупок было несколько, запросите все броски сразу — ждать одобрения между ними
              не придётся.
            </p>

            <div className="grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    playSound("click");
                    setRequestedTurns(n);
                  }}
                  className={`py-2 rounded-lg font-mono font-black text-sm border transition cursor-pointer ${
                    requestedTurns === n
                      ? "bg-[#00ffaa] text-black border-[#00ffaa] shadow-[0_0_12px_rgba(0,255,170,0.4)]"
                      : "bg-black/60 text-[#00ffaa] border-[#00ffaa]/30 hover:bg-[#00ffaa]/15"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setRequestedTurns((v) => Math.max(1, v - 1))}
                className="w-9 h-9 rounded-lg bg-white/5 border border-white/15 text-white font-mono text-base cursor-pointer hover:bg-white/10"
              >
                −
              </button>
              <div className="flex-1 text-center font-mono text-xs text-white/80">
                <b className="text-[#00ffaa] text-base">{requestedTurns}</b>{" "}
                {pluralizeTurns(requestedTurns)}
              </div>
              <button
                onClick={() => setRequestedTurns((v) => Math.min(10, v + 1))}
                className="w-9 h-9 rounded-lg bg-white/5 border border-white/15 text-white font-mono text-base cursor-pointer hover:bg-white/10"
              >
                +
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                playSound("success");
                onSendTurnRequest?.(requestedTurns);
                setIsTurnRequestOpen(false);
              }}
              className="w-full py-2.5 px-3 bg-[#00ffaa] text-black font-mono font-bold text-xs rounded-lg hover:bg-[#00ffaa]/80 transition cursor-pointer uppercase tracking-wider shadow-[0_0_15px_rgba(0,255,170,0.3)]"
            >
              Отправить запрос
            </button>
          </div>
        </div>
      )}

      {/* --- ADMIN BONUS CONFIRMATION MODAL --- */}
      {bonusConfirmPlayer && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 pointer-events-auto">
          <div className="relative w-full max-w-md bg-[#151518] border-2 border-yellow-500/50 rounded-2xl p-6 shadow-[0_0_40px_rgba(234,179,8,0.25)] font-sans text-[#e0e0e6] space-y-4">
            <div className="flex items-center gap-2 border-b border-yellow-500/20 pb-3 text-yellow-400 font-syne font-bold text-sm tracking-wider uppercase">
              <Gift size={20} className="animate-bounce text-yellow-400" />
              КОНТРОЛЬ ПРИЗОВ: НЕИСПОЛЬЗОВАННЫЙ БОНУС
            </div>

            <p className="text-xs text-white/80 leading-relaxed font-mono">
              Игрок{" "}
              <span
                className="font-bold text-[#00ffaa]"
                style={{ color: bonusConfirmPlayer.color }}
              >
                {bonusConfirmPlayer.name}
              </span>{" "}
              имеет активный полученный бонус:
            </p>

            <div className="bg-black/60 border border-yellow-500/30 rounded-xl p-3 space-y-1 font-mono text-xs">
              <div className="text-yellow-400 font-bold uppercase text-xs flex items-center gap-1.5">
                <span>🎁</span>
                <span>
                  {bonusConfirmPlayer.activeBonus?.extra || bonusConfirmPlayer.activeBonus?.name}
                </span>
              </div>
              {bonusConfirmPlayer.activeBonus?.description && (
                <div className="text-white/60 text-[10px]">
                  {bonusConfirmPlayer.activeBonus.description}
                </div>
              )}
            </div>

            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-[11px] text-yellow-200/90 leading-snug font-sans">
              ⚠️ <b>Правило игры:</b> Бонусы и призовые суммы не суммируются. Игрок может продолжить
              игру только после того, как использовал полученный бонус в реальной жизни!
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  playSound("success");
                  onApprovePlayerTurn?.(
                    bonusConfirmPlayer.id,
                    true,
                    grantTurns[bonusConfirmPlayer.id] ??
                      Math.min(10, Math.max(1, bonusConfirmPlayer.turnsRequested || 1))
                  );
                  setBonusConfirmPlayer(null);
                }}
                className="w-full btn py-2.5 px-3 bg-[#00ffaa] text-black font-mono font-bold text-xs rounded-lg hover:bg-[#00ffaa]/80 transition cursor-pointer uppercase tracking-wider shadow-[0_0_15px_rgba(0,255,170,0.3)]"
              >
                ✅ Подтвердить использование бонуса и одобрить ход
              </button>

              <button
                type="button"
                onClick={() => {
                  playSound("click");
                  onConsumeBonus?.(bonusConfirmPlayer.id);
                  setBonusConfirmPlayer(null);
                }}
                className="w-full btn py-2 px-3 bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 font-mono text-xs rounded-lg hover:bg-yellow-500/30 transition cursor-pointer uppercase tracking-wider"
              >
                🎁 Списать бонус (без одобрения хода)
              </button>

              <button
                type="button"
                onClick={() => setBonusConfirmPlayer(null)}
                className="w-full btn py-2 px-3 bg-white/5 border border-white/10 text-white/60 font-mono text-xs rounded-lg hover:bg-white/10 transition cursor-pointer uppercase tracking-wider"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {isCabinetOpen && (
        <PlayerCabinet
          me={me}
          gameState={gameState}
          prizes={me?.prizeLog || []}
          onClose={() => setIsCabinetOpen(false)}
        />
      )}
    </div>
  );
}
