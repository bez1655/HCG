export interface CyberSkin {
  id: string;
  name: string;
  icon: string;
  src: string;
  description: string;
}

export const CYBER_SKINS: CyberSkin[] = [
  {
    id: "chip_1",
    name: "Кибер-Дрон",
    icon: "🛸",
    src: "/chips/chip_1.svg",
    description: "Тактический дрон разведки с сенсорным сканером",
  },
  {
    id: "chip_2",
    name: "Квантовое Ядро",
    icon: "⚛️",
    src: "/chips/chip_2.svg",
    description: "Микро-реактор на холодном термоядерном синтезе",
  },
  {
    id: "chip_3",
    name: "Нейро-Матрица",
    icon: "🧠",
    src: "/chips/chip_3.svg",
    description: "Высокоскоростной нейросетевой процессор вычислений",
  },
  {
    id: "chip_4",
    name: "Плазменный Вихрь",
    icon: "🌀",
    src: "/chips/chip_4.svg",
    description: "Импульсный турбо-ускоритель с плазменным кольцом",
  },
  {
    id: "chip_5",
    name: "Кибер-Призрак",
    icon: "👤",
    src: "/chips/chip_5.svg",
    description: "Скрытный силуэт элитного цифрового оперативника",
  },
  {
    id: "chip_6",
    name: "Техно-Око",
    icon: "👁️",
    src: "/chips/chip_6.svg",
    description: "Кибернетический визор обнаружения скрытых данных",
  },
  {
    id: "chip_7",
    name: "Импульсный Чип",
    icon: "⚡",
    src: "/chips/chip_7.svg",
    description: "Высоковольтный криптографический сопроцессор",
  },
  {
    id: "chip_8",
    name: "Хакерский Череп",
    icon: "💀",
    src: "/chips/chip_8.svg",
    description: "Легендарная эмблема кибер-подполья и взломщиков",
  },
  {
    id: "chip_9",
    name: "Неоновый Кристалл",
    icon: "💎",
    src: "/chips/chip_9.svg",
    description: "Многогранный кристалл высокой плотности хранения",
  },
  {
    id: "chip_10",
    name: "Био-Реактор",
    icon: "🧪",
    src: "/chips/chip_10.svg",
    description: "Генератор кибер-сыворотки и энергетических бустеров",
  },
  {
    id: "chip_11",
    name: "Голо-Щит",
    icon: "🛡️",
    src: "/chips/chip_11.svg",
    description: "Защитный отражатель сетевых помех и сбоев",
  },
  {
    id: "chip_12",
    name: "Кибер-Дракон",
    icon: "🐉",
    src: "/chips/chip_12.svg",
    description: "Стилизованный герб клана ночных нетраннеров",
  },
  {
    id: "chip_13",
    name: "Орбитальный Модуль",
    icon: "🛰️",
    src: "/chips/chip_13.svg",
    description: "Спутниковый ретранслятор защищённой связи",
  },
];

export interface CyberColor {
  hex: string;
  name: string;
  glow: string;
}

export const CYBER_NEON_COLORS: CyberColor[] = [
  { hex: "#00ffaa", name: "Кибер-Мята", glow: "rgba(0,255,170,0.8)" },
  { hex: "#00d9ff", name: "Неоновый Циан", glow: "rgba(0,217,255,0.8)" },
  { hex: "#ff007f", name: "Лазерная Маджента", glow: "rgba(255,0,127,0.8)" },
  { hex: "#ff7a18", name: "Плазменный Янтарь", glow: "rgba(255,122,24,0.8)" },
  { hex: "#a855f7", name: "Ультрафиолет", glow: "rgba(168,85,247,0.8)" },
  { hex: "#eab308", name: "Кибер-Золото", glow: "rgba(234,179,8,0.8)" },
];

export function getSkinBySrc(src?: string): CyberSkin {
  if (!src) return CYBER_SKINS[0];
  const clean = src.split("?")[0].toLowerCase();
  const found = CYBER_SKINS.find((s) => s.src.toLowerCase() === clean);
  return found || CYBER_SKINS[0];
}
