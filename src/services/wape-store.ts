import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeNigerianPhoneNumber } from "./phone";
import { parseDateRange, type ExportFilterOptions } from "./chat-exporter";

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
  defaultCompareRooms?: [string, string];
}

export interface WapeConfigFile {
  version: string;
  key?: string;
  backupPath?: string;
  defaultCompareRooms?: [string, string];
}

export interface IgnoredGroup {
  jid: string;
  subject: string;
  communityName?: string | null;
  ignoredAt: number;
}

export interface ContactProvenanceSource {
  sourceType: string;
  sourceLabel: string;
  ownerPhone: string | null;
  scannedAt: number;
  groups: Array<{
    jid: string;
    subject: string;
    communityName: string | null;
  }>;
}

export interface ContactProvenanceGroup {
  jid: string;
  subject: string;
  communityName: string | null;
  sources: Array<{
    sourceType: string;
    sourceLabel: string;
    ownerPhone: string | null;
    scannedAt: number;
  }>;
}

export interface ContactProvenance {
  phone: string;
  groups: ContactProvenanceGroup[];
  sources: ContactProvenanceSource[];
  rooms: string[];
  lists: string[];
  totalGroupsCount: number;
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

export function getWapeConfigFile(): string {
  return join(getWapeDir(), "config.json");
}

export function getRoomsConfigFile(): string {
  return join(getWapeDir(), "rooms.json");
}

export function getSavedLinksFile(): string {
  return join(getWapeDir(), "links.json");
}

export function getIgnoredGroupsConfigFile(): string {
  return join(getWapeDir(), "ignored-groups.json");
}

export function getComparisonsFile(): string {
  return join(getWapeDir(), "comparisons.json");
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

export function saveAppConfig(
  config: AppConfig & { clearDefaultCompare?: boolean },
): void {
  const file = getWapeConfigFile();
  const current = getAppConfig();
  const updated: WapeConfigFile = {
    version: "1.0.0",
    ...current,
    ...config,
  };
  if (
    config.clearDefaultCompare ||
    (config.defaultCompareRooms === undefined &&
      "defaultCompareRooms" in config)
  ) {
    delete updated.defaultCompareRooms;
  }
  writeFileSync(file, JSON.stringify(updated, null, 2), "utf-8");
}

export function getWapeDbFile(): string {
  return join(getWapeDir(), "wape.db");
}

export function getWapeListsDir(): string {
  return join(getWapeDir(), "lists");
}

export function getMainListPath(): string {
  return join(getWapeListsDir(), "main.txt");
}

export function getLockListPath(): string {
  return join(getWapeListsDir(), "lock.txt");
}

let cachedDb: Database | null = null;
let currentDbPath: string | null = null;

export function getWapeDb(): Database {
  const dbPath = getWapeDbFile();
  if (cachedDb && currentDbPath === dbPath) {
    return cachedDb;
  }

  const isNewDb = !existsSync(dbPath);
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  initWapeDbSchema(db);

  if (isNewDb) {
    migrateLegacyDataToSqlite(db);
  }

  cachedDb = db;
  currentDbPath = dbPath;
  return db;
}

function initWapeDbSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      is_global INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_contacts (
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (list_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      owner_phone TEXT,
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      jid TEXT NOT NULL,
      subject TEXT NOT NULL,
      community_name TEXT,
      UNIQUE(source_id, jid)
    );

    CREATE TABLE IF NOT EXISTS contact_group_sources (
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (contact_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT,
      target_list TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS saved_links (
      url TEXT PRIMARY KEY,
      saved_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ignored_groups (
      jid TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      community_name TEXT,
      ignored_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS noted_comparisons (
      targets_key TEXT PRIMARY KEY,
      noted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS noted_comparison_contacts (
      targets_key TEXT NOT NULL REFERENCES noted_comparisons(targets_key) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (targets_key, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_groups_jid ON groups(jid);
    CREATE INDEX IF NOT EXISTS idx_room_groups_room ON room_groups(room_id);
    CREATE INDEX IF NOT EXISTS idx_cgs_group ON contact_group_sources(group_id);
  `);

  // Ensure default global lists exist
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO lists (name, is_global, created_at, updated_at) VALUES ('main', 1, ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO lists (name, is_global, created_at, updated_at) VALUES ('lock', 1, ?, ?)`,
    [now, now],
  );

  // Clean up any accidentally created path-based lists from previous runs
  const badLists = db
    .query(
      `SELECT id, name FROM lists WHERE name LIKE '%/%' OR name LIKE '%\\\\%'`,
    )
    .all() as { id: number; name: string }[];
  for (const bad of badLists) {
    const cleanName = normalizeListName(bad.name);
    if (cleanName && cleanName !== bad.name) {
      const targetList = db
        .query(`SELECT id FROM lists WHERE name = ?`)
        .get(cleanName) as { id: number } | null;
      if (targetList) {
        db.run(
          `INSERT OR IGNORE INTO list_contacts (list_id, contact_id) SELECT ?, contact_id FROM list_contacts WHERE list_id = ?`,
          [targetList.id, bad.id],
        );
      }
    }
    db.run(`DELETE FROM lists WHERE id = ?`, [bad.id]);
  }

  // Remove test artifact rooms if any leaked with 0 groups
  db.run(
    `DELETE FROM rooms WHERE id = 'renamed-room-1' AND NOT EXISTS (SELECT 1 FROM room_groups WHERE room_id = 'renamed-room-1')`,
  );

  // Clean up any .txt suffix in rooms.target_list
  db.run(
    `UPDATE rooms SET target_list = substr(target_list, 1, length(target_list) - 4) WHERE target_list LIKE '%.txt'`,
  );

  // Clean up legacy room-labeled and duplicate primary sources into a canonical 'Primary Backup' source
  const primarySources = db
    .query(
      `SELECT id, type, label FROM sources WHERE type = 'primary' OR label LIKE 'Room: %' ORDER BY id ASC`,
    )
    .all() as Array<{ id: number; type: string; label: string }>;

  if (primarySources.length > 0) {
    db.transaction(() => {
      let canonicalPrimary = db
        .query(
          `SELECT id FROM sources WHERE type = 'primary' AND label = 'Primary Backup' LIMIT 1`,
        )
        .get() as { id: number } | null;

      if (!canonicalPrimary) {
        const first = primarySources[0]!;
        db.run(
          `UPDATE sources SET type = 'primary', label = 'Primary Backup' WHERE id = ?`,
          [first.id],
        );
        canonicalPrimary = { id: first.id };
      }

      const canonicalId = canonicalPrimary.id;

      for (const src of primarySources) {
        if (src.id === canonicalId) continue;

        const srcGroups = db
          .query(
            `SELECT id, jid, subject, community_name FROM groups WHERE source_id = ?`,
          )
          .all(src.id) as Array<{
          id: number;
          jid: string;
          subject: string;
          community_name: string | null;
        }>;

        for (const g of srcGroups) {
          const existingTargetGroup = db
            .query(`SELECT id FROM groups WHERE source_id = ? AND jid = ?`)
            .get(canonicalId, g.jid) as { id: number } | null;

          if (existingTargetGroup) {
            db.run(
              `INSERT OR IGNORE INTO contact_group_sources (contact_id, group_id)
               SELECT contact_id, ? FROM contact_group_sources WHERE group_id = ?`,
              [existingTargetGroup.id, g.id],
            );
            db.run(`DELETE FROM contact_group_sources WHERE group_id = ?`, [
              g.id,
            ]);
            db.run(`DELETE FROM groups WHERE id = ?`, [g.id]);
          } else {
            db.run(`UPDATE groups SET source_id = ? WHERE id = ?`, [
              canonicalId,
              g.id,
            ]);
          }
        }

        db.run(`DELETE FROM sources WHERE id = ?`, [src.id]);
      }
    })();
  }
}

function migrateLegacyDataToSqlite(db: Database): void {
  const wapeDir = getWapeDir();
  const listsDir = join(wapeDir, "lists");
  const roomsFile = join(wapeDir, "rooms.json");
  const linksFile = join(wapeDir, "links.json");
  const ignoredFile = join(wapeDir, "ignored-groups.json");
  const comparisonsFile = join(wapeDir, "comparisons.json");

  db.transaction(() => {
    const now = Date.now();

    // 1. Migrate text lists
    if (existsSync(listsDir)) {
      const files = readdirSync(listsDir);
      for (const file of files) {
        if (!file.endsWith(".txt")) continue;
        const listName = file.replace(/\.txt$/, "");
        const isGlobal = listName === "main" || listName === "lock" ? 1 : 0;
        db.run(
          `INSERT OR IGNORE INTO lists (name, is_global, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          [listName, isGlobal, now, now],
        );
        const listRow = db
          .query(`SELECT id FROM lists WHERE name = ?`)
          .get(listName) as { id: number } | null;
        if (!listRow) continue;

        try {
          const content = readFileSync(join(listsDir, file), "utf-8");
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const normalized = normalizeNigerianPhoneNumber(line.trim());
            if (normalized) {
              db.run(
                `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
                [normalized, now],
              );
              const contactRow = db
                .query(`SELECT id FROM contacts WHERE phone = ?`)
                .get(normalized) as { id: number } | null;
              if (contactRow) {
                db.run(
                  `INSERT OR IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)`,
                  [listRow.id, contactRow.id],
                );
              }
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // 2. Migrate rooms.json
    interface LegacyRoomJson {
      id?: string;
      name?: string;
      targetList?: string;
      createdAt?: number;
      updatedAt?: number;
      groupIds?: (string | number)[];
      groupJidRowIds?: (string | number)[];
      groupNames?: string[];
    }
    if (existsSync(roomsFile)) {
      try {
        const raw = readFileSync(roomsFile, "utf-8");
        const parsed = JSON.parse(raw) as
          { rooms?: LegacyRoomJson[] } | LegacyRoomJson[];
        const list = Array.isArray(parsed) ? parsed : (parsed.rooms ?? []);
        for (const r of list) {
          const roomId = (r.id ?? "").trim().toLowerCase();
          if (!roomId) continue;
          db.run(
            `INSERT OR REPLACE INTO rooms (id, name, target_list, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
            [
              roomId,
              r.name ?? null,
              r.targetList ?? `${roomId}.txt`,
              r.createdAt ?? now,
              r.updatedAt ?? now,
            ],
          );
          db.run(`DELETE FROM room_groups WHERE room_id = ?`, [roomId]);
          const ids: (string | number)[] = r.groupIds ?? r.groupJidRowIds ?? [];
          const names: string[] = r.groupNames ?? [];
          for (let i = 0; i < ids.length; i++) {
            const rawId = ids[i];
            if (rawId === undefined) continue;
            const groupName = names[i] || String(rawId);
            db.run(
              `INSERT INTO room_groups (room_id, group_id, group_name, sort_order) VALUES (?, ?, ?, ?)`,
              [roomId, String(rawId), groupName, i],
            );
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 3. Migrate links.json
    if (existsSync(linksFile)) {
      try {
        const raw = readFileSync(linksFile, "utf-8");
        const parsed = JSON.parse(raw) as { links?: string[] } | string[];
        const list = Array.isArray(parsed) ? parsed : (parsed.links ?? []);
        for (const link of list) {
          const trimmed = (link ?? "").trim();
          if (trimmed) {
            db.run(
              `INSERT OR IGNORE INTO saved_links (url, saved_at) VALUES (?, ?)`,
              [trimmed, now],
            );
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 4. Migrate ignored-groups.json
    interface LegacyIgnoredGroupJson {
      jid?: string;
      subject?: string;
      communityName?: string | null;
      ignoredAt?: number;
    }
    if (existsSync(ignoredFile)) {
      try {
        const raw = readFileSync(ignoredFile, "utf-8");
        const parsed = JSON.parse(raw) as
          { groups?: LegacyIgnoredGroupJson[] } | LegacyIgnoredGroupJson[];
        const list = Array.isArray(parsed) ? parsed : (parsed.groups ?? []);
        for (const g of list) {
          const jid = (g.jid ?? "").trim();
          const subject = (g.subject ?? "").trim();
          if (jid && subject) {
            db.run(
              `INSERT OR REPLACE INTO ignored_groups (jid, subject, community_name, ignored_at) VALUES (?, ?, ?, ?)`,
              [jid, subject, g.communityName ?? null, g.ignoredAt ?? now],
            );
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 5. Migrate comparisons.json
    if (existsSync(comparisonsFile)) {
      try {
        const raw = readFileSync(comparisonsFile, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        for (const [key, contactsList] of Object.entries(parsed)) {
          if (!Array.isArray(contactsList)) continue;
          db.run(
            `INSERT OR REPLACE INTO noted_comparisons (targets_key, noted_at) VALUES (?, ?)`,
            [key, now],
          );
          db.run(
            `DELETE FROM noted_comparison_contacts WHERE targets_key = ?`,
            [key],
          );
          for (const item of contactsList) {
            const normalized = normalizeNigerianPhoneNumber(item);
            if (normalized) {
              db.run(
                `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
                [normalized, now],
              );
              const contactRow = db
                .query(`SELECT id FROM contacts WHERE phone = ?`)
                .get(normalized) as { id: number } | null;
              if (contactRow) {
                db.run(
                  `INSERT OR IGNORE INTO noted_comparison_contacts (targets_key, contact_id) VALUES (?, ?)`,
                  [key, contactRow.id],
                );
              }
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  })();
}

/**
 * List Management API
 */
export function normalizeListName(target: string): string {
  if (!target) return "";
  const trimmed = target.trim();
  const listsDir = resolve(getWapeListsDir());

  let expanded = trimmed;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  const resolved = resolve(expanded);

  if (
    resolved === listsDir ||
    resolved.startsWith(listsDir + "/") ||
    resolved.startsWith(listsDir + "\\")
  ) {
    const rel = relative(listsDir, resolved);
    return rel.replace(/\.[^/.\\]+$/, "");
  }

  const base = basename(expanded);
  return base.replace(/\.[^/.\\]+$/, "");
}

export function getOrCreateList(
  name: string,
  isGlobal = 0,
): { id: number; name: string } {
  const db = getWapeDb();
  const clean = normalizeListName(name);
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO lists (name, is_global, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [clean, isGlobal, now, now],
  );
  const row = db
    .query(`SELECT id, name FROM lists WHERE name = ?`)
    .get(clean) as {
    id: number;
    name: string;
  };
  return row;
}

export function getAllKnownLists(): {
  name: string;
  path: string;
  isGlobal: boolean;
  count: number;
}[] {
  const db = getWapeDb();
  const rows = db
    .query(
      `SELECT l.name, l.is_global, COUNT(lc.contact_id) as count
       FROM lists l
       LEFT JOIN list_contacts lc ON l.id = lc.list_id
       GROUP BY l.id
       ORDER BY l.is_global DESC, l.name ASC`,
    )
    .all() as { name: string; is_global: number; count: number }[];

  return rows.map((r) => ({
    name: r.is_global ? `${r.name} (Global)` : r.name,
    path: resolveListFilePath(r.name),
    isGlobal: Boolean(r.is_global),
    count: Number(r.count),
  }));
}

/**
 * Contact & List Data Operations
 */
export function getContactsFromList(listName: string): Set<string> {
  const db = getWapeDb();
  const clean = normalizeListName(listName);
  const rows = db
    .query(
      `SELECT c.phone
       FROM contacts c
       JOIN list_contacts lc ON c.id = lc.contact_id
       JOIN lists l ON l.id = lc.list_id
       WHERE l.name = ?`,
    )
    .all(clean) as { phone: string }[];

  return new Set(rows.map((r) => r.phone));
}

export function saveContactsToList(
  listName: string,
  contacts: Set<string>,
): void {
  const db = getWapeDb();
  const list = getOrCreateList(listName);
  const now = Date.now();

  db.transaction(() => {
    const insertContactStmt = db.prepare(
      `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
    );
    const insertListContactStmt = db.prepare(
      `INSERT OR IGNORE INTO list_contacts (list_id, contact_id) SELECT ?, id FROM contacts WHERE phone = ?`,
    );

    db.run(`DELETE FROM list_contacts WHERE list_id = ?`, [list.id]);
    for (const phone of contacts) {
      const normalized = normalizeNigerianPhoneNumber(phone);
      if (normalized) {
        insertContactStmt.run(normalized, now);
        insertListContactStmt.run(list.id, normalized);
      }
    }
    db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now, list.id]);
  })();
}

export function addContactsToList(
  listName: string,
  newContacts: Set<string>,
): { uniqueExtractsCount: number; addedCount: number; totalCount: number } {
  const db = getWapeDb();
  const list = getOrCreateList(listName);
  const now = Date.now();
  let addedCount = 0;

  db.transaction(() => {
    const insertContactStmt = db.prepare(
      `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
    );
    const insertListContactStmt = db.prepare(
      `INSERT OR IGNORE INTO list_contacts (list_id, contact_id) SELECT ?, id FROM contacts WHERE phone = ?`,
    );

    for (const phone of newContacts) {
      const normalized = normalizeNigerianPhoneNumber(phone);
      if (normalized) {
        insertContactStmt.run(normalized, now);
        const res = insertListContactStmt.run(list.id, normalized);
        if (res.changes > 0) {
          addedCount++;
        }
      }
    }
    db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now, list.id]);
  })();

  const totalRow = db
    .query(`SELECT COUNT(*) as cnt FROM list_contacts WHERE list_id = ?`)
    .get(list.id) as { cnt: number };

  return {
    uniqueExtractsCount: newContacts.size,
    addedCount,
    totalCount: totalRow.cnt,
  };
}

export function removeContactsFromList(
  listName: string,
  contactsToRemove: Set<string>,
): { uniqueExtractsCount: number; removedCount: number; totalCount: number } {
  const db = getWapeDb();
  const clean = normalizeListName(listName);
  const listRow = db
    .query(`SELECT id FROM lists WHERE name = ?`)
    .get(clean) as { id: number } | null;

  if (!listRow) {
    return {
      uniqueExtractsCount: contactsToRemove.size,
      removedCount: 0,
      totalCount: 0,
    };
  }

  let removedCount = 0;
  const now = Date.now();

  db.transaction(() => {
    const deleteStmt = db.prepare(
      `DELETE FROM list_contacts WHERE list_id = ? AND contact_id = (SELECT id FROM contacts WHERE phone = ?)`,
    );
    for (const phone of contactsToRemove) {
      const normalized = normalizeNigerianPhoneNumber(phone);
      if (normalized) {
        const res = deleteStmt.run(listRow.id, normalized);
        if (res.changes > 0) {
          removedCount++;
        }
      }
    }
    db.run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now, listRow.id]);
  })();

  const totalRow = db
    .query(`SELECT COUNT(*) as cnt FROM list_contacts WHERE list_id = ?`)
    .get(listRow.id) as { cnt: number };

  return {
    uniqueExtractsCount: contactsToRemove.size,
    removedCount,
    totalCount: totalRow.cnt,
  };
}

/**
 * Provenance & Source Tracking API
 */
export interface RecordProvenanceGroupItem {
  jid: string;
  subject: string;
  communityName: string | null;
  phones: string[];
}

export function recordScanProvenance(options: {
  type: "primary" | "oneoff";
  label: string;
  ownerPhone?: string | null;
  groups: RecordProvenanceGroupItem[];
}): { sourceId: number } {
  const db = getWapeDb();
  const now = Date.now();

  let sourceId = 0;

  db.transaction(() => {
    const insertSourceStmt = db.prepare(
      `INSERT INTO sources (type, label, owner_phone, scanned_at) VALUES (?, ?, ?, ?)`,
    );
    const updateSourceStmt = db.prepare(
      `UPDATE sources SET scanned_at = ?, owner_phone = COALESCE(?, owner_phone) WHERE id = ?`,
    );
    const insertGroupStmt = db.prepare(
      `INSERT INTO groups (source_id, jid, subject, community_name) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, jid) DO UPDATE SET subject = excluded.subject, community_name = excluded.community_name`,
    );
    const getGroupStmt = db.prepare(
      `SELECT id FROM groups WHERE source_id = ? AND jid = ?`,
    );
    const insertContactStmt = db.prepare(
      `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
    );
    const insertContactGroupStmt = db.prepare(
      `INSERT OR IGNORE INTO contact_group_sources (contact_id, group_id) SELECT id, ? FROM contacts WHERE phone = ?`,
    );

    const existingSource = db
      .query(`SELECT id FROM sources WHERE type = ? AND label = ?`)
      .get(options.type, options.label) as { id: number } | null;

    if (existingSource) {
      sourceId = existingSource.id;
      updateSourceStmt.run(now, options.ownerPhone ?? null, sourceId);
    } else {
      insertSourceStmt.run(
        options.type,
        options.label,
        options.ownerPhone ?? null,
        now,
      );
      const sourceRow = db.query(`SELECT last_insert_rowid() as id`).get() as {
        id: number;
      };
      sourceId = sourceRow.id;
    }

    for (const group of options.groups) {
      insertGroupStmt.run(
        sourceId,
        group.jid,
        group.subject,
        group.communityName ?? null,
      );
      const groupRow = getGroupStmt.get(sourceId, group.jid) as { id: number };

      for (const rawPhone of group.phones) {
        const normalized = normalizeNigerianPhoneNumber(rawPhone);
        if (normalized) {
          insertContactStmt.run(normalized, now);
          insertContactGroupStmt.run(groupRow.id, normalized);
        }
      }
    }
  })();

  return { sourceId };
}

export function getContactProvenance(phone: string): ContactProvenance | null {
  const normalized = normalizeNigerianPhoneNumber(phone);
  if (!normalized) return null;

  const db = getWapeDb();
  const contactRow = db
    .query(`SELECT id, phone FROM contacts WHERE phone = ?`)
    .get(normalized) as { id: number; phone: string } | null;

  if (!contactRow) {
    return {
      phone: normalized,
      groups: [],
      sources: [],
      rooms: [],
      lists: [],
      totalGroupsCount: 0,
    };
  }

  // 1. Fetch group & source associations
  interface GroupSourceRow {
    source_id: number;
    source_type: string;
    source_label: string;
    owner_phone: string | null;
    scanned_at: number;
    group_jid: string;
    group_subject: string;
    community_name: string | null;
  }

  const rows = db
    .query(
      `SELECT 
         s.id as source_id,
         s.type as source_type,
         s.label as source_label,
         s.owner_phone,
         s.scanned_at,
         g.jid as group_jid,
         g.subject as group_subject,
         g.community_name
       FROM contact_group_sources cgs
       JOIN groups g ON g.id = cgs.group_id
       JOIN sources s ON s.id = g.source_id
       WHERE cgs.contact_id = ?
       ORDER BY s.scanned_at DESC, g.subject ASC`,
    )
    .all(contactRow.id) as GroupSourceRow[];

  const groupsMap = new Map<string, ContactProvenanceGroup>();
  const sourcesMap = new Map<number, ContactProvenanceSource>();

  for (const r of rows) {
    // Unique group mapping by JID
    let g = groupsMap.get(r.group_jid);
    if (!g) {
      g = {
        jid: r.group_jid,
        subject: r.group_subject,
        communityName: r.community_name,
        sources: [],
      };
      groupsMap.set(r.group_jid, g);
    }
    if (
      !g.sources.some(
        (s) =>
          s.sourceType === r.source_type && s.sourceLabel === r.source_label,
      )
    ) {
      g.sources.push({
        sourceType: r.source_type,
        sourceLabel: r.source_label,
        ownerPhone: r.owner_phone,
        scannedAt: r.scanned_at,
      });
    }

    // Sources mapping (backward compatibility)
    let source = sourcesMap.get(r.source_id);
    if (!source) {
      source = {
        sourceType: r.source_type,
        sourceLabel: r.source_label,
        ownerPhone: r.owner_phone,
        scannedAt: r.scanned_at,
        groups: [],
      };
      sourcesMap.set(r.source_id, source);
    }
    if (!source.groups.some((grp) => grp.jid === r.group_jid)) {
      source.groups.push({
        jid: r.group_jid,
        subject: r.group_subject,
        communityName: r.community_name,
      });
    }
  }

  const uniqueGroups = Array.from(groupsMap.values());

  // 2. Fetch rooms
  interface RoomRow {
    id: string;
    name: string | null;
  }
  const roomRows = db
    .query(
      `SELECT DISTINCT r.id, r.name
       FROM rooms r
       WHERE r.target_list IN (
         SELECT l.name FROM list_contacts lc
         JOIN lists l ON l.id = lc.list_id
         WHERE lc.contact_id = ?
       )
       OR r.id IN (
         SELECT rg.room_id FROM room_groups rg
         JOIN groups g ON (rg.group_id = g.jid OR rg.group_id = CAST(g.id AS TEXT))
         JOIN contact_group_sources cgs ON cgs.group_id = g.id
         WHERE cgs.contact_id = ?
       )
       ORDER BY r.id ASC`,
    )
    .all(contactRow.id, contactRow.id) as RoomRow[];

  const rooms = roomRows.map((r) =>
    r.name && r.name !== r.id ? `${r.id} (${r.name})` : r.id,
  );

  // 3. Fetch list memberships
  const listRows = db
    .query(
      `SELECT l.name
       FROM list_contacts lc
       JOIN lists l ON l.id = lc.list_id
       WHERE lc.contact_id = ?
       ORDER BY l.is_global DESC, l.name ASC`,
    )
    .all(contactRow.id) as { name: string }[];

  return {
    phone: normalized,
    groups: uniqueGroups,
    sources: Array.from(sourcesMap.values()),
    rooms,
    lists: listRows.map((l) => l.name),
    totalGroupsCount: uniqueGroups.length,
  };
}

/**
 * Room Store API
 */
export function getRooms(): Room[] {
  const db = getWapeDb();
  interface RoomRow {
    id: string;
    name: string | null;
    target_list: string | null;
    created_at: number;
    updated_at: number;
  }
  const roomRows = db
    .query(
      `SELECT id, name, target_list, created_at, updated_at FROM rooms ORDER BY id ASC`,
    )
    .all() as RoomRow[];

  interface GroupRow {
    room_id: string;
    group_id: string;
    group_name: string;
    sort_order: number;
  }
  const groupRows = db
    .query(
      `SELECT room_id, group_id, group_name, sort_order FROM room_groups ORDER BY sort_order ASC`,
    )
    .all() as GroupRow[];

  const groupsByRoom = new Map<
    string,
    { ids: (string | number)[]; names: string[] }
  >();
  for (const g of groupRows) {
    let list = groupsByRoom.get(g.room_id);
    if (!list) {
      list = { ids: [], names: [] };
      groupsByRoom.set(g.room_id, list);
    }
    const numId = Number(g.group_id);
    list.ids.push(
      isNaN(numId) ? g.group_id : g.group_id.includes("@") ? g.group_id : numId,
    );
    list.names.push(g.group_name);
  }

  return roomRows.map((r) => {
    const gData = groupsByRoom.get(r.id) ?? { ids: [], names: [] };
    return {
      id: r.id,
      name: r.name ?? undefined,
      groupIds: gData.ids,
      groupJidRowIds: gData.ids,
      groupNames: gData.names,
      targetList: r.target_list,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function getRoomById(id: string): Room | null {
  const rooms = getRooms();
  return (
    rooms.find((r) => r.id.toLowerCase() === id.toLowerCase().trim()) ?? null
  );
}

export function isGroupInRoom(
  group: { jid: string; subject: string },
  room: Room,
) {
  const groupJid = group.jid.toLowerCase();
  const groupSubject = group.subject.trim().toLowerCase();

  const idMatch = (room.groupIds ?? room.groupJidRowIds ?? []).some((rawId) => {
    const idString = String(rawId).toLowerCase();
    return (
      idString === groupJid ||
      `${idString}@g.us` === groupJid ||
      groupJid === `${idString}@s.whatsapp.net`
    );
  });
  if (idMatch) return true;

  const nameMatch = (room.groupNames ?? []).some(
    (name) => name.trim().toLowerCase() === groupSubject,
  );
  if (nameMatch) return true;

  try {
    const db = getWapeDb();
    const row = db
      .query(
        `SELECT 1 FROM room_groups rg
         LEFT JOIN groups g ON (rg.group_id = CAST(g.id AS TEXT) OR rg.group_id = g.jid)
         WHERE rg.room_id = ?
           AND (
             rg.group_id = ?
             OR g.jid = ?
             OR (LOWER(rg.group_name) = ? AND LOWER(g.subject) = ?)
           )
         LIMIT 1`,
      )
      .get(room.id, group.jid, group.jid, groupSubject, groupSubject);
    if (row) return true;
  } catch {
    // Database fallback
  }

  return false;
}

export function saveRoom(room: Room): void {
  const db = getWapeDb();
  const roomId = room.id.trim().toLowerCase();
  const now = Date.now();
  const ids = room.groupIds ?? room.groupJidRowIds ?? [];
  const names = room.groupNames ?? [];

  db.transaction(() => {
    db.run(
      `INSERT INTO rooms (id, name, target_list, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, target_list = excluded.target_list, updated_at = excluded.updated_at`,
      [
        roomId,
        room.name ?? null,
        room.targetList ? normalizeListName(room.targetList) : roomId,
        room.createdAt ?? now,
        now,
      ],
    );

    db.run(`DELETE FROM room_groups WHERE room_id = ?`, [roomId]);
    for (let i = 0; i < ids.length; i++) {
      const gId = ids[i];
      if (gId === undefined) continue;
      const gName = names[i] || String(gId);
      db.run(
        `INSERT INTO room_groups (room_id, group_id, group_name, sort_order) VALUES (?, ?, ?, ?)`,
        [roomId, String(gId), gName, i],
      );
    }
  })();
}

export function deleteRoom(id: string): boolean {
  const db = getWapeDb();
  const roomId = id.trim().toLowerCase();
  const res = db.run(`DELETE FROM rooms WHERE id = ?`, [roomId]);
  return res.changes > 0;
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

  const db = getWapeDb();
  const existingNew = db
    .query(`SELECT id FROM rooms WHERE id = ?`)
    .get(cleanNewId);
  if (existingNew) {
    return {
      success: false,
      error: `A room with ID '${cleanNewId}' already exists.`,
    };
  }

  const room = getRoomById(cleanOldId);
  if (!room) {
    return { success: false, error: `Room '${cleanOldId}' not found.` };
  }

  // Rename physical list file if old list file exists on disk
  const oldListPath = resolveListFilePath(`${cleanOldId}.txt`);
  const newListPath = resolveListFilePath(`${cleanNewId}.txt`);
  let listRenamed = false;

  if (existsSync(oldListPath)) {
    try {
      renameSync(oldListPath, newListPath);
      listRenamed = true;
    } catch {
      // Ignore rename failure
    }
  }

  db.transaction(() => {
    // 1. Insert new room
    db.run(
      `INSERT INTO rooms (id, name, target_list, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [cleanNewId, room.name ?? null, cleanNewId, room.createdAt, Date.now()],
    );

    // 2. Re-point room_groups
    db.run(`UPDATE room_groups SET room_id = ? WHERE room_id = ?`, [
      cleanNewId,
      cleanOldId,
    ]);

    // 3. Delete old room
    db.run(`DELETE FROM rooms WHERE id = ?`, [cleanOldId]);

    // 4. Check if a list with oldId name exists in DB
    const oldList = db
      .query(`SELECT id FROM lists WHERE name = ?`)
      .get(cleanOldId) as { id: number } | null;
    if (oldList) {
      db.run(`UPDATE lists SET name = ? WHERE id = ?`, [
        cleanNewId,
        oldList.id,
      ]);
      listRenamed = true;
    }
  })();

  return { success: true, listRenamed };
}

/**
 * Links API
 */
export function getSavedLinks(filterOpts?: ExportFilterOptions): string[] {
  const db = getWapeDb();
  let sql = `SELECT url, saved_at FROM saved_links`;
  const params: (number | string)[] = [];

  if (filterOpts) {
    const { startTime, endTime } = parseDateRange(filterOpts);
    const conditions: string[] = [];
    if (startTime !== undefined) {
      conditions.push(`saved_at >= ?`);
      params.push(startTime);
    }
    if (endTime !== undefined) {
      conditions.push(`saved_at <= ?`);
      params.push(endTime);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(" AND ");
    }
  }

  const lastLimit = filterOpts?.last
    ? typeof filterOpts.last === "string"
      ? parseInt(filterOpts.last, 10)
      : filterOpts.last
    : undefined;

  if (lastLimit !== undefined && lastLimit > 0) {
    sql += ` ORDER BY saved_at DESC, url ASC LIMIT ?`;
    params.push(lastLimit);
    const rows = db.query(sql).all(...params) as {
      url: string;
      saved_at: number;
    }[];
    return rows.map((r) => r.url).sort((a, b) => a.localeCompare(b));
  } else {
    sql += ` ORDER BY url ASC`;
    const rows = db.query(sql).all(...params) as {
      url: string;
      saved_at: number;
    }[];
    return rows.map((r) => r.url);
  }
}

export function saveLinks(newLinks: string[]): {
  addedCount: number;
  totalCount: number;
} {
  const db = getWapeDb();
  const now = Date.now();
  let addedCount = 0;

  db.transaction(() => {
    for (const link of newLinks) {
      const trimmed = link.trim();
      if (trimmed) {
        const existing = db
          .query(`SELECT url FROM saved_links WHERE url = ?`)
          .get(trimmed);
        if (!existing) {
          db.run(`INSERT INTO saved_links (url, saved_at) VALUES (?, ?)`, [
            trimmed,
            now,
          ]);
          addedCount++;
        }
      }
    }
  })();

  const allLinks = getSavedLinks();
  return {
    addedCount,
    totalCount: allLinks.length,
  };
}

/**
 * Ignored Groups API
 */
export function getIgnoredGroups(): IgnoredGroup[] {
  const db = getWapeDb();
  const rows = db
    .query(
      `SELECT jid, subject, community_name, ignored_at FROM ignored_groups ORDER BY subject ASC`,
    )
    .all() as {
    jid: string;
    subject: string;
    community_name: string | null;
    ignored_at: number;
  }[];

  return rows.map((r) => ({
    jid: r.jid,
    subject: r.subject,
    communityName: r.community_name,
    ignoredAt: r.ignored_at,
  }));
}

export function getIgnoredJidSet(): Set<string> {
  const groups = getIgnoredGroups();
  return new Set(groups.map((g) => g.jid.toLowerCase()));
}

export function isGroupIgnored(jid: string): boolean {
  return getIgnoredJidSet().has(jid.toLowerCase().trim());
}

export function saveIgnoredGroups(groups: IgnoredGroup[]): void {
  const db = getWapeDb();
  const now = Date.now();
  db.transaction(() => {
    db.run(`DELETE FROM ignored_groups`);
    for (const g of groups) {
      db.run(
        `INSERT INTO ignored_groups (jid, subject, community_name, ignored_at) VALUES (?, ?, ?, ?)`,
        [g.jid, g.subject, g.communityName ?? null, g.ignoredAt || now],
      );
    }
  })();
}

export function addIgnoredGroups(
  newGroups: {
    jid: string;
    subject: string;
    communityName?: string | null;
  }[],
): { addedCount: number; totalCount: number } {
  const db = getWapeDb();
  const now = Date.now();
  let addedCount = 0;

  db.transaction(() => {
    for (const ng of newGroups) {
      const cleanJid = ng.jid.trim();
      if (cleanJid) {
        const existing = db
          .query(`SELECT jid FROM ignored_groups WHERE LOWER(jid) = ?`)
          .get(cleanJid.toLowerCase());
        if (!existing) {
          db.run(
            `INSERT INTO ignored_groups (jid, subject, community_name, ignored_at) VALUES (?, ?, ?, ?)`,
            [cleanJid, ng.subject.trim(), ng.communityName ?? null, now],
          );
          addedCount++;
        }
      }
    }
  })();

  const allGroups = getIgnoredGroups();
  return {
    addedCount,
    totalCount: allGroups.length,
  };
}

export function removeIgnoredGroups(jidsToRemove: string[]): {
  removedCount: number;
  totalCount: number;
} {
  const db = getWapeDb();
  let removedCount = 0;

  db.transaction(() => {
    for (const jid of jidsToRemove) {
      const res = db.run(`DELETE FROM ignored_groups WHERE LOWER(jid) = ?`, [
        jid.toLowerCase().trim(),
      ]);
      removedCount += res.changes;
    }
  })();

  const allGroups = getIgnoredGroups();
  return {
    removedCount,
    totalCount: allGroups.length,
  };
}

/**
 * Comparisons API
 */
export function getCanonicalComparisonKey(targets: string[]): string {
  const canonical = targets
    .map((t) => resolveListFilePath(t).toLowerCase())
    .sort();
  return canonical.join(":::");
}

export function getNotedComparison(targets: string[]): {
  exists: boolean;
  contacts: Set<string>;
} {
  const db = getWapeDb();
  const key = getCanonicalComparisonKey(targets);
  const compRow = db
    .query(`SELECT targets_key FROM noted_comparisons WHERE targets_key = ?`)
    .get(key);

  if (!compRow) {
    return { exists: false, contacts: new Set<string>() };
  }

  const rows = db
    .query(
      `SELECT c.phone
       FROM noted_comparison_contacts ncc
       JOIN contacts c ON c.id = ncc.contact_id
       WHERE ncc.targets_key = ?`,
    )
    .all(key) as { phone: string }[];

  return {
    exists: true,
    contacts: new Set(rows.map((r) => r.phone)),
  };
}

export function saveNotedComparison(
  targets: string[],
  contacts: Set<string> | string[],
): void {
  const db = getWapeDb();
  const key = getCanonicalComparisonKey(targets);
  const now = Date.now();

  db.transaction(() => {
    const insertContactStmt = db.prepare(
      `INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)`,
    );
    const insertNotedContactStmt = db.prepare(
      `INSERT OR IGNORE INTO noted_comparison_contacts (targets_key, contact_id) SELECT ?, id FROM contacts WHERE phone = ?`,
    );

    db.run(
      `INSERT OR REPLACE INTO noted_comparisons (targets_key, noted_at) VALUES (?, ?)`,
      [key, now],
    );
    db.run(`DELETE FROM noted_comparison_contacts WHERE targets_key = ?`, [
      key,
    ]);

    for (const phone of contacts) {
      const normalized = normalizeNigerianPhoneNumber(phone);
      if (normalized) {
        insertContactStmt.run(normalized, now);
        insertNotedContactStmt.run(key, normalized);
      }
    }
  })();
}

/**
 * File path resolver helper (for fallback or room display)
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

export function getListContactCount(listName: string): number {
  const db = getWapeDb();
  const clean = normalizeListName(listName);
  const listRow = db
    .query(`SELECT id FROM lists WHERE name = ?`)
    .get(clean) as { id: number } | null;
  if (!listRow) return 0;

  const totalRow = db
    .query(`SELECT COUNT(*) as cnt FROM list_contacts WHERE list_id = ?`)
    .get(listRow.id) as { cnt: number };
  return totalRow.cnt;
}
