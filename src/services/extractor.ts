import { inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../db";
import { chats, groupParticipantUsers } from "../db/schema";
import { normalizeNigerianPhoneNumber } from "./phone";

export interface GroupSummary {
  jidRowId: number;
  subject: string;
  groupType: number;
  communityName: string | null;
  participantCount: number;
}

/**
 * Resolves the parent Community name for a given group chat based on its group_type and naming context.
 */
export function resolveCommunityName(subject: string, groupType: number): string | null {
  if (groupType === 0) return null; // Standalone group

  const s = subject.toLowerCase();

  if (s.includes("gdg")) return "GDG On Campus Uniuyo";
  if (s.includes("notion")) return "Notion@UNIUYO";
  if (s.includes("squad") || s.includes("hackathon")) return "Squad Hackathon 3.0";
  if (s.includes("cowrywise")) return "Cowrywise UNIUYO";
  if (s.includes("superteam")) return "Superteam UNIUYO";
  if (s.includes("cardano") || s.includes("ucscn")) return "Unified Cardano Student Club (UCSCN)";
  if (s.includes("aws") || s.includes("cloud club")) return "AWS Cloud Club UNIUYO";
  if (s.includes("socsc")) return "SOCSC UNIUYO";
  if (s.includes("focosa")) return "FOCOSA Software Community";
  if (s.includes("nacos 22/23") || s.includes("docossa 022") || s.includes("docossa-nacos 0’22")) return "DOCOSSA-NACOS 0’22/0’23";
  if (s.includes("o25 series")) return "O25 Series NACOS UNIUYO";
  if (
    s.includes("024 series") ||
    s.includes("cos121") ||
    s.includes("cos 121") ||
    s.includes("csc111") ||
    s.includes("group 1") ||
    s.includes("group 2") ||
    s.includes("group 3") ||
    s.includes("group 4") ||
    s.includes("group 5") ||
    s.includes("group 6") ||
    s.includes("group 7") ||
    s.includes("group 8") ||
    s.includes("group 9") ||
    s.includes("group 10") ||
    s.includes("cyber security dept 024") ||
    s.includes("data science dept 024") ||
    s.includes("information systems '024")
  ) {
    return "'024 Series Computing Community";
  }
  if (s.includes("nacos")) return "NACOS UNIUYO Chapter";
  if (s.includes("directorate of information")) return "Directorate of Information & PR, SUG";
  if (s.includes("ontology project")) return "ONTOLOGY PROJECT";
  if (s.includes("square one")) return "SQUARE ONE";

  return "Community Subgroups";
}

export async function fetchAllGroups(db: AppDatabase): Promise<GroupSummary[]> {
  // Query all group chats that have participants and a non-empty subject
  const groupRows = await db
    .select({
      jidRowId: chats.jidRowId,
      subject: chats.subject,
      groupType: chats.groupType,
      participantCount: sql<number>`count(${groupParticipantUsers.id})`.mapWith(Number),
    })
    .from(chats)
    .innerJoin(groupParticipantUsers, sql`${chats.jidRowId} = ${groupParticipantUsers.groupJidRowId}`)
    .where(sql`${chats.subject} IS NOT NULL AND ${chats.subject} != ''`)
    .groupBy(chats.jidRowId, chats.subject, chats.groupType)
    .orderBy(sql`${chats.subject} COLLATE NOCASE ASC`);

  const validGroups: GroupSummary[] = [];

  for (const g of groupRows) {
    if (g.jidRowId !== null && g.subject !== null && g.participantCount > 0) {
      const groupType = g.groupType ?? 0;
      const communityName = resolveCommunityName(g.subject, groupType);
      validGroups.push({
        jidRowId: g.jidRowId,
        subject: g.subject,
        groupType,
        communityName,
        participantCount: g.participantCount,
      });
    }
  }

  // Sort groups: grouped by community name (with Standalone at the bottom), then by subject
  validGroups.sort((a, b) => {
    const commA = a.communityName ?? "ZZZ_Standalone";
    const commB = b.communityName ?? "ZZZ_Standalone";
    if (commA !== commB) {
      return commA.localeCompare(commB);
    }
    return a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" });
  });

  return validGroups;
}

export async function extractNigerianNumbersFromGroups(
  db: AppDatabase,
  groupJidRowIds: number[]
): Promise<Set<string>> {
  if (groupJidRowIds.length === 0) {
    return new Set<string>();
  }

  const participants = await db.query.groupParticipantUsers.findMany({
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

  const uniqueNigerianNumbers = new Set<string>();

  for (const participant of participants) {
    const userJid = participant.userJid;
    if (!userJid) continue;

    let candidateNumber: string | null = null;

    if (userJid.server === "s.whatsapp.net" && userJid.user) {
      candidateNumber = userJid.user;
    } else if (userJid.lidToPhoneMap?.phoneJid?.server === "s.whatsapp.net" && userJid.lidToPhoneMap.phoneJid.user) {
      candidateNumber = userJid.lidToPhoneMap.phoneJid.user;
    }

    if (candidateNumber) {
      const normalized = normalizeNigerianPhoneNumber(candidateNumber);
      if (normalized) {
        uniqueNigerianNumbers.add(normalized);
      }
    }
  }

  return uniqueNigerianNumbers;
}
