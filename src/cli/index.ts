#!/usr/bin/env bun
import { input, select } from "@inquirer/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { getDatabase } from "../db";
import { ensureDecryptedDatabase } from "../services/decryptor";
import { extractNigerianNumbersFromGroups, fetchAllGroups } from "../services/extractor";
import {
  getCommonContacts,
  getGlobalInventory,
  getInventoryStats,
  mergeContactsIntoFile,
  readContactsFromFile,
  resolveTargetToList,
} from "../services/file-manager";
import { formatPhoneNumber } from "../services/phone";
import {
  createRoomInteractive,
  editRoomInteractive,
  printRoomDetail,
  printRoomsTable,
} from "./room-manager";
import { searchCheckbox } from "./search-checkbox";
import {
  deleteRoom,
  getAllKnownLists,
  getAppConfig,
  getLockListPath,
  getMainListPath,
  getRoomById,
  getRooms,
  renameRoomId,
  resolveListFilePath,
  saveAppConfig,
  type Room,
} from "../services/wape-store";

const program = new Command();

program
  .name("wape")
  .description("wape - WhatsApp Phone Number Extractor, Room Manager & List Aggregator")
  .version("1.0.0");

function formatGroupLabel(group: { subject: string; communityName: string | null; participantCount: number }): string {
  if (group.communityName) {
    return `${pc.cyan(`[🏛️ ${group.communityName}]`)} └─ ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
  }
  return `${pc.dim("[Standalone]")} • ${group.subject} ${pc.dim(`(${group.participantCount} members)`)}`;
}

async function loadDbAndGroups(backupPath?: string, backupKey?: string) {
  const dbPath = await ensureDecryptedDatabase({
    backupPath,
    backupKey,
  });
  const db = getDatabase(dbPath);
  const groups = await fetchAllGroups(db);
  return { db, groups };
}

/**
 * Execute scan and export on an array of group JID row IDs
 */
async function executeGroupExport(
  db: ReturnType<typeof getDatabase>,
  targetGroupJids: number[],
  selectedGroupLabels: string[],
  options?: {
    forcedTargetList?: string;
    roomContext?: Room | null;
  }
) {
  if (targetGroupJids.length === 0) {
    console.log(pc.yellow("No groups selected for scanning."));
    return;
  }

  // Confirmation view
  console.log(pc.cyan("\n" + "=".repeat(68)));
  console.log(pc.bold(pc.cyan(`📋 SELECTED GROUPS FOR EXPORT (${targetGroupJids.length} total):`)));
  console.log("=".repeat(68));
  selectedGroupLabels.forEach((label, idx) => {
    console.log(`  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${label}`);
  });
  console.log("=".repeat(68) + "\n");

  // Only ask for yes/no confirmation on ad-hoc group selections, skip for room scans
  if (!options?.roomContext) {
    const proceedAnswer = await input({
      message: `Proceed with extracting Nigerian contacts from these ${pc.bold(targetGroupJids.length)} group(s)? (yes/no):`,
      validate: (val) => {
        const v = val.trim().toLowerCase();
        if (v === "yes" || v === "y" || v === "no" || v === "n") return true;
        return "Please enter 'yes' (or 'y') to proceed, or 'no' (or 'n') to cancel.";
      },
    });

    if (!["yes", "y"].includes(proceedAnswer.trim().toLowerCase())) {
      console.log(pc.yellow("Operation cancelled."));
      return;
    }
  }

  let targetFilePath: string;

  if (options?.forcedTargetList) {
    targetFilePath = resolveListFilePath(options.forcedTargetList);
  } else if (options?.roomContext) {
    // Room scans automatically use the room's dedicated list (${room.id}.txt)
    const roomListFile = options.roomContext.targetList ?? `${options.roomContext.id}.txt`;
    targetFilePath = resolveListFilePath(roomListFile);
  } else {
    const listChoices = [
      {
        name: `Main File (${pc.bold(getMainListPath())})`,
        value: getMainListPath(),
        description: "Primary global contacts list in ~/.wape/lists/main.txt",
      },
      {
        name: `Lock File (${pc.bold(getLockListPath())})`,
        value: getLockListPath(),
        description: "Secondary/lock global contacts list in ~/.wape/lists/lock.txt",
      },
      {
        name: "Custom List (specify file name in ~/.wape/lists/)",
        value: "__custom__",
        description: "Create or append to a custom list file",
      },
    ];

    console.log("");
    const choice = await select<string>({
      message: "Select destination text file:",
      choices: listChoices,
    });

    if (choice === "__custom__") {
      const customName = await input({
        message: "Enter custom list name (e.g. leads.txt):",
        validate: (val) => (val.trim() ? true : "List name cannot be empty."),
      });
      targetFilePath = resolveListFilePath(customName.trim());
    } else {
      targetFilePath = choice;
    }
  }

  console.log(pc.dim("\nExtracting and sieving unique Nigerian phone numbers..."));
  const uniqueExtracts = await extractNigerianNumbersFromGroups(db, targetGroupJids);

  const mergeResult = mergeContactsIntoFile(targetFilePath, uniqueExtracts);

  console.log(pc.green("\n" + "=".repeat(52)));
  console.log(pc.bold(pc.green("                 EXPORT REPORT")));
  console.log("=".repeat(52));
  console.log(`${pc.bold("Target List File:")}        ${pc.cyan(targetFilePath)}`);
  console.log(`${pc.bold("Selected Groups:")}         ${targetGroupJids.length}`);
  console.log(`${pc.bold("Unique Extracts Made:")}    ${pc.yellow(mergeResult.uniqueExtractsCount.toLocaleString())}`);
  console.log(`${pc.bold("New Contacts Added:")}      ${pc.green("+" + mergeResult.addedCount.toLocaleString())}`);
  console.log(`${pc.bold("Total Contacts in File:")}  ${pc.magenta(mergeResult.totalCount.toLocaleString())}`);
  console.log("=".repeat(52) + "\n");
}

async function scanSingleRoom(
  db: ReturnType<typeof getDatabase>,
  groups: Awaited<ReturnType<typeof fetchAllGroups>>,
  room: Room,
  opts?: { main?: boolean; lock?: boolean }
) {
  const groupMap = new Map(groups.map((g) => [g.jidRowId, g]));
  const activeJids: number[] = [];
  const labels: string[] = [];
  const missingNames: string[] = [];

  room.groupJidRowIds.forEach((jid, idx) => {
    const g = groupMap.get(jid);
    if (g) {
      activeJids.push(jid);
      labels.push(formatGroupLabel(g));
    } else {
      const name = room.groupNames && room.groupNames[idx] ? room.groupNames[idx] : `JID ${jid}`;
      missingNames.push(name);
    }
  });

  console.log(pc.cyan(`\n🏠 Scanning Room '${pc.bold(room.id)}' (${activeJids.length} active groups)...`));

  if (missingNames.length > 0) {
    console.log(
      pc.yellow(
        `⚠️ Note: ${missingNames.length} group(s) in room '${room.id}' are missing/exited and will be skipped:`
      )
    );
    missingNames.forEach((name) => console.log(`   ${pc.red("•")} ${pc.strikethrough(pc.dim(name))}`));
  }

  if (activeJids.length === 0) {
    console.log(pc.yellow(`No active groups to scan in room '${room.id}'.\n`));
    return;
  }

  let forcedList: string | undefined;
  if (opts?.main) forcedList = getMainListPath();
  else if (opts?.lock) forcedList = getLockListPath();

  await executeGroupExport(db, activeJids, labels, {
    forcedTargetList: forcedList,
    roomContext: room,
  });
}

/**
 * Scan Command
 */
program
  .command("scan [target]")
  .description("Scan WhatsApp groups or a configured room and export unique Nigerian phone numbers")
  .option("-b, --backup <path>", "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)")
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .option("--main", "Force output to global main list")
  .option("--lock", "Force output to global lock list")
  .action(async (target?: string, options?: { backup?: string; key?: string; main?: boolean; lock?: boolean }) => {
    try {
      console.log(pc.cyan("\n📱 wape - WhatsApp Group Contact Scanner\n"));
      console.log(pc.dim("Decrypting / preparing SQLite database..."));
      const { db, groups } = await loadDbAndGroups(options?.backup, options?.key);

      if (groups.length === 0) {
        console.log(pc.yellow("No group chats found in the backup."));
        return;
      }

      const rooms = getRooms();
      let roomToScan: Room | null = null;

      if (target) {
        roomToScan = getRoomById(target);
        if (!roomToScan) {
          console.error(pc.red(`Room with ID '${target}' not found. Use 'wape rooms list' to see rooms.`));
          process.exit(1);
        }
      } else if (rooms.length > 0) {
        const scanMode = await select<"room" | "adhoc">({
          message: "Choose scan method:",
          choices: [
            {
              name: `🏠 Scan from a configured Room (${rooms.length} rooms available)`,
              value: "room",
            },
            {
              name: `🔍 Select ad-hoc groups on the fly (${groups.length} groups)`,
              value: "adhoc",
            },
          ],
        });

        if (scanMode === "room") {
          const pickedRoomId = await select<string>({
            message: "Select room to scan:",
            choices: rooms.map((r) => ({
              name: `${r.id} ${pc.dim(`(${r.groupJidRowIds.length} groups)`)}`,
              value: r.id,
            })),
          });
          roomToScan = getRoomById(pickedRoomId);
        }
      }

      if (roomToScan) {
        await scanSingleRoom(db, groups, roomToScan, {
          main: options?.main,
          lock: options?.lock,
        });
      } else {
        const targetJids = await searchCheckbox({
          message: "Select group chats (Type to filter, Space to check, Enter to submit):",
          pageSize: 16,
          required: true,
          choices: groups.map((g) => ({
            name: formatGroupLabel(g),
            value: g.jidRowId,
            category: g.communityName ?? "Standalone Groups",
          })),
        });

        const selectedGroups = groups.filter((g) => targetJids.includes(g.jidRowId));
        const selectedLabels = selectedGroups.map((g) => formatGroupLabel(g));

        let forcedList: string | undefined;
        if (options?.main) {
          forcedList = getMainListPath();
        } else if (options?.lock) {
          forcedList = getLockListPath();
        }

        await executeGroupExport(db, targetJids, selectedLabels, {
          forcedTargetList: forcedList,
        });
      }
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

/**
 * Room Management Commands
 */
const roomCmd = program.command("rooms").alias("room").description("Manage wape rooms (collections of WhatsApp groups)");

roomCmd
  .command("list", { isDefault: false })
  .description("List all configured rooms")
  .action(async () => {
    try {
      const { groups } = await loadDbAndGroups();
      printRoomsTable(getRooms(), groups);
    } catch {
      printRoomsTable(getRooms());
    }
  });

roomCmd
  .command("info [id]")
  .description("Show details of a room, including all groups and contact count in its list")
  .action(async (id?: string) => {
    try {
      const rooms = getRooms();
      if (rooms.length === 0) {
        console.log(pc.yellow("\nNo rooms found. Use 'wape room create' to create one.\n"));
        return;
      }

      let room: Room | null = null;
      if (id) {
        room = getRoomById(id);
        if (!room) {
          console.error(pc.red(`\n❌ Error: Room '${id}' not found. Use 'wape room list' to see all rooms.\n`));
          process.exit(1);
        }
      } else {
        const pickedRoomId = await select<string>({
          message: "Select room to inspect:",
          choices: rooms.map((r) => ({
            name: `${r.name} ${pc.dim(`[${r.id}] (${r.groupJidRowIds.length} groups)`)}`,
            value: r.id,
          })),
        });
        room = getRoomById(pickedRoomId);
      }

      if (!room) return;

      const { groups } = await loadDbAndGroups();
      printRoomDetail(room, groups);
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

roomCmd
  .command("create <id>")
  .alias("new")
  .alias("add")
  .description("Create a new room with the specified ID interactively")
  .action(async (id: string) => {
    try {
      const { groups } = await loadDbAndGroups();
      await createRoomInteractive(groups, id);
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

roomCmd
  .command("edit [id]")
  .description("Edit groups of a room")
  .action(async (id?: string) => {
    try {
      const { groups } = await loadDbAndGroups();
      await editRoomInteractive(groups, id);
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

roomCmd
  .command("rename <oldId> <newId>")
  .alias("reid")
  .alias("mv")
  .description("Assign a new ID to a room and rename its contact list file")
  .action((oldId: string, newId: string) => {
    const res = renameRoomId(oldId, newId);
    if (!res.success) {
      console.error(pc.red(`\n❌ Error: ${res.error}\n`));
      process.exit(1);
    }

    console.log(pc.green(`\n✅ Room '${oldId}' renamed to '${newId}' successfully.`));
    if (res.listRenamed) {
      console.log(pc.dim(`📁 Contact list file renamed from ~/.wape/lists/${oldId}.txt to ~/.wape/lists/${newId}.txt\n`));
    } else {
      console.log(pc.dim(`📁 List path updated to ~/.wape/lists/${newId}.txt\n`));
    }
  });

roomCmd
  .command("delete <id> [ids...]")
  .description("Delete one or more rooms by ID")
  .action((id: string, extraIds?: string[]) => {
    const allIds = [id, ...(extraIds ?? [])];
    for (const targetId of allIds) {
      const success = deleteRoom(targetId);
      if (success) {
        console.log(pc.green(`\n🗑️ Room '${targetId}' deleted successfully.`));
      } else {
        console.log(pc.yellow(`\nRoom '${targetId}' not found.`));
      }
    }
    console.log("");
  });

roomCmd
  .command("scan [ids...]")
  .description("Scan all configured rooms, or specific rooms by ID")
  .option("--main", "Force export to global main list")
  .option("--lock", "Force export to global lock list")
  .action(async (ids?: string[], opts?: { main?: boolean; lock?: boolean }) => {
    const allRooms = getRooms();
    if (allRooms.length === 0) {
      console.log(pc.yellow("\nNo rooms configured. Use 'wape rooms create <id>' first.\n"));
      return;
    }

    const { db, groups } = await loadDbAndGroups();

    if (!ids || ids.length === 0) {
      console.log(pc.cyan(`\n🏠 Scanning all ${allRooms.length} configured room(s)...\n`));
      for (const room of allRooms) {
        await scanSingleRoom(db, groups, room, opts);
      }
      return;
    }

    for (const id of ids) {
      const room = getRoomById(id);
      if (!room) {
        console.error(pc.red(`\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`));
        continue;
      }
      await scanSingleRoom(db, groups, room, opts);
    }
  });

// Default `wape room` without subcommands shows help
roomCmd.action(() => {
  roomCmd.outputHelp();
});

/**
 * Pair Contacts (Intersection) Command
 */
program
  .command("pair [targets...]")
  .description("Find and list common contacts across multiple lists or rooms in XXXX XXX XXXX format")
  .action((targets?: string[]) => {
    try {
      let resolvedTargets: { label: string; filePath: string }[] = [];

      if (!targets || targets.length === 0) {
        resolvedTargets = [
          { label: `Main (${getMainListPath()})`, filePath: getMainListPath() },
          { label: `Lock (${getLockListPath()})`, filePath: getLockListPath() },
        ];
      } else if (targets.length === 1) {
        console.error(pc.red(`\n❌ Error: Please provide at least two targets to pair.\n`));
        process.exit(1);
      } else {
        resolvedTargets = targets.map((t) => resolveTargetToList(t));
      }

      const commonContacts = getCommonContacts(resolvedTargets.map(t => t.filePath));

      console.log(pc.cyan(`\n🔍 Common Contacts Intersection Analysis`));
      resolvedTargets.forEach((t, idx) => {
        console.log(pc.dim(`Target ${idx + 1}: ${t.label}`));
      });
      console.log(pc.bold(pc.yellow(`\nFound ${commonContacts.length.toLocaleString()} common contact(s) across all targets:\n`)));

      for (const contact of commonContacts) {
        console.log(formatPhoneNumber(contact));
      }

      console.log(pc.bold(pc.green(`\nTotal Common Contacts: ${commonContacts.length.toLocaleString()}\n`)));
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

/**
 * Stats Command
 */
program
  .command("stats [targets...]")
  .description("Display stats: global overview or detailed comparison across targets")
  .action((targets?: string[]) => {
    try {
      if (!targets || targets.length === 0) {
        // Global inventory across all lists
        const globalSummary = getGlobalInventory();

        console.log(pc.cyan("\n📊 wape Global Lists Stats Summary (~/.wape/lists/)\n"));
        console.log("=".repeat(65));
        console.log(`${pc.bold("List Name".padEnd(35))} ${pc.bold("Contacts Count")}`);
        console.log("-".repeat(65));

        globalSummary.lists.forEach((list) => {
          console.log(`${pc.white(list.name.padEnd(35))} ${pc.yellow(list.count.toLocaleString().padStart(12))}`);
        });

        console.log("=".repeat(65));
        console.log(
          `${pc.bold(pc.green("Grand Unique Total (All Lists Combined):"))} ${pc.bold(pc.green(globalSummary.grandUniqueTotal.toLocaleString()))}`
        );
        console.log("=".repeat(65) + "\n");
        return;
      }

      if (targets.length === 1 && targets[0]) {
        // Stats for a single list
        const target = resolveTargetToList(targets[0]);
        const contacts = readContactsFromFile(target.filePath);
        
        console.log(pc.cyan("\n📊 Single List Stats\n"));
        console.log("=".repeat(65));
        console.log(`${pc.bold(target.label + ":")} ${pc.yellow(contacts.size.toLocaleString())} contacts`);
        console.log("=".repeat(65) + "\n");
        return;
      }

      if (targets.length === 2 && targets[0] && targets[1]) {
        const targetA = resolveTargetToList(targets[0]);
        const targetB = resolveTargetToList(targets[1]);

        const stats = getInventoryStats(targetA.filePath, targetB.filePath, targetA.label, targetB.label);

        console.log(pc.cyan("\n📊 Comparative Stats Analysis\n"));
        console.log("=".repeat(65));
        console.log(`${pc.bold(stats.labelA + ":")} ${pc.yellow(stats.countA.toLocaleString())}`);
        console.log(`${pc.bold(stats.labelB + ":")} ${pc.yellow(stats.countB.toLocaleString())}`);
        console.log("-".repeat(65));
        console.log(`${pc.bold("Common Contacts (Overlap):")}       ${pc.cyan(stats.commonCount.toLocaleString())}`);
        console.log(`${pc.bold("Unique Combined Total (Union):")}   ${pc.green(pc.bold(stats.unionCount.toLocaleString()))}`);
        console.log("=".repeat(65) + "\n");
        return;
      }

      // Multi-target summary (>2 targets)
      console.log(pc.cyan(`\n📊 Multi-Target Stats Breakdown (${targets.length} targets)\n`));
      console.log("=".repeat(65));
      const combinedUnion = new Set<string>();

      targets.forEach((target) => {
        const resolved = resolveTargetToList(target);
        const contacts = readContactsFromFile(resolved.filePath);
        for (const c of contacts) combinedUnion.add(c);
        console.log(`${pc.white(resolved.label.padEnd(45))} ${pc.yellow(contacts.size.toLocaleString().padStart(10))}`);
      });

      console.log("-".repeat(65));
      console.log(
        `${pc.bold(pc.green("Combined Unique Total:"))} ${pc.bold(pc.green(combinedUnion.size.toLocaleString()))}`
      );
      console.log("=".repeat(65) + "\n");
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });
/**
 * Print Command
 */
program
  .command("print <target>")
  .description("Print all phone numbers in a room or list in XXXX XXX XXXX format")
  .action((target: string) => {
    try {
      const resolved = resolveTargetToList(target);
      const contacts = readContactsFromFile(resolved.filePath);

      if (contacts.size === 0) {
        console.log(pc.yellow(`\nNo contacts found in ${resolved.label}.\n`));
        return;
      }

      for (const contact of contacts) {
        console.log(formatPhoneNumber(contact));
      }
    } catch (error) {
      console.error(pc.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

/**
 * Lists overview
 */
program
  .command("lists")
  .description("List all known contact files in ~/.wape/lists/ and their current contact counts")
  .action(() => {
    const knownLists = getAllKnownLists();
    console.log(pc.cyan("\n📁 wape Contact Lists Repository (~/.wape/lists/)\n"));
    console.log("=".repeat(65));
    knownLists.forEach((l) => {
      const contacts = readContactsFromFile(l.path);
      console.log(
        `  ${pc.bold(l.name.padEnd(25))} ${pc.yellow(contacts.size.toLocaleString().padStart(8))} contacts ${pc.dim(`(${l.path})`)}`
      );
    });
    console.log("=".repeat(65) + "\n");
  });

/**
 * Configuration Command
 */
const configCmd = program.command("config").description("View or update ~/.wape/config.json settings");

configCmd
  .command("get")
  .description("View current ~/.wape/config.json configuration")
  .action(() => {
    const cfg = getAppConfig();
    console.log(pc.cyan("\n⚙️  wape Configuration (~/.wape/config.json)\n"));
    console.log("=".repeat(65));
    console.log(`${pc.bold("Key:")}         ${cfg.key ? pc.yellow(cfg.key.slice(0, 12) + "..." + cfg.key.slice(-6)) : pc.dim("(not set)")}`);
    console.log(`${pc.bold("Backup Path:")} ${cfg.backupPath ? pc.green(cfg.backupPath) : pc.dim("(auto-discovery)")}`);
    console.log("=".repeat(65) + "\n");
  });

configCmd
  .command("set")
  .description("Set configuration values")
  .option("-k, --key <key>", "Decryption key (64 hex characters or base64)")
  .option("-b, --backup <path>", "Path to WhatsApp backup file")
  .action((opts: { key?: string; backup?: string }) => {
    if (!opts.key && !opts.backup) {
      console.log(pc.yellow("Please provide --key <key> or --backup <path> to set."));
      return;
    }
    const update: { key?: string; backupPath?: string } = {};
    if (opts.key) update.key = opts.key.trim();
    if (opts.backup) update.backupPath = opts.backup.trim();
    saveAppConfig(update);
    console.log(pc.green("\n✅ Configuration updated in ~/.wape/config.json\n"));
  });

configCmd.action(() => {
  configCmd.outputHelp();
});

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse(process.argv);
}
