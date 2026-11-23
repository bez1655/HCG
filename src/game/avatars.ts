/**
 * Каталог киберпанк-портретов (аватаров) для героев HCG.
 * 5 мужских и 5 женских уникальных неоновых портретов.
 */

export interface CyberAvatar {
  id: string;
  name: string;
  gender: "male" | "female";
  color: string;
  src: string;
  description: string;
}

export const CYBER_AVATARS: CyberAvatar[] = [
  // Мужские портреты
  {
    id: "m_1",
    name: "Рон Самурай",
    gender: "male",
    color: "#00f0ff",
    src: "/avatars/m_1.svg",
    description: "Кибер-самурай с неоновым ирокезом и тактическим визором",
  },
  {
    id: "m_2",
    name: "Вектор Z",
    gender: "male",
    color: "#00ff66",
    src: "/avatars/m_2.svg",
    description: "Хакер-нетраннер в капюшоне с зелеными нейро-линзами",
  },
  {
    id: "m_3",
    name: "Маркус Голд",
    gender: "male",
    color: "#f5c542",
    src: "/avatars/m_3.svg",
    description: "Корпорат-фиксер с золотым моноклем и плазменным стилем",
  },
  {
    id: "m_4",
    name: "Бронкс Т-4",
    gender: "male",
    color: "#e11d48",
    src: "/avatars/m_4.svg",
    description: "Тяжелый киборг с титановой броней и красным сенсором",
  },
  {
    id: "m_5",
    name: "Док Кай",
    gender: "male",
    color: "#bd00ff",
    src: "/avatars/m_5.svg",
    description: "Риппердок кибер-подполья с фиолетовой нейро-повязкой",
  },

  // Женские портреты
  {
    id: "f_1",
    name: "Валькирия Нова",
    gender: "female",
    color: "#bd00ff",
    src: "/avatars/f_1.svg",
    description: "Неоновая воительница с фиолетовым каре и кибер-линзами",
  },
  {
    id: "f_2",
    name: "Призрак Миа",
    gender: "female",
    color: "#00f0ff",
    src: "/avatars/f_2.svg",
    description: "Гоуст-ассасин с бирюзовыми глазами и полумаской",
  },
  {
    id: "f_3",
    name: "Кира Байт",
    gender: "female",
    color: "#00ff66",
    src: "/avatars/f_3.svg",
    description: "Нетраннер с кислотно-зелеными дредами и голо-очками",
  },
  {
    id: "f_4",
    name: "Вивьен Скай",
    gender: "female",
    color: "#f5c542",
    src: "/avatars/f_4.svg",
    description: "Элитный агент мегакорпорации с золотыми имплантами",
  },
  {
    id: "f_5",
    name: "Аска Пилот",
    gender: "female",
    color: "#e11d48",
    src: "/avatars/f_5.svg",
    description: "Боевой пилот в шлеме с HUD-визором и системой подачи O2",
  },
];

/** Получить случайный аватар (опционально по полу) */
export function getRandomAvatar(gender?: "male" | "female"): CyberAvatar {
  const pool = gender
    ? CYBER_AVATARS.filter((a) => a.gender === gender)
    : CYBER_AVATARS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Найти аватар по src или id */
export function getAvatarBySrc(src?: string): CyberAvatar {
  if (!src) return CYBER_AVATARS[0];
  const clean = src.split("?")[0].toLowerCase();
  const found = CYBER_AVATARS.find(
    (a) => a.src.toLowerCase() === clean || a.id.toLowerCase() === clean
  );
  return found || CYBER_AVATARS[0];
}
