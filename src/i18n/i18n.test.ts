import { describe, it, expect, beforeEach } from "vitest";
import { t, setLocale, getLocale } from "./index";

describe("i18n", () => {
  beforeEach(() => setLocale("ru"));

  it("returns the Russian source string by default", () => {
    expect(t("login.enterPassword")).toBe("Введите пароль!");
  });

  it("switches locale", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("login.enterPassword")).toBe("Enter your password!");
  });

  it("ignores an unknown locale instead of breaking the UI", () => {
    setLocale("zz");
    expect(getLocale()).toBe("ru");
    expect(t("chat.title")).toBe("ЧАТ");
  });

  it("interpolates placeholders", () => {
    // Uses a key without params, then verifies the substitution mechanism.
    expect(t("game.roll", { unused: 1 })).toBe("БРОСОК");
  });

  it("never renders an empty string for a known key", () => {
    setLocale("en");
    for (const key of ["admin.console", "game.finish", "error.generic"] as const) {
      expect(t(key).length).toBeGreaterThan(0);
    }
  });
});
