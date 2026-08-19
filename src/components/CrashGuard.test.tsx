// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type React from "react";
import { render, cleanup } from "@testing-library/react";
import CrashGuard from "./CrashGuard";

/**
 * The error boundary this application spent three debugging rounds without.
 *
 * React 19 unmounts the entire tree when a render throws. With nothing to
 * catch it the screen goes white and the reason lives only in a console that
 * cannot be opened inside Telegram or an APK. Every guess about the freeze
 * was made blind for exactly that reason.
 */
function Boom({ message = "сбой" }: { message?: string }): React.ReactElement {
  throw new Error(message);
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught errors itself; silence it so the output stays readable.
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() =>
    Promise.resolve({ ok: true } as Response)
  );
});

afterEach(() => {
  consoleSpy.mockRestore();
  cleanup();
});

describe("CrashGuard", () => {
  it("renders children when nothing is wrong", () => {
    const { getByText } = render(
      <CrashGuard>
        <div>игра</div>
      </CrashGuard>
    );
    expect(getByText("игра")).toBeTruthy();
  });

  it("shows the error instead of a blank screen", () => {
    const { container } = render(
      <CrashGuard>
        <Boom message="кубик не отрисовался" />
      </CrashGuard>
    );
    expect(container.textContent).toContain("кубик не отрисовался");
    expect(container.textContent).toContain("Сбой в интерфейсе");
  });

  it("reports the crash to the server", () => {
    // The player cannot open devtools; the report has to reach the place the
    // operator already looks — docker compose logs.
    render(
      <CrashGuard area="board">
        <Boom />
      </CrashGuard>
    );

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe("/api/client-error");

    const body = JSON.parse((calls[0][1] as { body: string }).body);
    expect(body.area).toBe("board");
    expect(body.message).toBeTruthy();
  });

  it("survives a reporting endpoint that fails", () => {
    // A broken report must never replace the error being reported.
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() =>
      Promise.reject(new Error("нет сети"))
    );
    const { container } = render(
      <CrashGuard>
        <Boom message="исходная ошибка" />
      </CrashGuard>
    );
    expect(container.textContent).toContain("исходная ошибка");
  });

  it("offers a way out", () => {
    const { container } = render(
      <CrashGuard>
        <Boom />
      </CrashGuard>
    );
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Перезагрузить");
    expect(labels).toContain("Скопировать");
  });

  it("uses no styling the crash could have taken down", () => {
    // A fallback that depends on Tailwind, motion or icons is useless
    // precisely when it is needed.
    const src = fs.readFileSync(path.join(__dirname, "CrashGuard.tsx"), "utf-8");
    expect(src).not.toMatch(/from "framer-motion"|from "motion/);
    expect(src).not.toMatch(/from "lucide-react"/);
    expect(src).not.toMatch(/className=/);
  });
});

describe("the board is guarded", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "..", "App.tsx"), "utf-8");

  it("wraps BoardView, where the roll happens", () => {
    expect(app).toMatch(/<CrashGuard area="board">/);
    expect(app).toMatch(/<\/CrashGuard>/);
  });
});

describe("the server accepts crash reports", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf-8");

  it("has the endpoint", () => {
    expect(server).toMatch(/app\.post\("\/api\/client-error"/);
  });

  it("logs them where the operator already looks", () => {
    expect(server).toMatch(/log\.error\("Client crash reported"/);
  });

  it("is rate limited", () => {
    // Unauthenticated by necessity — a crash can precede login — so it must
    // not become a way to flood the log.
    const handler = server.slice(server.indexOf('app.post("/api/client-error"'));
    expect(handler.slice(0, 1500)).toMatch(/429/);
  });
});
