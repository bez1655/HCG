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
  name: string;
  role: "admin" | "player";
  cell: number;
  color: string;
  isOnline: boolean;
  lastRoll: number | null;
  skipNextTurn: boolean;
  turnRequested?: boolean;
  turnApprovedUntil?: number | null; // Timestamp in ms
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
  calibrationMode: boolean;
  selectedCalibrationCellId: number | null;
}
