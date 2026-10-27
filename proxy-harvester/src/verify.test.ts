import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { verifyOne, verifyAll, type Candidate } from "./verify.js";

/**
 * These use a real socket rather than a mock on purpose.
 *
 * The bug they guard against was invisible to mocks: request.timeout only
 * arms once a socket exists, and with a SOCKS proxy the agent creates the
 * socket, so a proxy that accepts TCP and then goes quiet was not covered at
 * all. A 5 s timeout took 30 s to give up. Only a genuine stalled connection
 * reproduces that.
 */
const servers: net.Server[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

/** A server that accepts the connection and then never speaks again. */
function blackHole(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // Hold the socket open, send nothing. This is what a dead free proxy
      // looks like from outside: the port is open, the traffic goes nowhere.
      socket.on("error", () => undefined);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

const candidate = (port: number): Candidate => ({
  address: `127.0.0.1:${port}`,
  protocol: "socks5",
  source: "test",
});

describe("probe deadline", () => {
  it("gives up on a stalled proxy within the timeout", async () => {
    const port = await blackHole();
    const started = Date.now();
    const result = await verifyOne(candidate(port), 1500);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    // Generous ceiling: the point is that it is bounded at all. Before the
    // fix this took ~30 s regardless of the timeout requested.
    expect(elapsed).toBeLessThan(4000);
  }, 15_000);

  it("reports a failure rather than throwing on a refused port", async () => {
    // Port 1 is reserved and never listening.
    const result = await verifyOne(
      { address: "127.0.0.1:1", protocol: "socks5", source: "test" },
      2000
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  }, 15_000);

  it("never resolves twice, even when timeout and error race", async () => {
    const port = await blackHole();
    let count = 0;
    await new Promise<void>((done) => {
      void verifyOne(candidate(port), 800).then(() => {
        count += 1;
        setTimeout(done, 1200);
      });
    });
    expect(count).toBe(1);
  }, 15_000);
});

describe("bulk verification", () => {
  it("returns nothing for an empty list without hanging", async () => {
    const results = await verifyAll([], { concurrency: 10, timeoutMs: 1000 });
    expect(results).toEqual([]);
  });

  it("finishes a batch of dead addresses in roughly one timeout", async () => {
    // Bounded concurrency must not serialise into timeout × count. With 20
    // dead addresses and a 1 s deadline this has to stay near 1 s, not 20 s.
    const port = await blackHole();
    const many = Array.from({ length: 20 }, () => candidate(port));

    const started = Date.now();
    const results = await verifyAll(many, { concurrency: 20, timeoutMs: 1000 });
    const elapsed = Date.now() - started;

    expect(results).toEqual([]);
    expect(elapsed).toBeLessThan(6000);
  }, 20_000);

  it("reports progress as it goes", async () => {
    // A silent container looks hung; the cycle log depends on this callback.
    const port = await blackHole();
    const seen: number[] = [];
    await verifyAll([candidate(port), candidate(port)], {
      concurrency: 2,
      timeoutMs: 800,
      onResult: (_r, done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toHaveLength(2);
  }, 15_000);
});
