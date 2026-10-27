import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Interface assets: the files themselves, and the cache-busting tags.
 *
 * Both halves have bitten this project already. All thirteen chip PNGs once
 * shipped corrupted — the 0x89 byte of the signature replaced by the Unicode
 * replacement character, because the files had been handled as text
 * somewhere along the way. Nothing failed loudly; the images simply did not
 * render. A signature check costs nothing and catches that class of damage
 * the moment it happens.
 *
 * The version tags matter just as much. Telegram's webview caches
 * aggressively, so replacing a file without bumping ?v= means the player
 * keeps seeing the old artwork and reports that nothing changed.
 */
const PUBLIC = path.resolve(__dirname, "..", "public");
const SRC = __dirname;

/** Bytes every PNG must start with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("interface assets are intact", () => {
  const images = ["BoardHAP.png", "Dice.png", "Log.png", "RulesHAP.png"];

  /** Bytes a JPEG starts with. Log.png and RulesHAP.png are JPEGs despite
   * the extension — they have been since the first commit, and browsers
   * dispatch on content rather than the name, so they render fine. The
   * check below accepts either format: the failure worth catching is a
   * mangled file, not a misleading suffix. */
  const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

  for (const name of images) {
    it(`${name} is a real image, not text-mangled`, () => {
      const file = path.join(PUBLIC, name);
      expect(fs.existsSync(file), `${name} is missing from public/`).toBe(true);

      const head = Buffer.alloc(8);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, head, 0, 8, 0);
      fs.closeSync(fd);

      const ok = head.equals(PNG_MAGIC) || head.subarray(0, 3).equals(JPEG_MAGIC);
      expect(
        ok,
        `${name} is neither a PNG nor a JPEG — it was probably converted to ` +
          `text at some point, which is exactly how all thirteen chip images ` +
          `died (0x89 replaced by the Unicode replacement character)`
      ).toBe(true);

      // The specific corruption that hit the chips: a text-safe replacement
      // character where the signature should be.
      expect(head.subarray(0, 3).equals(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    });
  }

  it("the two assets we replaced are genuine PNGs", () => {
    // These arrived as PNG and must stay PNG: the dice button relies on the
    // alpha channel, and a JPEG would put a black square behind it.
    for (const name of ["BoardHAP.png", "Dice.png"]) {
      const head = fs.readFileSync(path.join(PUBLIC, name)).subarray(0, 8);
      expect(head.equals(PNG_MAGIC), `${name} must be a PNG`).toBe(true);
    }
  });

  it("the dice button keeps its transparency", () => {
    // colour type 6 = RGBA. Without it the button would sit on an opaque
    // rectangle instead of floating over the board.
    const buf = fs.readFileSync(path.join(PUBLIC, "Dice.png"));
    expect(buf.readUInt8(25)).toBe(6);
  });

  it("the app icon is present and square enough for Android", () => {
    // @capacitor/assets derives 74 files from this one. A wrong size here
    // surfaces only at build time, deep in a Gradle log.
    const icon = path.resolve(__dirname, "..", "apk", "resources", "icon.png");
    expect(fs.existsSync(icon), "apk/resources/icon.png is missing").toBe(true);

    const buf = fs.readFileSync(icon);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);

    // IHDR: width and height are big-endian uint32 at offsets 16 and 20.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(1024);
  });

  it("the board video is a playable MP4", () => {
    const file = path.join(PUBLIC, "BoardHAP.mp4");
    expect(fs.existsSync(file)).toBe(true);

    const head = fs.readFileSync(file).subarray(0, 32).toString("latin1");
    // Every MP4 opens with an ftyp box; without moov it cannot be streamed.
    expect(head).toContain("ftyp");
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
  });
});

describe("cache-busting tags", () => {
  const sources = walk(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("every reference to a replaceable asset carries a ?v= tag", () => {
    // Without it, Telegram's webview serves the previous artwork from cache
    // and the change looks like it never happened.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf-8");
      for (const [i, line] of text.split("\n").entries()) {
        const m = line.match(/"\/(BoardHAP\.(png|mp4)|Dice\.png)(\?v=\d+)?"/);
        if (m && !m[3]) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    }
    expect(offenders, `these will be served stale: ${offenders.join(", ")}`).toEqual([]);
  });

  it("all references agree on the same version", () => {
    // A half-bumped set is worse than none: some assets update, others do
    // not, and the mismatch is blamed on the artwork rather than the tag.
    const versions = new Set<string>();
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf-8");
      for (const m of text.matchAll(/"\/(?:BoardHAP\.(?:png|mp4)|Dice\.png)\?v=(\d+)"/g)) {
        versions.add(m[1]);
      }
    }
    expect(versions.size, `mixed versions in use: ${[...versions].join(", ")}`).toBeLessThanOrEqual(
      1
    );
  });
});

/**
 * Права на скриптах.
 *
 * Флаг исполняемости теряется на каждом шагу: prettier его снимает, zip и
 * облачные диски не всегда переносят. На сервере это выглядит как
 * «permission denied» на ровном месте.
 *
 * fix-permissions.sh restores the bit. The test checks every .sh the
 * user might run on the VPS.
 */
describe("shell scripts are executable", () => {
  const ROOT = path.resolve(__dirname, "..");

  function findScripts(dir: string, depth = 0): string[] {
    if (depth > 2) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") return [];
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return findScripts(full, depth + 1);
      return e.isFile() && e.name.endsWith(".sh") ? [full] : [];
    });
  }

  it("every .sh in the project carries the executable bit", () => {
    const broken = findScripts(ROOT).filter((f) => {
      try {
        fs.accessSync(f, fs.constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });

    expect(
      broken.map((f) => path.relative(ROOT, f)),
      "run `npm run fix-perms` — these will fail with permission denied on the server"
    ).toEqual([]);
  });

  it("fix-permissions.sh also looks in the project root", () => {
    // Не косметика: именно пропуск корня и отправил диагностический скрипт
    // в архив нерабочим.
    const script = fs.readFileSync(path.join(ROOT, "scripts", "fix-permissions.sh"), "utf-8");
    expect(script).toMatch(/find \. deploy scripts/);
  });
});
