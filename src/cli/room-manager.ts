import { select } from "@inquirer/prompts";
import pc from "picocolors";
import type { GroupSummary } from "../services/extractor";
import { readContactsFromFile } from "../services/file-manager";
import {
  getRoomById,
  getRooms,
  resolveListFilePath,
  saveRoom,
  type Room,
} from "../services/wape-store";
import { searchCheckbox } from "./search-checkbox";

function formatGroupLabel(group: {
  subject: string;
  communityName: string | null;
  participantCount: number;
}): string {
  if (group.communityName) {
    return `${pc.cyan(`[🏛️ ${group.communityName}]`)} └─ ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
  }
  return `${pc.dim("[Standalone]")} • ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
}

export function printRoomsTable(rooms: Room[], groups?: GroupSummary[]): void {
  if (rooms.length === 0) {
    console.log(
      pc.yellow("\nNo rooms found. Use 'wape rooms new <id>' to create one.\n"),
    );
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

    const missingCount = groupSet
      ? r.groupJidRowIds.filter((id) => !groupSet.has(id)).length
      : 0;
    const missingBadge =
      missingCount > 0 ? ` ${pc.red(`(${missingCount} missing/exited)`)}` : "";

    console.log(
      `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${pc.bold(pc.white(r.id))}`,
    );
    console.log(
      `      ${pc.dim("Groups:")} ${pc.yellow(r.groupJidRowIds.length)} groups${missingBadge} | ${pc.dim("List:")} ${listInfo}`,
    );
    if (r.groupNames && r.groupNames.length > 0) {
      const preview = r.groupNames.slice(0, 2).join(", ");
      const more =
        r.groupNames.length > 2
          ? pc.dim(`, +${r.groupNames.length - 2} more`)
          : "";
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
  console.log(
    `${pc.bold("List File:")}         ${pc.green(listFile)} ${pc.dim(`(${filePath})`)}`,
  );
  console.log(
    `${pc.bold("Contacts in List:")}  ${pc.magenta(contacts.size.toLocaleString() + " contacts")}`,
  );

  const groupMap = groups ? new Map(groups.map((g) => [g.jidRowId, g])) : null;
  const activeCount = groupMap
    ? room.groupJidRowIds.filter((id) => groupMap.has(id)).length
    : room.groupJidRowIds.length;
  const missingCount = room.groupJidRowIds.length - activeCount;

  const countBadge =
    missingCount > 0
      ? `${pc.cyan(room.groupJidRowIds.length.toString())} (${pc.green(`${activeCount} active`)}, ${pc.red(`${missingCount} missing/exited`)})`
      : pc.cyan(room.groupJidRowIds.length.toString());

  console.log(`${pc.bold("Total Groups:")}      ${countBadge}`);
  console.log("-".repeat(75));
  console.log(pc.bold(pc.cyan("📋 INCLUDED GROUPS:")));

  if (room.groupJidRowIds.length === 0) {
    console.log(pc.dim("  (No groups included in this room yet)"));
  } else {
    room.groupJidRowIds.forEach((jid, idx) => {
      const num = pc.dim((idx + 1).toString().padStart(2, " ") + ".");
      const originalName =
        room.groupNames && room.groupNames[idx]
          ? room.groupNames[idx]
          : `JID ${jid}`;

      if (groupMap) {
        const g = groupMap.get(jid);
        if (g) {
          console.log(`  ${num} ${formatGroupLabel(g)}`);
          return;
        }
        // Group was exited or is missing from backup
        console.log(
          `  ${num} ${pc.red(`[⚠️ MISSING / EXITED]`)} ${pc.strikethrough(pc.dim(originalName))} ${pc.dim(`(JID: ${jid} • Read-only)`)}`,
        );
        return;
      }

      console.log(
        `  ${num} ${pc.white(originalName)} ${pc.dim(`(JID: ${jid})`)}`,
      );
    });
  }

  console.log("=".repeat(75) + "\n");
}

export async function createRoomInteractive(
  groups: GroupSummary[],
  id: string,
): Promise<Room | null> {
  const cleanId = id.trim().toLowerCase();

  if (getRoomById(cleanId)) {
    console.error(
      pc.red(`\n❌ Error: A room with ID '${cleanId}' already exists.\n`),
    );
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

  const selectedGroups = groups.filter((g) =>
    selectedJids.includes(g.jidRowId),
  );
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
      `\n✅ Room '${pc.bold(room.id)}' created successfully with ${room.groupJidRowIds.length} groups! (List: ${resolveListFilePath(targetList)})\n`,
    ),
  );
  return room;
}

export async function addGroupsToRoomInteractive(
  groups: GroupSummary[],
  initialId?: string,
): Promise<void> {
  const rooms = getRooms();
  if (rooms.length === 0) {
    console.log(
      pc.yellow("\nNo rooms found. Use 'wape rooms new <id>' to create one.\n"),
    );
    return;
  }

  let roomId = initialId?.trim().toLowerCase();
  if (roomId) {
    if (!getRoomById(roomId)) {
      console.error(
        pc.red(
          `\n❌ Error: Room '${initialId}' not found. Use 'wape rooms list' to see all rooms.\n`,
        ),
      );
      process.exit(1);
    }
  } else {
    roomId = await select<string>({
      message: "Select room to add groups to:",
      choices: rooms.map((r) => ({
        name: `${r.id} ${pc.dim(`(${r.groupJidRowIds.length} groups)`)}`,
        value: r.id,
      })),
    });
  }

  const room = getRoomById(roomId);
  if (!room) return;

  const otherRoomJids = new Set(
    rooms
      .filter((r) => r.id.toLowerCase() !== room.id.toLowerCase())
      .flatMap((r) => r.groupJidRowIds),
  );
  const existingJids = new Set(room.groupJidRowIds);

  // Groups already in this room or in any other room are filtered out
  const availableGroups = groups.filter(
    (g) => !existingJids.has(g.jidRowId) && !otherRoomJids.has(g.jidRowId),
  );

  if (availableGroups.length === 0) {
    console.log(
      pc.yellow(
        `\nNo new groups available to add to room '${room.id}'. (All groups are already in this room or included in other rooms).\n`,
      ),
    );
    return;
  }

  const selectedJids = await searchCheckbox({
    message: `Select groups to add to room '${room.id}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices: availableGroups.map((g) => ({
      name: formatGroupLabel(g),
      value: g.jidRowId,
      category: g.communityName ?? "Standalone Groups",
    })),
  });

  if (selectedJids.length === 0) {
    console.log(pc.yellow("\nNo groups were selected.\n"));
    return;
  }

  const selectedGroupObjects = groups.filter((g) =>
    selectedJids.includes(g.jidRowId),
  );

  room.groupJidRowIds = [...room.groupJidRowIds, ...selectedJids];
  room.groupNames = [
    ...(room.groupNames ?? []),
    ...selectedGroupObjects.map((g) => g.subject),
  ];

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Added ${selectedJids.length} group(s) to room '${room.id}' (${room.groupJidRowIds.length} total groups now).\n`,
    ),
  );
}

export async function removeGroupsFromRoomInteractive(
  groups: GroupSummary[],
  initialId?: string,
): Promise<void> {
  const rooms = getRooms();
  if (rooms.length === 0) {
    console.log(
      pc.yellow("\nNo rooms found. Use 'wape rooms new <id>' to create one.\n"),
    );
    return;
  }

  let roomId = initialId?.trim().toLowerCase();
  if (roomId) {
    if (!getRoomById(roomId)) {
      console.error(
        pc.red(
          `\n❌ Error: Room '${initialId}' not found. Use 'wape rooms list' to see all rooms.\n`,
        ),
      );
      process.exit(1);
    }
  } else {
    roomId = await select<string>({
      message: "Select room to remove groups from:",
      choices: rooms.map((r) => ({
        name: `${r.id} ${pc.dim(`(${r.groupJidRowIds.length} groups)`)}`,
        value: r.id,
      })),
    });
  }

  const room = getRoomById(roomId);
  if (!room) return;

  if (room.groupJidRowIds.length === 0) {
    console.log(pc.yellow(`\nRoom '${room.id}' has no groups to remove.\n`));
    return;
  }

  const groupMap = new Map(groups.map((g) => [g.jidRowId, g]));

  const choices = room.groupJidRowIds.map((jid, idx) => {
    const g = groupMap.get(jid);
    const originalName =
      room.groupNames && room.groupNames[idx]
        ? room.groupNames[idx]
        : `JID ${jid}`;

    if (g) {
      return {
        name: formatGroupLabel(g),
        value: jid,
        category: g.communityName ?? "Standalone Groups",
      };
    }
    return {
      name: `${pc.red("[⚠️ MISSING / EXITED]")} ${pc.strikethrough(pc.dim(originalName))} ${pc.dim(`(JID: ${jid})`)}`,
      value: jid,
      category: "Missing / Exited Groups",
    };
  });

  const selectedJidsToRemove = await searchCheckbox({
    message: `Select groups to remove from room '${room.id}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices,
  });

  if (selectedJidsToRemove.length === 0) {
    console.log(pc.yellow("\nNo groups were selected for removal.\n"));
    return;
  }

  const removeSet = new Set(selectedJidsToRemove);
  const remainingJids: number[] = [];
  const remainingNames: string[] = [];

  room.groupJidRowIds.forEach((jid, idx) => {
    if (!removeSet.has(jid)) {
      remainingJids.push(jid);
      remainingNames.push(room.groupNames?.[idx] ?? `JID ${jid}`);
    }
  });

  room.groupJidRowIds = remainingJids;
  room.groupNames = remainingNames;

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Removed ${selectedJidsToRemove.length} group(s) from room '${room.id}' (${room.groupJidRowIds.length} groups remaining).\n`,
    ),
  );
}

export async function manageRoomsMenu(groups: GroupSummary[]): Promise<void> {
  while (true) {
    const rooms = getRooms();
    const action = await select<"list" | "add" | "remove" | "exit">({
      message: `🏠 Wape Room Management Menu (${rooms.length} rooms configured):`,
      choices: [
        { name: "📋 View all rooms", value: "list" },
        ...(rooms.length > 0
          ? [
              {
                name: "➕ Add new groups to a room",
                value: "add" as const,
              },
              {
                name: "➖ Remove existing groups from a room",
                value: "remove" as const,
              },
            ]
          : []),
        { name: "🔙 Exit room manager", value: "exit" },
      ],
    });

    if (action === "list") {
      printRoomsTable(rooms, groups);
    } else if (action === "add") {
      await addGroupsToRoomInteractive(groups);
    } else if (action === "remove") {
      await removeGroupsFromRoomInteractive(groups);
    } else if (action === "exit") {
      break;
    }
  }
}
