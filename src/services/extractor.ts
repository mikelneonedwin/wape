import { sql } from "drizzle-orm";
import type { AppDatabase } from "../db";
import {
  chats,
  groupParticipantUsers,
  jids,
  messages,
  messageSystemWithGroupNodes,
} from "../db/schema";
import {
  normalizeNigerianPhoneNumber,
  normalizeOwnerPhoneNumber,
} from "./phone";
import { saveRoom, type Room } from "./wape-store";
import { parseDateRange, type ExportFilterOptions } from "./chat-exporter";

export interface GroupSummary {
  jidRowId: number;
  jidString: string;
  subject: string;
  groupType: number;
  communityName: string | null;
  participantCount: number;
}

/**
 * Resolves the parent Community name for a given group chat based on its group_type,
 * direct node relationships, and participant containment in community announcement groups.
 */
export async function fetchAllGroups(db: AppDatabase): Promise<GroupSummary[]> {
  // 1. Query all group chats that have participants and a non-empty subject
  const groupRows = await db
    .select({
      jidRowId: chats.jidRowId,
      jidUser: jids.user,
      jidServer: jids.server,
      jidRawString: jids.rawString,
      subject: chats.subject,
      groupType: chats.groupType,
      participantCount: sql<number>`count(${groupParticipantUsers.id})`.mapWith(
        Number,
      ),
    })
    .from(chats)
    .innerJoin(
      groupParticipantUsers,
      sql`${chats.jidRowId} = ${groupParticipantUsers.groupJidRowId}`,
    )
    .leftJoin(jids, sql`${chats.jidRowId} = ${jids.id}`)
    .where(sql`${chats.subject} IS NOT NULL AND ${chats.subject} != ''`)
    .groupBy(
      chats.jidRowId,
      jids.user,
      jids.server,
      jids.rawString,
      chats.subject,
      chats.groupType,
    )
    .orderBy(sql`${chats.subject} COLLATE NOCASE ASC`);

  // 2. Query community parent / announcement chats (group_type 1 or 3)
  const communityRows = await db
    .select({
      jidRowId: chats.jidRowId,
      subject: chats.subject,
      groupType: chats.groupType,
    })
    .from(chats)
    .where(
      sql`${chats.groupType} IN (1, 3) AND ${chats.subject} IS NOT NULL AND ${chats.subject} != ''`,
    );

  const communityMap = new Map<number, string>();
  for (const comm of communityRows) {
    if (comm.jidRowId !== null && comm.subject) {
      communityMap.set(comm.jidRowId, comm.subject.trim());
    }
  }

  // 3. Query direct parent links from message_system_with_group_nodes if table is present
  const directParentMap = new Map<number, string>();
  try {
    const nodeRows = await db
      .select({
        groupJidRowId: chats.jidRowId,
        parentJidRowId: messageSystemWithGroupNodes.groupJidRowId,
        parentSubject: messageSystemWithGroupNodes.groupSubject,
      })
      .from(messageSystemWithGroupNodes)
      .innerJoin(
        messages,
        sql`${messageSystemWithGroupNodes.messageRowId} = ${messages.id}`,
      )
      .innerJoin(chats, sql`${messages.chatRowId} = ${chats.id}`);

    for (const n of nodeRows) {
      if (
        n.groupJidRowId !== null &&
        n.parentJidRowId !== null &&
        n.groupJidRowId !== n.parentJidRowId
      ) {
        const parentName = (
          n.parentSubject ||
          communityMap.get(n.parentJidRowId) ||
          ""
        ).trim();
        if (parentName) {
          directParentMap.set(n.groupJidRowId, parentName);
        }
      }
    }
  } catch {
    // Graceful fallback if table is not present in older databases
  }

  // 4. Batch query participant memberships to determine community containment
  const allParticipantRows = await db
    .select({
      groupJidRowId: groupParticipantUsers.groupJidRowId,
      userJidRowId: groupParticipantUsers.userJidRowId,
    })
    .from(groupParticipantUsers);

  const groupParticipantsMap = new Map<number, number[]>();
  const communityParticipantsMap = new Map<number, Set<number>>();

  for (const p of allParticipantRows) {
    let gList = groupParticipantsMap.get(p.groupJidRowId);
    if (!gList) {
      gList = [];
      groupParticipantsMap.set(p.groupJidRowId, gList);
    }
    gList.push(p.userJidRowId);

    if (communityMap.has(p.groupJidRowId)) {
      let cSet = communityParticipantsMap.get(p.groupJidRowId);
      if (!cSet) {
        cSet = new Set<number>();
        communityParticipantsMap.set(p.groupJidRowId, cSet);
      }
      cSet.add(p.userJidRowId);
    }
  }

  const validGroups: GroupSummary[] = [];

  for (const g of groupRows) {
    if (g.jidRowId === null || !g.subject || g.participantCount <= 0) {
      continue;
    }

    const groupType = g.groupType ?? 0;
    const cleanSubject = g.subject.trim();
    let communityName: string | null = null;

    if (groupType === 1 || groupType === 3) {
      communityName = cleanSubject;
    } else if (directParentMap.has(g.jidRowId)) {
      communityName = directParentMap.get(g.jidRowId)!;
    } else if (groupType > 0) {
      const participants = groupParticipantsMap.get(g.jidRowId) || [];
      let bestComm: string | null = null;
      let bestScore = 0;
      let bestRatio = 0;

      for (const [commJid, commSet] of communityParticipantsMap.entries()) {
        if (commJid === g.jidRowId) continue;
        let matches = 0;
        for (const p of participants) {
          if (commSet.has(p)) matches++;
        }
        const ratio =
          participants.length > 0 ? matches / participants.length : 0;
        if (
          ratio >= 0.4 &&
          (matches > bestScore || (matches === bestScore && ratio > bestRatio))
        ) {
          bestScore = matches;
          bestRatio = ratio;
          bestComm = communityMap.get(commJid) ?? null;
        }
      }

      communityName = bestComm;
    }

    const jidString =
      g.jidRawString ||
      (g.jidUser && g.jidServer
        ? `${g.jidUser}@${g.jidServer}`
        : `${g.jidRowId}`);

    validGroups.push({
      jidRowId: g.jidRowId,
      jidString,
      subject: cleanSubject,
      groupType,
      communityName,
      participantCount: g.participantCount,
    });
  }

  // Sort groups: grouped by community name (with Standalone at the bottom), then by subject
  validGroups.sort((a, b) => {
    const commA = a.communityName ?? "ZZZ_Standalone";
    const commB = b.communityName ?? "ZZZ_Standalone";
    if (commA !== commB) {
      return commA.localeCompare(commB);
    }
    return a.subject.localeCompare(b.subject, undefined, {
      sensitivity: "base",
    });
  });

  return validGroups;
}

export interface ResolvedRoomGroupItem {
  id: string | number;
  resolvedJidString: string | null;
  resolvedJidRowId: number | null;
  subject: string;
  communityName: string | null;
  participantCount?: number;
  isMissing: boolean;
}

export interface ResolvedRoomResult {
  activeJidRowIds: number[];
  activeJidStrings: string[];
  resolvedItems: ResolvedRoomGroupItem[];
  missingCount: number;
  activeCount: number;
  hasMigrated: boolean;
}

/**
 * Resolves groups within a room against current database groups.
 * Migrates legacy numeric rowIds to globally unique WhatsApp JID strings ('...@g.us')
 * when an exact row+subject match or unique subject match is found.
 * Silently persists upgraded rooms back to ~/.wape/rooms.json.
 */
export function resolveRoomGroups(
  room: Room,
  groups?: GroupSummary[],
): ResolvedRoomResult {
  const ids: (string | number)[] = room.groupIds ?? room.groupJidRowIds ?? [];
  const names = room.groupNames ?? [];

  if (!groups || groups.length === 0) {
    const fallbackItems: ResolvedRoomGroupItem[] = ids.map((id, idx) => ({
      id,
      resolvedJidString: typeof id === "string" ? id : null,
      resolvedJidRowId: typeof id === "number" ? id : null,
      subject: names[idx] || (typeof id === "string" ? id : `JID ${id}`),
      communityName: null,
      isMissing: false,
    }));
    const activeJidRowIds = fallbackItems
      .map((i) => i.resolvedJidRowId)
      .filter((id): id is number => id !== null);
    const activeJidStrings = fallbackItems
      .map((i) => i.resolvedJidString)
      .filter((s): s is string => s !== null);

    return {
      activeJidRowIds,
      activeJidStrings,
      resolvedItems: fallbackItems,
      missingCount: 0,
      activeCount: ids.length,
      hasMigrated: false,
    };
  }

  const groupsByJidString = new Map<string, GroupSummary>();
  const groupsByRowId = new Map<number, GroupSummary>();
  const groupsBySubject = new Map<string, GroupSummary[]>();

  for (const g of groups) {
    if (g.jidString) {
      groupsByJidString.set(g.jidString.toLowerCase(), g);
    }
    groupsByRowId.set(g.jidRowId, g);
    const cleanSub = g.subject.trim().toLowerCase();
    const list = groupsBySubject.get(cleanSub) ?? [];
    list.push(g);
    groupsBySubject.set(cleanSub, list);
  }

  let hasMigrated = false;
  const newGroupIds: (string | number)[] = [...ids];
  const newGroupNames: string[] = [...names];

  const resolvedItems: ResolvedRoomGroupItem[] = [];
  const activeJidRowIds: number[] = [];
  const activeJidStrings: string[] = [];

  for (let idx = 0; idx < ids.length; idx++) {
    const rawId = ids[idx];
    const storedName = names[idx];

    if (typeof rawId === "string") {
      const match = groupsByJidString.get(rawId.toLowerCase());
      if (match) {
        resolvedItems.push({
          id: rawId,
          resolvedJidString: match.jidString,
          resolvedJidRowId: match.jidRowId,
          subject: match.subject,
          communityName: match.communityName,
          participantCount: match.participantCount,
          isMissing: false,
        });
        activeJidRowIds.push(match.jidRowId);
        activeJidStrings.push(match.jidString);
        if (storedName !== match.subject) {
          newGroupNames[idx] = match.subject;
          hasMigrated = true;
        }
      } else {
        resolvedItems.push({
          id: rawId,
          resolvedJidString: rawId,
          resolvedJidRowId: null,
          subject: storedName || rawId,
          communityName: null,
          isMissing: true,
        });
      }
    } else if (typeof rawId === "number") {
      const rowMatch = groupsByRowId.get(rawId);
      const isRowAndSubjectMatch =
        rowMatch &&
        (!storedName ||
          rowMatch.subject.trim().toLowerCase() ===
            storedName.trim().toLowerCase());

      if (isRowAndSubjectMatch && rowMatch) {
        // Reliably resolved via exact row ID and subject match
        resolvedItems.push({
          id: rowMatch.jidString,
          resolvedJidString: rowMatch.jidString,
          resolvedJidRowId: rowMatch.jidRowId,
          subject: rowMatch.subject,
          communityName: rowMatch.communityName,
          participantCount: rowMatch.participantCount,
          isMissing: false,
        });
        activeJidRowIds.push(rowMatch.jidRowId);
        activeJidStrings.push(rowMatch.jidString);

        newGroupIds[idx] = rowMatch.jidString;
        newGroupNames[idx] = rowMatch.subject;
        hasMigrated = true;
      } else {
        // Check unique subject match
        const subjectMatches = storedName
          ? groupsBySubject.get(storedName.trim().toLowerCase())
          : undefined;

        if (
          subjectMatches &&
          subjectMatches.length === 1 &&
          subjectMatches[0]
        ) {
          // Reliably resolved via unique subject match
          const subMatch = subjectMatches[0];
          resolvedItems.push({
            id: subMatch.jidString,
            resolvedJidString: subMatch.jidString,
            resolvedJidRowId: subMatch.jidRowId,
            subject: subMatch.subject,
            communityName: subMatch.communityName,
            participantCount: subMatch.participantCount,
            isMissing: false,
          });
          activeJidRowIds.push(subMatch.jidRowId);
          activeJidStrings.push(subMatch.jidString);

          newGroupIds[idx] = subMatch.jidString;
          newGroupNames[idx] = subMatch.subject;
          hasMigrated = true;
        } else if (rowMatch) {
          // Ambiguous / unreliably resolved: keep rowId as number, do not migrate ID
          resolvedItems.push({
            id: rawId,
            resolvedJidString: null,
            resolvedJidRowId: rowMatch.jidRowId,
            subject: storedName || rowMatch.subject,
            communityName: rowMatch.communityName,
            participantCount: rowMatch.participantCount,
            isMissing: false,
          });
          activeJidRowIds.push(rowMatch.jidRowId);
        } else {
          // Missing
          resolvedItems.push({
            id: rawId,
            resolvedJidString: null,
            resolvedJidRowId: null,
            subject: storedName || `JID ${rawId}`,
            communityName: null,
            isMissing: true,
          });
        }
      }
    }
  }

  if (hasMigrated) {
    room.groupIds = newGroupIds;
    room.groupJidRowIds = newGroupIds;
    room.groupNames = newGroupNames;
    saveRoom(room);
  }

  const missingCount = resolvedItems.filter((i) => i.isMissing).length;
  const activeCount = resolvedItems.length - missingCount;

  return {
    activeJidRowIds,
    activeJidStrings,
    resolvedItems,
    missingCount,
    activeCount,
    hasMigrated,
  };
}

export async function detectWhatsAppOwnerPhone(
  db: AppDatabase,
): Promise<string | null> {
  // 1. WhatsApp JID type 11 (JID_TYPE_USER_SELF)
  try {
    const selfJidRows = await db
      .select({
        user: jids.user,
        server: jids.server,
      })
      .from(jids)
      .where(sql`${jids.type} = 11 AND ${jids.server} = 's.whatsapp.net'`)
      .limit(1);

    if (selfJidRows.length > 0 && selfJidRows[0]?.user) {
      const normalized = normalizeOwnerPhoneNumber(selfJidRows[0].user);
      if (normalized) return normalized;
    }
  } catch {
    // Graceful fallback if type column doesn't exist
  }

  // 2. Props table fallback (registration_jid / my_jid)
  try {
    const row = db.$client
      .query<{ value: string }, []>(
        `SELECT value FROM props WHERE key IN ('my_jid', 'registration_jid') LIMIT 1`,
      )
      .get();
    if (row?.value) {
      const val = String(row.value);
      const userPart = val.split("@")[0] || val;
      const normalized = normalizeOwnerPhoneNumber(userPart);
      if (normalized) return normalized;
    }
  } catch {
    // Props table might not exist
  }

  // 3. Settings table fallback (backup_user_jid)
  try {
    const row = db.$client
      .query<{ value: string }, []>(
        `SELECT value FROM settings WHERE key = 'backup_user_jid' LIMIT 1`,
      )
      .get();
    if (row?.value) {
      const val = String(row.value);
      const userPart = val.split("@")[0] || val;
      const normalized = normalizeOwnerPhoneNumber(userPart);
      if (normalized) return normalized;
    }
  } catch {
    // Settings table might not exist
  }

  return null;
}

export interface GroupProvenanceExtraction {
  uniqueNigerianNumbers: Set<string>;
  groupPhonesMap: Map<number, Set<string>>;
}

export async function extractNigerianNumbersWithGroupMapping(
  db: AppDatabase,
  groupJidRowIds: number[],
): Promise<GroupProvenanceExtraction> {
  if (groupJidRowIds.length === 0) {
    return {
      uniqueNigerianNumbers: new Set<string>(),
      groupPhonesMap: new Map<number, Set<string>>(),
    };
  }

  const uniqueNigerianNumbers = new Set<string>();
  const groupPhonesMap = new Map<number, Set<string>>();

  for (const id of groupJidRowIds) {
    groupPhonesMap.set(id, new Set<string>());
  }

  const sqliteDb = db.$client;

  if (groupJidRowIds.length > 0) {
    const placeholders = groupJidRowIds.map(() => "?").join(",");
    const query = `
      SELECT 
        gpu.group_jid_row_id as groupJidRowId,
        j.user as user,
        j.server as server,
        pj.user as phoneUser,
        pj.server as phoneServer
      FROM group_participant_user gpu
      LEFT JOIN jid j ON gpu.user_jid_row_id = j._id
      LEFT JOIN jid_map jm ON j._id = jm.lid_row_id
      LEFT JOIN jid pj ON jm.jid_row_id = pj._id
      WHERE gpu.group_jid_row_id IN (${placeholders})

      UNION ALL

      SELECT 
        gpu.group_jid_row_id as groupJidRowId,
        j.user as user,
        j.server as server,
        pj.user as phoneUser,
        pj.server as phoneServer
      FROM group_past_participant_user gpu
      LEFT JOIN jid j ON gpu.user_jid_row_id = j._id
      LEFT JOIN jid_map jm ON j._id = jm.lid_row_id
      LEFT JOIN jid pj ON jm.jid_row_id = pj._id
      WHERE gpu.group_jid_row_id IN (${placeholders})
    `;

    try {
      const rows = sqliteDb
        .query(query)
        .all(...groupJidRowIds, ...groupJidRowIds) as {
        groupJidRowId: number;
        user: string | null;
        server: string | null;
        phoneUser: string | null;
        phoneServer: string | null;
      }[];

      for (const row of rows) {
        let candidateNumber: string | null = null;
        if (row.server === "s.whatsapp.net" && row.user) {
          candidateNumber = row.user;
        } else if (row.phoneServer === "s.whatsapp.net" && row.phoneUser) {
          candidateNumber = row.phoneUser;
        }

        if (candidateNumber) {
          const normalized = normalizeNigerianPhoneNumber(candidateNumber);
          if (normalized) {
            uniqueNigerianNumbers.add(normalized);
            let gSet = groupPhonesMap.get(row.groupJidRowId);
            if (!gSet) {
              gSet = new Set<string>();
              groupPhonesMap.set(row.groupJidRowId, gSet);
            }
            gSet.add(normalized);
          }
        }
      }
    } catch {
      // Graceful fallback if group_past_participant_user or other tables are not fully present in older databases
      // We will run the query without the UNION ALL
      const fallbackQuery = `
        SELECT 
          gpu.group_jid_row_id as groupJidRowId,
          j.user as user,
          j.server as server,
          pj.user as phoneUser,
          pj.server as phoneServer
        FROM group_participant_user gpu
        LEFT JOIN jid j ON gpu.user_jid_row_id = j._id
        LEFT JOIN jid_map jm ON j._id = jm.lid_row_id
        LEFT JOIN jid pj ON jm.jid_row_id = pj._id
        WHERE gpu.group_jid_row_id IN (${placeholders})
      `;
      try {
        const rows = sqliteDb.query(fallbackQuery).all(...groupJidRowIds) as {
          groupJidRowId: number;
          user: string | null;
          server: string | null;
          phoneUser: string | null;
          phoneServer: string | null;
        }[];
        for (const row of rows) {
          let candidateNumber: string | null = null;
          if (row.server === "s.whatsapp.net" && row.user) {
            candidateNumber = row.user;
          } else if (row.phoneServer === "s.whatsapp.net" && row.phoneUser) {
            candidateNumber = row.phoneUser;
          }

          if (candidateNumber) {
            const normalized = normalizeNigerianPhoneNumber(candidateNumber);
            if (normalized) {
              uniqueNigerianNumbers.add(normalized);
              let gSet = groupPhonesMap.get(row.groupJidRowId);
              if (!gSet) {
                gSet = new Set<string>();
                groupPhonesMap.set(row.groupJidRowId, gSet);
              }
              gSet.add(normalized);
            }
          }
        }
      } catch (err) {
        console.error("Extraction fallback query failed:", err);
      }
    }
  }

  return { uniqueNigerianNumbers, groupPhonesMap };
}

export async function extractNigerianNumbersFromGroups(
  db: AppDatabase,
  groupJidRowIds: number[],
): Promise<Set<string>> {
  const result = await extractNigerianNumbersWithGroupMapping(
    db,
    groupJidRowIds,
  );
  return result.uniqueNigerianNumbers;
}

/**
 * Normalizes and cleans a WhatsApp group invite link, stripping any search parameters.
 */
export function normalizeWhatsAppGroupLink(raw: string): string | null {
  const match = /(?:https?:\/\/)?chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/i.exec(
    raw,
  );
  if (!match || !match[1]) return null;
  return `https://chat.whatsapp.com/${match[1]}`;
}

/**
 * Extracts all unique WhatsApp group invite links from all messages in the database,
 * optionally filtered by date/time and limited to the last N newest links,
 * cleaned of search parameters and sorted alphabetically.
 */
export async function extractWhatsAppGroupLinks(
  db: AppDatabase,
  filterOpts?: ExportFilterOptions,
): Promise<string[]> {
  let sql = `SELECT text_data as textData FROM message WHERE text_data LIKE '%chat.whatsapp.com%'`;
  const params: (number | string)[] = [];

  if (filterOpts) {
    const { startTime, endTime } = parseDateRange(filterOpts);
    if (startTime !== undefined) {
      sql += ` AND timestamp >= ?`;
      params.push(startTime);
    }
    if (endTime !== undefined) {
      sql += ` AND timestamp <= ?`;
      params.push(endTime);
    }
  }

  sql += ` ORDER BY timestamp DESC, _id DESC`;

  const messageRows = db.$client.query(sql).all(...params) as {
    textData: string | null;
  }[];

  const uniqueLinks = new Set<string>();
  const linkRegex = /(?:https?:\/\/)?chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/gi;

  const lastLimit = filterOpts?.last
    ? typeof filterOpts.last === "string"
      ? parseInt(filterOpts.last, 10)
      : filterOpts.last
    : undefined;

  for (const row of messageRows) {
    if (!row.textData) continue;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(row.textData)) !== null) {
      if (match[1]) {
        uniqueLinks.add(`https://chat.whatsapp.com/${match[1]}`);
        if (
          lastLimit !== undefined &&
          lastLimit > 0 &&
          uniqueLinks.size >= lastLimit
        ) {
          break;
        }
      }
    }
    if (
      lastLimit !== undefined &&
      lastLimit > 0 &&
      uniqueLinks.size >= lastLimit
    ) {
      break;
    }
  }

  return Array.from(uniqueLinks).sort((a, b) => a.localeCompare(b));
}
