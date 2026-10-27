import ChipImage from "./ChipImage";
import React, { useState, useEffect } from "react";
import { GameState, Player } from "../types";
import { playSound } from "../utils/sounds";
import {
  Plus,
  Trash,
  Image,
  Save,
  X,
  ShieldAlert,
  Sliders,
  Download,
  Gift,
  Video,
} from "lucide-react";
import PlayerStatusBadge from "./PlayerStatusBadge";
import PlayerAvatarWithBadges from "./PlayerAvatarWithBadges";
import PlayerAchievementBadges from "./PlayerAchievementBadges";
import { turnsLeft, pluralizeTurns } from "../game/rules";
import { isTokenVisible } from "../game/presence";

interface AdminConsoleProps {
  gameState: GameState;
  /** Authenticated socket used for privileged admin queries. */
  socket?: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
    emit: (event: string, ...args: unknown[]) => void;
  } | null;
  onUpdatePlayer: (player: {
    id: string;
    cell: number;
    color: string;
    name: string;
    chipImage?: string;
  }) => void;
  onRegisterPlayer: (reg: {
    name: string;
    color: string;
    password?: string;
    chipImage?: string;
  }) => void;
  onDeletePlayer: (id: string) => void;
  onResetGame: (options: { clearPlayers: boolean }) => void;
  onSetBoardImage: (image: string | null) => void;
  onSetLoginBackground?: (image: string | null) => void;
  onSetRulesBackground?: (image: string | null) => void;
  onToggleCalibration: (mode: boolean) => void;
  /** Через сколько часов бездействия убирать фишку с доски. 0 — не убирать. */
  onSetTokenTimeout?: (hours: number) => void;
  /** turns: how many rolls to open at once (batch approval). */
  onApprovePlayerTurn?: (pId: string, confirmBonus?: boolean, turns?: number) => void;
  onRejectPlayerTurn?: (pId: string) => void;
  onConsumeBonus?: (pId: string) => void;
  /** Выдать кибер-девайс (+1 Щит, +1 Кубик или +1 Магнит) игроку */
  onGrantItem?: (pId: string, item: "shield" | "loaded_dice" | "magnet") => void;
  onClose: () => void;
}

/**
 * Compact 1..10 picker for a batch approval.
 *
 * Kept as a plain stepper rather than a text field: the admin console is used
 * from a phone, and a numeric input there opens a keyboard for a value that is
 * almost always 1..3.
 */
function TurnCountPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex items-center border border-[#00ffaa]/25 rounded-sm overflow-hidden font-mono">
      <button
        type="button"
        onClick={() => {
          playSound("click");
          onChange(Math.max(1, value - 1));
        }}
        className="px-1.5 py-0.5 text-[10px] text-[#00ffaa]/80 hover:bg-[#00ffaa]/15 cursor-pointer"
        title="Меньше ходов"
        aria-label="Меньше ходов"
      >
        −
      </button>
      <span className="px-1.5 text-[10px] font-black text-[#00ffaa] min-w-[16px] text-center">
        {value}
      </span>
      <button
        type="button"
        onClick={() => {
          playSound("click");
          onChange(Math.min(10, value + 1));
        }}
        className="px-1.5 py-0.5 text-[10px] text-[#00ffaa]/80 hover:bg-[#00ffaa]/15 cursor-pointer"
        title="Больше ходов"
        aria-label="Больше ходов"
      >
        +
      </button>
    </span>
  );
}

const ADMIN_COLORS = ["#FF0055", "#FF5500", "#FFFF00", "#39FF14", "#00FFFF", "#FF00FF", "#ffffff"];
// Фишки хранятся как SVG: PNG-версии были повреждены, а вектор ещё и
// принимает цвет игрока.
const CHIP_MODELS = Array.from({ length: 13 }, (_, i) => `/chips/chip_${i + 1}.svg?v=hw1`);

export default function AdminConsole({
  gameState,
  socket,
  onUpdatePlayer,
  onRegisterPlayer,
  onDeletePlayer,
  onResetGame,
  onSetBoardImage,
  onSetLoginBackground,
  onSetRulesBackground,
  onToggleCalibration,
  onSetTokenTimeout,
  onApprovePlayerTurn,
  onRejectPlayerTurn,
  onConsumeBonus,
  onGrantItem,
  onClose,
}: AdminConsoleProps) {
  // Manual Registration State
  const [newRegName, setNewRegName] = useState("");
  const [newRegColor, setNewRegColor] = useState("#39FF14");
  const [newRegPassword, setNewRegPassword] = useState("");
  const [newRegChipImage, setNewRegChipImage] = useState<string>("");

  /*
   * Порог скрытия фишек и сколько игроков сейчас скрыто.
   *
   * Число рядом с настройкой отвечает на вопрос «а кого я сейчас не вижу?» —
   * иначе непонятно, работает правило или нет.
   */
  const hideHours = gameState.hideTokensAfterHours ?? 5;
  const hiddenCount = gameState.players.filter(
    (p) => p.role === "player" && !isTokenVisible(p, hideHours)
  ).length;

  // Bonus Modal State
  const [bonusConfirmPlayer, setBonusConfirmPlayer] = useState<Player | null>(null);

  /*
   * Сколько ходов выдать игроку за одно одобрение (по id игрока).
   *
   * Раньше одобрение всегда открывало ровно один бросок, и игрок с
   * несколькими покупками ждал админа после каждого. Значение по умолчанию —
   * то, что игрок попросил в заявке, либо 1, если заявки не было вовсе.
   */
  const [grantTurns, setGrantTurns] = useState<Record<string, number>>({});
  /*
   * Значение по умолчанию: правка админа → заявка игрока → уже выданный
   * остаток → 1.
   *
   * Остаток важен: у игрока с четырьмя невыбранными ходами шаг-пикер
   * показывал «1», и кнопка «Задать» тихо срезала пачку до одного хода.
   */
  const turnsFor = (p: Player) =>
    grantTurns[p.id] ?? Math.min(10, Math.max(1, p.turnsRequested || turnsLeft(p) || 1));
  const setTurnsFor = (id: string, n: number) =>
    setGrantTurns((prev) => ({ ...prev, [id]: Math.min(10, Math.max(1, n)) }));

  // Player editing dictionary
  const [playerEdits, setPlayerEdits] = useState<{
    [id: string]: { cell: number; name: string; color: string; chipImage: string; dirty?: boolean };
  }>({});
  const [_passwords, setPasswords] = useState<{ [id: string]: string }>({});

  // Password protection status is delivered over the authenticated socket:
  // the admin password is no longer stored in localStorage, and the server
  // only ever reports whether a hash exists (never the password itself).
  useEffect(() => {
    if (!socket) return;
    const onPasswords = (data: { [id: string]: string }) => setPasswords(data || {});
    socket.on("admin:passwords", onPasswords);
    socket.emit("admin:get_passwords");
    return () => {
      socket.off("admin:passwords", onPasswords);
    };
  }, [socket, gameState.players.length]);

  // Calibration tool state
  const [_calCellId, _setCalCellId] = useState<number>(0);

  // Keep the table in sync with the server unless the admin is mid-edit.
  // Calling setState from render used to freeze the row on the first snapshot.
  useEffect(() => {
    setPlayerEdits((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of gameState.players) {
        const e = next[p.id];
        const chip = p.chipImage || "/chips/chip_1.svg";
        if (!e) {
          next[p.id] = { cell: p.cell, name: p.name, color: p.color, chipImage: chip };
          changed = true;
        } else if (!e.dirty) {
          if (e.cell !== p.cell || e.name !== p.name || e.color !== p.color || e.chipImage !== chip) {
            next[p.id] = { cell: p.cell, name: p.name, color: p.color, chipImage: chip };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [gameState.players]);

  const handlePlayerEditChange = (
    id: string,
    field: "cell" | "name" | "color" | "chipImage",
    val: any
  ) => {
    const current = playerEdits[id] || {
      cell: 0,
      name: "",
      color: "#fff",
      chipImage: "/chips/chip_1.svg",
    };
    setPlayerEdits((prev) => ({
      ...prev,
      [id]: {
        ...current,
        [field]: val,
        dirty: true,
      },
    }));
  };

  const handleSavePlayer = (pId: string) => {
    const edit = playerEdits[pId];
    if (edit) {
      playSound("success");
      onUpdatePlayer({
        id: pId,
        cell: Number(edit.cell),
        name: edit.name,
        color: edit.color,
        chipImage: edit.chipImage,
      });
      setPlayerEdits((prev) => ({ ...prev, [pId]: { ...edit, dirty: false } }));
    }
  };

  const handleCreatePlayer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRegName.trim()) return;
    playSound("success");
    onRegisterPlayer({
      name: newRegName.trim(),
      color: newRegColor,
      password: newRegPassword.trim(),
      chipImage: newRegChipImage || undefined,
    });
    setNewRegName("");
    setNewRegPassword("");
    setNewRegChipImage("");
  };

  const _handleBoardImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const base64 = evt.target?.result as string;
        onSetBoardImage(base64);
        playSound("success");
      };
      reader.readAsDataURL(file);
    }
  };

  const handleLoginBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onSetLoginBackground) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const base64 = evt.target?.result as string;
        onSetLoginBackground(base64);
        playSound("success");
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRulesBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onSetRulesBackground) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const base64 = evt.target?.result as string;
        onSetRulesBackground(base64);
        playSound("success");
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div
      id="admin_console"
      className="relative h-full w-full bg-[#0d0d0f] text-[#e0e0e6] flex flex-col font-sans overflow-y-auto scrollbar-none select-none"
    >
      {/* Grid background */}
      <div className="fixed inset-0 bg-[radial-gradient(rgba(224,224,230,0.03)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none z-0" />

      {/* Header */}
      <header className="w-full border-b border-[rgba(224,224,230,0.1)] bg-[#0d0d0f]/90 backdrop-blur-none p-4 sm:p-6 px-6 sm:px-8 flex flex-col md:flex-row justify-between items-center gap-4 z-30 sticky top-0 shrink-0">
        <div className="brand flex flex-col">
          <h1 className="font-syne text-2xl font-black uppercase tracking-tight text-white bg-gradient-to-r from-white to-[#00ffaa] bg-clip-text text-transparent">
            HAPSTORE // CORE
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/50">
            КОНСОЛЬ АДМИНИСТРАТОРА
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              playSound("click");
              const exportData = {
                logs: gameState.logs,
                players: gameState.players,
                cells: gameState.cells,
                timestamp: new Date().toISOString(),
              };
              const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `hapstore_export_${new Date().getTime()}.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
            className="btn py-2.5 px-5 font-mono text-[11px] font-bold uppercase tracking-wider bg-transparent border border-[rgba(224,224,230,0.1)] hover:bg-white/5 text-[#e0e0e6] inline-flex items-center gap-2 transition cursor-pointer"
          >
            <Download size={14} />
            ЭКСПОРТ ИСТОРИИ
          </button>

          {/*
            Очистка журнала. Записи уходят в архив на сервере, а не
            уничтожаются: кнопка рядом с экспортом, и промахнуться легко.
            Подтверждение — по той же причине.
          */}
          <button
            onClick={() => {
              playSound("click");
              if (!socket) return;
              const count = gameState.logs.length;
              if (count === 0) return;
              if (
                !window.confirm(
                  `Очистить журнал событий? Записей: ${count}.\n\n` +
                    `Они сохранятся в архиве на сервере и останутся доступны ` +
                    `через «ЭКСПОРТ ИСТОРИИ».`
                )
              ) {
                return;
              }
              socket.emit("admin:clear_logs");
            }}
            disabled={gameState.logs.length === 0}
            className="btn py-2.5 px-5 font-mono text-[11px] font-bold uppercase tracking-wider bg-transparent border border-[rgba(224,224,230,0.1)] hover:bg-white/5 text-[#e0e0e6] inline-flex items-center gap-2 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash size={14} />
            ОЧИСТИТЬ ЖУРНАЛ
          </button>

          <button
            onClick={() => {
              playSound("click");
              onClose();
            }}
            className="btn py-2.5 px-5 font-mono text-[11px] font-bold uppercase tracking-wider text-white bg-gradient-to-r from-[#ff007f] to-[#ff00ff] inline-flex items-center gap-2 shadow-[0_0_15px_rgba(255,0,127,0.4)] cursor-pointer hover:scale-[1.02] active:scale-[0.98] transition"
          >
            ВЕРНУТЬСЯ К ИГРЕ
          </button>
        </div>
      </header>

      {/* Unified Main Content Grid */}
      <div className="w-full max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col lg:flex-row gap-6 lg:gap-8 flex-1 items-start">
        {/* Sidebar - Player Registration */}
        <aside className="w-full lg:w-[320px] lg:shrink-0 bg-[#151518] border border-[rgba(224,224,230,0.1)] p-6 rounded-lg flex flex-col gap-8 relative z-10 select-none">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-2 block">
              [ REGISTRATION_MODULE ]
            </span>
            <div className="font-syne text-sm font-extrabold uppercase text-[#e0e0e6] mb-6 flex items-center gap-2">
              <Plus size={16} className="text-[#00ffaa]" />
              РЕГИСТРАЦИЯ ИГРОКА
            </div>
            <form onSubmit={handleCreatePlayer} className="space-y-5">
              <div>
                <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-1.5 block">
                  Никнейм
                </label>
                <input
                  type="text"
                  value={newRegName}
                  onChange={(e) => setNewRegName(e.target.value)}
                  required
                  className="w-full bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-3 text-sm text-[#e0e0e6] focus:outline-none focus:border-[#00ffaa] transition font-sans"
                  placeholder="Например: @username"
                />
              </div>

              <div>
                <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-1.5 block">
                  Пароль (Опционально)
                </label>
                <input
                  type="text"
                  value={newRegPassword}
                  onChange={(e) => setNewRegPassword(e.target.value)}
                  className="w-full bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-3 text-sm text-[#e0e0e6] focus:outline-none focus:border-[#00ffaa] transition font-sans"
                  placeholder="Пароль"
                />
              </div>

              <div>
                <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-2 block">
                  Цвет Подсветки
                </label>
                <div className="grid grid-cols-7 gap-2">
                  {ADMIN_COLORS.map((col) => (
                    <button
                      key={col}
                      type="button"
                      onClick={() => setNewRegColor(col)}
                      className="aspect-square rounded-sm cursor-pointer transition-all border-2"
                      style={{
                        backgroundColor: col,
                        borderColor: newRegColor === col ? "white" : "transparent",
                        boxShadow: newRegColor === col ? `0 0 10px ${col}` : "none",
                      }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-2 block">
                  Модель Фишки
                </label>
                <div className="grid grid-cols-5 gap-1.5 max-h-32 overflow-y-auto p-1.5 bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm scrollbar-thin">
                  <button
                    type="button"
                    onClick={() => setNewRegChipImage("")}
                    className={`col-span-5 py-1 px-2 text-[10px] font-mono font-bold uppercase tracking-wider border rounded cursor-pointer transition flex items-center justify-center gap-1 ${
                      !newRegChipImage
                        ? "border-[#00ffaa] bg-[#00ffaa]/15 text-[#00ffaa]"
                        : "border-white/10 text-white/50 hover:bg-white/5"
                    }`}
                  >
                    <span>🎲</span>
                    <span>Случайная Фишка</span>
                  </button>
                  {CHIP_MODELS.map((chipPath, idx) => (
                    <button
                      key={chipPath}
                      type="button"
                      onClick={() => setNewRegChipImage(chipPath)}
                      className={`p-1.5 border rounded-sm flex items-center justify-center aspect-square transition cursor-pointer ${
                        newRegChipImage === chipPath
                          ? "border-[#00ffaa] bg-[#00ffaa]/20 shadow-[0_0_8px_rgba(0,255,170,0.4)]"
                          : "border-white/10 hover:border-white/30 bg-black/40"
                      }`}
                      title={`Фишка ${idx + 1}`}
                    >
                      <img
                        src={chipPath}
                        alt={`Chip ${idx + 1}`}
                        className="w-6 h-6 object-contain"
                      />
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                className="w-full btn py-3 px-6 font-mono text-[11px] font-bold uppercase tracking-widest bg-[#0d0d0f] border border-[#00ffaa] text-[#00ffaa] hover:bg-[#00ffaa] hover:text-[#0d0d0f] transition cursor-pointer"
              >
                Зарегистрировать
              </button>
            </form>
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="w-full min-w-0 flex flex-col gap-6 lg:gap-8 relative z-10 select-none">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Card 1: Automoderation */}
            <div className="bg-[#151518] border border-[rgba(224,224,230,0.1)] p-6 rounded-lg shadow-md flex flex-col justify-between">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-2 block">
                  STATUS: ACTIVE
                </span>
                <div className="font-syne text-sm font-extrabold uppercase text-[#e0e0e6] mb-4 flex items-center gap-2">
                  <ShieldAlert size={16} className="text-[#00ffaa]" />
                  АВТОМОДЕРАЦИЯ
                </div>
                <div className="bg-[#0d0d0f]/60 p-4 border-l-4 border-[#00ffaa] rounded-sm">
                  <div className="flex justify-between items-center mb-2 font-mono text-[10px]">
                    <span className="opacity-50">СИСТЕМА:</span>
                    <span className="text-[#00ffaa] font-bold animate-pulse">АВТОПИЛОТ ON</span>
                  </div>
                  <p className="text-xs text-[#e0e0e6]/80 leading-relaxed font-sans">
                    Модерация результатов бросков отключена. Броски кубиков и переходы по клеткам
                    теперь обрабатываются сервером мгновенно.
                  </p>
                </div>
              </div>
            </div>

            {/* Card 2: Administrator Toolset */}
            <div className="bg-[#151518] border border-[rgba(224,224,230,0.1)] p-6 rounded-lg shadow-md flex flex-col justify-between">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 mb-2 block">
                  ADMIN_TOOLSET
                </span>
                <div className="font-syne text-sm font-extrabold uppercase text-[#e0e0e6] mb-4 flex items-center gap-2">
                  <Sliders size={16} className="text-[#00ffaa]" />
                  ИНСТРУМЕНТЫ
                </div>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => {
                      if (confirm("Вы уверены? Это сбросит позиции всех игроков на Старт!")) {
                        playSound("error");
                        onResetGame({ clearPlayers: false });
                      }
                    }}
                    className="w-full btn py-2 px-4 font-mono text-[11px] font-bold bg-transparent border border-[rgba(224,224,230,0.1)] text-[#e0e0e6] hover:bg-white/5 transition text-left cursor-pointer"
                  >
                    Сбросить Игру (Позиции)
                  </button>

                  <button
                    onClick={() => {
                      if (confirm("ВНИМАНИЕ! Вы удаляете ВСЕХ игроков. Продолжить?")) {
                        playSound("error");
                        onResetGame({ clearPlayers: true });
                      }
                    }}
                    className="w-full btn py-2 px-4 font-mono text-[11px] font-bold bg-[#ff007f]/10 border border-[#ff007f] text-[#ff007f] hover:bg-[#ff007f]/20 transition text-left cursor-pointer"
                  >
                    Удалить Всех Игроков
                  </button>
                </div>
              </div>

              {/*
                Скрытие фишек неактивных игроков.

                За несколько месяцев доска зарастает фишками тех, кто давно
                ушёл, и живых участников среди них не различить. Позиция при
                этом сохраняется: игрок вернулся — фишка снова на месте.
              */}
              <div className="mt-4 pt-4 border-t border-[rgba(224,224,230,0.1)] flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60">
                    Скрывать фишки после
                  </span>
                  <span className="font-mono text-[11px] font-bold text-[#00ffaa]">
                    {hideHours > 0 ? `${hideHours} ч` : "не скрывать"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {[
                    { h: 0, label: "Никогда" },
                    { h: 12, label: "12 ч" },
                    { h: 24, label: "Сутки" },
                    { h: 72, label: "3 дня" },
                    { h: 168, label: "Неделя" },
                  ].map((opt) => (
                    <button
                      key={opt.h}
                      type="button"
                      onClick={() => {
                        playSound("click");
                        onSetTokenTimeout?.(opt.h);
                      }}
                      className={`px-2.5 py-1 rounded font-mono text-[10px] border transition cursor-pointer ${
                        hideHours === opt.h
                          ? "bg-[#00ffaa] text-black border-[#00ffaa]"
                          : "bg-black/40 text-[#00ffaa]/70 border-[#00ffaa]/25 hover:bg-[#00ffaa]/15"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <p className="text-[9px] text-[#e0e0e6]/40 font-sans leading-snug">
                  Фишка игрока пропадает с доски, если он столько не заходил и не ходил. Позиция
                  сохраняется — вернётся, фишка появится снова. Тех, у кого есть открытые ходы,
                  запрос или невыданный приз, правило не трогает.
                  {hiddenCount > 0 && (
                    <>
                      {" "}
                      <b className="text-[#e0e0e6]/70">Сейчас скрыто: {hiddenCount}.</b>
                    </>
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() => onToggleCalibration(!gameState.calibrationMode)}
                className="flex items-center justify-between w-full mt-4 pt-4 border-t border-[rgba(224,224,230,0.1)] cursor-pointer focus:outline-none"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60">
                  КАЛИБРОВКА СЕТКИ
                </span>
                <div
                  className={`w-8 h-4 rounded-full relative transition-colors duration-200 ${gameState.calibrationMode ? "bg-[#00ffaa]" : "bg-neutral-800"}`}
                >
                  <div
                    className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-all duration-200 ${gameState.calibrationMode ? "left-4.5" : "left-0.5"}`}
                  />
                </div>
              </button>
            </div>
          </div>

          {/* Custom Backgrounds Manager */}
          <div className="bg-[#151518] border border-[rgba(224,224,230,0.1)] p-6 rounded-lg shadow-md flex flex-col gap-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-[rgba(224,224,230,0.1)] pb-3">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60 block">
                  MEDIA_SETTINGS
                </span>
                <div className="font-syne text-sm font-extrabold uppercase text-[#e0e0e6] flex items-center gap-2">
                  <Image size={18} className="text-[#00ffaa]" />
                  УПРАВЛЕНИЕ ФОНАМИ ЭКРАНОВ
                </div>
              </div>
              <p className="text-xs text-[#e0e0e6]/70 font-sans">
                Загрузите собственные видео (.mp4, .mov) или изображения (PNG, JPG, WebP) для всех
                экранов игры.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
              {/* Card 1: Main Board Screen Background */}
              <div className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] p-4 rounded-md flex flex-col justify-between gap-3">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-syne text-xs font-bold text-[#e0e0e6] uppercase">
                      1. Основной экран (Поле)
                    </span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-mono bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30">
                      BoardHAP.mp4
                    </span>
                  </div>
                  <p className="text-[11px] text-[#e0e0e6]/60 mb-1 leading-snug">
                    Используется стандартный видеофон <b>BoardHAP.mp4</b> из папки /public.
                  </p>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                  <div className="w-full py-2 px-3 font-mono text-[10px] font-bold bg-white/5 border border-white/10 text-[#00ffaa] text-center rounded uppercase tracking-wider flex items-center justify-center gap-1.5">
                    <Video size={12} />
                    Стандартный Видеофон Установлен
                  </div>
                </div>
              </div>

              {/* Card 2: Login Screen Background */}
              <div className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] p-4 rounded-md flex flex-col justify-between gap-3">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-syne text-xs font-bold text-[#e0e0e6] uppercase">
                      2. Экран Входа (Логин)
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[9px] font-mono ${gameState.loginBackground ? "bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30" : "bg-white/5 text-gray-400"}`}
                    >
                      {gameState.loginBackground ? "Свой фон" : "По умолчанию"}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#e0e0e6]/60 mb-3 leading-snug">
                    Фон формы авторизации и выбора никнейма.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="w-full btn py-2 px-3 font-mono text-[10px] font-bold bg-[#00ffaa]/10 border border-[#00ffaa] text-[#00ffaa] hover:bg-[#00ffaa]/20 transition text-center cursor-pointer uppercase tracking-wider flex items-center justify-center gap-1.5">
                    <Image size={12} />
                    Загрузить Файл
                    <input
                      type="file"
                      accept="image/*,video/*"
                      onChange={handleLoginBgUpload}
                      className="hidden"
                    />
                  </label>

                  {gameState.loginBackground && (
                    <button
                      type="button"
                      onClick={() => {
                        playSound("click");
                        if (onSetLoginBackground) onSetLoginBackground(null);
                      }}
                      className="w-full btn py-1.5 px-2 font-mono text-[9px] text-red-400 hover:text-red-300 transition text-center cursor-pointer border border-red-500/30 hover:border-red-500/60 rounded"
                    >
                      Сбросить фон входа
                    </button>
                  )}
                </div>
              </div>

              {/* Card 3: Rules Screen Background */}
              <div className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] p-4 rounded-md flex flex-col justify-between gap-3">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-syne text-xs font-bold text-[#e0e0e6] uppercase">
                      3. Экран Правил
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[9px] font-mono ${gameState.rulesBackground ? "bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30" : "bg-white/5 text-gray-400"}`}
                    >
                      {gameState.rulesBackground ? "Свой фон" : "По умолчанию"}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#e0e0e6]/60 mb-3 leading-snug">
                    Фоновое видео/изображение страницы с правилами.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="w-full btn py-2 px-3 font-mono text-[10px] font-bold bg-[#00ffaa]/10 border border-[#00ffaa] text-[#00ffaa] hover:bg-[#00ffaa]/20 transition text-center cursor-pointer uppercase tracking-wider flex items-center justify-center gap-1.5">
                    <Image size={12} />
                    Загрузить Файл
                    <input
                      type="file"
                      accept="image/*,video/*"
                      onChange={handleRulesBgUpload}
                      className="hidden"
                    />
                  </label>

                  {gameState.rulesBackground && (
                    <button
                      type="button"
                      onClick={() => {
                        playSound("click");
                        if (onSetRulesBackground) onSetRulesBackground(null);
                      }}
                      className="w-full btn py-1.5 px-2 font-mono text-[9px] text-red-400 hover:text-red-300 transition text-center cursor-pointer border border-red-500/30 hover:border-red-500/60 rounded"
                    >
                      Сбросить фон правил
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Prize Control Alert Banner for Pending Requests */}
          {(() => {
            const playersWithBonus = gameState.players.filter(
              (p) => p.role === "player" && p.activeBonus
            );
            if (playersWithBonus.length === 0) return null;

            return (
              <div className="bg-yellow-950/40 border-2 border-yellow-500/60 rounded-xl p-5 shadow-[0_0_25px_rgba(234,179,8,0.2)] flex flex-col gap-3">
                <div className="flex items-center justify-between border-b border-yellow-500/30 pb-2">
                  <div className="flex items-center gap-2 font-syne font-bold text-sm text-yellow-400 uppercase tracking-wider">
                    <Gift size={20} className="animate-bounce text-yellow-400" />
                    СИСТЕМА КОНТРОЛЯ ПРИЗОВ ({playersWithBonus.length})
                  </div>
                  <span className="text-[10px] font-mono text-yellow-300/80 bg-yellow-500/20 px-2 py-0.5 rounded border border-yellow-500/30 uppercase">
                    Правило: призы и бонусы не суммируются
                  </span>
                </div>
                <p className="text-xs text-yellow-100/90 leading-relaxed font-sans">
                  Игроки с активными бонусами могут продолжить игру и сделать новый бросок только
                  после того, как использовали свои бонусы в Таблице Жизни (в реальной жизни) и
                  администратор подтвердил их использование.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  {playersWithBonus.map((p) => (
                    <div
                      key={p.id}
                      className="bg-black/60 border border-yellow-500/40 rounded-lg p-3 flex flex-col justify-between gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold" style={{ color: p.color }}>
                          {p.name}
                        </span>
                        <span className="text-[10px] font-mono text-yellow-400 font-bold bg-yellow-500/20 px-2 py-0.5 rounded">
                          🎁 {p.activeBonus?.extra || p.activeBonus?.name}
                        </span>
                      </div>
                      <div className="text-[10px] text-white/70 font-mono">
                        {p.turnRequested ? (
                          <span className="text-amber-300 font-bold animate-pulse">
                            ⚠️ ЗАПРОШЕНО {Math.max(1, p.turnsRequested || 1)}{" "}
                            {pluralizeTurns(Math.max(1, p.turnsRequested || 1))} (Ожидает списания
                            бонуса)
                          </span>
                        ) : turnsLeft(p) > 0 ? (
                          <span className="text-emerald-400 font-bold">
                            Одобрено {turnsLeft(p)} {pluralizeTurns(turnsLeft(p))}
                          </span>
                        ) : (
                          <span className="text-white/40">Ход не затребован</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 pt-1 border-t border-white/10">
                        <button
                          type="button"
                          onClick={() => {
                            playSound("click");
                            setBonusConfirmPlayer(p);
                          }}
                          className="flex-1 py-1.5 px-2 bg-yellow-500 text-black font-mono font-bold text-[10px] rounded hover:bg-yellow-400 transition cursor-pointer uppercase tracking-wider text-center"
                        >
                          Подтвердить использование и одобрить
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            playSound("click");
                            onConsumeBonus?.(p.id);
                          }}
                          className="py-1.5 px-2 bg-white/10 border border-white/20 text-yellow-300 font-mono text-[10px] rounded hover:bg-white/20 transition cursor-pointer uppercase"
                          title="Списать бонус без вынесения одобрения"
                        >
                          Списать
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Control Deck Table Container */}
          <div className="bg-[#151518] border border-[rgba(224,224,230,0.1)] rounded-lg overflow-hidden flex flex-col shadow-md">
            <div className="p-4 border-b border-[rgba(224,224,230,0.1)] flex justify-between items-center bg-white/[0.02]">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#e0e0e6]/60">
                ЗАРЕГИСТРИРОВАННЫЕ УЧАСТНИКИ (
                {gameState.players.filter((p) => p.role === "player").length})
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse font-sans">
                <thead>
                  <tr className="bg-white/[0.01] border-b border-[rgba(224,224,230,0.1)]">
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Участник
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Пароль
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Фишка
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Цвет
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Клетка
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Бонус (Приз)
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Инвентарь
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Статус
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60">
                      Доступ
                    </th>
                    <th className="p-4 font-mono text-[10px] uppercase tracking-wider text-[#e0e0e6]/60 text-right">
                      Действия
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(224,224,230,0.05)] text-sm">
                  {gameState.players
                    .filter((p) => p.role === "player")
                    .map((p) => {
                      const edit = playerEdits[p.id] || {
                        cell: p.cell,
                        name: p.name,
                        color: p.color,
                        chipImage: p.chipImage || "/chips/chip_1.svg",
                      };
                      return (
                        <tr key={p.id} className="hover:bg-white/[0.01] transition-colors">
                          {/* Participant Name & Avatar */}
                          <td className="p-4">
                            <div className="flex items-center gap-3">
                              <PlayerAvatarWithBadges player={p} gameState={gameState} size="sm" />
                              <div className="flex flex-col gap-1">
                                <input
                                  type="text"
                                  value={edit.name}
                                  onChange={(e) =>
                                    handlePlayerEditChange(p.id, "name", e.target.value)
                                  }
                                  className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-1.5 text-xs text-[#e0e0e6] focus:outline-none focus:border-[#00ffaa] font-mono"
                                />
                                <PlayerAchievementBadges player={p} gameState={gameState} compact />
                              </div>
                            </div>
                          </td>
                          {/* Password Security Status */}
                          <td className="p-4 font-mono text-xs">
                            <span className="px-2 py-1 rounded bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30 text-[10px] font-bold flex items-center gap-1 w-fit">
                              🔒 PBKDF2 ХЭШ
                            </span>
                          </td>
                          {/* Chip Model */}
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              <ChipImage
                                src={edit.chipImage || p.chipImage || "/chips/chip_1.svg"}
                                color={edit.color || p.color || "#00ffaa"}
                                label="Модель фишки"
                                className="w-7 h-7 p-0.5 border border-white/20 rounded bg-black/60 [&>svg]:w-full [&>svg]:h-full"
                              />
                              <select
                                value={edit.chipImage || p.chipImage || "/chips/chip_1.svg"}
                                onChange={(e) =>
                                  handlePlayerEditChange(p.id, "chipImage", e.target.value)
                                }
                                className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-1.5 text-xs text-[#e0e0e6] focus:outline-none font-mono"
                              >
                                {CHIP_MODELS.map((chipPath, idx) => (
                                  <option key={chipPath} value={chipPath}>
                                    Фишка {idx + 1}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
                          {/* Color */}
                          <td className="p-4">
                            <select
                              value={edit.color}
                              onChange={(e) =>
                                handlePlayerEditChange(p.id, "color", e.target.value)
                              }
                              className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-2 text-xs text-[#e0e0e6] focus:outline-none"
                            >
                              {ADMIN_COLORS.map((col) => (
                                <option key={col} value={col}>
                                  {col}
                                </option>
                              ))}
                            </select>
                          </td>
                          {/* Cell */}
                          <td className="p-4">
                            <input
                              type="number"
                              min="0"
                              max="60"
                              value={edit.cell}
                              onChange={(e) => handlePlayerEditChange(p.id, "cell", e.target.value)}
                              className="bg-[#0d0d0f] border border-[rgba(224,224,230,0.1)] rounded-sm p-2 text-xs text-[#e0e0e6] w-16 text-center focus:outline-none font-mono"
                            />
                          </td>
                          {/* Active Bonus / Prize Column */}
                          <td className="p-4">
                            {p.activeBonus ? (
                              <div className="flex flex-col gap-1 font-mono items-start">
                                <span className="px-2 py-1 rounded text-[9px] font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 flex items-center gap-1">
                                  🎁 {p.activeBonus.extra || p.activeBonus.name}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    playSound("click");
                                    onConsumeBonus?.(p.id);
                                  }}
                                  className="text-[8px] text-yellow-300 hover:underline cursor-pointer font-bold uppercase tracking-wider"
                                  title="Подтвердить использование бонуса в реальной жизни"
                                >
                                  [Списать бонус]
                                </button>
                              </div>
                            ) : (
                              <span className="text-[10px] text-[#e0e0e6]/30 font-mono">Нет</span>
                            )}
                          </td>
                          {/* Inventory & Quick Grants */}
                          <td className="p-4">
                            <div className="flex flex-col gap-1.5 font-mono items-start">
                              <div className="flex items-center gap-1.5 text-[10px]">
                                <span
                                  className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1"
                                  title="Щит «Файрвол» (защищает от отката назад на ловушках)"
                                >
                                  🛡️ {p.inventory?.filter((i) => i === "shield").length || 0}
                                </span>
                                <span
                                  className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center gap-1"
                                  title="«Заряженный кубик» (гарантирует выпадение 6)"
                                >
                                  🎲 {p.inventory?.filter((i) => i === "loaded_dice").length || 0}
                                </span>
                                <span
                                  className="px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center gap-1"
                                  title="«Неоновый магнит» (притягивает к призовым клеткам в 1 шаге)"
                                >
                                  🧲 {p.inventory?.filter((i) => i === "magnet").length || 0}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    playSound("click");
                                    onGrantItem?.(p.id, "shield");
                                  }}
                                  className="btn py-0.5 px-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 rounded text-[9px] cursor-pointer transition flex items-center gap-0.5 font-mono"
                                  title="Выдать +1 Щит «Файрвол» игроку"
                                >
                                  +1 🛡️ Щит
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    playSound("click");
                                    onGrantItem?.(p.id, "loaded_dice");
                                  }}
                                  className="btn py-0.5 px-1.5 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 border border-purple-500/30 rounded text-[9px] cursor-pointer transition flex items-center gap-0.5 font-mono"
                                  title="Выдать +1 «Заряженный кубик» игроку"
                                >
                                  +1 🎲 Кубик
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    playSound("click");
                                    onGrantItem?.(p.id, "magnet");
                                  }}
                                  className="btn py-0.5 px-1.5 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 border border-cyan-500/30 rounded text-[9px] cursor-pointer transition flex items-center gap-0.5 font-mono"
                                  title="Выдать +1 «Неоновый магнит» игроку"
                                >
                                  +1 🧲 Магнит
                                </button>
                              </div>
                            </div>
                          </td>
                          {/* Status */}
                          <td className="p-4">
                            <PlayerStatusBadge player={p} gameState={gameState} />
                          </td>
                          {/* Access */}
                          <td className="p-4">
                            {turnsLeft(p) > 0 ? (
                              <div className="flex flex-col items-start font-mono gap-1">
                                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30 uppercase">
                                  Одобрено: {turnsLeft(p)} {pluralizeTurns(turnsLeft(p))}
                                </span>
                                {/* Здесь показывался остаток 12-часового окна.
                                    Ход больше не сгорает, считать нечего. */}
                                <span className="text-[9px] text-[#e0e0e6]/40">
                                  срок не ограничен
                                </span>
                                <div className="flex items-center gap-1">
                                  <TurnCountPicker
                                    value={turnsFor(p)}
                                    onChange={(n) => setTurnsFor(p.id, n)}
                                  />
                                  <button
                                    onClick={() => {
                                      playSound("success");
                                      onApprovePlayerTurn?.(p.id, !!p.activeBonus, turnsFor(p));
                                    }}
                                    className="btn py-1 px-2 bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30 hover:bg-[#00ffaa]/20 rounded-sm text-[8px] cursor-pointer uppercase"
                                    title="Заменить остаток новым количеством"
                                  >
                                    Задать
                                  </button>
                                  <button
                                    onClick={() => {
                                      playSound("click");
                                      onRejectPlayerTurn?.(p.id);
                                    }}
                                    className="btn py-1 px-1.5 bg-[#ff007f]/10 text-[#ff007f] border border-[#ff007f]/30 hover:bg-[#ff007f]/20 rounded-sm cursor-pointer"
                                    title="Снять одобрение полностью"
                                  >
                                    <X size={10} />
                                  </button>
                                </div>
                              </div>
                            ) : p.turnRequested ? (
                              <div className="flex flex-col items-start gap-1">
                                <span className="text-[8px] font-mono text-amber-300/80 uppercase">
                                  просит {Math.max(1, p.turnsRequested || 1)}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  <TurnCountPicker
                                    value={turnsFor(p)}
                                    onChange={(n) => setTurnsFor(p.id, n)}
                                  />
                                  <button
                                    onClick={() => {
                                      if (p.activeBonus) {
                                        playSound("click");
                                        setBonusConfirmPlayer(p);
                                      } else {
                                        playSound("success");
                                        onApprovePlayerTurn?.(p.id, false, turnsFor(p));
                                      }
                                    }}
                                    className="btn py-1 px-2.5 bg-[#00ffaa]/10 text-[#00ffaa] border border-[#00ffaa]/30 hover:bg-[#00ffaa]/20 rounded-sm text-[9px] cursor-pointer flex items-center gap-1"
                                    title={`Одобрить ${turnsFor(p)} ${pluralizeTurns(turnsFor(p))} — без ограничения по времени`}
                                  >
                                    Одобрить {turnsFor(p)}
                                    {p.activeBonus && (
                                      <span className="text-yellow-400 font-bold">🎁</span>
                                    )}
                                  </button>
                                  <button
                                    onClick={() => {
                                      playSound("click");
                                      onRejectPlayerTurn?.(p.id);
                                    }}
                                    className="btn py-1 px-1.5 bg-[#ff007f]/10 text-[#ff007f] border border-[#ff007f]/30 hover:bg-[#ff007f]/20 rounded-sm cursor-pointer"
                                    title="Отклонить"
                                  >
                                    <X size={10} />
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 font-mono">
                                <span className="text-[#e0e0e6]/40 text-[10px]">НЕТ</span>
                                <TurnCountPicker
                                  value={turnsFor(p)}
                                  onChange={(n) => setTurnsFor(p.id, n)}
                                />
                                <button
                                  onClick={() => {
                                    if (p.activeBonus) {
                                      playSound("click");
                                      setBonusConfirmPlayer(p);
                                    } else {
                                      playSound("success");
                                      onApprovePlayerTurn?.(p.id, false, turnsFor(p));
                                    }
                                  }}
                                  className="btn py-1 px-2 bg-[#151518] hover:bg-white/5 text-[#e0e0e6]/80 border border-[rgba(224,224,230,0.1)] rounded-sm text-[8px] cursor-pointer transition flex items-center gap-1"
                                  title={`Выдать ${turnsFor(p)} ${pluralizeTurns(turnsFor(p))} без запроса`}
                                >
                                  ВЫДАТЬ {turnsFor(p)}
                                  {p.activeBonus && (
                                    <span className="text-yellow-400 font-bold">🎁</span>
                                  )}
                                </button>
                              </div>
                            )}
                          </td>
                          {/* Actions */}
                          <td className="p-4 text-right space-x-2 whitespace-nowrap">
                            <button
                              onClick={() => handleSavePlayer(p.id)}
                              className="btn py-1.5 px-2.5 bg-[#00ffaa]/15 hover:bg-[#00ffaa]/25 text-[#00ffaa] border border-[#00ffaa]/20 rounded-sm text-[9px] cursor-pointer uppercase font-mono tracking-widest inline-flex items-center gap-1 transition"
                            >
                              <Save size={12} />
                              SAVE
                            </button>
                            <button
                              onClick={() => {
                                if (confirm(`Вы действительно хотите удалить игрока ${p.name}?`)) {
                                  playSound("error");
                                  onDeletePlayer(p.id);
                                }
                              }}
                              className="btn py-1.5 px-2 bg-[#ff007f]/10 hover:bg-[#ff007f]/20 text-[#ff007f] border border-[#ff007f]/20 rounded-sm cursor-pointer transition"
                            >
                              <Trash size={12} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  {gameState.players.filter((p) => p.role === "player").length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="text-center py-8 text-[#e0e0e6]/40 font-mono italic"
                      >
                        Зарегистрированных участников нет. Используйте панель слева для создания.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      {/* Admin Bonus Confirmation Modal */}
      {bonusConfirmPlayer && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-none">
          <div className="relative w-full max-w-md bg-[#151518] border-2 border-yellow-500/50 rounded-2xl p-6 shadow-[0_0_40px_rgba(234,179,8,0.25)] font-sans text-[#e0e0e6] space-y-4">
            <div className="flex items-center gap-2 border-b border-yellow-500/20 pb-3 text-yellow-400 font-syne font-bold text-sm tracking-wider uppercase">
              <Gift size={20} className="animate-bounce text-yellow-400" />
              КОНТРОЛЬ ПРИЗОВ: НЕИСПОЛЬЗОВАННЫЙ БОНУС
            </div>

            <p className="text-xs text-white/80 leading-relaxed font-mono">
              Участник{" "}
              <span
                className="font-bold text-[#00ffaa]"
                style={{ color: bonusConfirmPlayer.color }}
              >
                {bonusConfirmPlayer.name}
              </span>{" "}
              имеет активный бонус:
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
              ⚠️ <b>Правило игры:</b> Призовые суммы и бонусы не суммируются. Игрок может продолжить
              игру только после того, как использовал полученный бонус в реальной жизни!
            </div>

            <div className="flex items-center justify-between gap-2 bg-black/40 border border-white/10 rounded-lg px-3 py-2">
              <span className="text-[11px] font-mono text-white/70 uppercase tracking-wider">
                Сколько ходов выдать
              </span>
              <TurnCountPicker
                value={turnsFor(bonusConfirmPlayer)}
                onChange={(n) => setTurnsFor(bonusConfirmPlayer.id, n)}
              />
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  playSound("success");
                  onApprovePlayerTurn?.(bonusConfirmPlayer.id, true, turnsFor(bonusConfirmPlayer));
                  setBonusConfirmPlayer(null);
                }}
                className="w-full btn py-2.5 px-3 bg-[#00ffaa] text-black font-mono font-bold text-xs rounded-lg hover:bg-[#00ffaa]/80 transition cursor-pointer uppercase tracking-wider shadow-[0_0_15px_rgba(0,255,170,0.3)]"
              >
                ✅ Подтвердить бонус и выдать {turnsFor(bonusConfirmPlayer)}{" "}
                {pluralizeTurns(turnsFor(bonusConfirmPlayer))}
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

      {/* Footer */}
      <footer className="col-span-full border-t border-[rgba(224,224,230,0.1)] p-4 px-8 flex justify-between items-center font-mono text-[10px] text-[#e0e0e6]/40 bg-[#0d0d0f] relative z-20">
        <div>SYSTEM STATUS: OPTIMAL</div>
        <div>HAPSTORE CORE V1.0.4 // 2026</div>
        <div>COORDINATES: 55.7558, 37.6173</div>
      </footer>
    </div>
  );
}
