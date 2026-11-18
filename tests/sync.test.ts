import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  applySyncSnapshot,
  createSyncSnapshot,
  getSyncIdHash,
} from "../src/services/sync";
import {
  getAppConfig,
  getContactProvenance,
  getContactsFromList,
  getIgnoredGroups,
  getNotedComparison,
  getRoomById,
  getSavedLinks,
  recordScanProvenance,
  saveAppConfig,
  saveContactsToList,
  saveIgnoredGroups,
  saveLinks,
  saveNotedComparison,
  saveRoom,
} from "../src/services/wape-store";

let homeDir = "";
let previousHome = "";

function useHome(path: string) {
  process.env.WAPE_HOME = path;
}

beforeEach(() => {
  previousHome = process.env.WAPE_HOME ?? "";
  homeDir = mkdtempSync(join(tmpdir(), "wape-sync-test-"));
  useHome(homeDir);
});

afterEach(() => {
  if (previousHome) {
    process.env.WAPE_HOME = previousHome;
  } else {
    delete process.env.WAPE_HOME;
  }
  rmSync(homeDir, { recursive: true, force: true });
});

describe("wape sync snapshots", () => {
  it("merges database records and config in both directions", () => {
    const dirA = homeDir;
    const dirB = mkdtempSync(join(tmpdir(), "wape-sync-test-b-"));

    try {
      useHome(dirA);
      saveContactsToList("alpha", new Set(["08012345678", "+2348022223333"]));
      saveLinks(["https://chat.whatsapp.com/alpha-link"]);
      saveRoom({
        id: "room-a",
        groupIds: ["111@g.us"],
        groupNames: ["Group A"],
        targetList: "alpha",
        createdAt: 1000,
        updatedAt: 2000,
      });
      saveIgnoredGroups([
        { jid: "999@g.us", subject: "Spam A", ignoredAt: 1000 },
      ]);
      saveNotedComparison(["alpha"], ["+2348012345678"]);
      saveAppConfig({
        key: "key-a",
        backupPath: "/backups/a.crypt15",
        updatedAt: 1000,
      });
      const snapshotA = createSyncSnapshot();

      useHome(dirB);
      saveContactsToList("beta", new Set(["08012345678", "08099998888"]));
      saveLinks(["https://chat.whatsapp.com/beta-link"]);
      saveRoom({
        id: "room-b",
        groupIds: ["222@g.us"],
        groupNames: ["Group B"],
        targetList: "beta",
        createdAt: 1500,
        updatedAt: 2500,
      });
      saveIgnoredGroups([
        { jid: "888@g.us", subject: "Spam B", ignoredAt: 1500 },
      ]);
      saveAppConfig({
        key: "key-b",
        defaultCompareRooms: ["room-b", "room-c"],
        updatedAt: 2000,
      });

      const resultB = applySyncSnapshot(snapshotA);
      expect(resultB.received.contacts).toBe(1);
      expect(resultB.received.lists).toBe(1);
      expect(resultB.received.savedLinks).toBe(1);
      expect(resultB.received.rooms).toBe(1);
      expect(resultB.received.ignoredGroups).toBe(1);
      expect(resultB.received.configFields).toBeGreaterThan(0);

      expect(getContactsFromList("alpha").has("+2348012345678")).toBe(true);
      expect(getContactsFromList("alpha").has("+2348022223333")).toBe(true);
      expect(getNotedComparison(["alpha"]).exists).toBe(true);
      expect(getNotedComparison(["alpha"]).contacts.has("+2348012345678")).toBe(
        true,
      );
      expect(getSavedLinks()).toContain("https://chat.whatsapp.com/alpha-link");
      expect(getSavedLinks()).toContain("https://chat.whatsapp.com/beta-link");
      expect(getRoomById("room-a")?.groupNames).toEqual(["Group A"]);
      expect(
        getIgnoredGroups()
          .map((g) => g.jid)
          .sort(),
      ).toEqual(["888@g.us", "999@g.us"]);

      const configB = getAppConfig();
      expect(configB.key).toBe("key-b");
      expect(configB.backupPath).toBe("/backups/a.crypt15");
      expect(configB.defaultCompareRooms).toEqual(["room-b", "room-c"]);

      const secondApply = applySyncSnapshot(snapshotA);
      expect(secondApply.totalReceived).toBe(0);

      const snapshotB = createSyncSnapshot();
      useHome(dirA);
      const resultA = applySyncSnapshot(snapshotB);
      expect(resultA.received.contacts).toBe(1);
      expect(resultA.received.lists).toBe(1);
      expect(resultA.received.rooms).toBe(1);
      expect(getContactsFromList("beta").has("+2348099998888")).toBe(true);
      expect(getRoomById("room-b")?.groupNames).toEqual(["Group B"]);
      expect(getAppConfig().backupPath).toBe("/backups/a.crypt15");
    } finally {
      useHome(dirA);
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("merges scan provenance across devices", () => {
    const dirA = homeDir;
    const dirB = mkdtempSync(join(tmpdir(), "wape-sync-test-b-"));

    try {
      useHome(dirA);
      recordScanProvenance({
        type: "oneoff",
        label: "Client A",
        ownerPhone: "+2348000000001",
        groups: [
          {
            jid: "111@g.us",
            subject: "Shared Group",
            communityName: "Community A",
            phones: ["08012345678"],
          },
        ],
      });
      const snapshotA = createSyncSnapshot();

      useHome(dirB);
      recordScanProvenance({
        type: "oneoff",
        label: "Client B",
        ownerPhone: "+2348000000002",
        groups: [
          {
            jid: "222@g.us",
            subject: "Local Group",
            communityName: null,
            phones: ["08099998888"],
          },
        ],
      });

      const result = applySyncSnapshot(snapshotA);
      expect(result.received.sources).toBe(1);
      expect(result.received.groups).toBe(1);
      expect(result.received.contactGroupSources).toBe(1);

      const provenance = getContactProvenance("08012345678");
      expect(provenance?.groups.map((g) => g.subject)).toContain(
        "Shared Group",
      );
      expect(
        provenance?.sources.some((s) => s.sourceLabel === "Client A"),
      ).toBe(true);

      const localProvenance = getContactProvenance("08099998888");
      expect(localProvenance?.groups.map((g) => g.subject)).toContain(
        "Local Group",
      );
    } finally {
      useHome(dirA);
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("resolves equal config timestamps deterministically", () => {
    const dirA = homeDir;
    const dirB = mkdtempSync(join(tmpdir(), "wape-sync-test-b-"));

    try {
      useHome(dirA);
      saveAppConfig({ key: "aaa", updatedAt: 1000 });
      const snapshotA = createSyncSnapshot();

      useHome(dirB);
      saveAppConfig({ key: "zzz", updatedAt: 1000 });
      const snapshotB = createSyncSnapshot();

      applySyncSnapshot(snapshotA);
      useHome(dirA);
      applySyncSnapshot(snapshotB);

      expect(getAppConfig().key).toBe("zzz");
      useHome(dirB);
      expect(getAppConfig().key).toBe("zzz");
    } finally {
      useHome(dirA);
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("hashes sync IDs consistently", () => {
    expect(getSyncIdHash("My Sync")).toBe(getSyncIdHash("my sync"));
    expect(getSyncIdHash("My Sync")).not.toBe(getSyncIdHash("other"));
  });
});
