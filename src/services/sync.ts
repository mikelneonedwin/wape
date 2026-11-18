import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, homedir, networkInterfaces, platform } from "node:os";
import { sep } from "node:path";
import dgram from "node:dgram";
import {
  getAppConfig,
  getWapeConfigFile,
  getWapeDb,
  getWapeDir,
  getWapeListsDir,
  normalizeListName,
  saveAppConfig,
  type AppConfig,
} from "./wape-store";

const SYNC_DISCOVERY_PORT = 43821;
const SYNC_PROTOCOL_VERSION = 2;
const SYNC_DISCOVERY_INTERVAL_MS = 500;
const MAX_SYNC_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface SyncListRecord {
  name: string;
  isGlobal: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SyncContactRecord {
  phone: string;
  createdAt: number;
}

export interface SyncListContactRecord {
  listName: string;
  phone: string;
}

export interface SyncSourceRecord {
  type: string;
  label: string;
  ownerPhone: string | null;
  scannedAt: number;
}

export interface SyncGroupRecord {
  sourceType: string;
  sourceLabel: string;
  jid: string;
  subject: string;
  communityName: string | null;
}

export interface SyncContactGroupSourceRecord {
  phone: string;
  sourceType: string;
  sourceLabel: string;
  jid: string;
}

export interface SyncRoomRecord {
  id: string;
  name: string | null;
  targetList: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncRoomGroupRecord {
  roomId: string;
  groupId: string;
  groupName: string;
  sortOrder: number;
}

export interface SyncSavedLinkRecord {
  url: string;
  savedAt: number;
}

export interface SyncIgnoredGroupRecord {
  jid: string;
  subject: string;
  communityName: string | null;
  ignoredAt: number;
}

export interface SyncNotedComparisonRecord {
  targetsKey: string;
  notedAt: number;
}

export interface SyncNotedComparisonContactRecord {
  targetsKey: string;
  phone: string;
}

export interface SyncDatabaseSnapshot {
  lists: SyncListRecord[];
  contacts: SyncContactRecord[];
  listContacts: SyncListContactRecord[];
  sources: SyncSourceRecord[];
  groups: SyncGroupRecord[];
  contactGroupSources: SyncContactGroupSourceRecord[];
  rooms: SyncRoomRecord[];
  roomGroups: SyncRoomGroupRecord[];
  savedLinks: SyncSavedLinkRecord[];
  ignoredGroups: SyncIgnoredGroupRecord[];
  notedComparisons: SyncNotedComparisonRecord[];
  notedComparisonContacts: SyncNotedComparisonContactRecord[];
}

export interface SyncConfigSnapshot {
  config: AppConfig;
  updatedAt: number;
}

export interface SyncDeviceInfo {
  hostname: string;
  platform: string;
  nonce: string;
}

export interface SyncSnapshot {
  version: typeof SYNC_PROTOCOL_VERSION;
  generatedAt: number;
  device: SyncDeviceInfo;
  config: SyncConfigSnapshot;
  database: SyncDatabaseSnapshot;
}

export interface SyncReceivedCounts {
  lists: number;
  contacts: number;
  listContacts: number;
  sources: number;
  groups: number;
  contactGroupSources: number;
  rooms: number;
  roomGroups: number;
  savedLinks: number;
  ignoredGroups: number;
  notedComparisons: number;
  notedComparisonContacts: number;
  configFields: number;
}

export interface SyncApplyResult {
  received: SyncReceivedCounts;
  totalReceived: number;
  configUpdated: boolean;
}

export interface SyncPeer {
  address: string;
  port: number;
  nonce: string;
  hostname?: string;
  source: "beacon" | "request";
}

export interface SyncRunResult {
  role: "initiator" | "responder";
  peer: SyncPeer;
  received: SyncReceivedCounts;
  totalReceived: number;
  peerReceived?: SyncReceivedCounts;
  peerTotalReceived?: number;
  durationMs: number;
}

export interface SyncRunOptions {
  syncId: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}

interface SyncResponsePayload {
  v: number;
  type: string;
  syncHash: string;
  nonce: string;
  proof: string;
  device: SyncDeviceInfo;
  received: SyncReceivedCounts;
  snapshot: SyncSnapshot;
}

interface SyncRequestPayload {
  v?: number;
  type?: string;
  syncHash?: string;
  nonce?: string;
  proof?: string;
  hostname?: string;
  httpPort?: number;
  snapshot?: SyncSnapshot;
}

interface SyncBeaconPayload {
  v?: number;
  type?: string;
  syncHash?: string;
  nonce?: string;
  port?: number;
  hostname?: string;
  platform?: string;
}

function normalizeSyncId(syncId: string): string {
  return syncId.trim().toLowerCase();
}

export function getSyncIdHash(syncId: string): string {
  return createHash("sha256")
    .update(`wape-sync:${normalizeSyncId(syncId)}`)
    .digest("hex");
}

function getSyncProofForJson(
  syncId: string,
  nonce: string,
  snapshotJson: string,
): string {
  return createHmac("sha256", normalizeSyncId(syncId))
    .update(`${nonce}:${snapshotJson}`)
    .digest("hex");
}

function getSyncProof(
  syncId: string,
  nonce: string,
  snapshot: unknown,
): string {
  return getSyncProofForJson(syncId, nonce, JSON.stringify(snapshot));
}

function syncProofsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function getConfigSnapshot(): SyncConfigSnapshot {
  const config = getAppConfig();
  const file = getWapeConfigFile();
  let updatedAt = config.updatedAt ?? 0;
  if (!updatedAt && existsSync(file)) {
    try {
      updatedAt = Math.floor(statSync(file).mtimeMs);
    } catch {
      updatedAt = 0;
    }
  }
  return { config, updatedAt };
}

const PORTABLE_LISTS_PREFIX = "wape://lists/";
const PORTABLE_HOME_PREFIX = "wape://home/";
const PORTABLE_USERHOME_PREFIX = "wape://userhome/";

function encodePortablePath(path: string): string {
  return path.split(sep).join("/");
}

function decodePortablePath(path: string): string {
  return path.split("/").join(sep);
}

function toPortableComparisonKey(targetsKey: string): string {
  const listsPrefix = `${getWapeListsDir().toLowerCase()}${sep}`;
  const wapePrefix = `${getWapeDir().toLowerCase()}${sep}`;
  const userHomePrefix = `${homedir().toLowerCase()}${sep}`;

  return targetsKey
    .split(":::")
    .map((segment) => {
      if (segment.startsWith(listsPrefix)) {
        return `${PORTABLE_LISTS_PREFIX}${encodePortablePath(segment.slice(listsPrefix.length))}`;
      }
      if (segment.startsWith(wapePrefix)) {
        return `${PORTABLE_HOME_PREFIX}${encodePortablePath(segment.slice(wapePrefix.length))}`;
      }
      if (segment.startsWith(userHomePrefix)) {
        return `${PORTABLE_USERHOME_PREFIX}${encodePortablePath(segment.slice(userHomePrefix.length))}`;
      }
      return segment;
    })
    .sort()
    .join(":::");
}

function fromPortableComparisonKey(targetsKey: string): string {
  const listsDir = getWapeListsDir().toLowerCase();
  const wapeDir = getWapeDir().toLowerCase();
  const userHomeDir = homedir().toLowerCase();

  return targetsKey
    .split(":::")
    .map((segment) => {
      if (segment.startsWith(PORTABLE_LISTS_PREFIX)) {
        return `${listsDir}${sep}${decodePortablePath(segment.slice(PORTABLE_LISTS_PREFIX.length))}`.toLowerCase();
      }
      if (segment.startsWith(PORTABLE_HOME_PREFIX)) {
        return `${wapeDir}${sep}${decodePortablePath(segment.slice(PORTABLE_HOME_PREFIX.length))}`.toLowerCase();
      }
      if (segment.startsWith(PORTABLE_USERHOME_PREFIX)) {
        return `${userHomeDir}${sep}${decodePortablePath(segment.slice(PORTABLE_USERHOME_PREFIX.length))}`.toLowerCase();
      }
      return segment;
    })
    .sort()
    .join(":::");
}

export function createSyncSnapshot(): SyncSnapshot {
  const db = getWapeDb();

  const lists = db
    .query(
      `SELECT name, is_global, created_at, updated_at FROM lists ORDER BY name ASC`,
    )
    .all() as {
    name: string;
    is_global: number;
    created_at: number;
    updated_at: number;
  }[];

  const contacts = db
    .query(`SELECT phone, created_at FROM contacts ORDER BY phone ASC`)
    .all() as { phone: string; created_at: number }[];

  const listContacts = db
    .query(
      `SELECT l.name AS list_name, c.phone AS phone
       FROM list_contacts lc
       JOIN lists l ON l.id = lc.list_id
       JOIN contacts c ON c.id = lc.contact_id
       ORDER BY l.name ASC, c.phone ASC`,
    )
    .all() as { list_name: string; phone: string }[];

  const sources = db
    .query(
      `SELECT type, label, owner_phone, scanned_at FROM sources ORDER BY type ASC, label ASC`,
    )
    .all() as {
    type: string;
    label: string;
    owner_phone: string | null;
    scanned_at: number;
  }[];

  const groups = db
    .query(
      `SELECT s.type AS source_type, s.label AS source_label, g.jid, g.subject, g.community_name
       FROM groups g
       JOIN sources s ON s.id = g.source_id
       ORDER BY s.type ASC, s.label ASC, g.jid ASC`,
    )
    .all() as {
    source_type: string;
    source_label: string;
    jid: string;
    subject: string;
    community_name: string | null;
  }[];

  const contactGroupSources = db
    .query(
      `SELECT c.phone AS phone, s.type AS source_type, s.label AS source_label, g.jid AS jid
       FROM contact_group_sources cgs
       JOIN contacts c ON c.id = cgs.contact_id
       JOIN groups g ON g.id = cgs.group_id
       JOIN sources s ON s.id = g.source_id
       ORDER BY c.phone ASC, s.type ASC, s.label ASC, g.jid ASC`,
    )
    .all() as {
    phone: string;
    source_type: string;
    source_label: string;
    jid: string;
  }[];

  const rooms = db
    .query(
      `SELECT id, name, target_list, created_at, updated_at FROM rooms ORDER BY id ASC`,
    )
    .all() as {
    id: string;
    name: string | null;
    target_list: string | null;
    created_at: number;
    updated_at: number;
  }[];

  const roomGroups = db
    .query(
      `SELECT room_id, group_id, group_name, sort_order FROM room_groups ORDER BY room_id ASC, sort_order ASC`,
    )
    .all() as {
    room_id: string;
    group_id: string;
    group_name: string;
    sort_order: number;
  }[];

  const savedLinks = db
    .query(`SELECT url, saved_at FROM saved_links ORDER BY url ASC`)
    .all() as { url: string; saved_at: number }[];

  const ignoredGroups = db
    .query(
      `SELECT jid, subject, community_name, ignored_at FROM ignored_groups ORDER BY jid ASC`,
    )
    .all() as {
    jid: string;
    subject: string;
    community_name: string | null;
    ignored_at: number;
  }[];

  const notedComparisons = db
    .query(
      `SELECT targets_key, noted_at FROM noted_comparisons ORDER BY targets_key ASC`,
    )
    .all() as { targets_key: string; noted_at: number }[];

  const notedComparisonContacts = db
    .query(
      `SELECT ncc.targets_key AS targets_key, c.phone AS phone
       FROM noted_comparison_contacts ncc
       JOIN contacts c ON c.id = ncc.contact_id
       ORDER BY ncc.targets_key ASC, c.phone ASC`,
    )
    .all() as { targets_key: string; phone: string }[];

  return {
    version: SYNC_PROTOCOL_VERSION,
    generatedAt: Date.now(),
    device: {
      hostname: hostname(),
      platform: platform(),
      nonce: randomUUID(),
    },
    config: getConfigSnapshot(),
    database: {
      lists: lists.map((row) => ({
        name: row.name,
        isGlobal: Boolean(row.is_global),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      contacts: contacts.map((row) => ({
        phone: row.phone,
        createdAt: row.created_at,
      })),
      listContacts: listContacts.map((row) => ({
        listName: row.list_name,
        phone: row.phone,
      })),
      sources: sources.map((row) => ({
        type: row.type,
        label: row.label,
        ownerPhone: row.owner_phone,
        scannedAt: row.scanned_at,
      })),
      groups: groups.map((row) => ({
        sourceType: row.source_type,
        sourceLabel: row.source_label,
        jid: row.jid,
        subject: row.subject,
        communityName: row.community_name,
      })),
      contactGroupSources: contactGroupSources.map((row) => ({
        phone: row.phone,
        sourceType: row.source_type,
        sourceLabel: row.source_label,
        jid: row.jid,
      })),
      rooms: rooms.map((row) => ({
        id: row.id,
        name: row.name,
        targetList: row.target_list,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      roomGroups: roomGroups.map((row) => ({
        roomId: row.room_id,
        groupId: row.group_id,
        groupName: row.group_name,
        sortOrder: row.sort_order,
      })),
      savedLinks: savedLinks.map((row) => ({
        url: row.url,
        savedAt: row.saved_at,
      })),
      ignoredGroups: ignoredGroups.map((row) => ({
        jid: row.jid,
        subject: row.subject,
        communityName: row.community_name,
        ignoredAt: row.ignored_at,
      })),
      notedComparisons: notedComparisons.map((row) => ({
        targetsKey: toPortableComparisonKey(row.targets_key),
        notedAt: row.noted_at,
      })),
      notedComparisonContacts: notedComparisonContacts.map((row) => ({
        targetsKey: toPortableComparisonKey(row.targets_key),
        phone: row.phone,
      })),
    },
  };
}

function sourceKey(type: string, label: string): string {
  return JSON.stringify([type, label]);
}

function groupKey(sourceId: number, jid: string): string {
  return JSON.stringify([sourceId, jid]);
}

function emptyReceivedCounts(): SyncReceivedCounts {
  return {
    lists: 0,
    contacts: 0,
    listContacts: 0,
    sources: 0,
    groups: 0,
    contactGroupSources: 0,
    rooms: 0,
    roomGroups: 0,
    savedLinks: 0,
    ignoredGroups: 0,
    notedComparisons: 0,
    notedComparisonContacts: 0,
    configFields: 0,
  };
}

function mergeNullableText(incoming: string | null, existing: string | null) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return incoming > existing ? incoming : existing;
}

function configFingerprint(config: AppConfig): string {
  return JSON.stringify([
    config.key ?? null,
    config.backupPath ?? null,
    config.defaultCompareRooms ?? null,
  ]);
}

function mergeAppConfigSnapshots(
  local: SyncConfigSnapshot,
  incoming: SyncConfigSnapshot,
): { config: AppConfig; updatedAt: number; changedFields: string[] } {
  const localPreferred =
    local.updatedAt > incoming.updatedAt ||
    (local.updatedAt === incoming.updatedAt &&
      configFingerprint(local.config) >= configFingerprint(incoming.config));
  const preferred = localPreferred ? local.config : incoming.config;
  const fallback = localPreferred ? incoming.config : local.config;
  const merged: AppConfig = { ...local.config };
  const changedFields = new Set<string>();

  const scalarFields = ["key", "backupPath"] as const;
  for (const field of scalarFields) {
    const localValue = local.config[field];
    const incomingValue = incoming.config[field];
    if (localValue === incomingValue) continue;
    if (localValue === undefined) {
      if (incomingValue !== undefined) {
        merged[field] = incomingValue;
        changedFields.add(field);
      }
      continue;
    }
    if (incomingValue !== undefined) {
      const winner = preferred[field] ?? fallback[field];
      if (winner !== undefined && winner !== localValue) {
        merged[field] = winner;
        changedFields.add(field);
      }
    }
  }

  const localRooms = local.config.defaultCompareRooms;
  const incomingRooms = incoming.config.defaultCompareRooms;
  const sameRooms =
    localRooms !== undefined &&
    incomingRooms !== undefined &&
    localRooms.length === incomingRooms.length &&
    localRooms.every((room, index) => room === incomingRooms[index]);
  if (!sameRooms) {
    if (!localRooms) {
      if (incomingRooms) {
        merged.defaultCompareRooms = incomingRooms;
        changedFields.add("defaultCompareRooms");
      }
    } else if (incomingRooms) {
      const winner =
        preferred.defaultCompareRooms ?? fallback.defaultCompareRooms;
      if (winner && winner !== localRooms) {
        merged.defaultCompareRooms = winner;
        changedFields.add("defaultCompareRooms");
      }
    }
  }

  return {
    config: merged,
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    changedFields: Array.from(changedFields),
  };
}

export function applySyncSnapshot(snapshot: SyncSnapshot): SyncApplyResult {
  if (!snapshot || snapshot.version !== SYNC_PROTOCOL_VERSION) {
    throw new Error("Unsupported sync snapshot version.");
  }
  if (!snapshot.database) {
    throw new Error("Sync snapshot is missing database data.");
  }
  if (
    !snapshot.config ||
    typeof snapshot.config.config !== "object" ||
    snapshot.config.config === null ||
    typeof snapshot.config.updatedAt !== "number" ||
    !Number.isFinite(snapshot.config.updatedAt)
  ) {
    throw new Error("Sync snapshot is missing config data.");
  }

  const db = getWapeDb();
  const received = emptyReceivedCounts();
  const incomingDb = snapshot.database;

  db.transaction(() => {
    const now = Date.now();

    const listRows = db
      .query(`SELECT id, name, is_global, created_at, updated_at FROM lists`)
      .all() as {
      id: number;
      name: string;
      is_global: number;
      created_at: number;
      updated_at: number;
    }[];
    const listState = new Map<
      string,
      { id: number; isGlobal: number; createdAt: number; updatedAt: number }
    >();
    for (const row of listRows) {
      listState.set(row.name, {
        id: row.id,
        isGlobal: row.is_global,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    for (const item of incomingDb.lists ?? []) {
      const name = normalizeListName(String(item.name ?? ""));
      if (!name) continue;
      const isGlobal = item.isGlobal ? 1 : 0;
      const createdAt = Number(item.createdAt) || now;
      const updatedAt = Number(item.updatedAt) || now;
      const existing = listState.get(name);

      if (!existing) {
        db.run(
          `INSERT INTO lists (name, is_global, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          [name, isGlobal, createdAt, updatedAt],
        );
        const row = db.query(`SELECT last_insert_rowid() AS id`).get() as {
          id: number;
        };
        listState.set(name, {
          id: row.id,
          isGlobal,
          createdAt,
          updatedAt,
        });
        received.lists++;
        continue;
      }

      const nextIsGlobal = Math.max(existing.isGlobal, isGlobal);
      const nextCreatedAt = Math.min(existing.createdAt, createdAt);
      const nextUpdatedAt = Math.max(existing.updatedAt, updatedAt);
      const semanticChanged = nextIsGlobal !== existing.isGlobal;
      if (
        semanticChanged ||
        nextCreatedAt !== existing.createdAt ||
        nextUpdatedAt !== existing.updatedAt
      ) {
        db.run(
          `UPDATE lists SET is_global = ?, created_at = ?, updated_at = ? WHERE id = ?`,
          [nextIsGlobal, nextCreatedAt, nextUpdatedAt, existing.id],
        );
        existing.isGlobal = nextIsGlobal;
        existing.createdAt = nextCreatedAt;
        existing.updatedAt = nextUpdatedAt;
        if (semanticChanged) received.lists++;
      }
    }

    const contactRows = db
      .query(`SELECT id, phone, created_at FROM contacts`)
      .all() as { id: number; phone: string; created_at: number }[];
    const contactState = new Map<string, { id: number; createdAt: number }>();
    for (const row of contactRows) {
      contactState.set(row.phone, { id: row.id, createdAt: row.created_at });
    }

    const insertContact = db.prepare(
      `INSERT INTO contacts (phone, created_at) VALUES (?, ?)`,
    );
    for (const item of incomingDb.contacts ?? []) {
      const phone = String(item.phone ?? "").trim();
      if (!phone) continue;
      const createdAt = Number(item.createdAt) || now;
      const existing = contactState.get(phone);
      if (existing) {
        if (createdAt < existing.createdAt) {
          db.run(`UPDATE contacts SET created_at = ? WHERE id = ?`, [
            createdAt,
            existing.id,
          ]);
          existing.createdAt = createdAt;
        }
        continue;
      }
      insertContact.run(phone, createdAt);
      const row = db.query(`SELECT last_insert_rowid() AS id`).get() as {
        id: number;
      };
      contactState.set(phone, { id: row.id, createdAt });
      received.contacts++;
    }

    const sourceRows = db
      .query(`SELECT id, type, label, owner_phone, scanned_at FROM sources`)
      .all() as {
      id: number;
      type: string;
      label: string;
      owner_phone: string | null;
      scanned_at: number;
    }[];
    const sourceState = new Map<
      string,
      { id: number; ownerPhone: string | null; scannedAt: number }
    >();
    for (const row of sourceRows) {
      sourceState.set(sourceKey(row.type, row.label), {
        id: row.id,
        ownerPhone: row.owner_phone,
        scannedAt: row.scanned_at,
      });
    }

    for (const item of incomingDb.sources ?? []) {
      const type = String(item.type ?? "").trim();
      const label = String(item.label ?? "").trim();
      if (!type || !label) continue;
      const key = sourceKey(type, label);
      const ownerPhone = item.ownerPhone ?? null;
      const scannedAt = Number(item.scannedAt) || now;
      const existing = sourceState.get(key);

      if (!existing) {
        db.run(
          `INSERT INTO sources (type, label, owner_phone, scanned_at) VALUES (?, ?, ?, ?)`,
          [type, label, ownerPhone, scannedAt],
        );
        const row = db.query(`SELECT last_insert_rowid() AS id`).get() as {
          id: number;
        };
        sourceState.set(key, {
          id: row.id,
          ownerPhone,
          scannedAt,
        });
        received.sources++;
        continue;
      }

      let nextOwnerPhone = existing.ownerPhone;
      if (ownerPhone) {
        if (
          !nextOwnerPhone ||
          scannedAt > existing.scannedAt ||
          (scannedAt === existing.scannedAt && ownerPhone > nextOwnerPhone)
        ) {
          nextOwnerPhone = ownerPhone;
        }
      }
      const nextScannedAt = Math.max(existing.scannedAt, scannedAt);
      if (
        nextOwnerPhone !== existing.ownerPhone ||
        nextScannedAt !== existing.scannedAt
      ) {
        db.run(
          `UPDATE sources SET owner_phone = ?, scanned_at = ? WHERE id = ?`,
          [nextOwnerPhone, nextScannedAt, existing.id],
        );
        existing.ownerPhone = nextOwnerPhone;
        existing.scannedAt = nextScannedAt;
        received.sources++;
      }
    }

    const groupRows = db
      .query(
        `SELECT g.id, g.source_id, g.jid, g.subject, g.community_name, s.type, s.label
         FROM groups g
         JOIN sources s ON s.id = g.source_id`,
      )
      .all() as {
      id: number;
      source_id: number;
      jid: string;
      subject: string;
      community_name: string | null;
      type: string;
      label: string;
    }[];
    const groupState = new Map<
      string,
      { id: number; subject: string; communityName: string | null }
    >();
    for (const row of groupRows) {
      groupState.set(groupKey(row.source_id, row.jid), {
        id: row.id,
        subject: row.subject,
        communityName: row.community_name,
      });
    }

    for (const item of incomingDb.groups ?? []) {
      const jid = String(item.jid ?? "").trim();
      const subject = String(item.subject ?? "").trim();
      if (!jid || !subject) continue;
      const source = sourceState.get(
        sourceKey(
          String(item.sourceType ?? ""),
          String(item.sourceLabel ?? ""),
        ),
      );
      if (!source) continue;

      const key = groupKey(source.id, jid);
      const communityName = mergeNullableText(
        item.communityName ?? null,
        groupState.get(key)?.communityName ?? null,
      );
      const existing = groupState.get(key);

      if (!existing) {
        db.run(
          `INSERT INTO groups (source_id, jid, subject, community_name) VALUES (?, ?, ?, ?)`,
          [source.id, jid, subject, communityName],
        );
        const row = db.query(`SELECT last_insert_rowid() AS id`).get() as {
          id: number;
        };
        groupState.set(key, { id: row.id, subject, communityName });
        received.groups++;
        continue;
      }

      const nextSubject =
        mergeNullableText(subject, existing.subject) ?? subject;
      const nextCommunityName = communityName;
      if (
        nextSubject !== existing.subject ||
        nextCommunityName !== existing.communityName
      ) {
        db.run(
          `UPDATE groups SET subject = ?, community_name = ? WHERE id = ?`,
          [nextSubject, nextCommunityName, existing.id],
        );
        existing.subject = nextSubject;
        existing.communityName = nextCommunityName;
        received.groups++;
      }
    }

    const insertListContact = db.prepare(
      `INSERT OR IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)`,
    );
    for (const item of incomingDb.listContacts ?? []) {
      const listName = normalizeListName(String(item.listName ?? ""));
      const phone = String(item.phone ?? "").trim();
      if (!listName || !phone) continue;
      const list = listState.get(listName);
      const contact = contactState.get(phone);
      if (!list || !contact) continue;
      const result = insertListContact.run(list.id, contact.id);
      if (result.changes > 0) received.listContacts++;
    }

    const insertContactGroupSource = db.prepare(
      `INSERT OR IGNORE INTO contact_group_sources (contact_id, group_id) VALUES (?, ?)`,
    );
    for (const item of incomingDb.contactGroupSources ?? []) {
      const phone = String(item.phone ?? "").trim();
      const jid = String(item.jid ?? "").trim();
      if (!phone || !jid) continue;
      const contact = contactState.get(phone);
      const source = sourceState.get(
        sourceKey(
          String(item.sourceType ?? ""),
          String(item.sourceLabel ?? ""),
        ),
      );
      if (!contact || !source) continue;
      const group = groupState.get(groupKey(source.id, jid));
      if (!group) continue;
      const result = insertContactGroupSource.run(contact.id, group.id);
      if (result.changes > 0) received.contactGroupSources++;
    }

    const roomRows = db
      .query(`SELECT id, name, target_list, created_at, updated_at FROM rooms`)
      .all() as {
      id: string;
      name: string | null;
      target_list: string | null;
      created_at: number;
      updated_at: number;
    }[];
    const roomState = new Map<
      string,
      {
        id: string;
        name: string | null;
        targetList: string | null;
        createdAt: number;
        updatedAt: number;
      }
    >();
    for (const row of roomRows) {
      roomState.set(row.id, {
        id: row.id,
        name: row.name,
        targetList: row.target_list,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    for (const item of incomingDb.rooms ?? []) {
      const id = String(item.id ?? "")
        .trim()
        .toLowerCase();
      if (!id) continue;
      const createdAt = Number(item.createdAt) || now;
      const updatedAt = Number(item.updatedAt) || now;
      const existing = roomState.get(id);

      if (!existing) {
        db.run(
          `INSERT INTO rooms (id, name, target_list, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [id, item.name ?? null, item.targetList ?? id, createdAt, updatedAt],
        );
        roomState.set(id, {
          id,
          name: item.name ?? null,
          targetList: item.targetList ?? id,
          createdAt,
          updatedAt,
        });
        received.rooms++;
        continue;
      }

      const nextCreatedAt = Math.min(existing.createdAt, createdAt);
      const nextUpdatedAt = Math.max(existing.updatedAt, updatedAt);
      let nextName = existing.name;
      let nextTargetList = existing.targetList;

      if (updatedAt > existing.updatedAt) {
        nextName = item.name ?? null;
        nextTargetList = item.targetList ?? id;
      } else if (updatedAt === existing.updatedAt) {
        nextName = mergeNullableText(item.name ?? null, existing.name);
        nextTargetList = mergeNullableText(
          item.targetList ?? null,
          existing.targetList,
        );
      }

      const semanticChanged =
        nextName !== existing.name || nextTargetList !== existing.targetList;
      if (
        semanticChanged ||
        nextCreatedAt !== existing.createdAt ||
        nextUpdatedAt !== existing.updatedAt
      ) {
        db.run(
          `UPDATE rooms SET name = ?, target_list = ?, created_at = ?, updated_at = ? WHERE id = ?`,
          [nextName, nextTargetList, nextCreatedAt, nextUpdatedAt, id],
        );
        existing.name = nextName;
        existing.targetList = nextTargetList;
        existing.createdAt = nextCreatedAt;
        existing.updatedAt = nextUpdatedAt;
        if (semanticChanged) received.rooms++;
      }
    }

    const selectRoomGroup = db.prepare(
      `SELECT id, group_name, sort_order FROM room_groups WHERE room_id = ? AND group_id = ? ORDER BY sort_order ASC LIMIT 1`,
    );
    const insertRoomGroup = db.prepare(
      `INSERT INTO room_groups (room_id, group_id, group_name, sort_order) VALUES (?, ?, ?, ?)`,
    );
    const updateRoomGroup = db.prepare(
      `UPDATE room_groups SET group_name = ?, sort_order = ? WHERE id = ?`,
    );

    for (const item of incomingDb.roomGroups ?? []) {
      const roomId = String(item.roomId ?? "")
        .trim()
        .toLowerCase();
      const groupId = String(item.groupId ?? "").trim();
      if (!roomId || !groupId || !roomState.has(roomId)) continue;
      const groupName = String(item.groupName ?? groupId).trim() || groupId;
      const sortOrder = Number(item.sortOrder) || 0;
      const existing = selectRoomGroup.get(roomId, groupId) as {
        id: number;
        group_name: string;
        sort_order: number;
      } | null;

      if (!existing) {
        insertRoomGroup.run(roomId, groupId, groupName, sortOrder);
        received.roomGroups++;
        continue;
      }

      const incomingTuple = [sortOrder, groupName] as const;
      const existingTuple = [existing.sort_order, existing.group_name] as const;
      if (
        incomingTuple[0] === existingTuple[0] &&
        incomingTuple[1] === existingTuple[1]
      ) {
        continue;
      }
      const incomingWins =
        incomingTuple[0] < existingTuple[0] ||
        (incomingTuple[0] === existingTuple[0] &&
          incomingTuple[1] < existingTuple[1]);
      if (incomingWins) {
        updateRoomGroup.run(groupName, sortOrder, existing.id);
        received.roomGroups++;
      }
    }

    const insertSavedLink = db.prepare(
      `INSERT OR IGNORE INTO saved_links (url, saved_at) VALUES (?, ?)`,
    );
    for (const item of incomingDb.savedLinks ?? []) {
      const url = String(item.url ?? "").trim();
      if (!url) continue;
      const savedAt = Number(item.savedAt) || now;
      const result = insertSavedLink.run(url, savedAt);
      if (result.changes > 0) {
        received.savedLinks++;
      } else {
        db.run(
          `UPDATE saved_links SET saved_at = ? WHERE url = ? AND saved_at > ?`,
          [savedAt, url, savedAt],
        );
      }
    }

    const ignoredRows = db
      .query(
        `SELECT jid, subject, community_name, ignored_at FROM ignored_groups`,
      )
      .all() as {
      jid: string;
      subject: string;
      community_name: string | null;
      ignored_at: number;
    }[];
    const ignoredState = new Map<
      string,
      {
        subject: string;
        communityName: string | null;
        ignoredAt: number;
      }
    >();
    for (const row of ignoredRows) {
      ignoredState.set(row.jid.toLowerCase(), {
        subject: row.subject,
        communityName: row.community_name,
        ignoredAt: row.ignored_at,
      });
    }
    for (const item of incomingDb.ignoredGroups ?? []) {
      const jid = String(item.jid ?? "").trim();
      const subject = String(item.subject ?? "").trim();
      if (!jid || !subject) continue;
      const ignoredAt = Number(item.ignoredAt) || now;
      const key = jid.toLowerCase();
      const existing = ignoredState.get(key);
      if (!existing) {
        db.run(
          `INSERT INTO ignored_groups (jid, subject, community_name, ignored_at) VALUES (?, ?, ?, ?)`,
          [jid, subject, item.communityName ?? null, ignoredAt],
        );
        ignoredState.set(key, {
          subject,
          communityName: item.communityName ?? null,
          ignoredAt,
        });
        received.ignoredGroups++;
        continue;
      }
      const nextSubject =
        mergeNullableText(subject, existing.subject) ?? subject;
      const nextCommunityName = mergeNullableText(
        item.communityName ?? null,
        existing.communityName,
      );
      const nextIgnoredAt = Math.min(existing.ignoredAt, ignoredAt);
      const semanticChanged =
        nextSubject !== existing.subject ||
        nextCommunityName !== existing.communityName;
      if (semanticChanged || nextIgnoredAt !== existing.ignoredAt) {
        db.run(
          `UPDATE ignored_groups SET subject = ?, community_name = ?, ignored_at = ? WHERE LOWER(jid) = ?`,
          [nextSubject, nextCommunityName, nextIgnoredAt, key],
        );
        existing.subject = nextSubject;
        existing.communityName = nextCommunityName;
        existing.ignoredAt = nextIgnoredAt;
        if (semanticChanged) received.ignoredGroups++;
      }
    }

    const notedRows = db
      .query(`SELECT targets_key, noted_at FROM noted_comparisons`)
      .all() as { targets_key: string; noted_at: number }[];
    const notedState = new Map<string, number>();
    for (const row of notedRows) {
      notedState.set(row.targets_key, row.noted_at);
    }
    for (const item of incomingDb.notedComparisons ?? []) {
      const targetsKey = fromPortableComparisonKey(
        String(item.targetsKey ?? "").trim(),
      );
      if (!targetsKey) continue;
      const notedAt = Number(item.notedAt) || now;
      const existing = notedState.get(targetsKey);
      if (existing === undefined) {
        db.run(
          `INSERT INTO noted_comparisons (targets_key, noted_at) VALUES (?, ?)`,
          [targetsKey, notedAt],
        );
        notedState.set(targetsKey, notedAt);
        received.notedComparisons++;
      } else if (notedAt > existing) {
        db.run(
          `UPDATE noted_comparisons SET noted_at = ? WHERE targets_key = ?`,
          [notedAt, targetsKey],
        );
        notedState.set(targetsKey, notedAt);
        received.notedComparisons++;
      }
    }

    const insertNotedContact = db.prepare(
      `INSERT OR IGNORE INTO noted_comparison_contacts (targets_key, contact_id)
       SELECT ?, id FROM contacts WHERE phone = ?`,
    );
    for (const item of incomingDb.notedComparisonContacts ?? []) {
      const targetsKey = fromPortableComparisonKey(
        String(item.targetsKey ?? "").trim(),
      );
      const phone = String(item.phone ?? "").trim();
      if (!targetsKey || !phone || !notedState.has(targetsKey)) continue;
      const result = insertNotedContact.run(targetsKey, phone);
      if (result.changes > 0) received.notedComparisonContacts++;
    }
  })();

  const localConfig = getConfigSnapshot();
  const mergedConfig = mergeAppConfigSnapshots(localConfig, snapshot.config);
  let configUpdated = false;
  if (mergedConfig.changedFields.length > 0) {
    saveAppConfig({
      ...mergedConfig.config,
      updatedAt: mergedConfig.updatedAt,
    });
    configUpdated = true;
    received.configFields = mergedConfig.changedFields.length;
  }

  const totalReceived = Object.values(received).reduce(
    (sum, count) => sum + count,
    0,
  );

  return {
    received,
    totalReceived,
    configUpdated,
  };
}

function getBroadcastAddresses(): string[] {
  const addresses = new Set<string>(["255.255.255.255", "127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.add(entry.address);
      const mask = entry.netmask;
      if (mask && mask !== "255.255.255.255") {
        const broadcast = entry.address
          .split(".")
          .map((part, index) => {
            const maskPart = Number(mask.split(".")[index] ?? "255");
            return String(Number(part) | (~maskPart & 255));
          })
          .join(".");
        addresses.add(broadcast);
      }
    }
  }
  return Array.from(addresses);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_SYNC_PAYLOAD_BYTES) {
      throw new Error("Sync payload is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function startSyncServer(options: {
  syncHash: string;
  syncSecret: string;
  onRequest: (peer: SyncPeer, received: SyncReceivedCounts) => void;
}): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST" || req.url !== "/sync") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        const raw = await readRequestBody(req);
        const payload = JSON.parse(raw.toString("utf-8")) as SyncRequestPayload;

        if (
          payload.v !== SYNC_PROTOCOL_VERSION ||
          payload.type !== "wape-sync-request" ||
          payload.syncHash !== options.syncHash ||
          typeof payload.nonce !== "string" ||
          typeof payload.proof !== "string" ||
          !payload.snapshot ||
          !syncProofsEqual(
            payload.proof,
            getSyncProof(options.syncSecret, payload.nonce, payload.snapshot),
          )
        ) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid sync request" }));
          return;
        }

        const applied = applySyncSnapshot(payload.snapshot);
        const responseSnapshot = createSyncSnapshot();
        const response: SyncResponsePayload = {
          v: SYNC_PROTOCOL_VERSION,
          type: "wape-sync-response",
          syncHash: options.syncHash,
          nonce: payload.nonce,
          proof: getSyncProof(
            options.syncSecret,
            payload.nonce,
            responseSnapshot,
          ),
          device: {
            hostname: hostname(),
            platform: platform(),
            nonce: randomUUID(),
          },
          received: applied.received,
          snapshot: responseSnapshot,
        };

        const peer: SyncPeer = {
          address: req.socket.remoteAddress ?? "unknown",
          port:
            typeof payload.httpPort === "number" && payload.httpPort > 0
              ? payload.httpPort
              : 0,
          nonce: payload.nonce,
          hostname: payload.hostname,
          source: "request",
        };

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response), () => {
          options.onRequest(peer, applied.received);
        });
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function startDiscoverySocket(options: {
  syncHash: string;
  nonce: string;
  httpPort: number;
  onPeer: (peer: SyncPeer) => void;
}): Promise<{ socket: dgram.Socket; stop: () => void }> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const beacon = JSON.stringify({
    v: SYNC_PROTOCOL_VERSION,
    type: "wape-sync-beacon",
    syncHash: options.syncHash,
    nonce: options.nonce,
    port: options.httpPort,
    hostname: hostname(),
    platform: platform(),
  });
  const targets = getBroadcastAddresses();

  socket.on("message", (message, rinfo) => {
    try {
      const payload = JSON.parse(
        message.toString("utf-8"),
      ) as SyncBeaconPayload;
      if (
        payload.v !== SYNC_PROTOCOL_VERSION ||
        payload.type !== "wape-sync-beacon" ||
        payload.syncHash !== options.syncHash ||
        payload.nonce === options.nonce ||
        typeof payload.nonce !== "string" ||
        typeof payload.port !== "number" ||
        payload.port <= 0 ||
        payload.port > 65535
      ) {
        return;
      }
      options.onPeer({
        address: rinfo.address,
        port: payload.port,
        nonce: payload.nonce,
        hostname: payload.hostname,
        source: "beacon",
      });
    } catch {
      // Ignore malformed LAN traffic.
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(SYNC_DISCOVERY_PORT, "0.0.0.0", () => {
      socket.off("error", reject);
      socket.setBroadcast(true);
      resolve();
    });
  });

  const sendBeacon = () => {
    for (const address of targets) {
      socket.send(beacon, SYNC_DISCOVERY_PORT, address, () => {});
    }
  };
  sendBeacon();
  const timer = setInterval(sendBeacon, SYNC_DISCOVERY_INTERVAL_MS);
  timer.unref?.();

  return {
    socket,
    stop: () => {
      clearInterval(timer);
      try {
        socket.close();
      } catch {
        // Ignore close races during shutdown.
      }
    },
  };
}

export async function runWapeSync(
  options: SyncRunOptions,
): Promise<SyncRunResult> {
  const startedAt = Date.now();
  const syncId = normalizeSyncId(options.syncId);
  if (!syncId) {
    throw new Error("Sync ID cannot be empty.");
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const syncHash = getSyncIdHash(syncId);
  const nonce = randomUUID();
  const status = options.onStatus ?? (() => {});

  const peers = new Map<string, SyncPeer>();
  const incomingRequest = createDeferred<{
    peer: SyncPeer;
    received: SyncReceivedCounts;
  }>();
  let roleStarted = false;
  let incomingRequestSettled = false;
  let server: Server | null = null;
  let discovery: { socket: dgram.Socket; stop: () => void } | null = null;
  let httpPort = 0;
  let finish!: (result: SyncRunResult) => void;
  let fail!: (error: unknown) => void;
  const completion = new Promise<SyncRunResult>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const totalReceived = (received: SyncReceivedCounts) =>
    Object.values(received).reduce((sum, count) => sum + count, 0);

  const buildResult = (
    role: SyncRunResult["role"],
    peer: SyncPeer,
    received: SyncReceivedCounts,
    peerReceived?: SyncReceivedCounts,
  ): SyncRunResult => ({
    role,
    peer,
    received,
    totalReceived: totalReceived(received),
    peerReceived,
    peerTotalReceived: peerReceived ? totalReceived(peerReceived) : undefined,
    durationMs: Date.now() - startedAt,
  });

  const actAsResponder = async () => {
    status("Waiting for the other device to send its wape data...");
    const incoming = await incomingRequest.promise;
    finish(buildResult("responder", incoming.peer, incoming.received));
  };

  const actAsInitiator = async (peer: SyncPeer) => {
    status(`Connecting to ${peer.hostname ?? peer.address}...`);
    const snapshot = createSyncSnapshot();
    const snapshotJson = JSON.stringify(snapshot);
    const proof = getSyncProofForJson(syncId, nonce, snapshotJson);
    const body = `{"v":${SYNC_PROTOCOL_VERSION},"type":"wape-sync-request","syncHash":"${syncHash}","nonce":"${nonce}","proof":"${proof}","hostname":${JSON.stringify(hostname())},"httpPort":${httpPort},"snapshot":${snapshotJson}}`;
    const deadline = startedAt + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      try {
        const remaining = Math.max(deadline - Date.now(), 1);
        const response = await fetch(
          `http://${peer.address}:${peer.port}/sync`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(Math.min(remaining, 30_000)),
          },
        );
        if (!response.ok) {
          throw new Error(`Peer returned HTTP ${response.status}`);
        }
        const payload = (await response.json()) as SyncResponsePayload;
        if (
          payload.v !== SYNC_PROTOCOL_VERSION ||
          payload.type !== "wape-sync-response" ||
          payload.syncHash !== syncHash ||
          payload.nonce !== nonce ||
          typeof payload.proof !== "string" ||
          !payload.snapshot ||
          !payload.received ||
          !syncProofsEqual(
            payload.proof,
            getSyncProof(syncId, nonce, payload.snapshot),
          )
        ) {
          throw new Error("Peer returned an invalid sync response.");
        }
        const applied = applySyncSnapshot(payload.snapshot);
        finish(
          buildResult("initiator", peer, applied.received, payload.received),
        );
        return;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    fail(
      lastError instanceof Error
        ? lastError
        : new Error("Timed out waiting for the other wape device."),
    );
  };

  const tryStartRole = () => {
    if (roleStarted) return;
    if (incomingRequestSettled) {
      roleStarted = true;
      void actAsResponder().catch(fail);
      return;
    }
    const peer = Array.from(peers.values()).sort((a, b) =>
      a.nonce.localeCompare(b.nonce),
    )[0];
    if (!peer) return;
    roleStarted = true;
    status(`Found ${peer.hostname ?? peer.address}.`);
    if (nonce < peer.nonce) {
      void actAsInitiator(peer).catch(fail);
    } else {
      void actAsResponder().catch(fail);
    }
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    status("Starting local sync listener...");
    server = await startSyncServer({
      syncHash,
      syncSecret: syncId,
      onRequest: (peer, received) => {
        incomingRequestSettled = true;
        incomingRequest.resolve({ peer, received });
        tryStartRole();
      },
    });
    httpPort = (server.address() as AddressInfo).port;

    status("Searching for wape devices on this network...");
    discovery = await startDiscoverySocket({
      syncHash,
      nonce,
      httpPort,
      onPeer: (peer) => {
        peers.set(`${peer.address}:${peer.nonce}`, peer);
        tryStartRole();
      },
    });

    timeout = setTimeout(() => {
      fail(new Error("Timed out waiting for another wape device."));
    }, timeoutMs);
    timeout.unref?.();

    return await completion;
  } finally {
    if (timeout) clearTimeout(timeout);
    discovery?.stop();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  }
}
