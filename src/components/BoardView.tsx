import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { GameState, Player, Cell, CellType, CharacterClass } from "../types";
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
  Zap,
  LayoutGrid,
  Trophy,
  User,
  BarChart2,
} from "lucide-react";
import HelpScreen from "./HelpScreen";
import CellComponent from "./CellComponent";
import DiceRoll from "./DiceRoll";
import PlayerToken from "./PlayerToken";
import PlayerStatusBadge from "./PlayerStatusBadge";
import PlayerAvatarWithBadges from "./PlayerAvatarWithBadges";
import PlayerAchievementBadges from "./PlayerAchievementBadges";
import CellParticleEffect, { CellBurst } from "./CellParticleEffect";
import ActiveTurnIndicator from "./ActiveTurnIndicator";
import StatsSidebar from "./StatsSidebar";
import { turnsLeft, pluralizeTurns, DROP_BOX_CELL_IDS } from "../game/rules";
import { isTokenVisible } from "../game/presence";
import { describeEffect } from "../game/cellGuide";
import { getLoyaltyDiscountPercent, RANK_LABEL } from "../game/loyalty";
import { CLASS_LABEL } from "../game/encounters";
import PlayerCabinet from "./PlayerCabinet";
import InventoryBar from "./InventoryBar";
import { hapticImpact, hapticNotification, hapticSelection } from "../utils/haptics";
import { cleanPrizeText } from "../game/prizes";

interface BoardViewProps {
  gameState: GameState;
  onRoll: (item?: "shield" | "loaded_dice" | "magnet") => void;
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
  onUpdateSkin?: (chipImage: string, color: string) => void;
  onUpdateHero?: (data: {
    characterClass?: CharacterClass;
    avatar?: string;
    chipImage?: string;
    color?: string;
  }) => void;
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
  onUpdateSkin,
  onUpdateHero,
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
  // Временное положение перетаскиваемых пальцем клеток в режиме калибровки
  const [liveDragMap, setLiveDragMap] = useState<Record<number, { x: number; y: number }>>({});

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
  // Выбранный кибер-предмет из инвентаря для следующего броска ("shield" | "loaded_dice" | "magnet")
  const [selectedItem, setSelectedItem] = useState<"shield" | "loaded_dice" | "magnet" | null>(null);

  // Drawer states
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Close the navigation without touching the game state or the active roll.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleMenuEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };
    window.addEventListener("keydown", handleMenuEscape);
    return () => window.removeEventListener("keydown", handleMenuEscape);
  }, [isMenuOpen]);
  const [isPlayersDrawerOpen, setIsPlayersDrawerOpen] = useState(false);
  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [isCabinetOpen, setIsCabinetOpen] = useState(false);
  const [cabinetTab, setCabinetTab] = useState<"prizes" | "badges" | "skins" | "hero">("prizes");
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
  const [ecoMode, setEcoMode] = useState(() => {
    try {
      // Video loop is opt-in. Default ON eco (still PNG) — looping mp4
      // in Telegram WebView is what made the board unusable.
      const saved = localStorage.getItem("hcg_eco_mode");
      if (saved === "true") return true;
      return false;
    } catch {
      return true;
    }
  });

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
    snapVisualToServer();
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

  const me =
    gameState.players.find((p) => p.id === userId) ||
    gameState.players.find((p) => p.name === userId) ||
    gameState.players.find((p) => p.telegramUsername && `@${p.telegramUsername}` === userId);
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
    if (isRolling) return;
    setIsRolling(true);
    console.info(
      "[HCG] Отправляю roll:request",
      selectedItem ? `с предметом ${selectedItem}` : "без предметов",
      { isMyTurn, turnsLeft: myTurnsLeft, meId: me?.id }
    );
    setRolledNumber(null);
    onRoll(selectedItem || undefined);
    setSelectedItem(null);
  };

  // Start the 3D animation as soon as the server result arrives.
  useEffect(() => {
    if (pendingRoll !== null) {
      rollSessionRef.current += 1;
      setIsRolling(true);
    } else {
      setIsRolling(false);
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
    const hidden = typeof document !== "undefined" && document.hidden;
    if (isRolling || ecoMode || hidden) {
      video.pause();
      return;
    }
    const started = video.play() as Promise<void> | undefined;
    if (started && typeof started.catch === "function") started.catch(() => undefined);
  }, [isRolling, ecoMode]);

  useEffect(() => {
    const onVis = () => {
      const video = boardVideoRef.current;
      if (!video || ecoMode) return;
      if (document.hidden || isRolling) {
        video.pause();
        return;
      }
      const started = video.play() as Promise<void> | undefined;
      if (started && typeof started.catch === "function") started.catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [ecoMode, isRolling]);

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
      {/* Black shell: no second video, no CSS blur, no particle canvas. */}

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

      {/* --- FULLSCREEN CYBER MAIN MENU DRAWER --- */}
      <AnimatePresence>
            {isMenuOpen && (
              <motion.div
                key="hcg-menu-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="fixed inset-0 z-[160] flex justify-center pointer-events-auto"
              >
                <button
                  type="button"
                  aria-label="Закрыть меню"
                  className="absolute inset-0 w-full h-full bg-[#020811]/92 cursor-default"
                  onClick={() => setIsMenuOpen(false)}
                />
                <motion.nav
                  id="hcg-main-menu"
                  data-testid="hcg-main-menu"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Главное меню HCG"
                  initial={{ y: 30, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 30, opacity: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="relative flex flex-col w-full max-w-[480px] h-full min-h-0 overflow-hidden bg-[#050c17] text-white shadow-[0_0_80px_rgba(0,255,170,0.16)] border-x border-[#00ffaa]/20"
                >
                  <div className="relative shrink-0 px-5 pt-[max(22px,env(safe-area-inset-top))] pb-6 border-b border-[#00ffaa]/20 overflow-hidden">
                    <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-24 w-64 h-64 rounded-full bg-[#00ffaa]/10 blur-3xl" />
                    <div className="relative flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[10px] uppercase tracking-[0.32em] text-[#00ffaa] font-mono font-black">
                          HAPSTORE CYBER GAME
                        </p>
                        <h2 className="mt-3 font-black text-[30px] leading-none tracking-tight uppercase">
                          ГЛАВНОЕ <span className="text-[#00ffaa]">МЕНЮ</span>
                        </h2>
                        <p className="mt-2 text-[11px] font-mono text-white/50 tracking-wide">
                          ПАНЕЛЬ УПРАВЛЕНИЯ · HCG
                        </p>
                      </div>
                      <button
                        type="button"
                        autoFocus
                        aria-label="Закрыть главное меню"
                        onClick={() => setIsMenuOpen(false)}
                        className="shrink-0 grid place-items-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-xl bg-white/5 border border-white/20 hover:border-[#00ffaa] hover:text-[#00ffaa] transition-colors cursor-pointer"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5 space-y-6 scrollbar-none">
                    <section aria-labelledby="hcg-menu-game-section">
                      <h3 id="hcg-menu-game-section" className="px-2 mb-3 text-[10px] uppercase tracking-[0.24em] font-black font-mono text-white/45">01 / ГОРОД</h3>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button
                          type="button"
                          data-testid="menu-board"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); }}
                          className="col-span-2 flex items-center gap-3 rounded-2xl border border-[#00ffaa]/60 bg-gradient-to-r from-[#00ffaa]/20 to-[#00ffaa]/5 px-4 py-4 text-left hover:bg-[#00ffaa]/25 transition-colors"
                        >
                          <Zap size={21} className="text-[#00ffaa] shrink-0" />
                          <span className="flex-1"><strong className="block text-sm font-black tracking-wide">ВЕРНУТЬСЯ В ИГРУ</strong><span className="block text-[10px] text-white/55 mt-1 font-mono">Продолжить на игровом поле</span></span>
                          <span className="text-[#00ffaa] text-xl" aria-hidden="true">›</span>
                        </button>
                        <button
                          type="button"
                          data-testid="menu-players"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); setIsPlayersDrawerOpen(true); setIsChatDrawerOpen(false); }}
                          className="flex min-h-[90px] flex-col justify-center gap-2.5 rounded-2xl bg-[#101d29] border border-white/10 px-4 text-left hover:border-[#00ffaa]/50 transition-colors"
                        ><Users size={20} className="text-[#00ffaa]" /><strong className="text-[12px] tracking-wide">ИГРОКИ</strong></button>
                        <button
                          type="button"
                          data-testid="menu-chat"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); setIsChatDrawerOpen(true); setIsPlayersDrawerOpen(false); }}
                          className="flex min-h-[90px] flex-col justify-center gap-2.5 rounded-2xl bg-[#101d29] border border-white/10 px-4 text-left hover:border-[#00ffaa]/50 transition-colors"
                        ><MessageSquare size={20} className="text-[#00ffaa]" /><strong className="text-[12px] tracking-wide">ЧАТ</strong></button>
                        <button
                          type="button"
                          data-testid="menu-rules"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); openRules(); }}
                          className="flex min-h-[90px] flex-col justify-center gap-2.5 rounded-2xl bg-[#101d29] border border-white/10 px-4 text-left hover:border-[#f5c542]/50 transition-colors"
                        ><BookOpen size={20} className="text-[#f5c542]" /><strong className="text-[12px] tracking-wide">ПРАВИЛА</strong></button>
                        <button
                          type="button"
                          data-testid="menu-help"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); setIsHelpOpen(true); }}
                          className="flex min-h-[90px] flex-col justify-center gap-2.5 rounded-2xl bg-[#101d29] border border-white/10 px-4 text-left hover:border-[#f5c542]/50 transition-colors"
                        ><HelpCircle size={20} className="text-[#f5c542]" /><strong className="text-[12px] tracking-wide">СПРАВКА</strong></button>
                      </div>
                    </section>

                    <section aria-labelledby="hcg-menu-profile-section">
                      <h3 id="hcg-menu-profile-section" className="px-2 mb-3 text-[10px] uppercase tracking-[0.24em] font-black font-mono text-white/45">02 / ЛИЧНЫЙ КАБИНЕТ</h3>
                      <div className="space-y-2.5">
                        <button
                          type="button"
                          data-testid="menu-cabinet"
                          onClick={() => { playSound("click"); setCabinetTab("hero"); setIsMenuOpen(false); setIsCabinetOpen(true); }}
                          className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 bg-[#101d29] border border-[#00ffaa]/25 text-left hover:border-[#00ffaa]/60 transition-colors cursor-pointer"
                        >
                          <Zap size={18} className="text-[#00ffaa]" />
                          <span className="flex-1 text-xs font-black tracking-wide">Мой кабинет</span>
                          <span aria-hidden="true" className="text-white/40">›</span>
                        </button>
                        <button
                          type="button"
                          data-testid="menu-prizes"
                          onClick={() => { playSound("click"); setCabinetTab("prizes"); setIsMenuOpen(false); setIsCabinetOpen(true); }}
                          className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 bg-[#101d29] border border-[#f5c542]/20 text-left hover:border-[#f5c542]/60 transition-colors cursor-pointer"
                        >
                          <Award size={18} className="text-[#f5c542]" />
                          <span className="flex-1 text-xs font-black tracking-wide">МОИ ПРИЗЫ</span>
                          <span aria-hidden="true" className="text-white/40">›</span>
                        </button>
                        <button
                          type="button"
                          data-testid="menu-settings"
                          onClick={() => { playSound("click"); setIsMenuOpen(false); setIsAudioSettingsOpen(true); }}
                          className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 bg-[#101d29] border border-white/10 text-left hover:border-white/40 transition-colors cursor-pointer"
                        >
                          <Sliders size={18} className="text-[#a9a0ff]" />
                          <span className="flex-1 text-xs font-black tracking-wide">НАСТРОЙКИ</span>
                          <span aria-hidden="true" className="text-white/40">›</span>
                        </button>
                        {userRole === "admin" && (
                          <button
                            type="button"
                            data-testid="menu-admin"
                            onClick={() => { playSound("laser"); setIsMenuOpen(false); openAdminPanel(); }}
                            className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 bg-[#101d29] border border-blue-400/25 text-left hover:border-blue-400/60 transition-colors cursor-pointer"
                          >
                            <Shield size={18} className="text-blue-400" />
                            <span className="flex-1 text-xs font-black tracking-wide">АДМИНКА</span>
                            <span aria-hidden="true" className="text-white/40">›</span>
                          </button>
                        )}
                      </div>
                    </section>
                  </div>
                  <div className="shrink-0 p-4 pb-[max(16px,env(safe-area-inset-bottom))] border-t border-white/10 bg-[#050c17]">
                    <button
                      type="button"
                      data-testid="menu-logout"
                      onClick={() => { playSound("click"); setIsMenuOpen(false); onLogout(); }}
                      className="w-full flex items-center justify-center gap-3 rounded-xl border border-red-400/30 bg-red-500/5 px-4 py-3.5 text-red-300 hover:bg-red-500/15 transition-colors"
                    ><LogOut size={17} /><span className="text-xs font-black tracking-wider">ВЫЙТИ ИЗ ИГРЫ</span></button>
                  </div>
                </motion.nav>
              </motion.div>
            )}
          </AnimatePresence>

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
              className="absolute left-0 top-0 bottom-0 w-[290px] bg-black/95 backdrop-blur-xl border-r border-[#00ffaa]/20 z-50 p-5 pt-[max(20px,env(safe-area-inset-top))] pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-5 select-none pointer-events-auto shadow-2xl"
            >
              <div className="flex justify-between items-center border-b border-white/10 pb-3.5">
                <span className="font-mono text-[10px] font-black text-[#00ffaa] uppercase tracking-[0.2em]">
                  АКТИВНЫЕ ИГРОКИ
                </span>
                <button
                  onClick={() => setIsPlayersDrawerOpen(false)}
                  className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 flex items-center justify-center text-white/60 hover:text-white cursor-pointer"
                  aria-label="Закрыть список игроков"
                >
                  <X size={18} />
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
              className="absolute right-0 top-0 bottom-0 w-[300px] bg-black/95 backdrop-blur-xl border-l border-purple-500/20 z-50 p-5 pt-[max(20px,env(safe-area-inset-top))] pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-4 select-none pointer-events-auto shadow-2xl"
            >
              <div className="flex justify-between items-center border-b border-white/10 pb-3.5">
                <div className="flex bg-black border border-white/10 p-0.5 rounded-lg font-mono text-[9px] font-bold">
                  <button
                    onClick={() => {
                      playSound("click");
                      setActiveChatTab("chat");
                    }}
                    className={`min-h-[44px] px-3 py-1.5 rounded-md transition duration-200 cursor-pointer flex items-center justify-center ${activeChatTab === "chat" ? "bg-purple-500/20 text-white" : "text-gray-400"}`}
                  >
                    ЧАТ
                  </button>
                  <button
                    onClick={() => {
                      playSound("click");
                      setActiveChatTab("logs");
                    }}
                    className={`min-h-[44px] px-3 py-1.5 rounded-md transition duration-200 cursor-pointer flex items-center justify-center ${activeChatTab === "logs" ? "bg-cyan-500/20 text-[#00FFFF]" : "text-gray-400"}`}
                  >
                    СОБЫТИЯ
                  </button>
                </div>
                <button
                  onClick={() => setIsChatDrawerOpen(false)}
                  className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 flex items-center justify-center text-white/60 hover:text-white cursor-pointer"
                  aria-label="Закрыть чат"
                >
                  <X size={18} />
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
                    <div className="flex gap-1.5 items-center">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={replyTo ? "Ваш ответ..." : "Сообщение..."}
                      className="flex-1 min-h-[44px] bg-black border border-white/10 rounded-lg text-xs text-white px-3 py-2 focus:outline-none focus:border-purple-500 font-sans"
                    />
                    <button
                      type="submit"
                      aria-label="Отправить сообщение"
                      className="min-w-[44px] min-h-[44px] bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500 hover:text-white px-3 py-2 rounded-lg transition duration-200 cursor-pointer flex items-center justify-center shrink-0"
                    >
                      <Send size={15} />
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
        <div className="relative h-full w-full max-w-[56.25vh] bg-[#050811] shadow-[0_0_80px_rgba(0,0,0,0.9)] flex-shrink-0 overflow-hidden">
          {/* Игровая карта 9:16: приподнята так, чтобы нижняя часть поля (клетка 0 СТАРТ) не перекрывалась кнопкой броска */}
          <div
            ref={boardRef}
            onClick={handleBoardClick}
            className="board-container absolute top-0 left-0 right-0 bottom-[126px] aspect-[9/16] max-w-[calc((100vh-126px)*9/16)] mx-auto overflow-hidden select-none"
          >
            {/* --- TOP FLOATING OVERLAY HUD --- */}
            <div className="absolute top-0 left-0 right-0 pt-[max(6px,env(safe-area-inset-top))] px-2.5 z-40 pointer-events-none flex flex-col items-center">
              {/* Top Cyber Banner: HCG — HAPSTORE CYBER GAME */}
              <div className="w-full flex items-center justify-center gap-2 py-0.5 select-none pointer-events-none mb-1">
                <div className="h-[1px] w-6 md:w-10 bg-gradient-to-r from-transparent to-[#00f0ff]" />
                <span className="font-syne font-black italic tracking-[0.22em] text-[#00f0ff] text-[10px] md:text-xs drop-shadow-[0_0_8px_rgba(0,240,255,0.8)]">
                  HCG — HAPSTORE CYBER GAME
                </span>
                <div className="h-[1px] w-6 md:w-10 bg-gradient-to-l from-transparent to-[#00f0ff]" />
              </div>

              {/* Top Status Cards Row: Hero Card | Core 64 Capsule | Lap Capsule */}
              <div className="w-full flex items-center justify-between gap-1.5 pointer-events-auto select-none">
                {/* Left: Hero Card with chamfered corner */}
                <button
                  type="button"
                  onClick={() => {
                    playSound("click");
                    setCabinetTab("hero");
                    setIsCabinetOpen(true);
                  }}
                  className="flex items-center gap-2 px-2 py-1 bg-[#050c18]/90 border border-[#00f0ff]/60 hover:border-[#00f0ff] hover:bg-[#071529]/95 transition cursor-pointer shadow-[0_0_15px_rgba(0,240,255,0.3)] text-left min-w-0 rounded-xl"
                  style={{
                    clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)",
                  }}
                  title="Окно героя"
                >
                  <div className="w-[32px] h-[32px] rounded-full border border-[#00f0ff] overflow-hidden bg-black/60 shrink-0 shadow-[0_0_8px_rgba(0,240,255,0.5)]">
                    <img
                      src={me?.avatar || me?.chipImage || "/avatars/m_1.svg"}
                      alt="Hero"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = "none";
                      }}
                    />
                  </div>
                  <div className="flex flex-col min-w-0 leading-tight">
                    <span className="text-[7.5px] font-mono text-[#00f0ff]/80 uppercase leading-none font-bold">
                      Герой
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="text-[9.5px] font-mono font-black text-white truncate max-w-[75px]">
                        {CLASS_LABEL[me?.characterClass || "picker"] || me?.alias || "Хром-джек"}
                      </span>
                      <span className="text-[8px] text-[#00f0ff] font-bold">˅</span>
                    </div>
                    {/* Level & XP */}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[8px] font-mono font-black text-white">
                        Ур. {(me as any)?.characterLevel || 7}
                      </span>
                      <div className="w-10 h-1.5 bg-black/60 border border-[#00f0ff]/40 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-[#00f0ff] to-[#00ffaa] shadow-[0_0_6px_#00f0ff]"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.max(
                                15,
                                Math.round(
                                  (((me as any)?.characterExp || 70) /
                                    (((me as any)?.characterLevel || 7) * 200)) *
                                    100
                                )
                              )
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </button>

                {/* Center: Core 64 Goal Plaque as in screenshot */}
                <button
                  type="button"
                  onClick={() => {
                    playSound("click");
                    const cell64 = gameState.cells?.find((c) => c.id === 64);
                    if (cell64) setSelectedCell(cell64);
                  }}
                  className="flex flex-col items-center justify-center px-3.5 py-1 bg-gradient-to-b from-[#081830]/95 to-[#040a14]/95 border border-[#00f0ff]/70 hover:border-[#00ffaa] transition cursor-pointer shadow-[0_0_16px_rgba(0,240,255,0.4)] select-none shrink-0 rounded-2xl"
                  title="Главный приз"
                >
                  <div className="font-mono text-[9px] md:text-[10px] font-black text-[#00f0ff] tracking-wider uppercase leading-none">
                    ЯДРО <span className="text-white/60">•</span> <span className="text-[#facc15]">клетка 64</span>
                  </div>
                  <span className="font-mono text-[7.5px] md:text-[8px] text-white/95 tracking-tight whitespace-nowrap mt-0.5 drop-shadow-[0_0_4px_rgba(0,240,255,0.5)]">
                    Главный приз — МЕГА-КРИСТАЛЛ
                  </span>
                </button>

                {/* Right: Round Lap Capsule */}
                <div
                  className="px-3 py-1.5 bg-gradient-to-b from-[#081830]/95 to-[#040a14]/95 border border-[#00f0ff]/70 shadow-[0_0_15px_rgba(0,240,255,0.35)] text-white font-mono text-[10px] md:text-xs font-black tracking-wider uppercase select-none rounded-xl flex items-center justify-center shrink-0"
                >
                  КРУГ {((me as any)?.lapsCompleted ?? (me as any)?.lap ?? 0) + 1}
                </div>
              </div>
            </div>

          {/* --- LEFT VERTICAL INVENTORY DOCK (AS PER OWNER SCREENSHOT) --- */}
          <div className="absolute top-[72px] left-2 z-30 pointer-events-auto">
            <InventoryBar
              inventory={me?.inventory}
              activeItem={selectedItem}
              onToggleItem={(item) => setSelectedItem((prev) => (prev === item ? null : item))}
              disabled={isRolling || !isMyTurn}
            />
          </div>

          {/* Background Map: Video with GPU acceleration or Static Image in Eco Mode */}
          {ecoMode ? (
            <img
              src="/BoardHAP.png?v=16"
              alt="Игровое поле"
              className="absolute inset-0 w-full h-full object-fill opacity-100 pointer-events-none z-0"
            />
          ) : (
            <video
              ref={boardVideoRef}
              src="/BoardHAP.mp4?v=16"
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              poster="/BoardHAP.png?v=16"
              disablePictureInPicture
              disableRemotePlayback
              className="absolute inset-0 w-full h-full object-fill pointer-events-none z-0 [transform:translateZ(0)]"
            />
          )}

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
                  .map((cell, idx) => {
                    const live = liveDragMap[cell.id];
                    const px = live ? live.x : cell.x;
                    const py = live ? live.y : cell.y;
                    return `${idx === 0 ? "M" : "L"} ${px} ${py}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="rgba(0, 255, 170, 0.4)"
                strokeWidth="0.8"
                strokeDasharray="2 2"
                className="animate-[dash_10s_linear_infinite]"
              />
            </svg>
          )}

          {/* Режим калибровки: админ-индикатор */}
          {Boolean(gameState.calibrationMode && userRole === "admin") && (
            <div className="absolute top-[62px] left-1/2 -translate-x-1/2 z-40 bg-black/90 border border-[#00f0ff] px-3 py-1 rounded-full text-center shadow-[0_0_15px_rgba(0,240,255,0.5)] pointer-events-auto flex items-center gap-1.5 select-none animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00f0ff]" />
              <span className="font-mono text-[8.5px] font-bold text-white tracking-wider uppercase">
                РЕЖИМ КАЛИБРОВКИ: ТЯНИТЕ КЛЕТКИ ПАЛЬЦЕМ
              </span>
            </div>
          )}

          {/* Cyber Particle Burst Overlay */}
          {/* Particle bursts disabled: they re-painted the board every hop and fought the video decoder. */}

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
                isDropBox={DROP_BOX_CELL_IDS.includes(cell.id)}
                boardElement={boardRef.current}
                onCalibrateMove={(cellId, x, y) => {
                  setLiveDragMap((prev) => ({ ...prev, [cellId]: { x, y } }));
                }}
                onCalibrateEnd={(cellId, x, y) => {
                  setLiveDragMap((prev) => {
                    const next = { ...prev };
                    delete next[cellId];
                    return next;
                  });
                  onCalibrateCell({
                    cellId,
                    x: parseFloat(x.toFixed(2)),
                    y: parseFloat(y.toFixed(2)),
                  });
                  onSelectCalibrationCell?.(cellId);
                }}
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

              const liveCell = liveDragMap[currentCellId];
              const cellPosX = liveCell ? liveCell.x : cell.x;
              const cellPosY = liveCell ? liveCell.y : cell.y;

              return (
                <div
                  key={player.id}
                  className="absolute z-30 pointer-events-none"
                  style={{
                    left: `${cellPosX + offsetX}%`,
                    top: `${cellPosY + offsetY}%`,
                  }}
                >
                  <div className="relative -translate-x-1/2 -translate-y-1/2">
                    <PlayerToken
                      player={player}
                      pIdx={pIdx}
                      isActionCell={isActionCell}
                      isMe={player.id === me?.id}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* --- BOTTOM GAME BOARD ACTION HUD PANEL (Расположен строго ПОД картой) --- */}
          {/* 1. Active Prize Control Bonus Notice */}
          {me?.activeBonus && (
            <div className="absolute bottom-[130px] left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex flex-col items-center w-full max-w-xs px-2">
              <div className="bg-yellow-950/95 border border-yellow-500/70 rounded-xl p-2.5 text-center w-full shadow-[0_0_15px_rgba(234,179,8,0.3)] flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 font-syne text-[10px] text-yellow-400 font-extrabold uppercase tracking-wider">
                  <Gift size={14} className="text-yellow-400 animate-bounce" />
                  <span>СТАТУС: ЖДЁТ СПИСАНИЯ 🎁</span>
                </div>
                <div className="text-[11px] font-mono font-bold text-yellow-300 bg-black/60 px-2 py-0.5 rounded border border-yellow-500/40 truncate max-w-full">
                  {cleanPrizeText(me.activeBonus.extra || me.activeBonus.name)}
                </div>
                <p className="text-[9px] font-sans text-yellow-100/80 leading-tight">
                  Пока есть броски пачки — ходите. Новую пачку откроют после выдачи приза на кассе.
                </p>
              </div>
            </div>
          )}

          {/* 2. Cyber-Drop Coupons Floating Indicator */}
          {(me?.prizeLog || [])
            .filter((r) => !r.redeemed && typeof r.extra === "string" && r.extra.startsWith("HAP-"))
            .slice(-1)
            .map((r) => (
              <div
                key={r.extra}
                className="absolute bottom-[130px] left-3 z-30 pointer-events-auto bg-black/85 border border-[#f5c542] rounded-lg px-2.5 py-1 text-center shadow-lg"
              >
                <div className="font-mono text-[8px] text-white/60 uppercase">КУПОН ДРОПА</div>
                <div className="font-mono font-black text-[10px] text-[#f5c542] tracking-wider">
                  {r.extra}
                </div>
              </div>
            ))}
        </div>
        {/* --- END OF BOARD CONTAINER --- */}

        {/* --- ACTION CTA DOCK: TURNS COUNTER & ROLL BUTTON (Centered above navigation bar) --- */}
        <div className="absolute bottom-[56px] left-0 right-0 z-30 pointer-events-none flex flex-col items-center justify-center gap-1.5 px-4">
          {/* Turns Counter Plaque: ВАШИ ХОДЫ / ХОД ОДОБРЕН */}
          <div className="pointer-events-auto px-4 py-1 bg-[#050c18]/95 border border-[#00f0ff]/70 rounded-full flex items-center gap-2 shadow-[0_0_15px_rgba(0,240,255,0.4)] select-none">
            <span className="font-mono text-[9px] md:text-[10px] font-bold text-white/90 tracking-wider">
              {myTurnsLeft > 1
                ? `ХОДОВ: ${myTurnsLeft}`
                : hasApprovedTurn || isMyTurn
                ? "ХОД ОДОБРЕН"
                : "ВАШИ ХОДЫ:"}
            </span>
            {myTurnsLeft > 1 ? (
              <span className="font-mono text-[9px] font-black text-[#00ffaa] drop-shadow-[0_0_8px_rgba(0,255,170,0.85)]">
                ОСТАЛОСЬ {myTurnsLeft}
              </span>
            ) : !hasApprovedTurn && !isMyTurn ? (
              <span className="font-mono text-[13px] md:text-[14px] font-black text-[#facc15] drop-shadow-[0_0_8px_rgba(250,204,21,0.85)]">
                {myTurnsLeft}
              </span>
            ) : null}
          </div>

          {/* Wide Cyber CTA Button */}
          <div className="pointer-events-auto w-full max-w-[280px]">
            {hasApprovedTurn || isMyTurn ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isRolling) {
                    playSound("click");
                    return;
                  }
                  hapticImpact("heavy");
                  handleRoll();
                }}
                disabled={isRolling}
                className="w-full relative group h-[44px] px-4 bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 text-black font-black uppercase tracking-wider flex items-center justify-center gap-2.5 shadow-[0_0_24px_rgba(245,158,11,0.85)] hover:brightness-110 active:scale-95 transition cursor-pointer select-none rounded-xl border border-yellow-200"
                style={{
                  clipPath: "polygon(12px 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 12px 100%, 0 50%)",
                }}
                title="Бросить кубик"
              >
                <div className="relative w-7 h-7 shrink-0 flex items-center justify-center">
                  <img
                    src="/Dice.png?v=16"
                    alt="Кубик"
                    className="w-6 h-6 object-contain drop-shadow-[0_0_6px_rgba(0,0,0,0.8)] relative z-10"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "/assets/ui/icon_loaded_dice.png";
                    }}
                  />
                </div>
                <span className="font-syne font-black text-sm text-black tracking-wider drop-shadow-sm">
                  {isRolling ? "БРОСОК..." : "БРОСИТЬ КУБИК"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  playSound("click");
                  setIsTurnRequestOpen(true);
                }}
                disabled={!!me?.turnRequested}
                className={`w-full h-[44px] px-4 border font-mono font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(0,255,170,0.3)] transition active:scale-95 cursor-pointer rounded-xl ${
                  me?.turnRequested
                    ? "bg-amber-500/20 border-amber-400 text-amber-300 animate-pulse"
                    : "bg-[#050c18]/95 border-[#00ffaa] text-[#00ffaa] hover:bg-[#00ffaa]/20"
                }`}
                style={{
                  clipPath: "polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%)",
                }}
                title="Запросить ход"
              >
                <div className="relative w-6 h-6 shrink-0 flex items-center justify-center">
                  <img
                    src="/Dice.png?v=16"
                    alt="Кубик"
                    className={`w-5 h-5 object-contain ${
                      me?.turnRequested ? "opacity-90" : "opacity-75 grayscale-[25%]"
                    }`}
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = "/assets/ui/icon_loaded_dice.png";
                    }}
                  />
                </div>
                <span>
                  {me?.turnRequested
                    ? me?.turnsRequested && me.turnsRequested > 1
                      ? `ЗАПРОШЕНО: ${me.turnsRequested}`
                      : "ХОД ЗАПРОШЕН"
                    : "ЗАПРОСИТЬ ХОД"}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* --- BOTTOM NAVIGATION BAR (6 BUTTONS AS PER OWNER SCREENSHOT) --- */}
        <div className="absolute bottom-0 left-0 right-0 z-50 pointer-events-auto bg-[#030712]/95 border-t border-[#00f0ff]/30 backdrop-blur-xl px-1.5 pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-6 gap-1 w-full max-w-md mx-auto">
            {/* 1. МЕНЮ */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setIsMenuOpen(true);
              }}
              className="min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Главное меню"
            >
              <LayoutGrid size={16} />
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                МЕНЮ
              </span>
            </button>

            {/* 2. ЧАТ */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setIsChatDrawerOpen(true);
              }}
              className="relative min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Чат"
            >
              <MessageSquare size={16} />
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                ЧАТ
              </span>
              {(gameState.chatMessages?.length || 0) > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-[#00ffaa] rounded-full animate-ping" />
              )}
            </button>

            {/* 3. ИГРОКИ */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setIsPlayersDrawerOpen(true);
              }}
              className="min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Игроки и рейтинг"
            >
              <BarChart2 size={16} />
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                ИГРОКИ
              </span>
            </button>

            {/* 4. МОИ ПРИЗЫ */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setCabinetTab("prizes");
                setIsCabinetOpen(true);
              }}
              className="min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Мои призы"
            >
              <Trophy size={16} />
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                МОИ ПРИЗЫ
              </span>
            </button>

            {/* 5. Мой кабинет */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setCabinetTab("hero");
                setIsCabinetOpen(true);
              }}
              className="min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Личный кабинет"
            >
              <User size={16} />
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                Мой кабинет
              </span>
            </button>

            {/* 6. Герой */}
            <button
              type="button"
              onClick={() => {
                playSound("click");
                hapticSelection();
                setCabinetTab("hero");
                setIsCabinetOpen(true);
              }}
              className="min-h-[46px] flex flex-col items-center justify-center gap-1 py-1 px-0.5 rounded-xl bg-gradient-to-b from-[#081830]/90 to-[#020712]/95 border border-[#00f0ff]/40 hover:border-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all duration-150 active:scale-95 cursor-pointer text-[#00f0ff]"
              title="Выбор героя"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2C6.48 2 2 6.48 2 12C2 15.5 3.8 18.6 6.5 20.4L7 17C7 16.4 7.4 16 8 16H16C16.6 16 17 16.4 17 17L17.5 20.4C20.2 18.6 22 15.5 22 12C22 6.48 17.52 2 12 2Z" />
                <path d="M9 11L10 13H14L15 11" />
                <line x1="8" y1="9" x2="10" y2="9" />
                <line x1="14" y1="9" x2="16" y2="9" />
              </svg>
              <span className="font-mono text-[8px] font-bold tracking-tight text-white/95 uppercase leading-none">
                Герой
              </span>
            </button>
          </div>
        </div>
      </main>

      {/* --- FLOATING CELL PREVIEW DRAWER --- */}
      <AnimatePresence>
        {selectedCell && (
          <div
            className="fixed inset-0 z-[130] flex items-center justify-center p-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] bg-black/75 pointer-events-auto overflow-y-auto"
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
                  className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 flex items-center justify-center text-white/60 hover:text-white cursor-pointer"
                  aria-label="Закрыть превью клетки"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="font-syne font-extrabold text-sm text-white uppercase tracking-wider">
                {selectedCell.name}
              </div>
              <div className="bg-white/5 p-3 rounded-lg border border-white/5 text-[11px] leading-relaxed text-gray-300 font-sans">
                <div className="text-[#00ffaa] font-bold mb-1">{cleanPrizeText(describeEffect(selectedCell))}</div>
                {cleanPrizeText(selectedCell.description) || "Обычная клетка."}
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
          <div className="fixed inset-0 z-[140] flex items-center justify-center p-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] bg-black/90 pointer-events-auto overflow-y-auto">
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
                    НАСТРОЙКИ
                  </h3>
                </div>
                <button
                  onClick={() => {
                    playSound("click");
                    setIsAudioSettingsOpen(false);
                  }}
                  className="min-w-[44px] min-h-[44px] -mr-2 -mt-1 p-2 bg-red-950/40 border border-red-500/40 rounded-full text-red-400 hover:bg-red-500 hover:text-white transition cursor-pointer flex items-center justify-center"
                  aria-label="Закрыть настройки"
                >
                  <X size={16} />
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

                {/* Eco Mode / Background Video Toggle */}
                <div className="space-y-3 pt-2 border-t border-white/10">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Zap size={16} className="text-amber-400" />
                      <div>
                        <span className="text-xs font-bold text-white block uppercase tracking-wide">
                          ЭКО-РЕЖИМ (ФОН)
                        </span>
                        <span className="text-[9px] text-gray-500 block font-mono">
                          {ecoMode ? "СТАТИЧНЫЙ ФОН (БЕЗ ЛАГОВ 60 FPS)" : "ЖИВОЙ АНИМИРОВАННЫЙ ВИДЕОФОН"}
                        </span>
                      </div>
                    </div>
                    {/* Toggle Switch */}
                    <button
                      type="button"
                      onClick={() => {
                        playSound("click");
                        const nextState = !ecoMode;
                        setEcoMode(nextState);
                        try {
                          localStorage.setItem("hcg_eco_mode", String(nextState));
                        } catch {}
                      }}
                      className={`relative w-11 h-6 rounded-full p-1 transition-colors duration-300 cursor-pointer ${
                        ecoMode
                          ? "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]"
                          : "bg-gray-800"
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform duration-300 ${ecoMode ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                  </div>
                  <p className="text-[10px] text-gray-400 leading-relaxed font-sans pl-6">
                    Включите, если анимация поля подтормаживает или греется телефон. Видео заменится на сверхлегкую чёткую картинку.
                  </p>
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
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] bg-black/85 pointer-events-auto overflow-y-auto">
          <div className="relative w-full max-w-sm bg-[#151518] border-2 border-[#00ffaa]/40 rounded-2xl p-5 shadow-[0_0_40px_rgba(0,255,170,0.2)] font-sans text-[#e0e0e6] space-y-4">
            <div className="flex items-center justify-between border-b border-[#00ffaa]/20 pb-3">
              <span className="font-syne font-bold text-sm text-[#00ffaa] tracking-wider uppercase">
                Сколько ходов запросить
              </span>
              <button
                onClick={() => setIsTurnRequestOpen(false)}
                className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 flex items-center justify-center text-white/60 hover:text-white cursor-pointer"
                aria-label="Закрыть запрос ходов"
              >
                <X size={18} />
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
                    hapticSelection();
                    setRequestedTurns(n);
                  }}
                  className={`min-h-[44px] py-2 rounded-lg font-mono font-black text-sm border transition cursor-pointer flex items-center justify-center ${
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
                onClick={() => {
                  hapticSelection();
                  setRequestedTurns((v) => Math.max(1, v - 1));
                }}
                className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg bg-white/5 border border-white/15 text-white font-mono text-lg cursor-pointer hover:bg-white/10 flex items-center justify-center"
              >
                −
              </button>
              <div className="flex-1 text-center font-mono text-xs text-white/80">
                <b className="text-[#00ffaa] text-base">{requestedTurns}</b>{" "}
                {pluralizeTurns(requestedTurns)}
              </div>
              <button
                onClick={() => {
                  hapticSelection();
                  setRequestedTurns((v) => Math.min(10, v + 1));
                }}
                className="w-11 h-11 min-w-[44px] min-h-[44px] rounded-lg bg-white/5 border border-white/15 text-white font-mono text-lg cursor-pointer hover:bg-white/10 flex items-center justify-center"
              >
                +
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                playSound("success");
                hapticNotification("success");
                onSendTurnRequest?.(requestedTurns);
                setIsTurnRequestOpen(false);
              }}
              className="w-full min-h-[44px] py-2.5 px-3 bg-[#00ffaa] text-black font-mono font-bold text-xs rounded-lg hover:bg-[#00ffaa]/80 transition cursor-pointer uppercase tracking-wider shadow-[0_0_15px_rgba(0,255,170,0.3)] flex items-center justify-center"
            >
              Отправить запрос
            </button>
          </div>
        </div>
      )}

      {/* --- ADMIN BONUS CONFIRMATION MODAL --- */}
      {bonusConfirmPlayer && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))] bg-black/85 pointer-events-auto overflow-y-auto">
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
                  {cleanPrizeText(bonusConfirmPlayer.activeBonus?.extra || bonusConfirmPlayer.activeBonus?.name)}
                </span>
              </div>
              {bonusConfirmPlayer.activeBonus?.description && (
                <div className="text-white/60 text-[10px]">
                  {cleanPrizeText(bonusConfirmPlayer.activeBonus.description)}
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
                className="w-full btn min-h-[44px] py-2.5 px-3 bg-[#00ffaa] text-black font-mono font-bold text-xs rounded-lg hover:bg-[#00ffaa]/80 transition cursor-pointer uppercase tracking-wider shadow-[0_0_15px_rgba(0,255,170,0.3)] flex items-center justify-center text-center"
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
                className="w-full btn min-h-[44px] py-2 px-3 bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 font-mono text-xs rounded-lg hover:bg-yellow-500/30 transition cursor-pointer uppercase tracking-wider flex items-center justify-center text-center"
              >
                🎁 Списать бонус (без одобрения хода)
              </button>

              <button
                type="button"
                onClick={() => setBonusConfirmPlayer(null)}
                className="w-full btn min-h-[44px] py-2 px-3 bg-white/5 border border-white/10 text-white/60 font-mono text-xs rounded-lg hover:bg-white/10 transition cursor-pointer uppercase tracking-wider flex items-center justify-center text-center"
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
          onUpdateSkin={onUpdateSkin}
          onUpdateHero={onUpdateHero}
          initialTab={cabinetTab}
        />
      )}
    </div>
  );
}
