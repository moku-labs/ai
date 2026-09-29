import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertItems } from "../../items";
import { openRun } from "../../runs";
import { readRunSnapshot } from "../../snapshot";
import type { State } from "../../types";
import {
  closedState,
  closeTestJournal,
  intent,
  openTestJournal,
  type TestJournal
} from "./fixtures";

describe("journal snapshot", () => {
  let journal: TestJournal;
  let state: State;

  beforeEach(() => {
    journal = openTestJournal();
    state = journal.state;
  });

  afterEach(() => {
    closeTestJournal(journal);
  });

  describe("readSnapshot", () => {
    it("opens a second connection and reads committed rows", () => {
      const run = openRun(state, { glob: "*.yaml" });
      insertItems(state, run.id, [intent("pk-1")]);

      const snapshot = readRunSnapshot(state, journal.config, run.id);

      expect(snapshot.run.id).toBe(run.id);
      expect(snapshot.totals.total).toBe(1);
      expect(snapshot.recentItems).toHaveLength(1);
    });

    it("throws when the run does not exist", () => {
      expect(() => readRunSnapshot(state, journal.config, "missing-run")).toThrow(
        "[ai] Run not found: missing-run.\n  Verify the run id came from openRun() for this invocation."
      );
    });

    it("throws the not-open error before the journal is started", () => {
      expect(() => readRunSnapshot(closedState(), journal.config, "any-run")).toThrow(
        "[ai] Journal is not open."
      );
    });
  });
});
