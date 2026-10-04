import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Room {
  id: string;
  name?: string;
  groupIds?: (string | number)[];
  groupJidRowIds?: (string | number)[];
  groupNames: string[];
  targetList?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppConfig {
  key?: string;
  backupPath?: string;
}

export interface WapeConfigFile {
  version: string;
  key?: string;
  backupPath?: string;
}

export function getWapeConfigFile(): string {
  return join(getWapeDir(), "config.json");
}

export function getAppConfig(): AppConfig {
  const file = getWapeConfigFile();
  if (!existsSync(file)) {
    return {};
  }
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {};
  }
}

export function saveAppConfig(config: AppConfig): void {
  const file = getWapeConfigFile();
  const current = getAppConfig();
  const updated: WapeConfigFile = {
    version: "1.0.0",
    ...current,
    ...config,
  };
  writeFileSync(file, JSON.stringify(updated, null, 2), "utf-8");
}

export function getWapeDir(): string {
  const dir = process.env.WAPE_HOME
    ? resolve(process.env.WAPE_HOME)
    : join(homedir(), ".wape");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getWapeListsDir(): string {
  const listsDir = join(getWapeDir(), "lists");
  if (!existsSync(listsDir)) {
    mkdirSync(listsDir, { recursive: true });
  }
  return listsDir;
}

export function getMainListPath(): string {
  return join(getWapeListsDir(), "main.txt");
}

export function getLockListPath(): string {
  return join(getWapeListsDir(), "lock.txt");
}

export function getRoomsConfigFile(): string {
  return join(getWapeDir(), "rooms.json");
}

interface RawRoom {
  id: string;
  name?: string;
  groupIds?: (string | number)[];
  groupJidRowIds?: (string | number)[];
  groupNames?: string[];
  targetList?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export function getRooms(): Room[] {
  const file = getRoomsConfigFile();
  if (!existsSync(file)) {
    return [];
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { rooms?: RawRoom[] } | RawRoom[];
    const list: RawRoom[] = Array.isArray(parsed)
      ? parsed
      : (parsed.rooms ?? []);
    return list.map((r) => {
      const ids: (string | number)[] = r.groupIds ?? r.groupJidRowIds ?? [];
      return {
        id: r.id,
        name: r.name,
        groupIds: ids,
        groupJidRowIds: ids,
        groupNames: r.groupNames ?? [],
        targetList: r.targetList,
        createdAt: r.createdAt ?? Date.now(),
        updatedAt: r.updatedAt ?? Date.now(),
      };
    });
  } catch {
    return [];
  }
}

export interface RoomsConfigFile {
  version: string;
  rooms: Room[];
}

export function saveRooms(rooms: Room[]): void {
  const file = getRoomsConfigFile();
  const normalizedRooms = rooms.map((r) => {
    const ids = r.groupIds ?? r.groupJidRowIds ?? [];
    return {
      ...r,
      groupIds: ids,
      groupJidRowIds: ids,
    };
  });
  const config: RoomsConfigFile = {
    version: "1.0.0",
    rooms: normalizedRooms,
  };
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
}

export function getRoomById(id: string): Room | null {
  const rooms = getRooms();
  return rooms.find((r) => r.id.toLowerCase() === id.toLowerCase()) ?? null;
}

export function saveRoom(room: Room): void {
  const rooms = getRooms();
  const index = rooms.findIndex(
    (r) => r.id.toLowerCase() === room.id.toLowerCase(),
  );
  const ids = room.groupIds ?? room.groupJidRowIds ?? [];
  const normalized: Room = {
    ...room,
    groupIds: ids,
    groupJidRowIds: ids,
  };
  if (index >= 0) {
    rooms[index] = { ...normalized, updatedAt: Date.now() };
  } else {
    rooms.push({ ...normalized, createdAt: Date.now(), updatedAt: Date.now() });
  }
  saveRooms(rooms);
}

export function deleteRoom(id: string): boolean {
  const rooms = getRooms();
  const filtered = rooms.filter((r) => r.id.toLowerCase() !== id.toLowerCase());
  if (filtered.length !== rooms.length) {
    saveRooms(filtered);
    return true;
  }
  return false;
}

export function renameRoomId(
  oldId: string,
  newId: string,
): { success: boolean; error?: string; listRenamed?: boolean } {
  const cleanOldId = oldId.trim().toLowerCase();
  const cleanNewId = newId.trim().toLowerCase();

  if (!cleanNewId) {
    return { success: false, error: "New room ID cannot be empty." };
  }

  if (cleanOldId === cleanNewId) {
    return {
      success: false,
      error: "New room ID must be different from current ID.",
    };
  }

  const rooms = getRooms();
  const roomIndex = rooms.findIndex((r) => r.id.toLowerCase() === cleanOldId);
  const currentRoom = rooms[roomIndex];
  if (roomIndex === -1 || !currentRoom) {
    return { success: false, error: `Room '${cleanOldId}' not found.` };
  }

  const existingNew = rooms.find((r) => r.id.toLowerCase() === cleanNewId);
  if (existingNew) {
    return {
      success: false,
      error: `A room with ID '${cleanNewId}' already exists.`,
    };
  }

  // Rename physical list file if old list file exists
  const oldListPath = resolveListFilePath(`${cleanOldId}.txt`);
  const newListPath = resolveListFilePath(`${cleanNewId}.txt`);
  let listRenamed = false;

  if (existsSync(oldListPath)) {
    try {
      renameSync(oldListPath, newListPath);
      listRenamed = true;
    } catch (err) {
      return {
        success: false,
        error: `Failed to rename list file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  rooms[roomIndex] = {
    ...currentRoom,
    id: cleanNewId,
    targetList: `${cleanNewId}.txt`,
    updatedAt: Date.now(),
  };

  saveRooms(rooms);
  return { success: true, listRenamed };
}

/**
 * Resolves a list name or identifier to its physical file path inside ~/.wape/lists/.
 * Fixed lists: "main" -> ~/.wape/lists/main.txt, "lock" -> ~/.wape/lists/lock.txt.
 */
export function resolveListFilePath(listNameOrPath: string): string {
  const trimmed = listNameOrPath.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "main" || lower === "main.txt") {
    return getMainListPath();
  }

  if (lower === "lock" || lower === "lock.txt") {
    return getLockListPath();
  }

  // If explicit absolute path or homedir path
  if (isAbsolute(trimmed) || trimmed.startsWith("~")) {
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return join(homedir(), trimmed.slice(2));
    }
    return resolve(trimmed);
  }

  // If path contains directory separators (e.g. subdir/custom.txt or subdir\\custom.txt), but not just ./ or .\\
  if (
    (trimmed.includes("/") || trimmed.includes("\\")) &&
    !trimmed.startsWith("./") &&
    !trimmed.startsWith(".\\")
  ) {
    return resolve(trimmed);
  }

  const cleanName = trimmed.replace(/^(\.\/|\.\\)/, "");
  if (cleanName.toLowerCase().endsWith(".vcf")) {
    return resolve(cleanName);
  }
  if (existsSync(resolve(cleanName))) {
    return resolve(cleanName);
  }
  const filename = cleanName.endsWith(".txt") ? cleanName : `${cleanName}.txt`;
  return join(getWapeListsDir(), filename);
}

/**
 * Lists all known contact text files in ~/.wape/lists/.
 */
export function getAllKnownLists(): {
  name: string;
  path: string;
  isGlobal: boolean;
}[] {
  const listsDir = getWapeListsDir();
  const listsMap = new Map<
    string,
    { name: string; path: string; isGlobal: boolean }
  >();

  // Fixed global main & lock in ~/.wape/lists/
  const mainPath = getMainListPath();
  const lockPath = getLockListPath();

  listsMap.set("main", {
    name: "main (Global)",
    path: mainPath,
    isGlobal: true,
  });
  listsMap.set("lock", {
    name: "lock (Global)",
    path: lockPath,
    isGlobal: true,
  });

  // Scan ~/.wape/lists for custom lists
  if (existsSync(listsDir)) {
    const files = readdirSync(listsDir);
    for (const file of files) {
      if (file.endsWith(".txt")) {
        const fullPath = join(listsDir, file);
        const baseName = file.replace(/\.txt$/, "");
        if (fullPath !== mainPath && fullPath !== lockPath) {
          listsMap.set(baseName, {
            name: baseName,
            path: fullPath,
            isGlobal: false,
          });
        }
      }
    }
  }

  return Array.from(listsMap.values());
}

/**
 * Links file (~/.wape/links.json)
 */
export function getSavedLinksFile(): string {
  return join(getWapeDir(), "links.json");
}

export function getSavedLinks(): string[] {
  const file = getSavedLinksFile();
  if (!existsSync(file)) {
    return [];
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { links?: string[] } | string[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.links ?? [];
  } catch {
    return [];
  }
}

export function saveLinks(newLinks: string[]): {
  addedCount: number;
  totalCount: number;
} {
  const file = getSavedLinksFile();
  const existing = new Set(getSavedLinks());
  let addedCount = 0;

  for (const link of newLinks) {
    const trimmed = link.trim();
    if (trimmed && !existing.has(trimmed)) {
      existing.add(trimmed);
      addedCount++;
    }
  }

  const sortedList = Array.from(existing).sort();
  writeFileSync(
    file,
    JSON.stringify({ version: "1.0.0", links: sortedList }, null, 2),
    "utf-8",
  );

  return {
    addedCount,
    totalCount: sortedList.length,
  };
}

/**
 * Comparisons record file (~/.wape/comparisons.json)
 */
export function getComparisonsFile(): string {
  return join(getWapeDir(), "comparisons.json");
}

export function getCanonicalComparisonKey(targets: string[]): string {
  const canonicalPaths = targets
    .map((t) => resolveListFilePath(t).toLowerCase())
    .sort();
  return canonicalPaths.join(":::");
}

export function getNotedComparison(targets: string[]): {
  exists: boolean;
  contacts: Set<string>;
} {
  const file = getComparisonsFile();
  if (!existsSync(file)) {
    return { exists: false, contacts: new Set<string>() };
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const key = getCanonicalComparisonKey(targets);
    if (
      Object.prototype.hasOwnProperty.call(parsed, key) &&
      Array.isArray(parsed[key])
    ) {
      return { exists: true, contacts: new Set<string>(parsed[key]) };
    }
    return { exists: false, contacts: new Set<string>() };
  } catch {
    return { exists: false, contacts: new Set<string>() };
  }
}

export function saveNotedComparison(
  targets: string[],
  contacts: Set<string> | string[],
): void {
  const file = getComparisonsFile();
  let data: Record<string, string[]> = {};
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, "utf-8");
      data = JSON.parse(raw) as Record<string, string[]>;
    } catch {
      data = {};
    }
  }
  const key = getCanonicalComparisonKey(targets);
  const sorted = Array.from(contacts).sort();
  data[key] = sorted;
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Ignored Groups store (~/.wape/ignored-groups.json)
 */
export interface IgnoredGroup {
  jid: string;
  subject: string;
  communityName?: string | null;
  ignoredAt: number;
}

export interface IgnoredGroupsConfigFile {
  version: string;
  groups: IgnoredGroup[];
}

export function getIgnoredGroupsConfigFile(): string {
  return join(getWapeDir(), "ignored-groups.json");
}

export function getIgnoredGroups(): IgnoredGroup[] {
  const file = getIgnoredGroupsConfigFile();
  if (!existsSync(file)) {
    return [];
  }
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as
      { groups?: IgnoredGroup[] } | IgnoredGroup[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.groups ?? [];
  } catch {
    return [];
  }
}

export function saveIgnoredGroups(groups: IgnoredGroup[]): void {
  const file = getIgnoredGroupsConfigFile();
  const config: IgnoredGroupsConfigFile = {
    version: "1.0.0",
    groups,
  };
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
}

export function getIgnoredJidSet(): Set<string> {
  const groups = getIgnoredGroups();
  return new Set(groups.map((g) => g.jid.toLowerCase()));
}

export function isGroupIgnored(jid: string): boolean {
  return getIgnoredJidSet().has(jid.toLowerCase().trim());
}

export function addIgnoredGroups(
  newGroups: {
    jid: string;
    subject: string;
    communityName?: string | null;
  }[],
): { addedCount: number; totalCount: number } {
  const existing = getIgnoredGroups();
  const map = new Map<string, IgnoredGroup>();
  for (const g of existing) {
    map.set(g.jid.toLowerCase(), g);
  }

  let addedCount = 0;
  for (const ng of newGroups) {
    const cleanJid = ng.jid.trim();
    const key = cleanJid.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        jid: cleanJid,
        subject: ng.subject.trim(),
        communityName: ng.communityName ?? null,
        ignoredAt: Date.now(),
      });
      addedCount++;
    }
  }

  const updatedList = Array.from(map.values()).sort((a, b) =>
    a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }),
  );
  saveIgnoredGroups(updatedList);

  return {
    addedCount,
    totalCount: updatedList.length,
  };
}

export function removeIgnoredGroups(jidsToRemove: string[]): {
  removedCount: number;
  totalCount: number;
} {
  const existing = getIgnoredGroups();
  const removeSet = new Set(jidsToRemove.map((j) => j.toLowerCase().trim()));
  const filtered = existing.filter((g) => !removeSet.has(g.jid.toLowerCase()));
  const removedCount = existing.length - filtered.length;

  saveIgnoredGroups(filtered);

  return {
    removedCount,
    totalCount: filtered.length,
  };
}
