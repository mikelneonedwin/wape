process.env.WAPE_HOME = "/tmp/test_wape_sandbox";
process.env.WHATSAPP_BACKUP_PATH = "dummy.crypt15";
process.env.WHATSAPP_BACKUP_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.MAIN_FILE_PATH = "test_main.txt";
process.env.LOCK_FILE_PATH = "test_lock.txt";

import { describe, expect, it } from "bun:test";
import { formatPhoneNumber, normalizeNigerianPhoneNumber } from "../src/services/phone";
import {
  getCommonContacts,
  getInventoryStats,
  mergeContactsIntoFile,
  readContactsFromFile,
  writeContactsToFile,
} from "../src/services/file-manager";
import { isSqliteDatabase } from "../src/services/decryptor";
import { resolveCommunityName } from "../src/services/extractor";
import { unlinkSync, existsSync, writeFileSync } from "node:fs";

describe("Nigerian Phone Parser & Formatter", () => {
  it("normalizes international +234 numbers", () => {
    expect(normalizeNigerianPhoneNumber("+2348012345678")).toBe("08012345678");
    expect(normalizeNigerianPhoneNumber("2349012345678")).toBe("09012345678");
    expect(normalizeNigerianPhoneNumber("2347037761092")).toBe("07037761092");
  });

  it("normalizes local 0-prefixed numbers", () => {
    expect(normalizeNigerianPhoneNumber("08012345678")).toBe("08012345678");
    expect(normalizeNigerianPhoneNumber("09123456789")).toBe("09123456789");
  });

  it("normalizes 10-digit numbers missing leading zero", () => {
    expect(normalizeNigerianPhoneNumber("8012345678")).toBe("08012345678");
  });

  it("rejects invalid or non-Nigerian numbers", () => {
    expect(normalizeNigerianPhoneNumber("123456")).toBeNull();
    expect(normalizeNigerianPhoneNumber("13314003427")).toBeNull(); // US number
    expect(normalizeNigerianPhoneNumber("")).toBeNull();
  });

  it("formats phone number into XXXX XXX XXXX", () => {
    expect(formatPhoneNumber("08012345678")).toBe("0801 234 5678");
    expect(formatPhoneNumber("2349012345678")).toBe("0901 234 5678");
    expect(formatPhoneNumber("+2347037761092")).toBe("0703 776 1092");
  });
});

describe("File Manager Contact Operations", () => {
  const testFileA = "test_main.txt";
  const testFileB = "test_lock.txt";

  const cleanup = () => {
    if (existsSync(testFileA)) unlinkSync(testFileA);
    if (existsSync(testFileB)) unlinkSync(testFileB);
  };

  cleanup();

  it("reads, writes, and merges contacts properly", () => {
    const contactsA = new Set(["08012345678", "08022223333", "08033334444"]);
    writeContactsToFile(testFileA, contactsA);

    const readBack = readContactsFromFile(testFileA);
    expect(readBack.size).toBe(3);
    expect(readBack.has("08012345678")).toBe(true);

    const newExtracts = new Set(["08033334444", "08044445555", "08055556666"]);
    const result = mergeContactsIntoFile(testFileA, newExtracts);

    expect(result.uniqueExtractsCount).toBe(3);
    expect(result.addedCount).toBe(2);
    expect(result.totalCount).toBe(5);

    const updated = readContactsFromFile(testFileA);
    expect(updated.size).toBe(5);
  });

  it("calculates common contacts and inventory stats correctly", () => {
    writeContactsToFile(testFileA, new Set(["08011111111", "08022222222", "08033333333"]));
    writeContactsToFile(testFileB, new Set(["08022222222", "08033333333", "08044444444", "08055555555"]));

    const common = getCommonContacts(testFileA, testFileB);
    expect(common).toEqual(["08022222222", "08033333333"]);

    const stats = getInventoryStats(testFileA, testFileB);
    expect(stats.countA).toBe(3);
    expect(stats.countB).toBe(4);
    expect(stats.commonCount).toBe(2);
    expect(stats.unionCount).toBe(5);

    cleanup();
  });

  it("identifies unencrypted SQLite databases vs encrypted files", () => {
    const dummySqlite = "test_dummy.db";
    const dummyOther = "test_dummy.txt";

    writeFileSync(dummySqlite, Buffer.from("SQLite format 3\0extra-bytes"));
    writeFileSync(dummyOther, Buffer.from("random-encrypted-binary-content"));

    expect(isSqliteDatabase(dummySqlite)).toBe(true);
    expect(isSqliteDatabase(dummyOther)).toBe(false);

    unlinkSync(dummySqlite);
    unlinkSync(dummyOther);
  });
});

describe("Room Store and Management", () => {
  it("saves, retrieves, renames, and deletes rooms properly", async () => {
    const { saveRoom, getRooms, getRoomById, renameRoomId, deleteRoom, resolveListFilePath } = await import(
      "../src/services/wape-store"
    );
    const { writeFileSync, existsSync, unlinkSync } = await import("node:fs");

    const testRoom = {
      id: "test-room-1",
      groupJidRowIds: [1270, 2738],
      groupNames: ["GDGOC Dev Team", "GDGOC University of Uyo."],
      targetList: "test-room-1.txt",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveRoom(testRoom);
    const found = getRoomById("test-room-1");
    expect(found).not.toBeNull();
    expect(found?.groupJidRowIds.length).toBe(2);

    // Create a mock list file
    const oldPath = resolveListFilePath("test-room-1.txt");
    const newPath = resolveListFilePath("renamed-room-1.txt");
    writeFileSync(oldPath, "08031234567\n08091234567\n");

    const renameRes = renameRoomId("test-room-1", "renamed-room-1");
    expect(renameRes.success).toBe(true);
    expect(renameRes.listRenamed).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);

    const renamedRoom = getRoomById("renamed-room-1");
    expect(renamedRoom).not.toBeNull();
    expect(renamedRoom?.targetList).toBe("renamed-room-1.txt");

    // Clean up
    deleteRoom("renamed-room-1");
    if (existsSync(newPath)) unlinkSync(newPath);
    expect(getRoomById("renamed-room-1")).toBeNull();
  });

  it("saves and loads app config in WAPE_HOME config.json", async () => {
    const originalHome = process.env.WAPE_HOME;
    const testWapeDir = "/tmp/test_wape_" + Date.now();
    process.env.WAPE_HOME = testWapeDir;

    const { saveAppConfig, getAppConfig } = await import("../src/services/wape-store");
    saveAppConfig({ key: "test-hex-key-123", backupPath: "/custom/path/msgstore.db.crypt15" });
    const cfg = getAppConfig();
    expect(cfg.key).toBe("test-hex-key-123");
    expect(cfg.backupPath).toBe("/custom/path/msgstore.db.crypt15");

    const { rmSync, existsSync } = await import("node:fs");
    if (existsSync(testWapeDir)) rmSync(testWapeDir, { recursive: true, force: true });
    process.env.WAPE_HOME = originalHome;
  });
});



