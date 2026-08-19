import React, { useState } from "react";
import { playSound } from "../utils/sounds";
import { apiFetch, IS_STANDALONE_BUILD } from "../config/api";

interface LoginScreenProps {
  backgroundUrl?: string | null;
  /**
   * Message from the parent explaining why the form is being shown, e.g. the
   * Telegram handshake succeeded but the account has not been registered yet.
   */
  notice?: string;
  onLogin: (
    name: string,
    role: "admin" | "player",
    color: string,
    token?: string,
    forceId?: string
  ) => void;
}

const CYBERPUNK_COLORS = [
  { name: "Красный Неон", hex: "#E11D48" },
  { name: "Матрица", hex: "#059669" },
  { name: "Синий Лазер", hex: "#2563EB" },
  { name: "Золотой Нанит", hex: "#D4A017" },
  { name: "Ультрафиолет", hex: "#9333EA" },
  { name: "Хром", hex: "#E5E7EB" },
];

export default function LoginScreen({ backgroundUrl, notice, onLogin }: LoginScreenProps) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [selectedColor, setSelectedColor] = useState("#D4A017");
  const [errorMsg, setErrorMsg] = useState(notice || "");
  const [loading, setLoading] = useState(false);

  // A notice arriving after mount (the Telegram handshake resolves
  // asynchronously) must still reach the user.
  React.useEffect(() => {
    if (notice) setErrorMsg(notice);
  }, [notice]);

  const bg = backgroundUrl || "/Log.mp4";
  const isVideo = !bg || bg.endsWith(".mp4") || bg.endsWith(".mov") || bg.startsWith("data:video");

  React.useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      if (tg.initDataUnsafe?.user?.username) {
        setName("@" + tg.initDataUnsafe.user.username);
      } else if (tg.initDataUnsafe?.user?.first_name) {
        const sanitizedName = tg.initDataUnsafe.user.first_name.replace(/\s+/g, "").toLowerCase();
        setName("@" + sanitizedName);
      }
    }
  }, []);

  // We determine if they are logging in as admin just by checking if the name is 'admin' or if they type the admin password.
  // The server will handle validation. For now we pass both name and password.

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMsg("");

    if (!name.trim()) {
      setErrorMsg("Укажите ваше игровое имя!");
      playSound("error");
      return;
    }

    if (!password.trim()) {
      setErrorMsg("Введите пароль!");
      playSound("error");
      return;
    }

    playSound("click");
    setLoading(true);

    try {
      // The role is decided server-side by comparing the login name against
      // ADMIN_LOGIN and verifying ADMIN_PASSWORD_HASH. Nothing sent from here
      // can grant admin rights, so no admin login name is hardcoded.
      const tg = (window as any).Telegram?.WebApp;
      const response = await apiFetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          password: password.trim(),
          color: selectedColor,
          telegramId: tg?.initDataUnsafe?.user?.id,
          telegramUsername: tg?.initDataUnsafe?.user?.username,
        }),
      });

      const data = await response.json();
      setLoading(false);

      if (!response.ok) {
        setErrorMsg(data.error || "Ошибка подключения");
        playSound("error");
      } else {
        playSound("success");
        // Pass the signed session token upwards instead of the raw password.
        onLogin(data.name, data.role, data.color, data.token, data.id);
      }
    } catch (err) {
      setLoading(false);
      setErrorMsg("Ошибка связи с сервером");
      playSound("error");
    }
  };

  return (
    <div className="h-[100dvh] w-full bg-black flex items-center justify-center font-sans overflow-hidden select-none">
      {/* Background Container replicating the image aspect ratio (1080x1920) */}
      <div className="relative h-full w-full max-w-[56.25vh] aspect-[9/16] bg-[#0B1426] shadow-2xl overflow-hidden">
        {/* Background Video/Image */}
        {isVideo ? (
          <video
            src={bg}
            autoPlay
            loop
            muted
            playsInline
            poster="/Log.png"
            className="absolute inset-0 w-full h-full object-cover z-0"
          ></video>
        ) : (
          <img
            src={bg}
            alt="Login Background"
            className="absolute inset-0 w-full h-full object-cover z-0"
          />
        )}

        {/* If the video isn't uploaded yet, we can provide a fallback visual so it's not empty */}
        <div className="absolute inset-0 flex flex-col items-center justify-center opacity-0 -z-10 text-gray-500 text-xs">
          Пожалуйста, загрузите Log.mp4 в папку public/
        </div>

        {errorMsg && (
          <div className="absolute top-[38%] left-[10%] right-[10%] bg-red-950/90 border border-red-500/50 rounded-lg p-2 text-xs md:text-sm text-red-300 text-center font-mono z-50 animate-pulse shadow-[0_0_15px_rgba(255,0,85,0.4)]">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="absolute inset-0">
          {/* Имя Input */}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: @neon"
            maxLength={20}
            className="absolute top-[48.3%] left-[21.5%] w-[57%] h-[4.6%] bg-transparent text-white px-4 text-sm md:text-base focus:outline-none rounded-lg font-sans placeholder-gray-500 font-medium"
            style={{ height: "22px", width: "125px", marginLeft: "43px", marginTop: "57px" }}
          />

          {/* Пароль Input */}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Введите пароль"
            className="absolute top-[57.1%] left-[21.5%] w-[57%] h-[4.6%] bg-transparent text-white px-4 text-sm md:text-base focus:outline-none rounded-lg font-sans placeholder-gray-500 font-medium"
            style={{ marginLeft: "48px", width: "125px", height: "22px", marginTop: "33px" }}
          />

          {/* Фишки / Colors */}
          <div
            className="absolute top-[66.6%] left-[18.5%] w-[63%] h-[4.6%] flex items-center justify-between"
            style={{
              width: "216.375px",
              height: "28.675px",
              marginLeft: "14px",
              marginTop: "14px",
            }}
          >
            {CYBERPUNK_COLORS.map((color) => (
              <button
                key={color.hex}
                type="button"
                onClick={() => {
                  playSound("click");
                  setSelectedColor(color.hex);
                }}
                className={`relative h-[85%] aspect-square rounded-full flex items-center justify-center transition-all duration-300 group`}
                title={color.name}
              >
                {/* Ring when inactive */}
                <div
                  className={`absolute inset-0 rounded-full border-[2.5px] transition-all duration-300 ${selectedColor === color.hex ? "opacity-0 scale-110" : "opacity-100 scale-100 group-hover:scale-105"}`}
                  style={{
                    borderColor: color.hex,
                    boxShadow: `0 0 8px ${color.hex}, inset 0 0 5px ${color.hex}`,
                  }}
                ></div>

                {/* Inner fill when selected */}
                <div
                  className={`absolute inset-0 rounded-full transition-all duration-300 ${selectedColor === color.hex ? "opacity-100 scale-110" : "opacity-0 scale-50 group-hover:opacity-40 group-hover:scale-75"}`}
                  style={{ backgroundColor: color.hex, boxShadow: `0 0 15px ${color.hex}` }}
                ></div>
              </button>
            ))}
          </div>

          {/* Button Submit */}

          {/* Registration requests go to a Telegram administrator, so the
              button is pointless in the standalone Android app: that build is
              for the administrator, who is already registered. */}
          {!IS_STANDALONE_BUILD && (
          <button
            type="button"
            onClick={async (e) => {
              e.preventDefault();
              if (!name.trim()) {
                setErrorMsg("Укажите ваше игровое имя для запроса!");
                playSound("error");
                return;
              }
              playSound("click");
              try {
                const res = await apiFetch("/api/telegram/request-registration", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ username: name.trim() }),
                });
                const data = await res.json().catch(() => ({}));

                if (res.ok) {
                  setErrorMsg(
                    data.alreadyPending
                      ? "Заявка уже отправлена, ожидайте ответа администратора."
                      : "Заявка отправлена! Пароль придёт в этот чат с ботом."
                  );
                  playSound("success");
                } else {
                  // 409 = already a player, 429 = rate limited, 400 = bad handle.
                  setErrorMsg(data.error || "Не удалось отправить заявку.");
                  playSound("error");
                }
              } catch {
                setErrorMsg("Не удалось отправить запрос. Попробуйте позже.");
                playSound("error");
              }
            }}
            className="absolute top-[86%] left-[19%] w-[62%] h-[6%] bg-[#0B1426]/80 text-[#D4A017] border border-[#D4A017]/30 rounded-xl flex items-center justify-center text-[9px] md:text-[10px] font-bold font-mono tracking-wider transition-all hover:bg-[#D4A017]/20 z-50 text-center leading-tight flex-col shadow-[0_0_10px_rgba(212,160,23,0.3)]"
            style={{ width: "120px", marginLeft: "58px", marginTop: "-30px" }}
          >
            <span>ЗАПРОСИТЬ</span>
            <span>РЕГИСТРАЦИЮ</span>
          </button>
          )}

          <button
            type="submit"
            disabled={loading}
            className="absolute top-[81.5%] left-[19%] w-[62%] h-[9%] bg-transparent cursor-pointer rounded-2xl flex items-center justify-center transition-all duration-300 focus:outline-none hover:bg-white/5 group"
            style={{
              width: "100px",
              height: "22px",
              marginLeft: "68px",
              marginTop: "-44px",
              paddingLeft: "1px",
              marginRight: "3px",
            }}
          >
            {loading && (
              <span className="absolute inset-0 flex items-center justify-center bg-[#0B1426]/80 backdrop-blur-sm text-[#D4A017] font-bold text-lg md:text-xl tracking-[0.15em] rounded-2xl">
                ПОДКЛЮЧЕНИЕ...
              </span>
            )}
            <span className="sr-only">ВОЙТИ В СЕТЬ</span>
          </button>
        </form>
      </div>
    </div>
  );
}
