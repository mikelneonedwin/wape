import { inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../db";
import {
  chats,
  groupParticipantUsers,
  groupPastParticipantUsers,
  messages,
  messageSystemWithGroupNodes,
} from "../db/schema";
import { normalizeNigerianPhoneNumber } from "./phone";

export interface GroupSummary {
  jidRowId: number;
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
    .where(sql`${chats.subject} IS NOT NULL AND ${chats.subject} != ''`)
    .groupBy(chats.jidRowId, chats.subject, chats.groupType)
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

    validGroups.push({
      jidRowId: g.jidRowId,
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

export async function extractNigerianNumbersFromGroups(
  db: AppDatabase,
  groupJidRowIds: number[],
): Promise<Set<string>> {
  if (groupJidRowIds.length === 0) {
    return new Set<string>();
  }

  const uniqueNigerianNumbers = new Set<string>();

  const processParticipant = (participant: {
    userJid?: {
      server: string;
      user: string;
      lidToPhoneMap?: {
        phoneJid?: {
          server: string;
          user: string;
        } | null;
      } | null;
    } | null;
  }) => {
    const userJid = participant.userJid;
    if (!userJid) return;

    let candidateNumber: string | null = null;

    if (userJid.server === "s.whatsapp.net" && userJid.user) {
      candidateNumber = userJid.user;
    } else if (
      userJid.lidToPhoneMap?.phoneJid?.server === "s.whatsapp.net" &&
      userJid.lidToPhoneMap.phoneJid.user
    ) {
      candidateNumber = userJid.lidToPhoneMap.phoneJid.user;
    }

    if (candidateNumber) {
      const normalized = normalizeNigerianPhoneNumber(candidateNumber);
      if (normalized) {
        uniqueNigerianNumbers.add(normalized);
      }
    }
  };

  const currentParticipants = await db.query.groupParticipantUsers.findMany({
    where: inArray(groupParticipantUsers.groupJidRowId, groupJidRowIds),
    with: {
      userJid: {
        with: {
          lidToPhoneMap: {
            with: {
              phoneJid: true,
            },
          },
        },
      },
    },
  });

  for (const participant of currentParticipants) {
    processParticipant(participant);
  }

  try {
    const pastParticipants = await db.query.groupPastParticipantUsers.findMany({
      where: inArray(groupPastParticipantUsers.groupJidRowId, groupJidRowIds),
      with: {
        userJid: {
          with: {
            lidToPhoneMap: {
              with: {
                phoneJid: true,
              },
            },
          },
        },
      },
    });

    for (const participant of pastParticipants) {
      processParticipant(participant);
    }
  } catch {
    // Graceful fallback if group_past_participant_user table is not present in older databases
  }

  return uniqueNigerianNumbers;
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
 * cleaned of search parameters and sorted alphabetically.
 */
export async function extractWhatsAppGroupLinks(
  db: AppDatabase,
): Promise<string[]> {
  const messageRows = await db.query.messages.findMany({
    where: sql`${messages.textData} LIKE '%chat.whatsapp.com%'`,
    columns: {
      textData: true,
    },
  });

  const uniqueLinks = new Set<string>();
  const linkRegex = /(?:https?:\/\/)?chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/gi;

  for (const row of messageRows) {
    if (!row.textData) continue;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(row.textData)) !== null) {
      if (match[1]) {
        uniqueLinks.add(`https://chat.whatsapp.com/${match[1]}`);
      }
    }
  }

  return Array.from(uniqueLinks).sort((a, b) => a.localeCompare(b));
}
