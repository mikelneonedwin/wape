import type { AppDatabase } from "../db";
import { normalizeNigerianPhoneNumber } from "./phone";

export interface ExportFilterOptions {
  since?: string;
  from?: string | string[];
  to?: string;
  lastMonth?: boolean;
  last?: number | string;
}

export interface ChatMessage {
  id: number;
  chatRowId: number;
  fromMe: boolean;
  timestamp: number;
  textData: string;
  senderNameOrPhone: string;
}

export interface ResolvedChat {
  chatId: number;
  subject: string | null;
  phone: string | null;
  username: string | null;
  isGroup: boolean;
}

export interface SearchMessageResult {
  messageId: number;
  chatId: number;
  groupName: string;
  senderDisplay: string;
  timestamp: number;
  textData: string;
}

/**
 * Parses time-filter options into start and end millisecond timestamps.
 */
export function parseDateRange(
  opts: ExportFilterOptions,
  nowMs: number = Date.now(),
): {
  startTime?: number;
  endTime?: number;
} {
  let startTime: number | undefined;
  let endTime: number | undefined;

  if (opts.lastMonth) {
    const nowDate = new Date(nowMs);
    const firstDayLastMonth = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth() - 1,
      1,
      0,
      0,
      0,
      0,
    );
    const lastDayLastMonth = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      0,
      23,
      59,
      59,
      999,
    );
    startTime = firstDayLastMonth.getTime();
    endTime = lastDayLastMonth.getTime();
  }

  if (opts.since) {
    const match =
      /^(\d+)\s*([mhdwy]|min|mins|minute|minutes|hour|hours|day|days|week|weeks|year|years)?$/i.exec(
        opts.since.trim(),
      );
    if (!match || !match[1]) {
      throw new Error(
        `Invalid --since duration format: '${opts.since}'. Expected formats like '30m', '3d', '1w', '2h'.`,
      );
    }
    const val = parseInt(match[1], 10);
    const unit = (match[2] || "m").toLowerCase();

    let durationMs: number;
    if (unit.startsWith("m") && !unit.startsWith("mo")) {
      durationMs = val * 60 * 1000;
    } else if (unit.startsWith("h")) {
      durationMs = val * 60 * 60 * 1000;
    } else if (unit.startsWith("d")) {
      durationMs = val * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("w")) {
      durationMs = val * 7 * 24 * 60 * 60 * 1000;
    } else if (unit.startsWith("y")) {
      durationMs = val * 365 * 24 * 60 * 60 * 1000;
    } else {
      durationMs = val * 60 * 1000;
    }

    startTime = nowMs - durationMs;
  }

  if (opts.from) {
    // Support both string and array forms. The array form comes from
    // Commander's variadic --from <dates...> and allows inline "to":
    //   --from 2020-10-01 to 2020-10-30
    // which Commander delivers as ["2020-10-01", "to", "2020-10-30"].
    let fromDate: string;
    let inlineTo: string | undefined;

    if (Array.isArray(opts.from)) {
      fromDate = opts.from[0] ?? "";
      if (
        opts.from.length === 3 &&
        opts.from[1]?.toLowerCase() === "to" &&
        opts.from[2]
      ) {
        inlineTo = opts.from[2];
      }
    } else {
      fromDate = opts.from;
    }

    const parsed = new Date(fromDate.trim());
    if (isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid --from date: '${fromDate}'. Expected format YYYY-MM-DD.`,
      );
    }
    startTime = parsed.getTime();

    // Inline "to" sets endTime only when no explicit --to flag was provided
    if (inlineTo && !opts.to) {
      const parsedTo = new Date(inlineTo.trim());
      if (isNaN(parsedTo.getTime())) {
        throw new Error(
          `Invalid inline to date: '${inlineTo}'. Expected format YYYY-MM-DD.`,
        );
      }
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(inlineTo.trim())) {
        parsedTo.setHours(23, 59, 59, 999);
      }
      endTime = parsedTo.getTime();
    }
  }

  if (opts.to) {
    const parsed = new Date(opts.to.trim());
    if (isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid --to date: '${opts.to}'. Expected format YYYY-MM-DD.`,
      );
    }
    // If only date is provided (YYYY-MM-DD), set to end of that day
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(opts.to.trim())) {
      parsed.setHours(23, 59, 59, 999);
    }
    endTime = parsed.getTime();
  }

  return { startTime, endTime };
}

/**
 * Normalizes a raw phone number (e.g. 2348076488738 or +2348076488738) into a national format "08076488738"
 * or fallback string.
 */
export function formatSenderPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const normalized = normalizeNigerianPhoneNumber(raw);
  if (normalized && normalized.startsWith("+234") && normalized.length === 14) {
    return `0${normalized.slice(4)}`;
  }
  return raw;
}

export interface ResolveChatOptions {
  fuzzy?: boolean;
  allowedJidRowIds?: Set<number>;
}

/**
 * Finds matching chats from user query (phone number, contact name/username, group subject, or chat/JID identifier).
 */
export async function findMatchingChats(
  db: AppDatabase,
  targetQuery: string,
  options?: ResolveChatOptions,
): Promise<ResolvedChat[]> {
  const query = targetQuery.trim();
  if (!query) return [];

  const fuzzy = Boolean(options?.fuzzy);
  const digitsOnly = query.replace(/\D/g, "");
  const results: ResolvedChat[] = [];
  const seenChatIds = new Set<number>();

  const addResult = (row: {
    chatId: number;
    subject: string | null;
    phone: string | null;
    username: string | null;
    groupType: number | null;
    jidRowId?: number | null;
  }) => {
    if (seenChatIds.has(row.chatId)) return;
    if (
      options?.allowedJidRowIds &&
      row.jidRowId !== undefined &&
      row.jidRowId !== null &&
      !options.allowedJidRowIds.has(row.jidRowId)
    ) {
      return;
    }
    seenChatIds.add(row.chatId);
    results.push({
      chatId: row.chatId,
      subject: row.subject,
      phone: row.phone,
      username: row.username,
      isGroup: Boolean(row.subject || (row.groupType && row.groupType > 0)),
    });
  };

  // 1. Direct group / contact JID string match (e.g. 12036304...8@g.us or ...@s.whatsapp.net)
  if (query.includes("@")) {
    const jidRows = db.$client
      .query<
        {
          chatId: number;
          subject: string | null;
          phone: string | null;
          username: string | null;
          groupType: number | null;
          jidRowId: number | null;
        },
        [string, string]
      >(
        `
        SELECT 
          c._id as chatId,
          c.subject as subject,
          pj.user as phone,
          ldn.username as username,
          c.group_type as groupType,
          c.jid_row_id as jidRowId
        FROM chat c
        JOIN jid j ON c.jid_row_id = j._id
        LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
        LEFT JOIN jid pj ON jm.jid_row_id = pj._id
        LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
        WHERE j.raw_string = ? COLLATE NOCASE OR (j.user || '@' || j.server) = ? COLLATE NOCASE
      `,
      )
      .all(query, query);

    jidRows.forEach(addResult);
    if (results.length > 0) return results;
  }

  // 2. Exact match by chat subject / group name (case-insensitive)
  const exactSubjectRows = db.$client
    .query<
      {
        chatId: number;
        subject: string | null;
        phone: string | null;
        username: string | null;
        groupType: number | null;
        jidRowId: number | null;
      },
      [string]
    >(
      `
      SELECT 
        c._id as chatId,
        c.subject as subject,
        pj.user as phone,
        ldn.username as username,
        c.group_type as groupType,
        c.jid_row_id as jidRowId
      FROM chat c
      LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
      LEFT JOIN jid pj ON jm.jid_row_id = pj._id
      LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
      WHERE c.subject = ? COLLATE NOCASE
    `,
    )
    .all(query);

  exactSubjectRows.forEach(addResult);
  if (!fuzzy && results.length > 0) {
    return results;
  }

  // 3. Exact match by contact username
  const exactUsernameRows = db.$client
    .query<
      {
        chatId: number;
        subject: string | null;
        phone: string | null;
        username: string | null;
        groupType: number | null;
        jidRowId: number | null;
      },
      [string]
    >(
      `
      SELECT 
        c._id as chatId,
        c.subject as subject,
        pj.user as phone,
        ldn.username as username,
        c.group_type as groupType,
        c.jid_row_id as jidRowId
      FROM chat c
      LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
      LEFT JOIN jid pj ON jm.jid_row_id = pj._id
      LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
      WHERE ldn.username = ? COLLATE NOCASE
    `,
    )
    .all(query);

  exactUsernameRows.forEach(addResult);
  if (!fuzzy && results.length > 0) {
    return results;
  }

  // 4. Exact match by phone number (if digitsOnly)
  if (digitsOnly.length >= 7) {
    const lastDigits = digitsOnly.slice(-10);
    const phoneRows = db.$client
      .query<
        {
          chatId: number;
          subject: string | null;
          phone: string | null;
          username: string | null;
          groupType: number | null;
          jidRowId: number | null;
        },
        [string, string]
      >(
        `
        SELECT 
          c._id as chatId,
          c.subject as subject,
          pj.user as phone,
          ldn.username as username,
          c.group_type as groupType,
          c.jid_row_id as jidRowId
        FROM chat c
        LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
        LEFT JOIN jid pj ON jm.jid_row_id = pj._id
        LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
        WHERE pj.user = ? OR pj.user LIKE ?
      `,
      )
      .all(digitsOnly, `%${lastDigits}`);

    phoneRows.forEach(addResult);
    if (!fuzzy && results.length > 0) {
      return results;
    }
  }

  // 5. If fuzzy matching is enabled, search by substring across subjects and usernames
  if (fuzzy) {
    const fuzzySubjectRows = db.$client
      .query<
        {
          chatId: number;
          subject: string | null;
          phone: string | null;
          username: string | null;
          groupType: number | null;
          jidRowId: number | null;
        },
        [string]
      >(
        `
        SELECT 
          c._id as chatId,
          c.subject as subject,
          pj.user as phone,
          ldn.username as username,
          c.group_type as groupType,
          c.jid_row_id as jidRowId
        FROM chat c
        LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
        LEFT JOIN jid pj ON jm.jid_row_id = pj._id
        LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
        WHERE c.subject LIKE ? COLLATE NOCASE
      `,
      )
      .all(`%${query}%`);

    fuzzySubjectRows.forEach(addResult);

    const fuzzyUsernameRows = db.$client
      .query<
        {
          chatId: number;
          subject: string | null;
          phone: string | null;
          username: string | null;
          groupType: number | null;
          jidRowId: number | null;
        },
        [string]
      >(
        `
        SELECT 
          c._id as chatId,
          c.subject as subject,
          pj.user as phone,
          ldn.username as username,
          c.group_type as groupType,
          c.jid_row_id as jidRowId
        FROM chat c
        LEFT JOIN jid_map jm ON c.jid_row_id = jm.lid_row_id
        LEFT JOIN jid pj ON jm.jid_row_id = pj._id
        LEFT JOIN lid_display_name ldn ON c.jid_row_id = ldn.lid_row_id
        WHERE ldn.username LIKE ? COLLATE NOCASE
      `,
      )
      .all(`%${query}%`);

    fuzzyUsernameRows.forEach(addResult);
  }

  return results;
}

/**
 * Finds target chat from user query (phone number, contact name/username, group subject, or chat ID).
 */
export async function resolveTargetChat(
  db: AppDatabase,
  targetQuery: string,
  options?: ResolveChatOptions,
): Promise<ResolvedChat | null> {
  const matches = await findMatchingChats(db, targetQuery, options);
  return matches[0] ?? null;
}

/**
 * Formats a timestamp into WhatsApp copy header date/time "[DD/MM, HH:mm]"
 */
export function formatWhatsAppTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `[${day}/${month}, ${hours}:${minutes}]`;
}

/**
 * Formats a list of messages into the standard WhatsApp copied chat text.
 */
export function formatExportedChat(messages: ChatMessage[]): string {
  return messages
    .map(
      (m) =>
        `${formatWhatsAppTimestamp(m.timestamp)} ${m.senderNameOrPhone}: ${m.textData}`,
    )
    .join("\n");
}

/**
 * Extracts chat messages from a resolved chat applying date/time range filters.
 */
export async function exportChatMessages(
  db: AppDatabase,
  resolvedChat: ResolvedChat,
  filterOpts: ExportFilterOptions,
): Promise<{ text: string; messageCount: number }> {
  const { startTime, endTime } = parseDateRange(filterOpts);

  // Retrieve owner push name or phone for from_me messages
  const ownerPushNameRow = db.$client
    .query<{ value: string }, []>(
      `SELECT value FROM props WHERE key = 'user_push_name' LIMIT 1`,
    )
    .get();
  const ownerName = ownerPushNameRow?.value?.trim() || "You";

  let sqlQuery = `
    SELECT 
      m._id as id,
      m.chat_row_id as chatRowId,
      m.from_me as fromMe,
      m.timestamp as timestamp,
      m.text_data as textData,
      m.sender_jid_row_id as senderJidRowId,
      sender_jid.user as senderUser,
      phone_jid.user as phoneUser,
      ldn.username as username,
      gpu.label as participantLabel
    FROM message m
    JOIN chat c ON m.chat_row_id = c._id
    LEFT JOIN jid sender_jid ON m.sender_jid_row_id = sender_jid._id
    LEFT JOIN jid_map jm ON m.sender_jid_row_id = jm.lid_row_id
    LEFT JOIN jid phone_jid ON jm.jid_row_id = phone_jid._id
    LEFT JOIN lid_display_name ldn ON m.sender_jid_row_id = ldn.lid_row_id
    LEFT JOIN group_participant_user gpu ON c.jid_row_id = gpu.group_jid_row_id AND m.sender_jid_row_id = gpu.user_jid_row_id
    WHERE m.chat_row_id = ?
      AND m.text_data IS NOT NULL
      AND m.text_data != ''
  `;

  const params: (number | string)[] = [resolvedChat.chatId];

  if (startTime !== undefined) {
    sqlQuery += ` AND m.timestamp >= ?`;
    params.push(startTime);
  }

  if (endTime !== undefined) {
    sqlQuery += ` AND m.timestamp <= ?`;
    params.push(endTime);
  }

  sqlQuery += ` ORDER BY m.timestamp ASC, m._id ASC`;

  const rawRows = db.$client
    .query<
      {
        id: number;
        chatRowId: number;
        fromMe: number;
        timestamp: number;
        textData: string;
        senderJidRowId: number;
        senderUser: string | null;
        phoneUser: string | null;
        username: string | null;
        participantLabel: string | null;
      },
      (number | string)[]
    >(sqlQuery)
    .all(...params);

  // Default contact identifier for 1:1 chat if sender is not in a group
  const defaultPeerIdentifier =
    resolvedChat.username ||
    formatSenderPhone(resolvedChat.phone) ||
    resolvedChat.subject ||
    "Contact";

  const chatMessages: ChatMessage[] = rawRows.map((row) => {
    let senderDisplay: string;
    if (row.fromMe) {
      senderDisplay = ownerName;
    } else if (resolvedChat.isGroup) {
      if (row.participantLabel && row.participantLabel.trim()) {
        senderDisplay = row.participantLabel.trim();
      } else if (row.username && row.username.trim()) {
        senderDisplay = row.username.trim();
      } else if (row.phoneUser) {
        senderDisplay = formatSenderPhone(row.phoneUser);
      } else if (row.senderUser) {
        senderDisplay = formatSenderPhone(row.senderUser);
      } else {
        senderDisplay = "Unknown";
      }
    } else {
      senderDisplay = defaultPeerIdentifier;
    }

    return {
      id: row.id,
      chatRowId: row.chatRowId,
      fromMe: Boolean(row.fromMe),
      timestamp: row.timestamp,
      textData: row.textData,
      senderNameOrPhone: senderDisplay,
    };
  });

  const formatted = formatExportedChat(chatMessages);
  return {
    text: formatted,
    messageCount: chatMessages.length,
  };
}

/**
 * Counts messages matching search term across all chats.
 */
export async function countMessages(
  db: AppDatabase,
  searchTerm: string,
  filterOpts: ExportFilterOptions,
): Promise<number> {
  const { startTime, endTime } = parseDateRange(filterOpts);

  let sqlQuery = `SELECT count(*) as count FROM message WHERE text_data LIKE ?`;
  const params: (number | string)[] = [`%${searchTerm}%`];

  if (startTime !== undefined) {
    sqlQuery += ` AND timestamp >= ?`;
    params.push(startTime);
  }

  if (endTime !== undefined) {
    sqlQuery += ` AND timestamp <= ?`;
    params.push(endTime);
  }

  const row = db.$client
    .query<{ count: number }, (number | string)[]>(sqlQuery)
    .get(...params);

  return row?.count ?? 0;
}

/**
 * Searches messages across all chats (e.g. searching for whatsapp group invite links or keywords).
 */
export async function searchMessages(
  db: AppDatabase,
  searchTerm: string,
  filterOpts: ExportFilterOptions,
  limit?: number,
): Promise<SearchMessageResult[]> {
  const { startTime, endTime } = parseDateRange(filterOpts);

  let sqlQuery = `
    SELECT 
      m._id as messageId,
      m.chat_row_id as chatId,
      m.from_me as fromMe,
      m.timestamp as timestamp,
      m.text_data as textData,
      c.subject as groupName,
      sender_jid.user as senderUser,
      phone_jid.user as phoneUser,
      ldn.username as username,
      gpu.label as participantLabel,
      peer_phone_jid.user as peerPhoneUser
    FROM message m
    JOIN chat c ON m.chat_row_id = c._id
    LEFT JOIN jid sender_jid ON m.sender_jid_row_id = sender_jid._id
    LEFT JOIN jid_map jm ON m.sender_jid_row_id = jm.lid_row_id
    LEFT JOIN jid phone_jid ON jm.jid_row_id = phone_jid._id
    LEFT JOIN lid_display_name ldn ON m.sender_jid_row_id = ldn.lid_row_id
    LEFT JOIN group_participant_user gpu ON c.jid_row_id = gpu.group_jid_row_id AND m.sender_jid_row_id = gpu.user_jid_row_id
    LEFT JOIN jid_map peer_jm ON c.jid_row_id = peer_jm.lid_row_id
    LEFT JOIN jid peer_phone_jid ON peer_jm.jid_row_id = peer_phone_jid._id
    WHERE m.text_data LIKE ?
  `;

  const params: (number | string)[] = [`%${searchTerm}%`];

  if (startTime !== undefined) {
    sqlQuery += ` AND m.timestamp >= ?`;
    params.push(startTime);
  }

  if (endTime !== undefined) {
    sqlQuery += ` AND m.timestamp <= ?`;
    params.push(endTime);
  }

  sqlQuery += ` ORDER BY m.timestamp DESC`;

  if (limit !== undefined && limit > 0) {
    sqlQuery += ` LIMIT ?`;
    params.push(limit);
  }

  const rows = db.$client
    .query<
      {
        messageId: number;
        chatId: number;
        fromMe: number;
        timestamp: number;
        textData: string;
        groupName: string | null;
        senderUser: string | null;
        phoneUser: string | null;
        username: string | null;
        participantLabel: string | null;
        peerPhoneUser: string | null;
      },
      (number | string)[]
    >(sqlQuery)
    .all(...params);

  return rows.map((r) => {
    let senderDisplay: string;
    if (r.fromMe) {
      senderDisplay = "You";
    } else if (r.participantLabel && r.participantLabel.trim()) {
      senderDisplay = r.participantLabel.trim();
    } else if (r.username && r.username.trim()) {
      senderDisplay = r.username.trim();
    } else if (r.phoneUser) {
      senderDisplay = formatSenderPhone(r.phoneUser);
    } else if (r.senderUser) {
      senderDisplay = formatSenderPhone(r.senderUser);
    } else if (r.peerPhoneUser) {
      senderDisplay = formatSenderPhone(r.peerPhoneUser);
    } else {
      senderDisplay = "Unknown";
    }

    const groupName =
      r.groupName ||
      (r.peerPhoneUser ? formatSenderPhone(r.peerPhoneUser) : "Direct Chat");

    return {
      messageId: r.messageId,
      chatId: r.chatId,
      groupName,
      senderDisplay,
      timestamp: r.timestamp,
      textData: r.textData,
    };
  });
}
