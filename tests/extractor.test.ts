import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

const sandboxDir = join(tmpdir(), "test_wape_sandbox");
if (existsSync(sandboxDir)) {
  rmSync(sandboxDir, { recursive: true, force: true });
}
process.env.WAPE_HOME = sandboxDir;

import { describe, expect, it } from "bun:test";
import {
  formatPhoneNumber,
  normalizeNigerianPhoneNumber,
} from "../src/services/phone";
import {
  getCommonContacts,
  getComparisonDiff,
  getInventoryStats,
  mergeContactsIntoFile,
  readContactsFromFile,
  unmergeContactsFromFile,
  writeContactsToFile,
} from "../src/services/file-manager";
import {
  isSqliteDatabase,
  discoverMsgstoreBackups,
} from "../src/services/decryptor";
import { copyToClipboard } from "../src/services/clipboard";
import {
  getCanonicalComparisonKey,
  getComparisonsFile,
  getNotedComparison,
  getWapeDir,
  saveNotedComparison,
} from "../src/services/wape-store";

describe("Nigerian Phone Parser & Formatter", () => {
  it("normalizes international +234 numbers", () => {
    expect(normalizeNigerianPhoneNumber("+2348012345678")).toBe(
      "+2348012345678",
    );
    expect(normalizeNigerianPhoneNumber("2349012345678")).toBe(
      "+2349012345678",
    );
    expect(normalizeNigerianPhoneNumber("2347037761092")).toBe(
      "+2347037761092",
    );
  });

  it("normalizes local 0-prefixed numbers", () => {
    expect(normalizeNigerianPhoneNumber("08012345678")).toBe("+2348012345678");
    expect(normalizeNigerianPhoneNumber("09123456789")).toBe("+2349123456789");
  });

  it("normalizes 10-digit numbers missing leading zero", () => {
    expect(normalizeNigerianPhoneNumber("8012345678")).toBe("+2348012345678");
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
    const contactsA = new Set([
      "+2348012345678",
      "+2348022223333",
      "+2348033334444",
    ]);
    writeContactsToFile(testFileA, contactsA);

    const readBack = readContactsFromFile(testFileA);
    expect(readBack.size).toBe(3);
    expect(readBack.has("+2348012345678")).toBe(true);

    const newExtracts = new Set([
      "+2348033334444",
      "+2348044445555",
      "+2348055556666",
    ]);
    const result = mergeContactsIntoFile(testFileA, newExtracts);

    expect(result.uniqueExtractsCount).toBe(3);
    expect(result.addedCount).toBe(2);
    expect(result.totalCount).toBe(5);

    const updated = readContactsFromFile(testFileA);
    expect(updated.size).toBe(5);
  });

  it("calculates common contacts and inventory stats correctly", () => {
    writeContactsToFile(
      testFileA,
      new Set(["+2348011111111", "+2348022222222", "+2348033333333"]),
    );
    writeContactsToFile(
      testFileB,
      new Set([
        "+2348022222222",
        "+2348033333333",
        "+2348044444444",
        "+2348055555555",
      ]),
    );

    const common = getCommonContacts([testFileA, testFileB]);
    expect(common).toEqual(["+2348022222222", "+2348033333333"]);

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

  it("handles order-independent comparison recording and detects new contacts", () => {
    const list1 = "test_compare_1.txt";
    const list2 = "test_compare_2.txt";
    const comparisonsFile = getComparisonsFile();

    const cleanupCompare = () => {
      if (existsSync(list1)) unlinkSync(list1);
      if (existsSync(list2)) unlinkSync(list2);
      if (existsSync(comparisonsFile)) unlinkSync(comparisonsFile);
    };

    cleanupCompare();

    // Initial state: 2 common contacts
    writeContactsToFile(
      list1,
      new Set(["+2348011111111", "+2348022222222", "+2348033333333"]),
    );
    writeContactsToFile(
      list2,
      new Set(["+2348022222222", "+2348033333333", "+2348044444444"]),
    );

    // Canonical key is order-agnostic
    expect(getCanonicalComparisonKey([list1, list2])).toBe(
      getCanonicalComparisonKey([list2, list1]),
    );

    // Initial diff before recording (all common contacts are new on first run)
    const diffInitial = getComparisonDiff([list1, list2]);
    expect(diffInitial.hasPreviousRecord).toBe(false);
    expect(diffInitial.currentCommon).toEqual([
      "+2348022222222",
      "+2348033333333",
    ]);
    expect(diffInitial.newContacts).toEqual([
      "+2348022222222",
      "+2348033333333",
    ]);

    // Consciously note the 2 contacts
    saveNotedComparison([list1, list2], diffInitial.currentCommon);

    // Check retrieving in reverse order
    const notedReverse = getNotedComparison([list2, list1]);
    expect(notedReverse.exists).toBe(true);
    expect(notedReverse.contacts.size).toBe(2);

    // Add 2 new common contacts to both lists
    writeContactsToFile(
      list1,
      new Set([
        "+2348011111111",
        "+2348022222222",
        "+2348033333333",
        "+2348055555555",
        "+2348066666666",
      ]),
    );
    writeContactsToFile(
      list2,
      new Set([
        "+2348022222222",
        "+2348033333333",
        "+2348044444444",
        "+2348055555555",
        "+2348066666666",
      ]),
    );

    // Comparison in reverse order detects exactly the 2 new contacts without saving yet
    const diffUpdated = getComparisonDiff([list2, list1]);
    expect(diffUpdated.hasPreviousRecord).toBe(true);
    expect(diffUpdated.previousCount).toBe(2);
    expect(diffUpdated.currentCommon.length).toBe(4);
    expect(diffUpdated.newContacts).toEqual([
      "+2348055555555",
      "+2348066666666",
    ]);

    // Subsequent call without saving still flags them as new
    const diffStillNew = getComparisonDiff([list1, list2]);
    expect(diffStillNew.newContacts).toEqual([
      "+2348055555555",
      "+2348066666666",
    ]);

    // Consciously note the 4 contacts
    saveNotedComparison([list1, list2], diffStillNew.currentCommon);

    // Next comparison now shows 0 new contacts
    const diffAfterNote = getComparisonDiff([list1, list2]);
    expect(diffAfterNote.hasPreviousRecord).toBe(true);
    expect(diffAfterNote.previousCount).toBe(4);
    expect(diffAfterNote.newContacts).toEqual([]);

    cleanupCompare();
  });

  it("parses contacts from vCard (.vcf) files including folded lines, various Nigerian number formats, and ignores invalid/non-Nigerian numbers", () => {
    const vcfSample = `BEGIN:VCARD
VERSION:3.0
FN:Adeoluwa Doe
TEL;TYPE=CELL:+234 801 234 5678
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Bisi Akindele
item1.TEL;waid=2349012345678:0901 234 5678
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Chidi Okeke
TEL;TYPE=HOME:803 123 4567
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Non Nigerian Contact
TEL;TYPE=WORK:+1 (555) 123-4567
END:VCARD
BEGIN:VCARD
VERSION:2.1
N:Eze;Emeka;;;
FN:Emeka Eze
TEL;CELL;VOICE:07037761092
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Folded Line Contact
NOTE:This is a long note that is folded across
 multiple lines
TEL:+234 805
 555 6666
END:VCARD
`;

    const vcfFile = "test_contacts.vcf";
    writeFileSync(vcfFile, vcfSample, "utf-8");

    const contacts = readContactsFromFile(vcfFile);
    expect(contacts.size).toBe(5);
    expect(contacts.has("+2348012345678")).toBe(true);
    expect(contacts.has("+2349012345678")).toBe(true);
    expect(contacts.has("+2348031234567")).toBe(true);
    expect(contacts.has("+2347037761092")).toBe(true);
    expect(contacts.has("+2348055556666")).toBe(true);
    // US number excluded
    expect(contacts.has("+15551234567")).toBe(false);

    // Test patching from VCF into a target text list file
    const targetList = "test_patched_room.txt";
    if (existsSync(targetList)) unlinkSync(targetList);
    writeContactsToFile(targetList, new Set(["+2348012345678"]));

    const mergeRes = mergeContactsIntoFile(targetList, contacts);
    expect(mergeRes.uniqueExtractsCount).toBe(5);
    expect(mergeRes.addedCount).toBe(4);
    expect(mergeRes.totalCount).toBe(5);

    // Test comparison between VCF and room list
    const common = getCommonContacts([vcfFile, targetList]);
    expect(common.length).toBe(5);

    // Test unpatching contacts from VCF out of the room list
    const unmergeRes = unmergeContactsFromFile(targetList, contacts);
    expect(unmergeRes.uniqueExtractsCount).toBe(5);
    expect(unmergeRes.removedCount).toBe(5);
    expect(unmergeRes.totalCount).toBe(0);

    const afterUnpatch = readContactsFromFile(targetList);
    expect(afterUnpatch.size).toBe(0);

    if (existsSync(vcfFile)) unlinkSync(vcfFile);
    if (existsSync(targetList)) unlinkSync(targetList);
  });
});

describe("Room Store and Management", () => {
  it("saves, retrieves, renames, and deletes rooms properly", async () => {
    const {
      saveRoom,
      getRoomById,
      renameRoomId,
      deleteRoom,
      resolveListFilePath,
    } = await import("../src/services/wape-store");
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
    expect(found?.groupJidRowIds?.length).toBe(2);

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
    expect(renamedRoom?.targetList).toBe("renamed-room-1");

    // Clean up
    deleteRoom("renamed-room-1");
    if (existsSync(newPath)) unlinkSync(newPath);
    expect(getRoomById("renamed-room-1")).toBeNull();
  });

  it("saves and loads app config in WAPE_HOME config.json", async () => {
    const originalHome = process.env.WAPE_HOME;
    const testWapeDir = join(tmpdir(), "test_wape_" + Date.now());
    process.env.WAPE_HOME = testWapeDir;

    const { saveAppConfig, getAppConfig } =
      await import("../src/services/wape-store");
    saveAppConfig({
      key: "test-hex-key-123",
      backupPath: "/custom/path/msgstore.db.crypt15",
    });
    const cfg = getAppConfig();
    expect(cfg.key).toBe("test-hex-key-123");
    expect(cfg.backupPath).toBe("/custom/path/msgstore.db.crypt15");

    const { rmSync, existsSync } = await import("node:fs");
    if (existsSync(testWapeDir))
      rmSync(testWapeDir, { recursive: true, force: true });
    process.env.WAPE_HOME = originalHome;
  });

  it("saves, retrieves, and deduplicates WhatsApp group links in links.json", async () => {
    const { saveLinks, getSavedLinks, getSavedLinksFile } =
      await import("../src/services/wape-store");
    const { unlinkSync, existsSync } = await import("node:fs");

    const linksFile = getSavedLinksFile();
    if (existsSync(linksFile)) unlinkSync(linksFile);

    const res1 = saveLinks([
      "https://chat.whatsapp.com/DEF456",
      "https://chat.whatsapp.com/ABC123",
    ]);
    expect(res1.addedCount).toBe(2);
    expect(res1.totalCount).toBe(2);

    // Second save with duplicate and 1 new
    const res2 = saveLinks([
      "https://chat.whatsapp.com/ABC123",
      "https://chat.whatsapp.com/GHI789",
    ]);
    expect(res2.addedCount).toBe(1);
    expect(res2.totalCount).toBe(3);

    const links = getSavedLinks();
    expect(links).toEqual([
      "https://chat.whatsapp.com/ABC123",
      "https://chat.whatsapp.com/DEF456",
      "https://chat.whatsapp.com/GHI789",
    ]);

    if (existsSync(linksFile)) unlinkSync(linksFile);
  });

  it("saves, retrieves, deduplicates, and removes ignored groups in ignored-groups.json", async () => {
    const {
      addIgnoredGroups,
      getIgnoredGroups,
      getIgnoredJidSet,
      getIgnoredGroupsConfigFile,
      isGroupIgnored,
      removeIgnoredGroups,
    } = await import("../src/services/wape-store");
    const { unlinkSync, existsSync } = await import("node:fs");

    const ignoredFile = getIgnoredGroupsConfigFile();
    if (existsSync(ignoredFile)) unlinkSync(ignoredFile);

    const addRes1 = addIgnoredGroups([
      {
        jid: "120363011111111111@g.us",
        subject: "Family Circle",
        communityName: null,
      },
      {
        jid: "120363022222222222@g.us",
        subject: "Gaming Squad",
        communityName: "Gamers Hub",
      },
    ]);
    expect(addRes1.addedCount).toBe(2);
    expect(addRes1.totalCount).toBe(2);

    // Duplicate JID should be skipped
    const addRes2 = addIgnoredGroups([
      {
        jid: "120363011111111111@g.us",
        subject: "Family Circle Duplicate",
      },
      {
        jid: "120363033333333333@g.us",
        subject: "Neighborhood Watch",
      },
    ]);
    expect(addRes2.addedCount).toBe(1);
    expect(addRes2.totalCount).toBe(3);

    expect(isGroupIgnored("120363011111111111@g.us")).toBe(true);
    expect(isGroupIgnored("120363099999999999@g.us")).toBe(false);

    const jidSet = getIgnoredJidSet();
    expect(jidSet.has("120363011111111111@g.us")).toBe(true);
    expect(jidSet.has("120363022222222222@g.us")).toBe(true);
    expect(jidSet.has("120363033333333333@g.us")).toBe(true);

    const allIgnored = getIgnoredGroups();
    expect(allIgnored.length).toBe(3);

    // Remove one group
    const removeRes = removeIgnoredGroups(["120363022222222222@g.us"]);
    expect(removeRes.removedCount).toBe(1);
    expect(removeRes.totalCount).toBe(2);
    expect(isGroupIgnored("120363022222222222@g.us")).toBe(false);

    if (existsSync(ignoredFile)) unlinkSync(ignoredFile);
  });
});

describe("WhatsApp Group Link Extractor", () => {
  it("normalizes and strips search params from whatsapp group invite links", async () => {
    const { normalizeWhatsAppGroupLink } =
      await import("../src/services/extractor");
    expect(
      normalizeWhatsAppGroupLink(
        "https://chat.whatsapp.com/Cgh2VBRsPVLAUlAVpnkOjU?s=cl&p=a&mlu=4",
      ),
    ).toBe("https://chat.whatsapp.com/Cgh2VBRsPVLAUlAVpnkOjU");
    expect(
      normalizeWhatsAppGroupLink("chat.whatsapp.com/BlwHjpJmY9yI9wUA8pXXll"),
    ).toBe("https://chat.whatsapp.com/BlwHjpJmY9yI9wUA8pXXll");
    expect(
      normalizeWhatsAppGroupLink(
        "https://chat.whatsapp.com/DQdObCaowLG1vHHHF7Rz3N?mode=gi_t",
      ),
    ).toBe("https://chat.whatsapp.com/DQdObCaowLG1vHHHF7Rz3N");
  });
});

describe("Group and Community Extractor", () => {
  it("correctly resolves standalone groups, direct node parent links, and containment communities", async () => {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const schema = await import("../src/db/schema");
    const { fetchAllGroups } = await import("../src/services/extractor");

    const sqlite = new Database(":memory:");
    sqlite.run(`
      CREATE TABLE jid (_id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, server TEXT NOT NULL, agent INTEGER, device INTEGER, type INTEGER, raw_string TEXT);
      CREATE TABLE jid_map (lid_row_id INTEGER PRIMARY KEY, jid_row_id INTEGER NOT NULL, sort_id INTEGER);
      CREATE TABLE chat (_id INTEGER PRIMARY KEY AUTOINCREMENT, jid_row_id INTEGER UNIQUE, subject TEXT, group_type INTEGER, hidden INTEGER, archived INTEGER);
      CREATE TABLE message (_id INTEGER PRIMARY KEY AUTOINCREMENT, chat_row_id INTEGER NOT NULL, text_data TEXT, timestamp INTEGER);
      CREATE TABLE group_participant_user (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid_row_id INTEGER NOT NULL, user_jid_row_id INTEGER NOT NULL, rank INTEGER, pending INTEGER, add_timestamp INTEGER);
      CREATE TABLE message_system_with_group_nodes (message_row_id INTEGER PRIMARY KEY, group_jid_row_id INTEGER, group_node_type INTEGER, group_subject TEXT, version INTEGER);
    `);

    // Insert JIDs
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (100, 'tech-comm', 'g.us'), (101, 'tech-ann', 'g.us'), (200, 'frontend', 'g.us'), (300, 'backend', 'g.us'), (400, 'family', 'g.us')`,
    );

    // Insert Community parent (type 1) and announcement (type 3)
    sqlite.run(
      `INSERT INTO chat (_id, jid_row_id, subject, group_type) VALUES (1, 100, 'Tech Community', 1)`,
    );
    sqlite.run(
      `INSERT INTO chat (_id, jid_row_id, subject, group_type) VALUES (2, 101, 'Tech Community Announcements', 3)`,
    );

    // Insert Subgroup A (type 2) which has members belonging to Tech Community Announcements
    sqlite.run(
      `INSERT INTO chat (_id, jid_row_id, subject, group_type) VALUES (3, 200, 'Frontend Devs', 2)`,
    );

    // Insert Subgroup B (type 2) linked via message_system_with_group_nodes
    sqlite.run(
      `INSERT INTO chat (_id, jid_row_id, subject, group_type) VALUES (4, 300, 'Backend Devs', 2)`,
    );
    sqlite.run(`INSERT INTO message (_id, chat_row_id) VALUES (10, 4)`);
    sqlite.run(
      `INSERT INTO message_system_with_group_nodes (message_row_id, group_jid_row_id, group_subject) VALUES (10, 100, 'Tech Community')`,
    );

    // Insert Standalone group (type 0)
    sqlite.run(
      `INSERT INTO chat (_id, jid_row_id, subject, group_type) VALUES (5, 400, 'Family Group', 0)`,
    );

    // Add participants:
    // Tech Community has user 1
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (100, 1)`,
    );
    // Tech Community Announcements has users 1, 2, 3, 4
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (101, 1), (101, 2), (101, 3), (101, 4)`,
    );
    // Frontend Devs has users 1, 2, 3 (all 3 in Tech Community -> 100% overlap)
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (200, 1), (200, 2), (200, 3)`,
    );
    // Backend Devs has user 4
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (300, 4)`,
    );
    // Family Group has users 5, 6
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (400, 5), (400, 6)`,
    );

    const db = drizzle({ client: sqlite, schema });
    const groups = await fetchAllGroups(db);

    expect(groups.length).toBe(5);

    const frontend = groups.find((g) => g.subject === "Frontend Devs");
    expect(frontend?.communityName).toBe("Tech Community Announcements");

    const backend = groups.find((g) => g.subject === "Backend Devs");
    expect(backend?.communityName).toBe("Tech Community");

    const family = groups.find((g) => g.subject === "Family Group");
    expect(family?.communityName).toBeNull();
  });

  it("dynamically resolves all storage paths relative to custom WAPE_HOME", async () => {
    const originalHome = process.env.WAPE_HOME;
    const customHome = join(tmpdir(), "custom_wape_env_test_" + Date.now());
    process.env.WAPE_HOME = customHome;

    const {
      getWapeDir,
      getWapeConfigFile,
      getWapeListsDir,
      getMainListPath,
      getLockListPath,
      getRoomsConfigFile,
      getSavedLinksFile,
      resolveListFilePath,
    } = await import("../src/services/wape-store");

    expect(getWapeDir()).toBe(customHome);
    expect(getWapeConfigFile()).toBe(join(customHome, "config.json"));
    expect(getWapeListsDir()).toBe(join(customHome, "lists"));
    expect(getMainListPath()).toBe(join(customHome, "lists", "main.txt"));
    expect(getLockListPath()).toBe(join(customHome, "lists", "lock.txt"));
    expect(getRoomsConfigFile()).toBe(join(customHome, "rooms.json"));
    expect(getSavedLinksFile()).toBe(join(customHome, "links.json"));
    expect(resolveListFilePath("leads")).toBe(
      join(customHome, "lists", "leads.txt"),
    );
    expect(resolveListFilePath("main")).toBe(
      join(customHome, "lists", "main.txt"),
    );

    const { rmSync, existsSync } = await import("node:fs");
    if (existsSync(customHome)) {
      rmSync(customHome, { recursive: true, force: true });
    }
    process.env.WAPE_HOME = originalHome;
  });

  it("resolves one-off backup credentials and environment variables without overwriting config.json", async () => {
    const { resolveBackupCredentials } =
      await import("../src/services/decryptor");
    const { getAppConfig, saveAppConfig } =
      await import("../src/services/wape-store");

    // Baseline config
    saveAppConfig({ key: "saved-config-key-111" });

    // Dummy db file for discovery/path test
    const dummyDb = join(tmpdir(), "oneoff_test_db_" + Date.now() + ".db");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(dummyDb, Buffer.from("SQLite format 3\0"));

    // 1. One-off options override config
    const creds1 = await resolveBackupCredentials({
      backupPath: dummyDb,
      backupKey: "one-off-hex-key-999",
    });
    expect(creds1.backupKey).toBe("one-off-hex-key-999");
    expect(creds1.backupPath).toBe(dummyDb);

    // Config remains unchanged
    expect(getAppConfig().key).toBe("saved-config-key-111");

    // 2. WAPE_KEY and WAPE_BACKUP env vars override config
    process.env.WAPE_KEY = "env-hex-key-777";
    process.env.WAPE_BACKUP = dummyDb;

    const creds2 = await resolveBackupCredentials();
    expect(creds2.backupKey).toBe("env-hex-key-777");
    expect(creds2.backupPath).toBe(dummyDb);

    // Config still remains unchanged
    expect(getAppConfig().key).toBe("saved-config-key-111");

    delete process.env.WAPE_KEY;
    delete process.env.WAPE_BACKUP;
    unlinkSync(dummyDb);
  });

  it("extracts phone numbers from both current and past group participants", async () => {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const schema = await import("../src/db/schema");
    const { extractNigerianNumbersFromGroups } =
      await import("../src/services/extractor");

    const sqlite = new Database(":memory:");
    sqlite.run(`
      CREATE TABLE jid (_id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, server TEXT NOT NULL, agent INTEGER, device INTEGER, type INTEGER, raw_string TEXT);
      CREATE TABLE jid_map (lid_row_id INTEGER PRIMARY KEY, jid_row_id INTEGER NOT NULL, sort_id INTEGER);
      CREATE TABLE chat (_id INTEGER PRIMARY KEY AUTOINCREMENT, jid_row_id INTEGER UNIQUE, subject TEXT, group_type INTEGER, hidden INTEGER, archived INTEGER);
      CREATE TABLE group_participant_user (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid_row_id INTEGER NOT NULL, user_jid_row_id INTEGER NOT NULL, rank INTEGER, pending INTEGER, add_timestamp INTEGER);
      CREATE TABLE group_past_participant_user (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_jid_row_id INTEGER NOT NULL, user_jid_row_id INTEGER NOT NULL);
    `);

    // Insert phone JIDs
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (1, '2348011111111', 's.whatsapp.net')`,
    );
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (2, '2348022222222', 's.whatsapp.net')`,
    );
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (3, '2348033333333', 's.whatsapp.net')`,
    );
    // LID JID for user 4 mapped to phone JID 5
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (4, '123456789012345', 'lid')`,
    );
    sqlite.run(
      `INSERT INTO jid (_id, user, server) VALUES (5, '2348044444444', 's.whatsapp.net')`,
    );
    sqlite.run(`INSERT INTO jid_map (lid_row_id, jid_row_id) VALUES (4, 5)`);

    // Group 100:
    // Current participants: user 1, user 4 (lid mapped to 5)
    sqlite.run(
      `INSERT INTO group_participant_user (group_jid_row_id, user_jid_row_id) VALUES (100, 1), (100, 4)`,
    );
    // Past participants: user 2, user 3
    sqlite.run(
      `INSERT INTO group_past_participant_user (group_jid_row_id, user_jid_row_id) VALUES (100, 2), (100, 3)`,
    );

    const db = drizzle({ client: sqlite, schema });
    const numbers = await extractNigerianNumbersFromGroups(db, [100]);

    expect(numbers.size).toBe(4);
    expect(numbers.has("+2348011111111")).toBe(true);
    expect(numbers.has("+2348022222222")).toBe(true);
    expect(numbers.has("+2348033333333")).toBe(true);
    expect(numbers.has("+2348044444444")).toBe(true);
  });

  it("silently migrates legacy group rowIds to unique WhatsApp JIDs when reliably resolvable", async () => {
    const { resolveRoomGroups } = await import("../src/services/extractor");
    const { getRoomById, saveRoom } =
      await import("../src/services/wape-store");

    const availableGroups = [
      {
        jidRowId: 10,
        jidString: "120363011111111111@g.us",
        subject: "Exact Match Group",
        groupType: 0,
        communityName: null,
        participantCount: 15,
      },
      {
        jidRowId: 20, // Row ID 20 in new DB
        jidString: "120363022222222222@g.us",
        subject: "Displaced Subject Match",
        groupType: 0,
        communityName: null,
        participantCount: 8,
      },
      {
        jidRowId: 30,
        jidString: "120363033333333333@g.us",
        subject: "Duplicate Name",
        groupType: 0,
        communityName: null,
        participantCount: 5,
      },
      {
        jidRowId: 31,
        jidString: "120363044444444444@g.us",
        subject: "Duplicate Name",
        groupType: 0,
        communityName: null,
        participantCount: 12,
      },
    ];

    const testRoom = {
      id: "migration-test-room",
      // Entry 0: 10 + "Exact Match Group" -> should resolve to 120363011111111111@g.us
      // Entry 1: 999 (old row ID) + "Displaced Subject Match" -> should resolve to 120363022222222222@g.us
      // Entry 2: 888 (old row ID) + "Duplicate Name" -> ambiguous, should remain 888
      // Entry 3: "120363011111111111@g.us" -> already string JID
      groupIds: [10, 999, 888, "120363011111111111@g.us"],
      groupNames: [
        "Exact Match Group",
        "Displaced Subject Match",
        "Duplicate Name",
        "Exact Match Group",
      ],
      targetList: "migration-test-room.txt",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    saveRoom(testRoom);

    const result = resolveRoomGroups(testRoom, availableGroups);

    expect(result.hasMigrated).toBe(true);
    expect(result.activeCount).toBe(3); // Entry 0, 1, 3 active
    expect(result.missingCount).toBe(1); // Entry 2 missing (ambiguous row 888 not in DB)

    // Verify room in-memory migration
    expect(testRoom.groupIds[0]).toBe("120363011111111111@g.us");
    expect(testRoom.groupIds[1]).toBe("120363022222222222@g.us");
    expect(testRoom.groupIds[2]).toBe(888); // Unreliable match kept as number
    expect(testRoom.groupIds[3]).toBe("120363011111111111@g.us");

    // Verify persisted room in rooms.json
    const persisted = getRoomById("migration-test-room");
    expect(persisted).not.toBeNull();
    expect(persisted?.groupIds?.[0]).toBe("120363011111111111@g.us");
    expect(persisted?.groupIds?.[1]).toBe("120363022222222222@g.us");
    expect(persisted?.groupIds?.[2]).toBe(888);
  });

  it("discovers backups and sorts them by date landed on drive (newest first)", () => {
    const wapeDir = getWapeDir();

    const olderFile = join(wapeDir, "msgstore-2023-01-01.1.db.crypt14");
    const newerFile = join(wapeDir, "msgstore-2023-06-01.1.db.crypt14");

    writeFileSync(olderFile, "fake backup 1");
    // sleep tiny bit or touch mtime
    const now = Date.now();
    const olderTime = new Date(now - 100000);
    const newerTime = new Date(now);

    utimesSync(olderFile, olderTime, olderTime);

    writeFileSync(newerFile, "fake backup 2");
    utimesSync(newerFile, newerTime, newerTime);

    const discovered = discoverMsgstoreBackups();
    expect(discovered.length).toBeGreaterThanOrEqual(2);
    const olderIdx = discovered.indexOf(olderFile);
    const newerIdx = discovered.indexOf(newerFile);

    expect(newerIdx).toBeLessThan(olderIdx);

    unlinkSync(olderFile);
    unlinkSync(newerFile);
  });

  it("handles copyToClipboard without throwing error in any environment", async () => {
    const res = await copyToClipboard(
      "0801 234 5678  [NEW]\n0802 345 6789  [NEW]",
    );
    expect(typeof res).toBe("boolean");
  });

  it("guarantees WhatsApp owner phone identification via JID type 11", async () => {
    const { getDatabase } = await import("../src/db");
    const { detectWhatsAppOwnerPhone } =
      await import("../src/services/extractor");
    const { Database } = await import("bun:sqlite");

    const testDbPath = join(tmpdir(), `owner_test_${Date.now()}.db`);
    const rawDb = new Database(testDbPath, { create: true });
    rawDb.exec(`
      CREATE TABLE jid (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        server TEXT NOT NULL,
        agent INTEGER,
        device INTEGER,
        type INTEGER,
        raw_string TEXT
      );
      INSERT INTO jid (user, server, type) VALUES ('2348039876543', 's.whatsapp.net', 11);
      INSERT INTO jid (user, server, type) VALUES ('2348011111111', 's.whatsapp.net', 0);
    `);
    rawDb.close();

    const db = getDatabase(testDbPath);
    const owner = await detectWhatsAppOwnerPhone(db);
    expect(owner).toBe("+2348039876543");

    unlinkSync(testDbPath);
  });

  it("records and retrieves contact group provenance across multiple backups and one-offs", async () => {
    const { recordScanProvenance, getContactProvenance, saveContactsToList } =
      await import("../src/services/wape-store");

    saveContactsToList("main", new Set(["+2348012345678"]));
    saveContactsToList("real-estate", new Set(["+2348012345678"]));

    // 1. Primary scan
    recordScanProvenance({
      type: "primary",
      label: "Primary Backup",
      ownerPhone: "+2348031112222",
      groups: [
        {
          jid: "120363011111111111@g.us",
          subject: "Landlords Forum",
          communityName: "Real Estate Hub",
          phones: ["+2348012345678", "+2348099999999"],
        },
        {
          jid: "120363022222222222@g.us",
          subject: "Lekki Residents",
          communityName: null,
          phones: ["+2348012345678"],
        },
      ],
    });

    // 2. One-off scan for Alice
    recordScanProvenance({
      type: "oneoff",
      label: "Alice Work Phone",
      ownerPhone: "+2348039876543",
      groups: [
        {
          jid: "120363033333333333@g.us",
          subject: "Crypto Traders Lagos",
          communityName: null,
          phones: ["+2348012345678"],
        },
        {
          jid: "120363044444444444@g.us",
          subject: "Tech Founders Hub",
          communityName: "Tech Hub",
          phones: ["+2348012345678"],
        },
      ],
    });

    const provenance = getContactProvenance("08012345678");
    expect(provenance).not.toBeNull();
    expect(provenance?.phone).toBe("+2348012345678");
    expect(provenance?.totalGroupsCount).toBe(4);
    expect(provenance?.sources.length).toBe(2);

    const oneoffSource = provenance?.sources.find(
      (s) => s.sourceType === "oneoff",
    );
    expect(oneoffSource).toBeDefined();
    expect(oneoffSource?.sourceLabel).toBe("Alice Work Phone");
    expect(oneoffSource?.ownerPhone).toBe("+2348039876543");
    expect(oneoffSource?.groups.length).toBe(2);

    expect(provenance?.lists).toContain("main");
    expect(provenance?.lists).toContain("real-estate");
  });

  it("migrates all legacy text lists, rooms, links, and ignored groups to SQLite on first run", async () => {
    const originalHome = process.env.WAPE_HOME;
    const migrationDir = join(tmpdir(), `test_migration_${Date.now()}`);
    mkdirSync(join(migrationDir, "lists"), { recursive: true });

    // Seed legacy text lists
    writeFileSync(
      join(migrationDir, "lists", "main.txt"),
      "08031111111\n08032222222\n",
    );
    writeFileSync(
      join(migrationDir, "lists", "vip.txt"),
      "08032222222\n08033333333\n",
    );

    // Seed legacy rooms.json
    writeFileSync(
      join(migrationDir, "rooms.json"),
      JSON.stringify({
        version: "1.0.0",
        rooms: [
          {
            id: "migrated-room",
            groupNames: ["Group A"],
            groupIds: ["120363011111111111@g.us"],
            targetList: "migrated-room.txt",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );

    // Seed legacy links.json
    writeFileSync(
      join(migrationDir, "links.json"),
      JSON.stringify({
        version: "1.0.0",
        links: ["https://chat.whatsapp.com/TEST12345"],
      }),
    );

    // Seed legacy ignored-groups.json
    writeFileSync(
      join(migrationDir, "ignored-groups.json"),
      JSON.stringify({
        version: "1.0.0",
        groups: [
          {
            jid: "120363099999999999@g.us",
            subject: "Spam Group",
            ignoredAt: Date.now(),
          },
        ],
      }),
    );

    process.env.WAPE_HOME = migrationDir;
    const { getContactsFromList, getRooms, getSavedLinks, getIgnoredGroups } =
      await import("../src/services/wape-store");

    const mainContacts = getContactsFromList("main");
    expect(mainContacts.size).toBe(2);
    expect(mainContacts.has("+2348031111111")).toBe(true);

    const vipContacts = getContactsFromList("vip");
    expect(vipContacts.size).toBe(2);
    expect(vipContacts.has("+2348033333333")).toBe(true);

    const rooms = getRooms();
    expect(rooms.length).toBe(1);
    expect(rooms[0]?.id).toBe("migrated-room");

    const links = getSavedLinks();
    expect(links).toContain("https://chat.whatsapp.com/TEST12345");

    const ignored = getIgnoredGroups();
    expect(ignored.length).toBe(1);
    expect(ignored[0]?.jid).toBe("120363099999999999@g.us");

    // Clean up
    rmSync(migrationDir, { recursive: true, force: true });
    process.env.WAPE_HOME = originalHome;
  });

  it("stores, retrieves, and clears defaultCompareRooms in config.json", async () => {
    const { saveAppConfig, getAppConfig } =
      await import("../src/services/wape-store");

    saveAppConfig({
      defaultCompareRooms: ["room-alpha", "room-beta"],
    });

    let cfg = getAppConfig();
    expect(cfg.defaultCompareRooms).toEqual(["room-alpha", "room-beta"]);

    saveAppConfig({
      clearDefaultCompare: true,
    });

    cfg = getAppConfig();
    expect(cfg.defaultCompareRooms).toBeUndefined();
  });

  it("identifies international (non-Nigerian) WhatsApp account owners", async () => {
    const { getDatabase } = await import("../src/db");
    const { detectWhatsAppOwnerPhone } =
      await import("../src/services/extractor");
    const { normalizeOwnerPhoneNumber } = await import("../src/services/phone");
    const { Database } = await import("bun:sqlite");

    expect(normalizeOwnerPhoneNumber("14155552671")).toBe("+14155552671");
    expect(normalizeOwnerPhoneNumber("+447911123456")).toBe("+447911123456");
    expect(normalizeOwnerPhoneNumber("08031234567")).toBe("+2348031234567");

    const testDbPath = join(tmpdir(), `intl_owner_test_${Date.now()}.db`);
    const rawDb = new Database(testDbPath, { create: true });
    rawDb.exec(`
      CREATE TABLE jid (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        server TEXT NOT NULL,
        agent INTEGER,
        device INTEGER,
        type INTEGER,
        raw_string TEXT
      );
      INSERT INTO jid (user, server, type) VALUES ('14155552671', 's.whatsapp.net', 11);
    `);
    rawDb.close();

    const db = getDatabase(testDbPath);
    const owner = await detectWhatsAppOwnerPhone(db);
    expect(owner).toBe("+14155552671");

    unlinkSync(testDbPath);
  });

  it("normalizes list file paths properly and preserves total contact counts across scans", async () => {
    const { normalizeListName, resolveListFilePath, getWapeListsDir } =
      await import("../src/services/wape-store");
    const { mergeContactsIntoFile, readContactsFromFile } =
      await import("../src/services/file-manager");

    const listsDir = getWapeListsDir();
    const fullNormPath = join(listsDir, "norm.txt");

    expect(normalizeListName(fullNormPath)).toBe("norm");
    expect(normalizeListName("norm.txt")).toBe("norm");
    expect(normalizeListName("norm")).toBe("norm");
    expect(normalizeListName(join(listsDir, "main.txt"))).toBe("main");

    // Seed list 'sample' with 3 contacts
    const samplePath = resolveListFilePath("sample.txt");
    mergeContactsIntoFile(
      samplePath,
      new Set(["08031111111", "08032222222", "08033333333"]),
    );

    const read1 = readContactsFromFile(samplePath);
    expect(read1.size).toBe(3);

    // Scan again with an overlapping number using absolute path
    const report = mergeContactsIntoFile(
      samplePath,
      new Set(["08033333333", "08034444444"]),
    );

    expect(report.uniqueExtractsCount).toBe(2);
    expect(report.addedCount).toBe(1);
    expect(report.totalCount).toBe(4);

    const read2 = readContactsFromFile(samplePath);
    expect(read2.size).toBe(4);
  });
});
