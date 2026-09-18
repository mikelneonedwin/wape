import { input, select } from "@inquirer/prompts";
import pc from "picocolors";
import type { GroupSummary } from "../services/extractor";
import { readContactsFromFile } from "../services/file-manager";
import {
  deleteRoom,
  getRoomById,
  getRooms,
  resolveListFilePath,
  saveRoom,
  type Room,
} from "../services/wape-store";
import { searchCheckbox } from "./search-checkbox";

function formatGroupLabel(group: { subject: string; communityName: string | null; participantCount: number }): string {
  if (group.communityName) {
    return `${pc.cyan(`[🏛️ ${group.communityName}]`)} └─ ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
  }
  return `${pc.dim("[Standalone]")} • ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
}

export function printRoomsTable(rooms: Room[], groups?: GroupSummary[]): void {
  if (rooms.length === 0) {
    console.log(pc.yellow("\nNo rooms found. Use 'wape room create <id>' to create one.\n"));
    return;
  }

  const groupSet = groups ? new Set(groups.map((g) => g.jidRowId)) : null;

  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(pc.bold(pc.cyan("🏠 CONFIGURED WAPE ROOMS")));
  console.log("=".repeat(75));

  rooms.forEach((r, idx) => {
    const listFile = r.targetList ?? `${r.id}.txt`;
    const filePath = resolveListFilePath(listFile);
    const contacts = readContactsFromFile(filePath);
    const listInfo = `${pc.green(listFile)} ${pc.yellow(`(${contacts.size} contacts)`)}`;

    const missingCount = groupSet ? r.groupJidRowIds.filter((id) => !groupSet.has(id)).length : 0;
    const missingBadge = missingCount > 0 ? ` ${pc.red(`(${missingCount} missing/exited)`)}` : "";

    console.log(
      `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${pc.bold(pc.white(r.id))}`
    );
    console.log(
      `      ${pc.dim("Groups:")} ${pc.yellow(r.groupJidRowIds.length)} groups${missingBadge} | ${pc.dim("List:")} ${listInfo}`
    );
    if (r.groupNames && r.groupNames.length > 0) {
      const preview = r.groupNames.slice(0, 2).join(", ");
      const more = r.groupNames.length > 2 ? pc.dim(`, +${r.groupNames.length - 2} more`) : "";
      console.log(`      ${pc.dim("Included:")} ${preview}${more}`);
    }
    console.log(pc.dim("-".repeat(75)));
  });
  console.log("");
}

export function printRoomDetail(room: Room, groups?: GroupSummary[]): void {
  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(pc.bold(pc.cyan(`🏠 ROOM: ${room.id.toUpperCase()}`)));
  console.log("=".repeat(75));
  console.log(`${pc.bold("Room ID:")}           ${pc.yellow(room.id)}`);

  const listFile = room.targetList ?? `${room.id}.txt`;
  const filePath = resolveListFilePath(listFile);
  const contacts = readContactsFromFile(filePath);
  console.log(`${pc.bold("List File:")}         ${pc.green(listFile)} ${pc.dim(`(${filePath})`)}`);
  console.log(`${pc.bold("Contacts in List:")}  ${pc.magenta(contacts.size.toLocaleString() + " contacts")}`);

  const groupMap = groups ? new Map(groups.map((g) => [g.jidRowId, g])) : null;
  const activeCount = groupMap ? room.groupJidRowIds.filter((id) => groupMap.has(id)).length : room.groupJidRowIds.length;
  const missingCount = room.groupJidRowIds.length - activeCount;

  const countBadge =
    missingCount > 0
      ? `${pc.cyan(room.groupJidRowIds.length.toString())} (${pc.green(`${activeCount} active`)}, ${pc.red(`${missingCount} missing/exited`)})`
      : pc.cyan(room.groupJidRowIds.length.toString());

  console.log(`${pc.bold("Total Groups:")}      ${countBadge}`);
  console.log("-".repeat(75));
  console.log(pc.bold(pc.cyan("📋 INCLUDED GROUPS:")));

  room.groupJidRowIds.forEach((jid, idx) => {
    const num = pc.dim((idx + 1).toString().padStart(2, " ") + ".");
    const originalName = room.groupNames && room.groupNames[idx] ? room.groupNames[idx] : `JID ${jid}`;

    if (groupMap) {
      const g = groupMap.get(jid);
      if (g) {
        console.log(`  ${num} ${formatGroupLabel(g)}`);
        return;
      }
      // Group was exited or is missing from backup
      console.log(
        `  ${num} ${pc.red(`[⚠️ MISSING / EXITED]`)} ${pc.strikethrough(pc.dim(originalName))} ${pc.dim(`(JID: ${jid} • Read-only)`)}`
      );
      return;
    }

    console.log(`  ${num} ${pc.white(originalName)} ${pc.dim(`(JID: ${jid})`)}`);
  });

  console.log("=".repeat(75) + "\n");
}

export async function createRoomInteractive(groups: GroupSummary[], id: string): Promise<Room | null> {
  const cleanId = id.trim().toLowerCase();

  if (getRoomById(cleanId)) {
    console.error(pc.red(`\n❌ Error: A room with ID '${cleanId}' already exists.\n`));
    return null;
  }

  console.log(pc.cyan(`\n🏠 Creating Room '${pc.bold(cleanId)}'\n`));
  console.log(pc.dim("Select the WhatsApp groups to include in this room:"));

  const selectedJids = await searchCheckbox({
    message: `Select groups for room '${cleanId}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices: groups.map((g) => ({
      name: formatGroupLabel(g),
      value: g.jidRowId,
      category: g.communityName ?? "Standalone Groups",
    })),
  });

  const selectedGroups = groups.filter((g) => selectedJids.includes(g.jidRowId));
  const groupNames = selectedGroups.map((g) => g.subject);

  // Every room strictly has its dedicated list named after its ID
  const targetList = `${cleanId}.txt`;

  const room: Room = {
    id: cleanId,
    groupJidRowIds: selectedJids,
    groupNames,
    targetList,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Room '${pc.bold(room.id)}' created successfully with ${room.groupJidRowIds.length} groups! (List: ~/.wape/lists/${targetList})\n`
    )
  );
  return room;
}

export async function editRoomInteractive(groups: GroupSummary[], initialId?: string): Promise<void> {
  const rooms = getRooms();
  if (rooms.length === 0) {
    console.log(pc.yellow("\nNo rooms available to edit."));
    return;
  }

  let roomId = initialId?.trim().toLowerCase();
  if (!roomId || !getRoomById(roomId)) {
    roomId = await select<string>({
      message: "Select a room to edit / manage:",
      choices: rooms.map((r) => ({
        name: `${r.id} ${pc.dim(`(${r.groupJidRowIds.length} groups)`)}`,
        value: r.id,
      })),
    });
  }

  const room = getRoomById(roomId);
  if (!room) return;

  const action = await select<"groups" | "delete">({
    message: `Manage Room '${room.id}':`,
    choices: [
      {
        name: "👥 Edit included groups (add/remove groups)",
        value: "groups",
      },
      {
        name: "🗑️  Delete this room",
        value: "delete",
      },
    ],
  });

  if (action === "groups") {
    const precheckedSet = new Set(room.groupJidRowIds);
    const updatedJids = await searchCheckbox({
      message: `Edit groups for room '${room.id}':`,
      pageSize: 16,
      required: true,
      choices: groups.map((g) => ({
        name: formatGroupLabel(g),
        value: g.jidRowId,
        category: g.communityName ?? "Standalone Groups",
        checked: precheckedSet.has(g.jidRowId),
      })),
    });

    const updatedGroups = groups.filter((g) => updatedJids.includes(g.jidRowId));
    room.groupJidRowIds = updatedJids;
    room.groupNames = updatedGroups.map((g) => g.subject);
    saveRoom(room);
    console.log(pc.green(`\n✅ Updated room '${room.id}' groups (${room.groupJidRowIds.length} total).\n`));
  } else if (action === "delete") {
    const deleteConfirm = await input({
      message: `Are you sure you want to delete room '${room.id}'? (yes/no):`,
      validate: (val) => {
        const v = val.trim().toLowerCase();
        if (v === "yes" || v === "y" || v === "no" || v === "n") return true;
        return "Please enter 'yes' (or 'y') to delete, or 'no' (or 'n') to cancel.";
      },
    });

    if (["yes", "y"].includes(deleteConfirm.trim().toLowerCase())) {
      deleteRoom(room.id);
      console.log(pc.green(`\n🗑️ Room '${room.id}' deleted.\n`));
    } else {
      console.log(pc.yellow("Deletion cancelled."));
    }
  }
}

export async function manageRoomsMenu(groups: GroupSummary[]): Promise<void> {
  while (true) {
    const rooms = getRooms();
    const action = await select<"list" | "edit" | "exit">({
      message: `🏠 Wape Room Management Menu (${rooms.length} rooms configured):`,
      choices: [
        { name: "📋 View all rooms", value: "list" },
        ...(rooms.length > 0
          ? [{ name: "✏️  Edit / manage an existing room", value: "edit" as const }]
          : []),
        { name: "🔙 Exit room manager", value: "exit" },
      ],
    });

    if (action === "list") {
      printRoomsTable(rooms, groups);
    } else if (action === "edit") {
      await editRoomInteractive(groups);
    } else if (action === "exit") {
      break;
    }
  }
}
