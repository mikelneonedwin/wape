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
import { formatGroupLabel } from "./room-manager";

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
      isCommunityRoot: live?.isCommunityRoot,
      isAnnouncement: live?.isAnnouncement,
      isSubgroup: live?.isSubgroup,
      isStandalone: live?.isStandalone,
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

  choices.sort((a, b) => {
    const isStandA = a.category === "Standalone Groups";
    const isStandB = b.category === "Standalone Groups";
    if (isStandA !== isStandB) return isStandA ? 1 : -1;
    if (a.category && b.category && a.category !== b.category) {
      return a.category.localeCompare(b.category, undefined, {
        sensitivity: "base",
      });
    }

    const liveA = groupsByJid.get(a.value.toLowerCase());
    const liveB = groupsByJid.get(b.value.toLowerCase());
    const typeRank = (g?: GroupSummary) => {
      if (!g) return 4;
      if (g.isCommunityRoot ?? g.groupType === 1) return 1;
      if (g.isAnnouncement ?? g.groupType === 3) return 2;
      if (g.isSubgroup ?? (g.groupType === 2 || g.groupType === 6)) return 3;
      return 4;
    };
    const rankDiff = typeRank(liveA) - typeRank(liveB);
    if (rankDiff !== 0) return rankDiff;

    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
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
      isCommunityRoot?: boolean;
      isAnnouncement?: boolean;
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
      isCommunityRoot: live?.isCommunityRoot,
      isAnnouncement: live?.isAnnouncement,
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
    commItems.sort((a, b) => {
      const typeRank = (x: typeof a) => {
        if (x.isCommunityRoot) return 1;
        if (x.isAnnouncement) return 2;
        return 3;
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
      const isRoot = item.isCommunityRoot;
      const isAnn = item.isAnnouncement;
      const countLabel =
        item.participantCount !== undefined
          ? ` ${pc.dim(`(${item.participantCount.toLocaleString()}${isRoot ? " total" : ""} members)`)}`
          : "";
      const missingBadge = item.isMissing
        ? ` ${pc.red("[⚠️ NOT IN CURRENT BACKUP]")}`
        : "";

      if (isRoot) {
        console.log(
          `    ${num} ${pc.magenta(pc.bold("[Community Record]"))} ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
        );
      } else if (isAnn) {
        console.log(
          `    ${num} └─ ${pc.yellow("[Announcement]")} ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
        );
      } else {
        console.log(
          `    ${num} └─ ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
        );
      }
    }
    console.log("");
  }

  if (standaloneItems.length > 0) {
    standaloneItems.sort((a, b) =>
      a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }),
    );

    if (sortedCommunityNames.length > 0) {
      console.log(`  ${pc.bold(pc.dim("📁 Standalone Groups"))}`);
    }

    for (const item of standaloneItems) {
      const num = pc.dim(globalIndex.toString().padStart(3, " ") + ".");
      globalIndex++;
      const countLabel =
        item.participantCount !== undefined
          ? ` ${pc.dim(`(${item.participantCount.toLocaleString()} members)`)}`
          : "";
      const missingBadge = item.isMissing
        ? ` ${pc.red("[⚠️ NOT IN CURRENT BACKUP]")}`
        : "";
      console.log(
        `  ${num} • ${item.subject}${countLabel}${missingBadge} ${pc.dim(`(${item.jid})`)}`,
      );
    }
    console.log("");
  }

  console.log("=".repeat(75) + "\n");
}

export async function ignoreAuditItemsInteractive(
  items: {
    jidString: string;
    subject: string;
    communityName: string | null;
    participantCount?: number;
    isCommunityRoot?: boolean;
    isAnnouncement?: boolean;
    isSubgroup?: boolean;
    isStandalone?: boolean;
  }[],
): Promise<void> {
  const ignoredJids = getIgnoredJidSet();
  const unignored = items.filter(
    (item) => !ignoredJids.has(item.jidString.toLowerCase()),
  );

  if (unignored.length === 0) {
    console.log(
      pc.yellow(
        "\nAll flagged items are already in your ignored groups list.\n",
      ),
    );
    return;
  }

  // Sort unignored items so communities and groups are grouped and ordered properly:
  // 1. Communities first (alphabetical by communityName), Standalone at the bottom
  // 2. Within each community:
  //    - Community Root FIRST
  //    - Announcement Group SECOND
  //    - Subgroups THIRD (alphabetical by subject)
  // 3. Within Standalone Groups: alphabetical by subject
  unignored.sort((a, b) => {
    const isCommA = Boolean(a.communityName);
    const isCommB = Boolean(b.communityName);
    if (isCommA !== isCommB) {
      return isCommA ? -1 : 1;
    }
    if (
      a.communityName &&
      b.communityName &&
      a.communityName !== b.communityName
    ) {
      return a.communityName.localeCompare(b.communityName, undefined, {
        sensitivity: "base",
      });
    }
    const typeRank = (x: typeof a) => {
      if (x.isCommunityRoot) return 1;
      if (x.isAnnouncement) return 2;
      if (x.isSubgroup) return 3;
      return 4;
    };
    const rankDiff = typeRank(a) - typeRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.subject.localeCompare(b.subject, undefined, {
      sensitivity: "base",
    });
  });

  const selectedJids = await searchCheckbox<string>({
    message:
      "Select groups to ignore from future audits (Type to filter, Space to check, Enter to submit):",
    pageSize: 16,
    required: false,
    choices: unignored.map((item) => ({
      name: formatGroupLabel(item),
      value: item.jidString,
      category: item.communityName ?? "Standalone Groups",
    })),
  });

  if (selectedJids.length === 0) {
    console.log(pc.yellow("\nNo groups were selected to ignore.\n"));
    return;
  }

  const toAdd = unignored.filter((item) =>
    selectedJids.includes(item.jidString),
  );

  const { addedCount, totalCount } = addIgnoredGroups(
    toAdd.map((item) => ({
      jid: item.jidString,
      subject: item.subject,
      communityName: item.communityName,
    })),
  );

  console.log(
    pc.green(
      `\n🚫 Ignored ${addedCount} group(s) (${totalCount} total ignored groups now). They will be excluded from future audits.\n`,
    ),
  );
}
