import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jids = sqliteTable("jid", {
  id: integer("_id").primaryKey({ autoIncrement: true }),
  user: text("user").notNull(),
  server: text("server").notNull(),
  agent: integer("agent"),
  device: integer("device"),
  type: integer("type"),
  rawString: text("raw_string"),
});

export const jidMaps = sqliteTable("jid_map", {
  lidRowId: integer("lid_row_id").primaryKey(),
  jidRowId: integer("jid_row_id").notNull(),
  sortId: integer("sort_id"),
});

export const chats = sqliteTable("chat", {
  id: integer("_id").primaryKey({ autoIncrement: true }),
  jidRowId: integer("jid_row_id").unique(),
  subject: text("subject"),
  groupType: integer("group_type"),
  hidden: integer("hidden"),
  archived: integer("archived"),
});

export const messages = sqliteTable("message", {
  id: integer("_id").primaryKey({ autoIncrement: true }),
  chatRowId: integer("chat_row_id").notNull(),
  textData: text("text_data"),
  timestamp: integer("timestamp"),
});

export const groupParticipantUsers = sqliteTable("group_participant_user", {
  id: integer("_id").primaryKey({ autoIncrement: true }),
  groupJidRowId: integer("group_jid_row_id").notNull(),
  userJidRowId: integer("user_jid_row_id").notNull(),
  rank: integer("rank"),
  pending: integer("pending"),
  addTimestamp: integer("add_timestamp"),
});

export const groupPastParticipantUsers = sqliteTable(
  "group_past_participant_user",
  {
    id: integer("_id").primaryKey({ autoIncrement: true }),
    groupJidRowId: integer("group_jid_row_id").notNull(),
    userJidRowId: integer("user_jid_row_id").notNull(),
  },
);

export const messageSystemWithGroupNodes = sqliteTable(
  "message_system_with_group_nodes",
  {
    messageRowId: integer("message_row_id").primaryKey(),
    groupJidRowId: integer("group_jid_row_id"),
    groupNodeType: integer("group_node_type"),
    groupSubject: text("group_subject"),
    version: integer("version"),
  },
);

export const jidRelations = relations(jids, ({ one, many }) => ({
  chat: one(chats, {
    fields: [jids.id],
    references: [chats.jidRowId],
  }),
  groupParticipantMemberships: many(groupParticipantUsers, {
    relationName: "participantUserJid",
  }),
  groupParticipationsAsGroup: many(groupParticipantUsers, {
    relationName: "participantGroupJid",
  }),
  groupPastParticipantMemberships: many(groupPastParticipantUsers, {
    relationName: "pastParticipantUserJid",
  }),
  groupPastParticipationsAsGroup: many(groupPastParticipantUsers, {
    relationName: "pastParticipantGroupJid",
  }),
  lidToPhoneMap: one(jidMaps, {
    fields: [jids.id],
    references: [jidMaps.lidRowId],
    relationName: "lidMapping",
  }),
  phoneToLidMaps: many(jidMaps, {
    relationName: "phoneMapping",
  }),
}));

export const jidMapRelations = relations(jidMaps, ({ one }) => ({
  lidJid: one(jids, {
    fields: [jidMaps.lidRowId],
    references: [jids.id],
    relationName: "lidMapping",
  }),
  phoneJid: one(jids, {
    fields: [jidMaps.jidRowId],
    references: [jids.id],
    relationName: "phoneMapping",
  }),
}));

export const chatRelations = relations(chats, ({ one, many }) => ({
  jid: one(jids, {
    fields: [chats.jidRowId],
    references: [jids.id],
  }),
  participants: many(groupParticipantUsers),
  pastParticipants: many(groupPastParticipantUsers),
}));

export const groupParticipantUserRelations = relations(
  groupParticipantUsers,
  ({ one }) => ({
    groupChat: one(chats, {
      fields: [groupParticipantUsers.groupJidRowId],
      references: [chats.jidRowId],
    }),
    groupJid: one(jids, {
      fields: [groupParticipantUsers.groupJidRowId],
      references: [jids.id],
      relationName: "participantGroupJid",
    }),
    userJid: one(jids, {
      fields: [groupParticipantUsers.userJidRowId],
      references: [jids.id],
      relationName: "participantUserJid",
    }),
  }),
);

export const groupPastParticipantUserRelations = relations(
  groupPastParticipantUsers,
  ({ one }) => ({
    groupChat: one(chats, {
      fields: [groupPastParticipantUsers.groupJidRowId],
      references: [chats.jidRowId],
    }),
    groupJid: one(jids, {
      fields: [groupPastParticipantUsers.groupJidRowId],
      references: [jids.id],
      relationName: "pastParticipantGroupJid",
    }),
    userJid: one(jids, {
      fields: [groupPastParticipantUsers.userJidRowId],
      references: [jids.id],
      relationName: "pastParticipantUserJid",
    }),
  }),
);
