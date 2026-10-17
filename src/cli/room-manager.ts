import { select } from "@inquirer/prompts";
import pc from "picocolors";
import {
  resolveRoomGroups,
  type ExitableGroupAudit,
  type GroupDemographics,
  type GroupSummary,
  type ResolvedRoomGroupItem,
} from "../services/extractor";
import {
  getListContactCount,
  getIgnoredJidSet,
  getRoomById,
  getRooms,
  normalizeListName,
  saveRoom,
  type ContactProvenanceGroup,
  type Room,
} from "../services/wape-store";
import { formatPhoneNumber } from "../services/phone";
import { printIgnoredGroups } from "./ignore-manager";
import { searchCheckbox } from "./search-checkbox";

export function formatProvenanceGroupItem(
  group: ContactProvenanceGroup,
  options?: { showRooms?: boolean },
) {
  const comm = group.communityName
    ? `${pc.cyan(`[🏛️ ${group.communityName}]`)} └─ `
    : `${pc.dim("[Standalone]")} • `;

  const oneoffSources = group.sources.filter(
    (source) => source.sourceType === "oneoff",
  );
  let extraInfo = "";
  if (oneoffSources.length > 0) {
    const labels = oneoffSources
      .map((source) =>
        source.ownerPhone
          ? `${source.sourceLabel} • Owner: ${formatPhoneNumber(source.ownerPhone)}`
          : source.sourceLabel,
      )
      .join(", ");
    extraInfo = ` ${pc.magenta(`(One-off: ${labels})`)}`;
  }

  let roomInfo = "";
  if (options?.showRooms !== false && group.rooms !== undefined) {
    if (group.rooms.length > 0) {
      const roomLabel =
        group.rooms.length === 1
          ? `Room: ${group.rooms[0]}`
          : `Rooms: ${group.rooms.join(", ")}`;
      roomInfo = ` ${pc.green(`[${roomLabel}]`)}`;
    } else {
      roomInfo = ` ${pc.dim("[No Room]")}`;
    }
  }

  return `${comm}${group.subject}${extraInfo}${roomInfo}`;
}

export function formatGroupLabel(group: {
  subject: string;
  communityName: string | null;
  participantCount?: number;
  isCommunityRoot?: boolean;
  isAnnouncement?: boolean;
  isSubgroup?: boolean;
  isStandalone?: boolean;
  groupType?: number;
}): string {
  const countLabel =
    group.participantCount !== undefined
      ? ` ${pc.dim(`(${group.participantCount.toLocaleString()} members)`)}`
      : "";

  const isRoot = group.isCommunityRoot ?? group.groupType === 1;
  const isAnn = group.isAnnouncement ?? group.groupType === 3;

  if (isRoot) {
    const totalCount =
      group.participantCount !== undefined
        ? ` ${pc.dim(`(${group.participantCount.toLocaleString()} total members)`)}`
        : "";
    return `${pc.magenta(pc.bold("[🏛️ Community Record]"))} ${group.subject}${totalCount}`;
  }

  if (group.communityName) {
    const badge = isAnn ? ` └─ ${pc.yellow("[Announcement]")} ` : " └─ ";
    return `${pc.cyan(`[🏛️ ${group.communityName}]`)}${badge}${group.subject}${countLabel}`;
  }

  return `${pc.dim("[Standalone]")} • ${group.subject}${countLabel}`;
}

export function printGroups(
  groups: GroupSummary[],
  options?: { rank?: boolean; roomId?: string },
): void {
  if (groups.length === 0) {
    const scopeMsg = options?.roomId
      ? `No active group chats found in room '${options.roomId}'.`
      : "No active group chats found.";
    console.log(pc.yellow(`\n${scopeMsg}\n`));
    return;
  }

  const roomSuffix = options?.roomId ? ` IN ROOM '${options.roomId}'` : "";

  if (options?.rank) {
    const ranked = [...groups].sort((a, b) => {
      if (b.participantCount !== a.participantCount) {
        return b.participantCount - a.participantCount;
      }
      return a.subject.localeCompare(b.subject, undefined, {
        sensitivity: "base",
      });
    });

    console.log(pc.cyan("\n" + "=".repeat(75)));
    console.log(
      pc.bold(
        pc.cyan(
          `🏆 RANKED WHATSAPP GROUPS${roomSuffix} (${ranked.length} total)`,
        ),
      ),
    );
    console.log("=".repeat(75) + "\n");

    ranked.forEach((g, idx) => {
      const num = pc.dim((idx + 1).toString().padStart(3, " ") + ".");
      console.log(`  ${num} ${formatGroupLabel(g)}`);
    });

    console.log("\n" + "=".repeat(75) + "\n");
    return;
  }

  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(
    pc.bold(
      pc.cyan(
        `👥 ACTIVE WHATSAPP GROUPS${roomSuffix} (${groups.length} total)`,
      ),
    ),
  );
  console.log("=".repeat(75) + "\n");

  const communityMap = new Map<string, GroupSummary[]>();
  const standaloneItems: GroupSummary[] = [];

  for (const g of groups) {
    if (g.communityName) {
      const list = communityMap.get(g.communityName) ?? [];
      list.push(g);
      communityMap.set(g.communityName, list);
    } else {
      standaloneItems.push(g);
    }
  }

  const sortedCommunityNames = Array.from(communityMap.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  let globalIndex = 1;

  for (const commName of sortedCommunityNames) {
    const commItems = communityMap.get(commName)!;
    commItems.sort((a, b) => {
      const typeRank = (g: GroupSummary) => {
        if (g.isCommunityRoot ?? g.groupType === 1) return 1;
        if (g.isAnnouncement ?? g.groupType === 3) return 2;
        if (g.isSubgroup ?? (g.groupType === 2 || g.groupType === 6)) return 3;
        return 4;
      };
      const rankDiff = typeRank(a) - typeRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.subject.localeCompare(b.subject, undefined, {
        sensitivity: "base",
      });
    });

    console.log(`  ${pc.cyan(pc.bold(`🏛️  ${commName}`))}`);
    for (const item of commItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;
      const isRoot = item.isCommunityRoot ?? item.groupType === 1;
      const isAnn = item.isAnnouncement ?? item.groupType === 3;

      if (isRoot) {
        const countLabel = ` ${pc.dim(`(${item.participantCount.toLocaleString()} total members)`)}`;
        console.log(
          `    ${num} ${pc.magenta(pc.bold("[Community Record]"))} ${item.subject}${countLabel}`,
        );
      } else if (isAnn) {
        const countLabel = ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`;
        console.log(
          `    ${num} └─ ${pc.yellow("[Announcement]")} ${item.subject}${countLabel}`,
        );
      } else {
        const countLabel = ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`;
        console.log(`    ${num} └─ ${item.subject}${countLabel}`);
      }
    }
    console.log("");
  }

  if (standaloneItems.length > 0) {
    standaloneItems.sort((a, b) =>
      a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }),
    );

    if (sortedCommunityNames.length > 0) {
      console.log(`  ${pc.bold(pc.dim("🌐 Standalone Groups"))}`);
    }

    for (const item of standaloneItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;
      const countLabel = ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`;
      console.log(`  ${num} ${item.subject}${countLabel}`);
    }
    console.log("");
  }

  console.log("=".repeat(75) + "\n");
}

export function printRoomsTable(rooms: Room[], groups?: GroupSummary[]): void {
  if (rooms.length === 0) {
    console.log(
      pc.yellow("\nNo rooms found. Use 'wape rooms new <id>' to create one.\n"),
    );
    return;
  }

  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(pc.bold(pc.cyan("🏠 CONFIGURED WAPE ROOMS")));
  console.log("=".repeat(75));

  rooms.forEach((r, idx) => {
    const listName = r.targetList ? normalizeListName(r.targetList) : r.id;
    const count = getListContactCount(listName);
    const listInfo = `${pc.green(listName)} ${pc.yellow(`(${count.toLocaleString()} contacts)`)}`;

    const resolved = resolveRoomGroups(r, groups);
    const totalCount = resolved.resolvedItems.length;
    const missingCount = resolved.missingCount;
    const missingBadge =
      missingCount > 0 ? ` ${pc.red(`(${missingCount} missing/exited)`)}` : "";

    console.log(
      `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${pc.bold(pc.white(r.id))}`,
    );
    console.log(
      `      ${pc.dim("Groups:")} ${pc.yellow(totalCount)} groups${missingBadge} | ${pc.dim("List:")} ${listInfo}`,
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

  const listName = room.targetList
    ? normalizeListName(room.targetList)
    : room.id;
  const count = getListContactCount(listName);
  console.log(`${pc.bold("Target List:")}       ${pc.green(listName)}`);
  console.log(
    `${pc.bold("Contacts in List:")}  ${pc.magenta(count.toLocaleString() + " contacts")}`,
  );

  const resolved = resolveRoomGroups(room, groups);
  const totalCount = resolved.resolvedItems.length;
  const activeCount = resolved.activeCount;
  const missingCount = resolved.missingCount;

  const countBadge =
    missingCount > 0
      ? `${pc.cyan(totalCount.toString())} (${pc.green(`${activeCount} active`)}, ${pc.red(`${missingCount} missing/exited`)})`
      : pc.cyan(totalCount.toString());

  console.log(`${pc.bold("Total Groups:")}      ${countBadge}`);
  console.log("-".repeat(75));
  console.log(pc.bold(pc.cyan("📋 INCLUDED GROUPS:")));

  if (totalCount === 0) {
    console.log(pc.dim("  (No groups included in this room yet)"));
  } else {
    resolved.resolvedItems.forEach((item, idx) => {
      const num = pc.dim((idx + 1).toString().padStart(2, " ") + ".");
      if (groups) {
        if (!item.isMissing) {
          console.log(`  ${num} ${formatGroupLabel(item)}`);
        } else {
          console.log(
            `  ${num} ${pc.red(`[⚠️ MISSING / EXITED]`)} ${pc.strikethrough(pc.dim(item.subject))} ${pc.dim(`(ID: ${item.id} • Read-only)`)}`,
          );
        }
      } else {
        console.log(
          `  ${num} ${pc.white(item.subject)} ${pc.dim(`(ID: ${item.id})`)}`,
        );
      }
    });
  }

  console.log("=".repeat(75) + "\n");
}

export function printRoomGroups(room: Room, groups?: GroupSummary[]): void {
  const resolved = resolveRoomGroups(room, groups);

  if (resolved.resolvedItems.length === 0) {
    console.log(pc.yellow(`\nNo groups configured in room '${room.id}'.\n`));
    return;
  }

  console.log(
    pc.cyan(
      `\n📋 Groups in room '${pc.bold(room.id)}' (${resolved.resolvedItems.length} groups):\n`,
    ),
  );

  const communityMap = new Map<string, typeof resolved.resolvedItems>();
  const standaloneItems: typeof resolved.resolvedItems = [];

  for (const item of resolved.resolvedItems) {
    if (item.communityName) {
      const list = communityMap.get(item.communityName) ?? [];
      list.push(item);
      communityMap.set(item.communityName, list);
    } else {
      standaloneItems.push(item);
    }
  }

  const sortedCommunityNames = Array.from(communityMap.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  let globalIndex = 1;

  for (const commName of sortedCommunityNames) {
    const commItems = communityMap.get(commName)!;
    commItems.sort((a, b) => {
      const typeRank = (g: typeof a) => {
        if (g.isCommunityRoot ?? g.groupType === 1) return 1;
        if (g.isAnnouncement ?? g.groupType === 3) return 2;
        if (g.isSubgroup ?? (g.groupType === 2 || g.groupType === 6)) return 3;
        return 4;
      };
      const rankDiff = typeRank(a) - typeRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.subject.localeCompare(b.subject, undefined, {
        sensitivity: "base",
      });
    });

    console.log(`  ${pc.cyan(pc.bold(`🏛️  ${commName}`))}`);
    for (const item of commItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;
      const isRoot = item.isCommunityRoot ?? item.groupType === 1;
      const isAnn = item.isAnnouncement ?? item.groupType === 3;

      if (isRoot) {
        const countLabel =
          item.participantCount !== undefined
            ? ` ${pc.dim(`(${item.participantCount.toLocaleString()} total members)`)}`
            : "";
        console.log(
          `    ${num} ${pc.magenta(pc.bold("[Community Record]"))} ${item.subject}${countLabel}`,
        );
      } else if (isAnn) {
        const countLabel =
          item.participantCount !== undefined
            ? ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`
            : "";
        console.log(
          `    ${num} └─ ${pc.yellow("[Announcement]")} ${item.subject}${countLabel}`,
        );
      } else {
        const countLabel =
          item.participantCount !== undefined
            ? ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`
            : "";
        console.log(`    ${num} └─ ${item.subject}${countLabel}`);
      }
    }
    console.log("");
  }

  if (standaloneItems.length > 0) {
    standaloneItems.sort((a, b) =>
      a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }),
    );

    if (sortedCommunityNames.length > 0) {
      console.log(`  ${pc.bold(pc.dim("🌐 Standalone Groups"))}`);
    }

    for (const item of standaloneItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;

      if (item.isMissing) {
        console.log(
          `  ${num} ${pc.red(`[⚠️ MISSING / EXITED]`)} ${pc.strikethrough(pc.dim(item.subject))} ${pc.dim(`(ID: ${item.id})`)}`,
        );
      } else {
        const countLabel =
          item.participantCount !== undefined
            ? ` ${pc.dim(`(${item.participantCount} members)`)}`
            : "";
        console.log(`  ${num} ${item.subject}${countLabel}`);
      }
    }
    console.log("");
  }
}

export function printRoomAudit(
  room: Room,
  demographics: GroupDemographics[],
  missingItems: ResolvedRoomGroupItem[] = [],
  thresholdPercent = 50,
  showAll = false,
  exitedCount = 0,
): void {
  const flagged = demographics.filter((d) => d.isFlagged);
  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(
    pc.bold(
      pc.cyan(
        `AUDIT RESULTS: ROOM "${room.id.toUpperCase()}" (Threshold: more than ${thresholdPercent}% non-Nigerian members)`,
      ),
    ),
  );
  console.log("=".repeat(75));
  console.log(`${pc.bold("Room ID:")}           ${pc.yellow(room.id)}`);
  const exitedNote =
    exitedCount > 0 ? ` ${pc.dim(`(${exitedCount} left groups skipped)`)}` : "";
  console.log(
    `${pc.bold("Active Groups:")}     ${pc.white(demographics.length.toString())}${exitedNote}`,
  );
  const flaggedBadge =
    flagged.length > 0
      ? pc.bold(pc.red(`${flagged.length} group(s)`))
      : pc.bold(pc.green("0 groups (None)"));
  console.log(`${pc.bold("Flagged Groups:")}    ${flaggedBadge}`);
  console.log("-".repeat(75));

  const itemsToDisplay = showAll ? demographics : flagged;
  const sectionTitle = showAll
    ? "ALL GROUPS IN ROOM:"
    : `FLAGGED GROUPS (more than ${thresholdPercent}% non-Nigerian members):`;
  console.log(pc.bold(pc.cyan(sectionTitle)));

  if (itemsToDisplay.length === 0) {
    if (showAll) {
      console.log(pc.dim("  (No groups found in this room)"));
    } else {
      console.log(
        pc.green(
          `\n  None! All active groups in this room have ${thresholdPercent}% or fewer non-Nigerian members.`,
        ),
      );
    }
  } else {
    itemsToDisplay.forEach((item, idx) => {
      const num = pc.dim((idx + 1).toString().padStart(2, " ") + ".");
      const statusBadge = item.isFlagged
        ? pc.bold(pc.red("[FLAGGED]"))
        : pc.bold(pc.green("[OK]     "));

      let typeBadge = "";
      if (item.isCommunityRoot) {
        typeBadge = `${pc.magenta(pc.bold("[Community Record]"))} `;
      } else if (item.isAnnouncement) {
        typeBadge = `${pc.yellow("[Announcement]")} `;
      }

      const commText = item.isCommunityRoot
        ? "Community Record (Parent)"
        : item.communityName
          ? item.communityName
          : "None (Standalone)";

      const totalLabel = item.isCommunityRoot ? " total members" : " members";

      console.log(
        `\n  ${num} ${statusBadge} ${typeBadge}${pc.bold(item.subject)} ${pc.dim(`(${item.totalMembers.toLocaleString()}${totalLabel})`)}`,
      );
      console.log(`     ${pc.dim("Community:")}   ${pc.white(commText)}`);

      if (item.isFlagged) {
        console.log(
          `     ${pc.dim("Flag reason:")} ${pc.red(
            `${item.nonNigerianPercentage}% of members (${item.nonNigerianCount.toLocaleString()}) are from outside Nigeria, which is higher than your ${thresholdPercent}% limit.`,
          )}`,
        );
      } else {
        console.log(
          `     ${pc.dim("Status:")}      ${pc.green(
            `${item.nonNigerianPercentage}% of members are from outside Nigeria, which is within your ${thresholdPercent}% limit.`,
          )}`,
        );
      }

      const hiddenText =
        item.unmappedCount > 0
          ? `, ${item.unmappedCount.toLocaleString()} private/hidden profiles`
          : "";
      console.log(
        `     ${pc.dim("Breakdown:")}   ${item.nonNigerianCount.toLocaleString()} non-Nigerian, ${item.nigerianCount.toLocaleString()} Nigerian${hiddenText}.`,
      );
    });
  }

  if (showAll && missingItems.length > 0) {
    console.log(pc.dim("\n  Missing or Exited Groups:"));
    missingItems.forEach((item) => {
      console.log(
        `    ${pc.red("[MISSING]")} ${pc.dim(item.subject)} ${pc.dim(`(ID: ${item.id})`)}`,
      );
    });
  }

  console.log("\n" + "=".repeat(75));
  if (flagged.length > 0) {
    console.log(
      pc.red(
        pc.bold(
          `Audit complete: ${flagged.length} of ${demographics.length} active groups have more than ${thresholdPercent}% non-Nigerian members.`,
        ),
      ),
    );
  } else {
    console.log(
      pc.green(
        pc.bold(
          `Audit complete: All active groups in this room are within your Nigerian demographic threshold (${thresholdPercent}% or fewer non-Nigerian members).`,
        ),
      ),
    );
  }
  console.log("=".repeat(75) + "\n");
}

export function printExitableAudit(
  flaggedGroups: ExitableGroupAudit[],
  totalScannedCount: number,
  options?: { roomContext?: Room | null },
): void {
  console.log(pc.cyan("\n" + "=".repeat(75)));
  const title = options?.roomContext
    ? `AUDIT RESULTS: ROOM "${options.roomContext.id.toUpperCase()}" (GROUPS RECOMMENDED TO LEAVE OR DELETE)`
    : "AUDIT RESULTS: GROUPS RECOMMENDED TO LEAVE OR DELETE";
  console.log(pc.bold(pc.cyan(title)));
  console.log("=".repeat(75));
  if (options?.roomContext) {
    console.log(
      `${pc.bold("Room ID:")}              ${pc.yellow(options.roomContext.id)}`,
    );
  }
  console.log(
    `${pc.bold("Total Groups Scanned:")} ${pc.white(totalScannedCount.toLocaleString())}`,
  );
  const flaggedBadge =
    flaggedGroups.length > 0
      ? pc.bold(pc.red(`${flaggedGroups.length} group(s)`))
      : pc.bold(pc.green("0 groups (None)"));
  console.log(`${pc.bold("Groups Flagged:")}       ${flaggedBadge}`);
  console.log("-".repeat(75));

  console.log(pc.bold(pc.cyan("FLAGGED GROUPS:")));

  if (flaggedGroups.length === 0) {
    console.log(
      pc.green(
        "\n  None! All scanned groups appear active, healthy, and relevant.",
      ),
    );
  } else {
    flaggedGroups.forEach((item, idx) => {
      const num = pc.dim((idx + 1).toString().padStart(2, " ") + ".");
      const statusBadge = pc.bold(pc.red("[FLAGGED]"));

      const isRoot = item.isCommunityRoot;
      const isAnn = item.isAnnouncement;
      const typeBadge = isRoot
        ? ` ${pc.magenta(pc.bold("[Community Record]"))}`
        : isAnn
          ? ` ${pc.yellow("[Announcement Group]")}`
          : "";

      const commText = item.communityName
        ? item.communityName
        : "None (Standalone)";

      const memberText =
        item.totalMembers > 0
          ? ` (${item.totalMembers.toLocaleString()}${isRoot ? " total" : ""} members)`
          : "";

      console.log(
        `\n  ${num} ${statusBadge}${typeBadge} ${pc.bold(item.subject)}${pc.dim(memberText)}`,
      );
      console.log(`     ${pc.dim("Community:")}   ${pc.white(commText)}`);
      console.log(`     ${pc.dim("Flag reason:")} ${pc.red(item.reason)}`);
      console.log(`     ${pc.dim("Details:")}     ${pc.white(item.details)}`);
    });
  }

  console.log("\n" + "=".repeat(75));
  if (flaggedGroups.length > 0) {
    console.log(
      pc.red(
        pc.bold(
          `Audit complete: ${flaggedGroups.length} of ${totalScannedCount} scanned groups are recommended for leaving or deleting.`,
        ),
      ),
    );
  } else {
    console.log(
      pc.green(
        pc.bold(
          "Audit complete: No groups flagged. All groups appear healthy.",
        ),
      ),
    );
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

  const rooms = getRooms();
  const otherRoomsResolved = rooms.map((r) => resolveRoomGroups(r, groups));
  const otherRoomJidStrings = new Set(
    otherRoomsResolved.flatMap((res) => res.activeJidStrings),
  );
  const ignoredJids = getIgnoredJidSet();

  const availableGroups = groups.filter(
    (g) =>
      !otherRoomJidStrings.has(g.jidString) &&
      !ignoredJids.has(g.jidString.toLowerCase()),
  );

  if (availableGroups.length === 0) {
    console.log(
      pc.yellow(
        `\nNo groups available to add to new room '${cleanId}'. (All groups are already in other rooms or marked as ignored).\n`,
      ),
    );
    return null;
  }

  console.log(pc.cyan(`\n🏠 Creating Room '${pc.bold(cleanId)}'\n`));
  console.log(pc.dim("Select the WhatsApp groups to include in this room:"));

  const selectedGroupJidStrings = await searchCheckbox<string>({
    message: `Select groups for room '${cleanId}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices: availableGroups.map((g) => ({
      name: formatGroupLabel(g),
      value: g.jidString,
      category: g.communityName ?? "Standalone Groups",
    })),
  });

  const selectedGroups = groups.filter((g) =>
    selectedGroupJidStrings.includes(g.jidString),
  );
  const groupNames = selectedGroups.map((g) => g.subject);

  const targetList = cleanId;

  const room: Room = {
    id: cleanId,
    groupIds: selectedGroupJidStrings,
    groupJidRowIds: selectedGroupJidStrings,
    groupNames,
    targetList,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Room '${pc.bold(room.id)}' created successfully with ${selectedGroupJidStrings.length} groups! (List: ${room.id})\n`,
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
      choices: rooms.map((r) => {
        const ids = r.groupIds ?? r.groupJidRowIds ?? [];
        return {
          name: `${r.id} ${pc.dim(`(${ids.length} groups)`)}`,
          value: r.id,
        };
      }),
    });
  }

  const room = getRoomById(roomId);
  if (!room) return;

  const resolved = resolveRoomGroups(room, groups);

  const otherRoomsResolved = rooms
    .filter((r) => r.id.toLowerCase() !== room.id.toLowerCase())
    .map((r) => resolveRoomGroups(r, groups));

  const otherRoomJidStrings = new Set(
    otherRoomsResolved.flatMap((res) => res.activeJidStrings),
  );
  const existingJidStrings = new Set(resolved.activeJidStrings);
  const ignoredJids = getIgnoredJidSet();

  const availableGroups = groups.filter(
    (g) =>
      !existingJidStrings.has(g.jidString) &&
      !otherRoomJidStrings.has(g.jidString) &&
      !ignoredJids.has(g.jidString.toLowerCase()),
  );

  if (availableGroups.length === 0) {
    console.log(
      pc.yellow(
        `\nNo new groups available to add to room '${room.id}'. (All groups are already in this room, included in other rooms, or marked as ignored).\n`,
      ),
    );
    return;
  }

  const selectedGroupJidStrings = await searchCheckbox<string>({
    message: `Select groups to add to room '${room.id}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices: availableGroups.map((g) => ({
      name: formatGroupLabel(g),
      value: g.jidString,
      category: g.communityName ?? "Standalone Groups",
    })),
  });

  if (selectedGroupJidStrings.length === 0) {
    console.log(pc.yellow("\nNo groups were selected.\n"));
    return;
  }

  const selectedGroupObjects = groups.filter((g) =>
    selectedGroupJidStrings.includes(g.jidString),
  );

  const currentIds = room.groupIds ?? room.groupJidRowIds ?? [];
  room.groupIds = [...currentIds, ...selectedGroupJidStrings];
  room.groupJidRowIds = room.groupIds;
  room.groupNames = [
    ...(room.groupNames ?? []),
    ...selectedGroupObjects.map((g) => g.subject),
  ];

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Added ${selectedGroupJidStrings.length} group(s) to room '${pc.bold(room.id)}' (${room.groupIds.length} total groups now):`,
    ),
  );
  selectedGroupObjects.forEach((g, idx) => {
    console.log(
      `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${formatGroupLabel(g)}`,
    );
  });
  console.log("");
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
      choices: rooms.map((r) => {
        const ids = r.groupIds ?? r.groupJidRowIds ?? [];
        return {
          name: `${r.id} ${pc.dim(`(${ids.length} groups)`)}`,
          value: r.id,
        };
      }),
    });
  }

  const room = getRoomById(roomId);
  if (!room) return;

  const resolved = resolveRoomGroups(room, groups);

  if (resolved.resolvedItems.length === 0) {
    console.log(pc.yellow(`\nRoom '${room.id}' has no groups to remove.\n`));
    return;
  }

  const sortedItems = [...resolved.resolvedItems].sort((a, b) => {
    if (a.isMissing !== b.isMissing) return a.isMissing ? 1 : -1;

    const isCommA = Boolean(a.communityName);
    const isCommB = Boolean(b.communityName);
    if (isCommA !== isCommB) return isCommA ? -1 : 1;

    if (
      a.communityName &&
      b.communityName &&
      a.communityName !== b.communityName
    ) {
      return a.communityName.localeCompare(b.communityName, undefined, {
        sensitivity: "base",
      });
    }

    if (a.communityName && b.communityName) {
      const typeRank = (g: typeof a) => {
        if (g.isCommunityRoot ?? g.groupType === 1) return 1;
        if (g.isAnnouncement ?? g.groupType === 3) return 2;
        if (g.isSubgroup ?? (g.groupType === 2 || g.groupType === 6)) return 3;
        return 4;
      };
      const rankDiff = typeRank(a) - typeRank(b);
      if (rankDiff !== 0) return rankDiff;
    }

    return a.subject.localeCompare(b.subject, undefined, {
      sensitivity: "base",
    });
  });

  const choices = sortedItems.map((item) => {
    if (!item.isMissing) {
      return {
        name: formatGroupLabel(item),
        value: item.id,
        category: item.communityName ?? "Standalone Groups",
      };
    }
    return {
      name: `${pc.red("[⚠️ MISSING / EXITED]")} ${pc.strikethrough(pc.dim(item.subject))} ${pc.dim(`(ID: ${item.id})`)}`,
      value: item.id,
      category: "Missing / Exited Groups",
    };
  });

  const selectedIdsToRemove = await searchCheckbox<string | number>({
    message: `Select groups to remove from room '${room.id}' (Type to filter, Space to check, Enter to submit):`,
    pageSize: 16,
    required: true,
    choices,
  });

  if (selectedIdsToRemove.length === 0) {
    console.log(pc.yellow("\nNo groups were selected for removal.\n"));
    return;
  }

  const removeSet = new Set(selectedIdsToRemove);
  const remainingIds: (string | number)[] = [];
  const remainingNames: string[] = [];

  resolved.resolvedItems.forEach((item) => {
    if (!removeSet.has(item.id)) {
      remainingIds.push(item.id);
      remainingNames.push(item.subject);
    }
  });

  room.groupIds = remainingIds;
  room.groupJidRowIds = remainingIds;
  room.groupNames = remainingNames;

  saveRoom(room);

  console.log(
    pc.green(
      `\n✅ Removed ${selectedIdsToRemove.length} group(s) from room '${room.id}' (${room.groupIds.length} groups remaining).\n`,
    ),
  );
}

export async function manageRoomsMenu(groups: GroupSummary[]): Promise<void> {
  while (true) {
    const rooms = getRooms();
    const action = await select<"list" | "add" | "remove" | "ignored" | "exit">(
      {
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
          { name: "🚫 View ignored groups", value: "ignored" as const },
          { name: "🔙 Exit room manager", value: "exit" },
        ],
      },
    );

    if (action === "list") {
      printRoomsTable(rooms, groups);
    } else if (action === "add") {
      await addGroupsToRoomInteractive(groups);
    } else if (action === "remove") {
      await removeGroupsFromRoomInteractive(groups);
    } else if (action === "ignored") {
      printIgnoredGroups(groups);
    } else if (action === "exit") {
      break;
    }
  }
}
