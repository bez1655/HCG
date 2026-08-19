import React from "react";

/**
 * Catches a render crash and shows what happened.
 *
 * This application had no error boundary at all. In React 19 an uncaught
 * error during render unmounts the whole tree — the screen goes blank and
 * the reason exists only in a console nobody can open on a phone. That is
 * exactly what the white APK screenshot was: not a hang, a crash.
 *
 * Three rounds of diagnosis were spent guessing at causes because the
 * evidence was being thrown away. This component keeps it: the message and
 * stack are shown on screen, copyable, and posted to the server so they land
 * in `docker compose logs`.
 *
 * It deliberately renders no dependencies of its own — no Tailwind classes,
 * no motion, no icons. A fallback that needs the rest of the app to work is
 * useless precisely when it is needed.
 */
interface Props {
  children: React.ReactNode;
  /** Where the crash happened, for the report. */
  area?: string;
}

interface State {
  error: Error | null;
  info: string;
}

export default class CrashGuard extends React.Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const stack = info.componentStack ?? "";
    this.setState({ info: stack });

    // Console first: it survives even if the report below fails.
    console.error("[HCG] Сбой интерфейса:", error, stack);

    /*
     * Send it to the server.
     *
     * The player cannot open devtools inside Telegram, and asking them to is
     * how the last three rounds went. keepalive so the request still goes
     * out if the view is being torn down. Failure here is ignored on
     * purpose — a broken report must not replace the error being reported.
     */
    try {
      void fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          area: this.props.area ?? "unknown",
          message: error.message,
          stack: (error.stack ?? "").slice(0, 2000),
          componentStack: stack.slice(0, 2000),
          userAgent: navigator.userAgent,
          url: location.href,
        }),
      }).catch(() => undefined);
    } catch {
      /* nothing more we can do */
    }
  }

  private reset = (): void => {
    this.setState({ error: null, info: "" });
  };

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const report = `${error.message}\n\n${error.stack ?? ""}\n\nКомпоненты:${info}`;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99999,
          background: "#12060b",
          color: "#ffd9e0",
          font: "13px/1.5 ui-monospace, Menlo, Consolas, monospace",
          padding: "18px",
          overflow: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "10px" }}>
          Сбой в интерфейсе
        </div>

        <div style={{ color: "#ff8fa3", marginBottom: "14px", wordBreak: "break-word" }}>
          {error.message}
        </div>

        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#1c0a12",
            border: "1px solid #40202c",
            borderRadius: "8px",
            padding: "10px",
            maxHeight: "42vh",
            overflow: "auto",
            margin: 0,
          }}
        >
          {report}
        </pre>

        <div style={{ display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" }}>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(report).catch(() => undefined);
            }}
            style={btn}
          >
            Скопировать
          </button>
          <button onClick={this.reset} style={btn}>
            Попробовать снова
          </button>
          <button onClick={() => location.reload()} style={btn}>
            Перезагрузить
          </button>
        </div>

        <div style={{ marginTop: "12px", color: "#9a7580", fontSize: "11px" }}>
          Отчёт отправлен на сервер — он виден в{" "}
          <span style={{ color: "#ffd9e0" }}>docker compose logs hcg_app</span>
        </div>
      </div>
    );
  }
}

const btn: React.CSSProperties = {
  background: "#2a1119",
  color: "#ffd9e0",
  border: "1px solid #5a2a38",
  borderRadius: "8px",
  padding: "9px 14px",
  font: "600 12px ui-monospace, monospace",
  cursor: "pointer",
};
