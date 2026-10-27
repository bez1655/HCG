import { describe, it, expect } from "vitest";
import { choosePersistedState, snapshotRecency } from "./chooseState";

describe("choosePersistedState", () => {
  it("prefers the snapshot with the higher revision", () => {
    const local = { revision: 10, updatedAt: 1, players: [{ id: "a", cell: 40 }] };
    const remote = { revision: 8, updatedAt: 999, players: [{ id: "a", cell: 12 }] };
    const chosen = choosePersistedState(local, remote);
    expect(chosen.source).toBe("local");
    expect(chosen.state?.players?.[0].cell).toBe(40);
  });

  it("prefers a newer updatedAt when revisions match", () => {
    const local = { revision: 3, updatedAt: 100, players: [{ cell: 5 }] };
    const remote = { revision: 3, updatedAt: 200, players: [{ cell: 9 }] };
    expect(choosePersistedState(local, remote).source).toBe("remote");
  });

  it("does not let a stale Firestore snapshot undo a batch of rolls", () => {
    // Exactly the production failure: five rolls landed, disk has cell 31,
    // Firestore still has cell 14 from five seconds earlier, process restarts.
    const local = {
      revision: 84,
      updatedAt: 1_800_000,
      players: [{ id: "hapalka", cell: 31, lastSeenAt: 1_800_000 }],
    };
    const remote = {
      revision: 79,
      updatedAt: 1_794_000,
      players: [{ id: "hapalka", cell: 14, lastSeenAt: 1_794_000 }],
    };
    const chosen = choosePersistedState(local, remote);
    expect(chosen.source).toBe("local");
    expect(chosen.state?.players?.[0].cell).toBe(31);
  });

  it("uses local disk when neither snapshot has a clock", () => {
    const local = { players: [{ cell: 20 }] };
    const remote = { players: [{ cell: 4 }] };
    expect(choosePersistedState(local, remote).source).toBe("local");
  });

  it("returns the only available side", () => {
    expect(choosePersistedState({ revision: 1 }, null).source).toBe("local");
    expect(choosePersistedState(null, { revision: 1 }).source).toBe("remote");
    expect(choosePersistedState(null, null).source).toBe("none");
  });

  it("ranks a clocked snapshot above a clock-less one", () => {
    expect(snapshotRecency({ revision: 1, updatedAt: 1 })).toBeGreaterThan(
      snapshotRecency({ players: [{ lastSeenAt: Date.now(), cell: 64 }] })
    );
  });
});
