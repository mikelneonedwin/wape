import pc from "picocolors";
import { resolveRoomGroups, type GroupSummary } from "../services/extractor";
import {
  addIgnoredGroups,
  getIgnoredGroups,
  getIgnoredJidSet,
  getRooms,
  removeIgnoredGroups,
} from "../services/wape-store";
import { searchCheckbox } from "./search-checkbox";

function formatGroupLabel(group: {
  subject: string;
  communityName: string | null;
  participantCount?: number;
}): string {
  const countLabel =
    group.participantCount !== undefined
      ? ` ${pc.dim(`(${group.participantCount} members)`)}`
      : "";
  if (group.communityName) {
    return `${pc.cyan(`[🏛️ ${group.communityName}]`)} └─ ${group.subject}${countLabel}`;
  }
  return `${pc.dim("[Standalone]")} • ${group.subject}${countLabel}`;
}

export async function ignoreGroupsInteractive(
  groups: GroupSummary[],
): Promise<void> {
  const ignoredJids = getIgnoredJidSet();
  const rooms = getRooms();
  const roomJids = new Set(
    rooms.flatMap((r) => resolveRoomGroups(r, groups).activeJidStrings),
  );

  const availableGroups = groups.filter(
    (g) =>
      !ignoredJids.has(g.jidString.toLowerCase()) && !roomJids.has(g.jidString),
  );

  if (availableGroups.length === 0) {
    console.log(
      pc.yellow(
        "\nNo groups available to ignore (all groups are already ignored or configured in rooms).\n",
      ),
    );
    return;
  }

  console.log(pc.cyan("\n🚫 Ignore Groups\n"));
  console.log(
    pc.dim(
      "Select groups to mark as ignored (they will be hidden from rooms and scans):",
    ),
  );

  const selectedJidStrings = await searchCheckbox<string>({
    message:
      "Select groups to mark as ignored (Type to filter, Space to check, Enter to submit):",
    pageSize: 16,
    required: true,
    choices: availableGroups.map((g) => ({
      name: formatGroupLabel(g),
      value: g.jidString,
      category: g.communityName ?? "Standalone Groups",
    })),
  });

  if (selectedJidStrings.length === 0) {
    console.log(pc.yellow("\nNo groups were selected.\n"));
    return;
  }

  const selectedGroups = groups.filter((g) =>
    selectedJidStrings.includes(g.jidString),
  );

  const { addedCount, totalCount } = addIgnoredGroups(
    selectedGroups.map((g) => ({
      jid: g.jidString,
      subject: g.subject,
      communityName: g.communityName,
    })),
  );

  console.log(
    pc.green(
      `\n🚫 Marked ${addedCount} group(s) as ignored (${totalCount} total ignored groups now):`,
    ),
  );
  selectedGroups.forEach((g, idx) => {
    console.log(
      `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${formatGroupLabel(g)}`,
    );
  });
  console.log("");
}

export async function unignoreGroupsInteractive(
  groups?: GroupSummary[],
): Promise<void> {
  const ignored = getIgnoredGroups();
  if (ignored.length === 0) {
    console.log(pc.yellow("\nNo ignored groups found.\n"));
    return;
  }

  const groupsByJid = new Map(
    groups?.map((g) => [g.jidString.toLowerCase(), g]),
  );

  const choices = ignored.map((ig) => {
    const live = groupsByJid.get(ig.jid.toLowerCase());
    const label = formatGroupLabel({
      subject: live?.subject ?? ig.subject,
      communityName: live ? live.communityName : (ig.communityName ?? null),
      participantCount: live?.participantCount,
    });
    return {
      name: live
        ? label
        : `${pc.dim("[Stored]")} • ${ig.subject} ${pc.dim(`(JID: ${ig.jid})`)}`,
      value: ig.jid,
      category:
        (live ? live.communityName : ig.communityName) ?? "Standalone Groups",
    };
  });

  const selectedJids = await searchCheckbox<string>({
    message:
      "Select groups to unignore / restore (Type to filter, Space to check, Enter to submit):",
    pageSize: 16,
    required: true,
    choices,
  });

  if (selectedJids.length === 0) {
    console.log(pc.yellow("\nNo groups were selected.\n"));
    return;
  }

  const { removedCount, totalCount } = removeIgnoredGroups(selectedJids);

  console.log(
    pc.green(
      `\n✅ Unignored ${removedCount} group(s) (${totalCount} ignored groups remaining).\n`,
    ),
  );
}

export function printIgnoredGroups(groups?: GroupSummary[]): void {
  const ignored = getIgnoredGroups();
  if (ignored.length === 0) {
    console.log(
      pc.yellow(
        "\nNo groups currently ignored. Use 'wape ignore' to mark groups as ignored.\n",
      ),
    );
    return;
  }

  console.log(pc.cyan("\n" + "=".repeat(75)));
  console.log(
    pc.bold(pc.cyan(`🚫 IGNORED WAPE GROUPS (${ignored.length} total)`)),
  );
  console.log("=".repeat(75));

  const groupsByJid = new Map(
    groups?.map((g) => [g.jidString.toLowerCase(), g]),
  );

  const communityMap = new Map<
    string,
    Array<{
      jid: string;
      subject: string;
      participantCount?: number;
      isMissing?: boolean;
    }>
  >();
  const standaloneItems: Array<{
    jid: string;
    subject: string;
    participantCount?: number;
    isMissing?: boolean;
  }> = [];

  for (const ig of ignored) {
    const live = groupsByJid.get(ig.jid.toLowerCase());
    const comm = live ? live.communityName : ig.communityName;
    const item = {
      jid: ig.jid,
      subject: live ? live.subject : ig.subject,
      participantCount: live?.participantCount,
      isMissing: groups ? !live : false,
    };
    if (comm) {
      const list = communityMap.get(comm) ?? [];
      list.push(item);
      communityMap.set(comm, list);
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
    commItems.sort((a, b) =>
      a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }),
    );

    console.log(`  ${pc.cyan(pc.bold(`🏛️  ${commName}`))}`);
    for (const item of commItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;
      const countLabel =
        item.participantCount !== undefined
          ? ` ${pc.dim(`(${item.participantCount} members)`)}`
          : "";
      const missingBadge = item.isMissing
        ? ` ${pc.red("[⚠️ NOT IN CURRENT BACKUP]")}`
        : "";
      console.log(
        `    ${num} └─ ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
      );
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
      const countLabel =
        item.participantCount !== undefined
          ? ` ${pc.dim(`(${item.participantCount} members)`)}`
          : "";
      const missingBadge = item.isMissing
        ? ` ${pc.red("[⚠️ NOT IN CURRENT BACKUP]")}`
        : "";
      console.log(
        `  ${num} ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
      );
    }
    console.log("");
  }

  console.log("=".repeat(75) + "\n");
}
