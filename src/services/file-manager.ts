import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeNigerianPhoneNumber } from "./phone";
import {
  addContactsToList,
  getAllKnownLists,
  getContactsFromList,
  getNotedComparison,
  getOrCreateList,
  getRoomById,
  getWapeDb,
  normalizeListName,
  removeContactsFromList,
  saveContactsToList,
  type Room,
} from "./wape-store";

/**
 * Parses vCard (.vcf) content and returns unique normalized Nigerian phone numbers.
 */
export function extractContactsFromVcfContent(content: string): Set<string> {
  const contacts = new Set<string>();
  // Unfold multi-line folded vCard fields (lines starting with space or tab)
  const unfolded = content.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match TEL or itemX.TEL lines: e.g. TEL:+234..., TEL;TYPE=CELL:080..., item1.TEL;waid=...:080...
    if (/^(?:[a-zA-Z0-9_-]+\.)?TEL(?:;[^:]*)?:(.*)$/i.test(trimmed)) {
      const match = trimmed.match(
        /^(?:[a-zA-Z0-9_-]+\.)?TEL(?:;[^:]*)?:(.*)$/i,
      );
      const rawNumber = match?.[1]?.trim();
      if (rawNumber) {
        const normalized = normalizeNigerianPhoneNumber(rawNumber);
        if (normalized) {
          contacts.add(normalized);
        }
      }
    }
  }

  return contacts;
}

export function isExplicitPhysicalFile(filePath: string): boolean {
  if (filePath.toLowerCase().endsWith(".vcf")) return true;
  if (filePath.includes("/") || filePath.includes("\\")) {
    return true;
  }
  return false;
}

export function readContactsFromFile(filePath: string): Set<string> {
  const fullPath = resolve(filePath);
  if (fullPath.toLowerCase().endsWith(".vcf") && existsSync(fullPath)) {
    const content = readFileSync(fullPath, "utf-8");
    return extractContactsFromVcfContent(content);
  }

  // If explicit physical file outside (e.g. external text file passed to patch/unpatch)
  if (
    (filePath.includes("/") || filePath.includes("\\")) &&
    existsSync(fullPath)
  ) {
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const contacts = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const normalized = normalizeNigerianPhoneNumber(trimmed);
      if (normalized) {
        contacts.add(normalized);
      }
    }
    return contacts;
  }

  const listName = normalizeListName(filePath);
  return getContactsFromList(listName);
}

export function writeContactsToFile(
  filePath: string,
  contacts: Set<string>,
): void {
  const listName = normalizeListName(filePath);
  saveContactsToList(listName, contacts);
}

export interface MergeResult {
  uniqueExtractsCount: number;
  addedCount: number;
  totalCount: number;
}

export function mergeContactsIntoFile(
  filePath: string,
  newContacts: Set<string>,
): MergeResult {
  const listName = normalizeListName(filePath);
  return addContactsToList(listName, newContacts);
}

export interface UnmergeResult {
  uniqueExtractsCount: number;
  removedCount: number;
  totalCount: number;
}

export function unmergeContactsFromFile(
  filePath: string,
  contactsToRemove: Set<string>,
): UnmergeResult {
  const listName = normalizeListName(filePath);
  return removeContactsFromList(listName, contactsToRemove);
}

export function getCommonContacts(filePaths: string[]): string[] {
  if (filePaths.length === 0 || !filePaths[0]) return [];

  // Fast path: if all filePaths are database lists and not external physical files (.vcf or slash paths)
  const isAllDbLists = filePaths.every((p) => !isExplicitPhysicalFile(p));
  if (isAllDbLists) {
    const db = getWapeDb();
    const cleanNames = filePaths.map((p) => normalizeListName(p));
    const placeholders = cleanNames.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT c.phone
         FROM contacts c
         JOIN list_contacts lc ON c.id = lc.contact_id
         JOIN lists l ON lc.list_id = l.id
         WHERE l.name IN (${placeholders})
         GROUP BY c.id, c.phone
         HAVING COUNT(DISTINCT l.id) = ?
         ORDER BY c.phone ASC`,
      )
      .all(...cleanNames, cleanNames.length) as { phone: string }[];
    return rows.map((r) => r.phone);
  }

  // Fallback for external vCard or text files
  let common = readContactsFromFile(filePaths[0]);
  for (let i = 1; i < filePaths.length; i++) {
    const path = filePaths[i];
    if (!path) continue;
    const currentSet = readContactsFromFile(path);
    const intersection = new Set<string>();
    for (const item of common) {
      if (currentSet.has(item)) {
        intersection.add(item);
      }
    }
    common = intersection;
  }

  return Array.from(common).sort();
}

export interface ComparisonDiff {
  currentCommon: string[];
  newContacts: string[];
  hasPreviousRecord: boolean;
  previousCount: number;
}

export function getComparisonDiff(
  filePaths: string[],
  canonicalTargets?: string[],
): ComparisonDiff {
  const currentCommon = getCommonContacts(filePaths);
  const noted = getNotedComparison(canonicalTargets ?? filePaths);
  const newContacts = currentCommon.filter((c) => !noted.contacts.has(c));

  return {
    currentCommon,
    newContacts,
    hasPreviousRecord: noted.exists,
    previousCount: noted.contacts.size,
  };
}

export interface InventoryStats {
  labelA: string;
  labelB: string;
  countA: number;
  countB: number;
  commonCount: number;
  unionCount: number;
}

export function getInventoryStats(
  fileAPath: string,
  fileBPath: string,
  labelA = "List A",
  labelB = "List B",
): InventoryStats {
  const isDbA = !isExplicitPhysicalFile(fileAPath);
  const isDbB = !isExplicitPhysicalFile(fileBPath);

  if (isDbA && isDbB) {
    const db = getWapeDb();
    const nameA = normalizeListName(fileAPath);
    const nameB = normalizeListName(fileBPath);
    const listA = getOrCreateList(nameA);
    const listB = getOrCreateList(nameB);

    const rowA = db
      .query(`SELECT COUNT(*) as cnt FROM list_contacts WHERE list_id = ?`)
      .get(listA.id) as { cnt: number };
    const rowB = db
      .query(`SELECT COUNT(*) as cnt FROM list_contacts WHERE list_id = ?`)
      .get(listB.id) as { cnt: number };
    const commonRow = db
      .query(
        `SELECT COUNT(*) as cnt
         FROM list_contacts lc1
         JOIN list_contacts lc2 ON lc1.contact_id = lc2.contact_id
         WHERE lc1.list_id = ? AND lc2.list_id = ?`,
      )
      .get(listA.id, listB.id) as { cnt: number };

    const countA = rowA.cnt;
    const countB = rowB.cnt;
    const commonCount = commonRow.cnt;
    const unionCount = countA + countB - commonCount;

    return {
      labelA,
      labelB,
      countA,
      countB,
      commonCount,
      unionCount,
    };
  }

  const setA = readContactsFromFile(fileAPath);
  const setB = readContactsFromFile(fileBPath);

  let commonCount = 0;
  const union = new Set<string>(setA);

  for (const item of setB) {
    if (setA.has(item)) {
      commonCount++;
    }
    union.add(item);
  }

  return {
    labelA,
    labelB,
    countA: setA.size,
    countB: setB.size,
    commonCount,
    unionCount: union.size,
  };
}

export interface GlobalInventorySummary {
  lists: { name: string; path: string; count: number }[];
  grandUniqueTotal: number;
}

/**
 * Computes global inventory data for every list in ~/.wape/lists and env lists.
 * Shows individual totals and the unique grand union of all lists without intersection clutter.
 */
export function getGlobalInventory(): GlobalInventorySummary {
  const db = getWapeDb();

  // 1. Query individual list counts in one SQL pass
  const countRows = db
    .query(
      `SELECT l.name, COUNT(lc.contact_id) as count
       FROM lists l
       LEFT JOIN list_contacts lc ON l.id = lc.list_id
       GROUP BY l.id, l.name
       ORDER BY l.id ASC`,
    )
    .all() as { name: string; count: number }[];

  const countMap = new Map<string, number>();
  for (const r of countRows) {
    countMap.set(r.name.toLowerCase(), r.count);
  }

  const knownLists = getAllKnownLists();
  const listSummaries = knownLists.map((item) => ({
    name: item.name,
    path: item.path,
    count: countMap.get(item.name.toLowerCase()) ?? 0,
  }));

  // 2. Query grand unique total in SQLite
  const grandTotalRow = db
    .query(
      `SELECT COUNT(DISTINCT contact_id) as grandTotal
       FROM list_contacts`,
    )
    .get() as { grandTotal: number };

  return {
    lists: listSummaries,
    grandUniqueTotal: grandTotalRow.grandTotal,
  };
}

/**
 * Resolves a target parameter which could be a room ID, a list name, or a file path.
 */
export function resolveTargetToList(target: string): {
  label: string;
  filePath: string;
  room?: Room | null;
} {
  const room = getRoomById(target);
  if (room) {
    const listName = room.targetList
      ? normalizeListName(room.targetList)
      : room.id;
    return {
      label: `Room '${room.id}'`,
      filePath: listName,
      room,
    };
  }

  const clean = normalizeListName(target);
  return {
    label: clean,
    filePath: clean,
    room: null,
  };
}
