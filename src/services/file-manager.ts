import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeNigerianPhoneNumber } from "./phone";
import { getAllKnownLists, getRoomById, resolveListFilePath } from "./wape-store";

export function readContactsFromFile(filePath: string): Set<string> {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    return new Set<string>();
  }

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

export function writeContactsToFile(filePath: string, contacts: Set<string>): void {
  const fullPath = resolve(filePath);
  const sorted = Array.from(contacts).sort();
  const content = sorted.length > 0 ? `${sorted.join("\n")}\n` : "";
  writeFileSync(fullPath, content, "utf-8");
}

export interface MergeResult {
  uniqueExtractsCount: number;
  addedCount: number;
  totalCount: number;
}

export function mergeContactsIntoFile(filePath: string, newContacts: Set<string>): MergeResult {
  const existingContacts = readContactsFromFile(filePath);
  const initialSize = existingContacts.size;

  const union = new Set<string>(existingContacts);
  for (const contact of newContacts) {
    union.add(contact);
  }

  const addedCount = union.size - initialSize;
  const totalCount = union.size;

  writeContactsToFile(filePath, union);

  return {
    uniqueExtractsCount: newContacts.size,
    addedCount,
    totalCount,
  };
}

export function getCommonContacts(fileAPath: string, fileBPath: string): string[] {
  const setA = readContactsFromFile(fileAPath);
  const setB = readContactsFromFile(fileBPath);

  const common: string[] = [];
  for (const item of setA) {
    if (setB.has(item)) {
      common.push(item);
    }
  }

  return common.sort();
}

export interface InventoryStats {
  labelA: string;
  labelB: string;
  countA: number;
  countB: number;
  commonCount: number;
  unionCount: number;
}

export function getInventoryStats(fileAPath: string, fileBPath: string, labelA = "List A", labelB = "List B"): InventoryStats {
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
  const knownLists = getAllKnownLists();
  const grandUnion = new Set<string>();

  const listSummaries = knownLists.map((item) => {
    const contacts = readContactsFromFile(item.path);
    for (const c of contacts) {
      grandUnion.add(c);
    }
    return {
      name: item.name,
      path: item.path,
      count: contacts.size,
    };
  });

  return {
    lists: listSummaries,
    grandUniqueTotal: grandUnion.size,
  };
}

/**
 * Resolves a target parameter which could be a room ID, a list name, or a file path.
 */
export function resolveTargetToList(target: string): { label: string; filePath: string } {
  const room = getRoomById(target);
  if (room) {
    const listPath = room.targetList
      ? resolveListFilePath(room.targetList)
      : resolveListFilePath(`room_${room.id}`);
    return {
      label: `Room '${room.name}' (${room.id}) -> ${room.targetList ?? `room_${room.id}.txt`}`,
      filePath: listPath,
    };
  }

  return {
    label: target,
    filePath: resolveListFilePath(target),
  };
}
