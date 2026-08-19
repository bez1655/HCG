export enum CellType {
  START = "start",
  NORMAL = "normal",
  BONUS = "bonus",
  PENALTY = "penalty",
  BITCOIN = "bitcoin",
  ERROR = "error",
  FINISH = "finish",
  FLASK = "flask",
  SNAKE = "snake",
  CHECKPOINT = "checkpoint",
}

export interface ActiveBonus {
  name: string;
  extra?: string;
  description?: string;
  value?: number;
  cellId?: number;
  receivedAt: number;
}

export interface Player {
  id: string;
  /**
   * Настоящее имя входа — Telegram-хендл вида «@user».
   *
   * ЛИЧНЫЕ ДАННЫЕ. Другим игрокам не показывается: наружу идёт alias.
   * Остаётся в модели, потому что по нему игрок входит и его находит
   * администратор.
   */
  name: string;
  /**
   * Игровой псевдоним — герой из известной вселенной.
   *
   * Именно он виден остальным: в списке игроков, в журнале, в чате. Игрок,
   * купивший товар, больше не раскрывает свой аккаунт другим участникам.
   */
  alias?: string;
  role: "admin" | "player";
  cell: number;
  color: string;
  isOnline: boolean;
  /**
   * Когда игрок в последний раз заходил в игру ИЛИ делал ход.
   *
   * По этой отметке фишка давно пропавшего игрока убирается с доски: за
   * несколько месяцев неактивные фишки скапливаются так, что живых
   * участников среди них не различить. Позиция при этом сохраняется —
   * человек вернулся, фишка снова на месте.
   */
  lastSeenAt?: number;
  lastRoll: number | null;
  skipNextTurn: boolean;
  turnRequested?: boolean;
  turnApprovedUntil?: number | null; // Timestamp in ms
  /**
   * How many approved rolls are still unspent.
   *
   * A player who bought several items at once had to wait for a separate
   * approval after every single roll. An approval now opens a batch: the
   * counter is decremented by each roll and the 12-hour window covers the
   * whole batch. 0 / undefined means "no approved turn".
   */
  turnsApproved?: number;
  /**
   * When the current batch was opened.
   *
   * Deliberately separate from turnApprovedUntil: a "+1 ХОД" cell pushes the
   * 12-hour window forward, so the window cannot tell us when the batch
   * began. This does, which is what decides whether a prize was won inside
   * the batch (carry on rolling) or before it (prize control applies).
   */
  turnBatchStartedAt?: number;
  /** How many turns the player asked for in the pending request (default 1). */
  turnsRequested?: number;
  avatar?: string;
  chipImage?: string;
  telegramId?: number;
  telegramUsername?: string;
  activeBonus?: ActiveBonus | null;
}

export interface Cell {
  id: number;
  name: string;
  description: string;
  type: CellType;
  value: number; // For gold rewards/penalties or cell changes
  x: number; // Percent of board width (0 to 100)
  y: number; // Percent of board height (0 to 100)
  extra?: string; // Additional text like "1 БРОСОК" or "200g"
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  text: string;
  timestamp: string;
  isAdmin: boolean;
}

export interface GameLog {
  id: string;
  message: string;
  timestamp: string;
  type: "system" | "roll" | "move" | "chat" | "admin" | "error";
}

export interface GameState {
  /** Version of the persisted shape; see migrateState() in server.ts. */
  schemaVersion?: number;
  /**
   * Monotonic counter bumped on every save.
   *
   * Lets the client ignore an older snapshot that arrives late (reconnect
   * racing a patch) and lets boot pick the newer of disk vs Firestore.
   */
  revision?: number;
  /** Wall-clock of the last save, ms since epoch. */
  updatedAt?: number;
  players: Player[];
  cells: Cell[];
  currentPlayerId: string | null;
  turnRequestUserId: string | null;
  turnStatus: "idle" | "waiting_roll" | "waiting_admin_confirmation";
  chatMessages: ChatMessage[];
  logs: GameLog[];
  boardImage: string | null; // Base64 or URL
  loginBackground?: string | null; // Base64 or URL
  rulesBackground?: string | null; // Base64 or URL
  /**
   * Через сколько часов бездействия фишка пропадает с доски.
   *
   * 0 — показывать всех, как было раньше. Настраивается администратором,
   * потому что подходящий срок зависит от того, как часто идёт игра.
   */
  hideTokensAfterHours?: number;
  calibrationMode: boolean;
  selectedCalibrationCellId: number | null;
}
