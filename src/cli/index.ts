#!/usr/bin/env bun
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { input, select } from "@inquirer/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { getDatabase } from "../db";
import { ensureDecryptedDatabase } from "../services/decryptor";
import { copyToClipboard } from "../services/clipboard";
import {
  extractNigerianNumbersFromGroups,
  extractWhatsAppGroupLinks,
  fetchAllGroups,
  resolveRoomGroups,
  type GroupSummary,
} from "../services/extractor";
import {
  getCommonContacts,
  getComparisonDiff,
  getGlobalInventory,
  getInventoryStats,
  mergeContactsIntoFile,
  readContactsFromFile,
  resolveTargetToList,
  unmergeContactsFromFile,
} from "../services/file-manager";
import { formatPhoneNumber } from "../services/phone";
import {
  addGroupsToRoomInteractive,
  createRoomInteractive,
  printRoomDetail,
  printRoomGroups,
  printRoomsTable,
  removeGroupsFromRoomInteractive,
} from "./room-manager";
import {
  ignoreGroupsInteractive,
  printIgnoredGroups,
  unignoreGroupsInteractive,
} from "./ignore-manager";
import { searchCheckbox } from "./search-checkbox";
import {
  deleteRoom,
  getAllKnownLists,
  getAppConfig,
  getIgnoredJidSet,
  getLockListPath,
  getMainListPath,
  getRoomById,
  getRooms,
  getSavedLinks,
  getSavedLinksFile,
  getWapeConfigFile,
  getWapeListsDir,
  renameRoomId,
  resolveListFilePath,
  saveAppConfig,
  saveLinks,
  saveNotedComparison,
  type Room,
} from "../services/wape-store";

const program = new Command();

program
  .name("wape")
  .description(
    "wape - WhatsApp Phone Number Extractor, Room Manager & List Aggregator",
  )
  .version("1.0.0");

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
  },
) {
  if (targetGroupJids.length === 0) {
    console.log(pc.yellow("No groups selected for scanning."));
    return;
  }

  // Confirmation view - only show for ad-hoc group selections, skip for room scans to keep output concise
  if (!options?.roomContext) {
    console.log(pc.cyan("\n" + "=".repeat(68)));
    console.log(
      pc.bold(
        pc.cyan(
          `📋 SELECTED GROUPS FOR EXPORT (${targetGroupJids.length} total):`,
        ),
      ),
    );
    console.log("=".repeat(68));
    selectedGroupLabels.forEach((label, idx) => {
      console.log(
        `  ${pc.bold((idx + 1).toString().padStart(2, " "))}. ${label}`,
      );
    });
    console.log("=".repeat(68) + "\n");

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
    const roomListFile =
      options.roomContext.targetList ?? `${options.roomContext.id}.txt`;
    targetFilePath = resolveListFilePath(roomListFile);
  } else {
    const knownLists = getAllKnownLists();
    const listChoices = [
      {
        name: `Main File (${pc.bold(getMainListPath())})`,
        value: getMainListPath(),
        description: `Primary global contacts list in ${getMainListPath()}`,
      },
      {
        name: `Lock File (${pc.bold(getLockListPath())})`,
        value: getLockListPath(),
        description: `Secondary/lock global contacts list in ${getLockListPath()}`,
      },
      ...knownLists
        .filter((l) => !l.isGlobal)
        .map((l) => {
          const contacts = readContactsFromFile(l.path);
          return {
            name: `${pc.bold(l.name)} ${pc.yellow(`(${contacts.size.toLocaleString()} contacts)`)}`,
            value: l.path,
            description: l.path,
          };
        }),
      {
        name: `Custom List (specify file name in ${getWapeListsDir()}/)`,
        value: "__custom__",
        description: `Create or append to a custom list file in ${getWapeListsDir()}/`,
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

  console.log(
    pc.dim("\nExtracting and sieving unique Nigerian phone numbers..."),
  );
  const uniqueExtracts = await extractNigerianNumbersFromGroups(
    db,
    targetGroupJids,
  );

  const mergeResult = mergeContactsIntoFile(targetFilePath, uniqueExtracts);

  console.log(pc.green("\n" + "=".repeat(52)));
  console.log(pc.bold(pc.green("                 EXPORT REPORT")));
  console.log("=".repeat(52));
  console.log(
    `${pc.bold("Target List File:")}        ${pc.cyan(targetFilePath)}`,
  );
  console.log(
    `${pc.bold("Selected Groups:")}         ${targetGroupJids.length}`,
  );
  console.log(
    `${pc.bold("Unique Extracts Made:")}    ${pc.yellow(mergeResult.uniqueExtractsCount.toLocaleString())}`,
  );
  console.log(
    `${pc.bold("New Contacts Added:")}      ${pc.green("+" + mergeResult.addedCount.toLocaleString())}`,
  );
  console.log(
    `${pc.bold("Total Contacts in File:")}  ${pc.magenta(mergeResult.totalCount.toLocaleString())}`,
  );
  console.log("=".repeat(52) + "\n");
}

async function scanSingleRoom(
  db: ReturnType<typeof getDatabase>,
  groups: Awaited<ReturnType<typeof fetchAllGroups>>,
  room: Room,
  opts?: { main?: boolean; lock?: boolean; targetList?: string },
) {
  const resolved = resolveRoomGroups(room, groups);
  const activeJids = resolved.activeJidRowIds;
  const labels = resolved.resolvedItems
    .filter((i) => !i.isMissing)
    .map((i) => formatGroupLabel(i));
  const missingNames = resolved.resolvedItems
    .filter((i) => i.isMissing)
    .map((i) => i.subject);

  const missingBadge =
    missingNames.length > 0
      ? ` • ${pc.yellow(`${missingNames.length} missing/exited skipped`)}`
      : "";

  console.log(
    pc.cyan(
      `\n🏠 Scanning Room '${pc.bold(room.id)}' (${activeJids.length} active groups${missingBadge})...`,
    ),
  );

  if (activeJids.length === 0) {
    console.log(pc.yellow(`No active groups to scan in room '${room.id}'.\n`));
    return;
  }

  let forcedList: string | undefined;
  if (opts?.targetList) forcedList = resolveListFilePath(opts.targetList);
  else if (opts?.main) forcedList = getMainListPath();
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
  .description(
    "Scan WhatsApp groups or a configured room and export unique Nigerian phone numbers",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .option(
    "-t, --target-list <nameOrPath>",
    "Direct output to a specific list file or name",
  )
  .option("--main", "Force output to global main list")
  .option("--lock", "Force output to global lock list")
  .option("--include-ignored", "Include ignored groups in ad-hoc selection")
  .action(
    async (
      target?: string,
      options?: {
        backup?: string;
        key?: string;
        targetList?: string;
        main?: boolean;
        lock?: boolean;
        includeIgnored?: boolean;
      },
    ) => {
      try {
        console.log(pc.cyan("\n📱 wape - WhatsApp Group Contact Scanner\n"));
        console.log(pc.dim("Decrypting / preparing SQLite database..."));
        const { db, groups } = await loadDbAndGroups(
          options?.backup,
          options?.key,
        );

        if (groups.length === 0) {
          console.log(pc.yellow("No group chats found in the backup."));
          return;
        }

        const rooms = getRooms();
        let roomToScan: Room | null = null;

        if (target) {
          roomToScan = getRoomById(target);
          if (!roomToScan) {
            console.error(
              pc.red(
                `Room with ID '${target}' not found. Use 'wape rooms list' to see rooms.`,
              ),
            );
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
              choices: rooms.map((r) => {
                const count = (r.groupIds ?? r.groupJidRowIds ?? []).length;
                return {
                  name: `${r.id} ${pc.dim(`(${count} groups)`)}`,
                  value: r.id,
                };
              }),
            });
            roomToScan = getRoomById(pickedRoomId);
          }
        }

        if (roomToScan) {
          await scanSingleRoom(db, groups, roomToScan, {
            main: options?.main,
            lock: options?.lock,
            targetList: options?.targetList,
          });
        } else {
          const ignoredJids = getIgnoredJidSet();
          const availableGroups = options?.includeIgnored
            ? groups
            : groups.filter((g) => !ignoredJids.has(g.jidString.toLowerCase()));

          if (availableGroups.length === 0) {
            console.log(
              pc.yellow(
                "\nNo available groups found to scan. (All groups are marked as ignored; use --include-ignored to include them).\n",
              ),
            );
            return;
          }

          const targetJids = await searchCheckbox({
            message:
              "Select group chats (Type to filter, Space to check, Enter to submit):",
            pageSize: 16,
            required: true,
            choices: availableGroups.map((g) => ({
              name: formatGroupLabel(g),
              value: g.jidRowId,
              category: g.communityName ?? "Standalone Groups",
            })),
          });

          const selectedGroups = groups.filter((g) =>
            targetJids.includes(g.jidRowId),
          );
          const selectedLabels = selectedGroups.map((g) => formatGroupLabel(g));

          let forcedList: string | undefined;
          if (options?.targetList) {
            forcedList = resolveListFilePath(options.targetList);
          } else if (options?.main) {
            forcedList = getMainListPath();
          } else if (options?.lock) {
            forcedList = getLockListPath();
          }

          await executeGroupExport(db, targetJids, selectedLabels, {
            forcedTargetList: forcedList,
          });
        }
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

/**
 * One-off Command Group
 */
const oneoffCmd = program
  .command("oneoff")
  .description(
    "Scan a one-off WhatsApp backup database using a one-off decryption key without touching config.json",
  )
  .action(() => {
    oneoffCmd.outputHelp();
  });

oneoffCmd
  .command("scan [target]")
  .description(
    "Scan groups from a one-off WhatsApp backup and export Nigerian contacts",
  )
  .requiredOption(
    "-k, --key <key>",
    "Decryption key for the one-off backup (required)",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (optional, auto-discovers if omitted)",
  )
  .option(
    "-t, --target-list <nameOrPath>",
    "Direct output to a specific list file or name",
  )
  .option("--main", "Force output to global main list")
  .option("--lock", "Force output to global lock list")
  .action(
    async (
      target?: string,
      options?: {
        key: string;
        backup?: string;
        targetList?: string;
        main?: boolean;
        lock?: boolean;
      },
    ) => {
      try {
        console.log(
          pc.cyan("\n📱 wape - One-Off WhatsApp Backup Contact Scanner\n"),
        );
        console.log(
          pc.dim("Decrypting / preparing one-off SQLite database..."),
        );
        const { db, groups } = await loadDbAndGroups(
          options?.backup,
          options?.key,
        );

        if (groups.length === 0) {
          console.log(pc.yellow("No group chats found in the backup."));
          return;
        }

        let forcedList: string | undefined;
        if (options?.targetList) {
          forcedList = resolveListFilePath(options.targetList);
        } else if (options?.main) {
          forcedList = getMainListPath();
        } else if (options?.lock) {
          forcedList = getLockListPath();
        }

        let roomToScan: Room | null = null;

        if (target) {
          roomToScan = getRoomById(target);
          if (!roomToScan) {
            console.error(
              pc.red(
                `Room with ID '${target}' not found. Use 'wape rooms list' to see rooms.`,
              ),
            );
            process.exit(1);
          }
        }

        if (roomToScan) {
          await scanSingleRoom(db, groups, roomToScan, {
            main: options?.main,
            lock: options?.lock,
            targetList: options?.targetList,
          });
        } else {
          const targetJids = await searchCheckbox({
            message:
              "Select group chats (Type to filter, Space to check, Enter to submit):",
            pageSize: 16,
            required: true,
            choices: groups.map((g) => ({
              name: formatGroupLabel(g),
              value: g.jidRowId,
              category: g.communityName ?? "Standalone Groups",
            })),
          });

          const selectedGroups = groups.filter((g) =>
            targetJids.includes(g.jidRowId),
          );
          const selectedLabels = selectedGroups.map((g) => formatGroupLabel(g));

          await executeGroupExport(db, targetJids, selectedLabels, {
            forcedTargetList: forcedList,
          });
        }
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

oneoffCmd
  .command("links")
  .description(
    `Extract all newly found WhatsApp group invite links from a one-off backup, record them to ${getSavedLinksFile()}, print, and copy them`,
  )
  .requiredOption(
    "-k, --key <key>",
    "Decryption key for the one-off backup (required)",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (optional, auto-discovers if omitted)",
  )
  .action(async (options: { key: string; backup?: string }) => {
    try {
      const { db } = await loadDbAndGroups(options.backup, options.key);
      const allExtractedLinks = await extractWhatsAppGroupLinks(db);

      if (allExtractedLinks.length === 0) {
        console.log(
          pc.yellow("\nNo WhatsApp group invite links found in backup.\n"),
        );
        return;
      }

      const recordedLinks = new Set(getSavedLinks());
      const newLinks = allExtractedLinks.filter(
        (link) => !recordedLinks.has(link),
      );

      if (newLinks.length === 0) {
        console.log(
          pc.green(
            `\nAll ${allExtractedLinks.length} WhatsApp group invite links found in backup are already recorded in ${getSavedLinksFile()}.\n`,
          ),
        );
        return;
      }

      saveLinks(newLinks);

      const clipboardText = newLinks.join("\n");
      const copied = await copyToClipboard(clipboardText);

      for (const link of newLinks) {
        console.log(link);
      }

      if (copied) {
        console.log(
          pc.dim(
            `\n📋 Copied ${newLinks.length.toLocaleString()} newly found link(s) to clipboard.\n`,
          ),
        );
      }
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Room Management Commands
 */
const roomCmd = program
  .command("rooms")
  .description("Manage wape rooms (collections of WhatsApp groups)");

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
  .description(
    "Show details of a room, including all groups and contact count in its list",
  )
  .action(async (id?: string) => {
    try {
      const rooms = getRooms();
      if (rooms.length === 0) {
        console.log(
          pc.yellow(
            "\nNo rooms found. Use 'wape rooms new <id>' to create one.\n",
          ),
        );
        return;
      }

      let room: Room | null = null;
      if (id) {
        room = getRoomById(id);
        if (!room) {
          console.error(
            pc.red(
              `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
            ),
          );
          process.exit(1);
        }
      } else {
        const pickedRoomId = await select<string>({
          message: "Select room to inspect:",
          choices: rooms.map((r) => {
            const count = (r.groupIds ?? r.groupJidRowIds ?? []).length;
            return {
              name: `${r.id} ${pc.dim(`(${count} groups)`)}`,
              value: r.id,
            };
          }),
        });
        room = getRoomById(pickedRoomId);
      }

      if (!room) return;

      const { groups } = await loadDbAndGroups();
      printRoomDetail(room, groups);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("groups [id]")
  .description("Print out the WhatsApp groups configured in a room")
  .action(async (id?: string) => {
    try {
      const rooms = getRooms();
      if (rooms.length === 0) {
        console.log(
          pc.yellow(
            "\nNo rooms found. Use 'wape rooms new <id>' to create one.\n",
          ),
        );
        return;
      }

      let room: Room | null = null;
      if (id) {
        room = getRoomById(id);
        if (!room) {
          console.error(
            pc.red(
              `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
            ),
          );
          process.exit(1);
        }
      } else {
        const pickedRoomId = await select<string>({
          message: "Select room to view groups:",
          choices: rooms.map((r) => {
            const count = (r.groupIds ?? r.groupJidRowIds ?? []).length;
            return {
              name: `${r.id} ${pc.dim(`(${count} groups)`)}`,
              value: r.id,
            };
          }),
        });
        room = getRoomById(pickedRoomId);
      }

      if (!room) return;

      let groups: GroupSummary[] | undefined;
      try {
        const res = await loadDbAndGroups();
        groups = res.groups;
      } catch {
        // Backup / db might not be configured, will fall back to stored group names in room
      }

      printRoomGroups(room, groups);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("new <id>")
  .description("Create a new room with the specified ID interactively")
  .action(async (id: string) => {
    try {
      const { groups } = await loadDbAndGroups();
      await createRoomInteractive(groups, id);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("add [id]")
  .description("Add new groups to an existing room")
  .action(async (id?: string) => {
    try {
      const { groups } = await loadDbAndGroups();
      await addGroupsToRoomInteractive(groups, id);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("remove [id]")
  .description("Remove groups from an existing room")
  .action(async (id?: string) => {
    try {
      const { groups } = await loadDbAndGroups();
      await removeGroupsFromRoomInteractive(groups, id);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
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

    console.log(
      pc.green(`\n✅ Room '${oldId}' renamed to '${newId}' successfully.`),
    );
    if (res.listRenamed) {
      console.log(
        pc.dim(
          `📁 Contact list file renamed from ${resolveListFilePath(`${oldId}.txt`)} to ${resolveListFilePath(`${newId}.txt`)}\n`,
        ),
      );
    } else {
      console.log(
        pc.dim(
          `📁 List path updated to ${resolveListFilePath(`${newId}.txt`)}\n`,
        ),
      );
    }
  });

roomCmd
  .command("delete <id> [ids...]")
  .description("Delete one or more rooms by ID")
  .action(async (id: string, extraIds?: string[]) => {
    const allIds = [id, ...(extraIds ?? [])];
    for (const targetId of allIds) {
      const room = getRoomById(targetId);
      const listPath = resolveListFilePath(
        room?.targetList ?? `${targetId}.txt`,
      );
      const hasListFile = existsSync(listPath);

      const success = deleteRoom(targetId);
      if (success) {
        console.log(pc.green(`\n🗑️ Room '${targetId}' deleted successfully.`));

        if (hasListFile) {
          const deleteListAnswer = await input({
            message: `Delete associated contact list file (${pc.cyan(listPath)})? (yes/no):`,
            validate: (val) => {
              const v = val.trim().toLowerCase();
              if (v === "yes" || v === "y" || v === "no" || v === "n")
                return true;
              return "Please enter 'yes' (or 'y') or 'no' (or 'n').";
            },
          });

          if (["yes", "y"].includes(deleteListAnswer.trim().toLowerCase())) {
            try {
              unlinkSync(listPath);
              console.log(pc.dim(`📁 Deleted contact list file: ${listPath}`));
            } catch (err) {
              console.error(
                pc.red(
                  `Failed to delete list file: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
          }
        }
      } else {
        console.log(pc.yellow(`\nRoom '${targetId}' not found.`));
      }
    }
    console.log("");
  });

roomCmd
  .command("path <id>")
  .description("Get the absolute path to a room's contact list file")
  .action((id: string) => {
    const room = getRoomById(id);
    if (!room) {
      console.error(
        pc.red(
          `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
        ),
      );
      process.exit(1);
    }
    const listPath = resolveListFilePath(room.targetList ?? `${room.id}.txt`);
    console.log(listPath);
  });

roomCmd
  .command("patch <id> <files...>")
  .description(
    "Import and merge contacts from external text/vCard (.vcf) file(s) into a room's list",
  )
  .action((id: string, files: string[]) => {
    try {
      const room = getRoomById(id);
      if (!room) {
        console.error(
          pc.red(
            `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
          ),
        );
        process.exit(1);
      }

      const targetListPath = resolveListFilePath(
        room.targetList ?? `${room.id}.txt`,
      );
      const allNewContacts = new Set<string>();

      for (const f of files) {
        const resolvedPath = resolve(f);
        if (!existsSync(resolvedPath)) {
          console.error(
            pc.red(`\n❌ Error: File '${f}' not found at ${resolvedPath}\n`),
          );
          process.exit(1);
        }
        const contacts = readContactsFromFile(resolvedPath);
        for (const c of contacts) allNewContacts.add(c);
      }

      if (allNewContacts.size === 0) {
        console.log(
          pc.yellow(
            `\nNo valid Nigerian phone numbers found in the provided file(s).\n`,
          ),
        );
        return;
      }

      const mergeResult = mergeContactsIntoFile(targetListPath, allNewContacts);

      console.log(pc.green("\n" + "=".repeat(58)));
      console.log(pc.bold(pc.green(`        PATCH REPORT: Room '${room.id}'`)));
      console.log("=".repeat(58));
      console.log(
        `${pc.bold("Target List File:")}        ${pc.cyan(targetListPath)}`,
      );
      console.log(`${pc.bold("Source File(s):")}          ${files.join(", ")}`);
      console.log(
        `${pc.bold("Valid Extracts Found:")}    ${pc.yellow(mergeResult.uniqueExtractsCount.toLocaleString())}`,
      );
      console.log(
        `${pc.bold("New Contacts Added:")}      ${pc.green("+" + mergeResult.addedCount.toLocaleString())}`,
      );
      console.log(
        `${pc.bold("Total Contacts in Room:")}  ${pc.magenta(mergeResult.totalCount.toLocaleString())}`,
      );
      console.log("=".repeat(58) + "\n");
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("unpatch <id> <files...>")
  .description(
    "Remove contacts present in external text/vCard (.vcf) file(s) from a room's list",
  )
  .action((id: string, files: string[]) => {
    try {
      const room = getRoomById(id);
      if (!room) {
        console.error(
          pc.red(
            `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
          ),
        );
        process.exit(1);
      }

      const targetListPath = resolveListFilePath(
        room.targetList ?? `${room.id}.txt`,
      );
      const allRemoveContacts = new Set<string>();

      for (const f of files) {
        const resolvedPath = resolve(f);
        if (!existsSync(resolvedPath)) {
          console.error(
            pc.red(`\n❌ Error: File '${f}' not found at ${resolvedPath}\n`),
          );
          process.exit(1);
        }
        const contacts = readContactsFromFile(resolvedPath);
        for (const c of contacts) allRemoveContacts.add(c);
      }

      if (allRemoveContacts.size === 0) {
        console.log(
          pc.yellow(
            `\nNo valid Nigerian phone numbers found in the provided file(s) to unpatch.\n`,
          ),
        );
        return;
      }

      const unmergeResult = unmergeContactsFromFile(
        targetListPath,
        allRemoveContacts,
      );

      console.log(pc.yellow("\n" + "=".repeat(58)));
      console.log(
        pc.bold(pc.yellow(`       UNPATCH REPORT: Room '${room.id}'`)),
      );
      console.log("=".repeat(58));
      console.log(
        `${pc.bold("Target List File:")}        ${pc.cyan(targetListPath)}`,
      );
      console.log(`${pc.bold("Source File(s):")}          ${files.join(", ")}`);
      console.log(
        `${pc.bold("Valid Extracts Found:")}    ${pc.yellow(unmergeResult.uniqueExtractsCount.toLocaleString())}`,
      );
      console.log(
        `${pc.bold("Contacts Removed:")}        ${pc.red("-" + unmergeResult.removedCount.toLocaleString())}`,
      );
      console.log(
        `${pc.bold("Total Contacts in Room:")}  ${pc.magenta(unmergeResult.totalCount.toLocaleString())}`,
      );
      console.log("=".repeat(58) + "\n");
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("scan [ids...]")
  .description("Scan all configured rooms, or specific rooms by ID")
  .option("--main", "Force export to global main list")
  .option("--lock", "Force export to global lock list")
  .action(async (ids?: string[], opts?: { main?: boolean; lock?: boolean }) => {
    const allRooms = getRooms();
    if (allRooms.length === 0) {
      console.log(
        pc.yellow("\nNo rooms configured. Use 'wape rooms new <id>' first.\n"),
      );
      return;
    }

    const { db, groups } = await loadDbAndGroups();

    if (!ids || ids.length === 0) {
      console.log(
        pc.cyan(`\n🏠 Scanning all ${allRooms.length} configured room(s)...\n`),
      );
      for (const room of allRooms) {
        await scanSingleRoom(db, groups, room, opts);
      }
      return;
    }

    for (const id of ids) {
      const room = getRoomById(id);
      if (!room) {
        console.error(
          pc.red(
            `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
          ),
        );
        continue;
      }
      await scanSingleRoom(db, groups, room, opts);
    }
  });

async function executeCompare(
  targets: { label: string; filePath: string }[],
  title = "Common Contacts Intersection Analysis",
) {
  const filePaths = targets.map((t) => t.filePath);
  const diff = getComparisonDiff(filePaths);
  const newSet = new Set(diff.newContacts);

  console.log(pc.cyan(`\n🔍 ${title}`));
  targets.forEach((t, idx) => {
    console.log(pc.dim(`Target ${idx + 1}: ${t.label}`));
  });

  const newBadgeSummary =
    diff.newContacts.length > 0
      ? pc.green(` (${diff.newContacts.length.toLocaleString()} new)`)
      : "";

  console.log(
    pc.bold(
      pc.yellow(
        `\nFound ${diff.currentCommon.length.toLocaleString()} common contact(s) across all targets${newBadgeSummary}:\n`,
      ),
    ),
  );

  for (const contact of diff.currentCommon) {
    const isNew = newSet.has(contact);
    const badge = isNew ? `  ${pc.bold(pc.green("[NEW]"))}` : "";
    console.log(`${formatPhoneNumber(contact)}${badge}`);
  }

  const totalSummary =
    diff.newContacts.length > 0
      ? `Total Common Contacts: ${diff.currentCommon.length.toLocaleString()} (+${diff.newContacts.length.toLocaleString()} new)`
      : `Total Common Contacts: ${diff.currentCommon.length.toLocaleString()}`;

  console.log(pc.bold(pc.green(`\n${totalSummary}\n`)));

  // Automatically copy new contacts with [NEW] tag to clipboard, each on its own line
  if (diff.newContacts.length > 0) {
    const clipboardText = diff.newContacts
      .map((contact) => `${formatPhoneNumber(contact)}  [NEW]`)
      .join("\n");
    const copied = await copyToClipboard(clipboardText);
    if (copied) {
      console.log(
        pc.dim(
          `📋 Copied ${diff.newContacts.length.toLocaleString()} new contact(s) with [NEW] tag to clipboard.\n`,
        ),
      );
    }
  }

  // Automatically record / update the comparison record for future runs
  saveNotedComparison(filePaths, diff.currentCommon);
}

async function executeBundle(
  targets: { label: string; filePath: string }[],
  options?: {
    backup?: string;
    key?: string;
  },
) {
  const { db, groups } = await loadDbAndGroups(options?.backup, options?.key);

  // 1. General room scan (scan all configured rooms to update their list files)
  const allRooms = getRooms();
  if (allRooms.length > 0) {
    console.log(
      pc.cyan(`\n🏠 Scanning all ${allRooms.length} configured room(s)...\n`),
    );
    for (const room of allRooms) {
      await scanSingleRoom(db, groups, room);
    }
  }

  // 2. Calculate comparison diff (reads freshly updated room list files)
  const filePaths = targets.map((t) => t.filePath);
  const diff = getComparisonDiff(filePaths);
  const newContacts = diff.newContacts;

  // 3. Extract new group invite links from backup database
  const allExtractedLinks = await extractWhatsAppGroupLinks(db);
  const recordedLinks = new Set(getSavedLinks());
  const newLinks = allExtractedLinks.filter((link) => !recordedLinks.has(link));

  const formattedNewContacts = newContacts.map(
    (contact) => `${formatPhoneNumber(contact)}  [NEW]`,
  );

  for (const contactLine of formattedNewContacts) {
    console.log(contactLine);
  }

  for (const link of newLinks) {
    console.log(link);
  }

  const clipboardItems = [...formattedNewContacts, ...newLinks];
  let copied = false;
  if (clipboardItems.length > 0) {
    copied = await copyToClipboard(clipboardItems.join("\n"));
  }

  saveNotedComparison(filePaths, diff.currentCommon);
  if (newLinks.length > 0) {
    saveLinks(newLinks);
  }

  if (clipboardItems.length === 0) {
    console.log(
      pc.yellow(
        "\nNo new common contacts or new WhatsApp group invite links found.\n",
      ),
    );
  } else if (copied) {
    const parts: string[] = [];
    if (newContacts.length > 0) {
      parts.push(`${newContacts.length.toLocaleString()} new contact(s)`);
    }
    if (newLinks.length > 0) {
      parts.push(`${newLinks.length.toLocaleString()} new group link(s)`);
    }
    console.log(pc.dim(`\n📋 Copied ${parts.join(" and ")} to clipboard.\n`));
  }
}

roomCmd
  .command("compare [rooms...]")
  .description(
    "Find and list common contacts across rooms in XXXX XXX XXXX format",
  )
  .action(async (roomIds?: string[]) => {
    try {
      const allRooms = getRooms();
      let targetRooms: Room[] = [];

      if (!roomIds || roomIds.length === 0) {
        if (allRooms.length < 2) {
          console.error(
            pc.red(
              `\n❌ Error: Please provide at least two rooms to compare (or configure at least 2 rooms).\n`,
            ),
          );
          process.exit(1);
        }
        targetRooms = allRooms;
      } else if (roomIds.length === 1) {
        console.error(
          pc.red(`\n❌ Error: Please provide at least two rooms to compare.\n`),
        );
        process.exit(1);
      } else {
        for (const id of roomIds) {
          const r = getRoomById(id);
          if (!r) {
            console.error(
              pc.red(
                `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
              ),
            );
            process.exit(1);
          }
          targetRooms.push(r);
        }
      }

      const resolvedTargets = targetRooms.map((r) => {
        const filePath = resolveListFilePath(r.targetList ?? `${r.id}.txt`);
        return {
          label: `Room '${r.id}' (${filePath})`,
          filePath,
        };
      });

      await executeCompare(
        resolvedTargets,
        "Rooms Common Contacts Intersection Analysis",
      );
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

roomCmd
  .command("bundle [rooms...]")
  .description(
    "Compare rooms to extract only new common contacts alongside new WhatsApp group invite links, and copy both to clipboard",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(
    async (roomIds?: string[], options?: { backup?: string; key?: string }) => {
      try {
        const allRooms = getRooms();
        let targetRooms: Room[] = [];

        if (!roomIds || roomIds.length === 0) {
          if (allRooms.length < 2) {
            console.error(
              pc.red(
                `\n❌ Error: Please provide at least two rooms to bundle (or configure at least 2 rooms).\n`,
              ),
            );
            process.exit(1);
          }
          targetRooms = allRooms;
        } else if (roomIds.length === 1) {
          console.error(
            pc.red(
              `\n❌ Error: Please provide at least two rooms to bundle.\n`,
            ),
          );
          process.exit(1);
        } else {
          for (const id of roomIds) {
            const r = getRoomById(id);
            if (!r) {
              console.error(
                pc.red(
                  `\n❌ Error: Room '${id}' not found. Use 'wape rooms list' to see all rooms.\n`,
                ),
              );
              process.exit(1);
            }
            targetRooms.push(r);
          }
        }

        const resolvedTargets = targetRooms.map((r) => {
          const filePath = resolveListFilePath(r.targetList ?? `${r.id}.txt`);
          return {
            label: `Room '${r.id}' (${filePath})`,
            filePath,
          };
        });

        await executeBundle(resolvedTargets, options);
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

// Default `wape rooms` without subcommands shows help
roomCmd.action(() => {
  roomCmd.outputHelp();
});

/**
 * Compare Contacts (Intersection) Command
 */
program
  .command("compare [targets...]")
  .description(
    "Find and list common contacts across multiple lists or rooms in XXXX XXX XXXX format",
  )
  .action(async (targets?: string[]) => {
    try {
      let resolvedTargets: { label: string; filePath: string }[] = [];

      if (!targets || targets.length === 0) {
        resolvedTargets = [
          { label: `Main (${getMainListPath()})`, filePath: getMainListPath() },
          { label: `Lock (${getLockListPath()})`, filePath: getLockListPath() },
        ];
      } else if (targets.length === 1) {
        console.error(
          pc.red(
            `\n❌ Error: Please provide at least two targets to compare.\n`,
          ),
        );
        process.exit(1);
      } else {
        resolvedTargets = targets.map((t) => resolveTargetToList(t));
      }

      await executeCompare(
        resolvedTargets,
        "Common Contacts Intersection Analysis",
      );
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Bundle Command
 */
program
  .command("bundle [targets...]")
  .description(
    "Compare rooms or lists to extract only new common contacts alongside new WhatsApp group invite links, and copy both to clipboard",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(
    async (
      targets?: string[],
      options?: {
        backup?: string;
        key?: string;
      },
    ) => {
      try {
        let resolvedTargets: { label: string; filePath: string }[] = [];

        if (!targets || targets.length === 0) {
          const allRooms = getRooms();
          if (allRooms.length >= 2) {
            resolvedTargets = allRooms.map((r) => {
              const filePath = resolveListFilePath(
                r.targetList ?? `${r.id}.txt`,
              );
              return {
                label: `Room '${r.id}' (${filePath})`,
                filePath,
              };
            });
          } else {
            resolvedTargets = [
              {
                label: `Main (${getMainListPath()})`,
                filePath: getMainListPath(),
              },
              {
                label: `Lock (${getLockListPath()})`,
                filePath: getLockListPath(),
              },
            ];
          }
        } else if (targets.length === 1) {
          console.error(
            pc.red(
              `\n❌ Error: Please provide at least two targets to bundle.\n`,
            ),
          );
          process.exit(1);
        } else {
          resolvedTargets = targets.map((t) => resolveTargetToList(t));
        }

        await executeBundle(resolvedTargets, options);
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

/**
 * Stats Command
 */
program
  .command("stats [targets...]")
  .description(
    "Display stats: global overview or detailed comparison across targets",
  )
  .action((targets?: string[]) => {
    try {
      if (!targets || targets.length === 0) {
        // Global inventory across all lists
        const globalSummary = getGlobalInventory();

        console.log(
          pc.cyan(
            `\n📊 wape Global Lists Stats Summary (${getWapeListsDir()}/)\n`,
          ),
        );
        console.log("=".repeat(65));
        console.log(
          `${pc.bold("List Name".padEnd(35))} ${pc.bold("Contacts Count")}`,
        );
        console.log("-".repeat(65));

        globalSummary.lists.forEach((list) => {
          console.log(
            `${pc.white(list.name.padEnd(35))} ${pc.yellow(list.count.toLocaleString().padStart(12))}`,
          );
        });

        console.log("=".repeat(65));
        console.log(
          `${pc.bold(pc.green("Grand Unique Total (All Lists Combined):"))} ${pc.bold(pc.green(globalSummary.grandUniqueTotal.toLocaleString()))}`,
        );
        console.log("=".repeat(65) + "\n");
        return;
      }

      if (targets.length === 1 && targets[0]) {
        // Stats for a single list
        const target = resolveTargetToList(targets[0]);
        const contacts = readContactsFromFile(target.filePath);

        console.log(pc.cyan("\n" + "=".repeat(65)));
        console.log(
          pc.bold(pc.cyan(`📊 STATS: ${target.label.toUpperCase()}`)),
        );
        console.log("=".repeat(65));
        console.log(
          `${pc.bold("Target File:")}         ${pc.green(target.filePath)}`,
        );
        console.log(
          `${pc.bold("Total Unique Contacts:")} ${pc.magenta(contacts.size.toLocaleString())}`,
        );
        console.log("=".repeat(65) + "\n");
        return;
      }

      // Comparison across multiple targets
      const filePaths = targets.map((t) => resolveTargetToList(t).filePath);
      const labels = targets.map((t) => resolveTargetToList(t).label);

      if (filePaths.length === 2 && filePaths[0] && filePaths[1]) {
        const stats = getInventoryStats(filePaths[0], filePaths[1]);
        const [labelA, labelB] = labels;

        console.log(pc.cyan("\n" + "=".repeat(65)));
        console.log(pc.bold(pc.cyan("📊 TWO-WAY LIST COMPARISON")));
        console.log("=".repeat(65));
        console.log(
          `  ${pc.bold(labelA?.padEnd(28) ?? "List A")}: ${pc.yellow(stats.countA.toLocaleString().padStart(8))} contacts ${pc.dim(`(${filePaths[0]})`)}`,
        );
        console.log(
          `  ${pc.bold(labelB?.padEnd(28) ?? "List B")}: ${pc.yellow(stats.countB.toLocaleString().padStart(8))} contacts ${pc.dim(`(${filePaths[1]})`)}`,
        );
        console.log("-".repeat(65));
        console.log(
          `  ${pc.bold(pc.green("Common to Both (Intersection):"))}  ${pc.bold(pc.green(stats.commonCount.toLocaleString().padStart(8)))} contacts`,
        );
        console.log(
          `  ${pc.bold(pc.magenta("Total Unique Combined (Union):"))}  ${pc.bold(pc.magenta(stats.unionCount.toLocaleString().padStart(8)))} contacts`,
        );
        console.log("=".repeat(65) + "\n");
        return;
      }

      // Multi-way comparison (3+ lists)
      const common = getCommonContacts(filePaths);
      const allUnique = new Set<string>();
      filePaths.forEach((f) => {
        const contacts = readContactsFromFile(f);
        contacts.forEach((c) => allUnique.add(c));
      });

      console.log(pc.cyan("\n" + "=".repeat(65)));
      console.log(
        pc.bold(
          pc.cyan(`📊 MULTI-LIST COMPARISON (${filePaths.length} lists)`),
        ),
      );
      console.log("=".repeat(65));
      filePaths.forEach((f, idx) => {
        const contacts = readContactsFromFile(f);
        console.log(
          `  ${pc.bold((labels[idx] ?? "").padEnd(28))}: ${pc.yellow(contacts.size.toLocaleString().padStart(8))} contacts ${pc.dim(`(${f})`)}`,
        );
      });
      console.log("-".repeat(65));
      console.log(
        `  ${pc.bold(pc.green("Common to ALL Selected Lists:"))}    ${pc.bold(pc.green(common.length.toLocaleString().padStart(8)))} contacts`,
      );
      console.log(
        `  ${pc.bold(pc.magenta("Total Unique Combined (Union):"))}  ${pc.bold(pc.magenta(allUnique.size.toLocaleString().padStart(8)))} contacts`,
      );
      console.log("=".repeat(65) + "\n");
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Patch Command
 */
program
  .command("patch [args...]")
  .description(
    "Patch/import contacts from external text/vCard (.vcf) file(s) into global lists (--main, --lock) or a room/list target",
  )
  .option("--main", `Patch into global main list (${getMainListPath()})`)
  .option("--lock", `Patch into global lock list (${getLockListPath()})`)
  .action(
    (args: string[] = [], opts: { main?: boolean; lock?: boolean } = {}) => {
      try {
        let targetLabel = "";
        let targetListPath = "";
        let fileArgs: string[] = [];

        if (opts.main && opts.lock) {
          console.error(
            pc.red(
              "\n❌ Error: Cannot specify both --main and --lock simultaneously.\n",
            ),
          );
          process.exit(1);
        }

        if (opts.main) {
          targetLabel = "Global Main List (main.txt)";
          targetListPath = getMainListPath();
          fileArgs = args;
        } else if (opts.lock) {
          targetLabel = "Global Lock List (lock.txt)";
          targetListPath = getLockListPath();
          fileArgs = args;
        } else {
          if (args.length < 2) {
            console.error(
              pc.red(
                "\n❌ Error: Please specify a target list/room and at least one source file.\n" +
                  "   Usage: wape patch --main <file1.txt> [file2.txt...]\n" +
                  "          wape patch --lock <file1.txt> [file2.txt...]\n" +
                  "          wape patch <target> <file1.txt> [file2.txt...]\n",
              ),
            );
            process.exit(1);
          }
          const [targetArg, ...restFiles] = args;
          if (!targetArg) {
            console.error(
              pc.red("\n❌ Error: Please specify a target list or room.\n"),
            );
            process.exit(1);
          }
          const resolved = resolveTargetToList(targetArg);
          targetLabel = resolved.label;
          targetListPath = resolved.filePath;
          fileArgs = restFiles;
        }

        if (fileArgs.length === 0) {
          console.error(
            pc.red(
              "\n❌ Error: At least one source text file must be specified.\n" +
                "   Usage: wape patch --main <file1.txt> [file2.txt...]\n" +
                "          wape patch --lock <file1.txt> [file2.txt...]\n" +
                "          wape patch <target> <file1.txt> [file2.txt...]\n",
            ),
          );
          process.exit(1);
        }

        const allNewContacts = new Set<string>();

        for (const f of fileArgs) {
          const resolvedPath = resolve(f);
          if (!existsSync(resolvedPath)) {
            console.error(
              pc.red(`\n❌ Error: File '${f}' not found at ${resolvedPath}\n`),
            );
            process.exit(1);
          }
          const contacts = readContactsFromFile(resolvedPath);
          for (const c of contacts) allNewContacts.add(c);
        }

        if (allNewContacts.size === 0) {
          console.log(
            pc.yellow(
              "\nNo valid Nigerian phone numbers found in the provided file(s).\n",
            ),
          );
          return;
        }

        const mergeResult = mergeContactsIntoFile(
          targetListPath,
          allNewContacts,
        );

        console.log(pc.green("\n" + "=".repeat(58)));
        console.log(pc.bold(pc.green(`        PATCH REPORT: ${targetLabel}`)));
        console.log("=".repeat(58));
        console.log(
          `${pc.bold("Target List File:")}        ${pc.cyan(targetListPath)}`,
        );
        console.log(
          `${pc.bold("Source File(s):")}          ${fileArgs.join(", ")}`,
        );
        console.log(
          `${pc.bold("Valid Extracts Found:")}    ${pc.yellow(mergeResult.uniqueExtractsCount.toLocaleString())}`,
        );
        console.log(
          `${pc.bold("New Contacts Added:")}      ${pc.green("+" + mergeResult.addedCount.toLocaleString())}`,
        );
        console.log(
          `${pc.bold("Total Contacts in List:")}  ${pc.magenta(mergeResult.totalCount.toLocaleString())}`,
        );
        console.log("=".repeat(58) + "\n");
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

/**
 * Unpatch Command
 */
program
  .command("unpatch [args...]")
  .description(
    "Unpatch/remove contacts present in external text/vCard (.vcf) file(s) from global lists (--main, --lock) or a room/list target",
  )
  .option("--main", `Unpatch from global main list (${getMainListPath()})`)
  .option("--lock", `Unpatch from global lock list (${getLockListPath()})`)
  .action(
    (args: string[] = [], opts: { main?: boolean; lock?: boolean } = {}) => {
      try {
        let targetLabel = "";
        let targetListPath = "";
        let fileArgs: string[] = [];

        if (opts.main && opts.lock) {
          console.error(
            pc.red(
              "\n❌ Error: Cannot specify both --main and --lock simultaneously.\n",
            ),
          );
          process.exit(1);
        }

        if (opts.main) {
          targetLabel = "Global Main List (main.txt)";
          targetListPath = getMainListPath();
          fileArgs = args;
        } else if (opts.lock) {
          targetLabel = "Global Lock List (lock.txt)";
          targetListPath = getLockListPath();
          fileArgs = args;
        } else {
          if (args.length < 2) {
            console.error(
              pc.red(
                "\n❌ Error: Please specify a target list/room and at least one source file to unpatch.\n" +
                  "   Usage: wape unpatch --main <file1.vcf> [file2.vcf...]\n" +
                  "          wape unpatch --lock <file1.vcf> [file2.vcf...]\n" +
                  "          wape unpatch <target> <file1.vcf> [file2.vcf...]\n",
              ),
            );
            process.exit(1);
          }
          const [targetArg, ...restFiles] = args;
          if (!targetArg) {
            console.error(
              pc.red("\n❌ Error: Please specify a target list or room.\n"),
            );
            process.exit(1);
          }
          const resolved = resolveTargetToList(targetArg);
          targetLabel = resolved.label;
          targetListPath = resolved.filePath;
          fileArgs = restFiles;
        }

        if (fileArgs.length === 0) {
          console.error(
            pc.red(
              "\n❌ Error: At least one source file must be specified.\n" +
                "   Usage: wape unpatch --main <file1.vcf> [file2.vcf...]\n" +
                "          wape unpatch --lock <file1.vcf> [file2.vcf...]\n" +
                "          wape unpatch <target> <file1.vcf> [file2.vcf...]\n",
            ),
          );
          process.exit(1);
        }

        const allRemoveContacts = new Set<string>();

        for (const f of fileArgs) {
          const resolvedPath = resolve(f);
          if (!existsSync(resolvedPath)) {
            console.error(
              pc.red(`\n❌ Error: File '${f}' not found at ${resolvedPath}\n`),
            );
            process.exit(1);
          }
          const contacts = readContactsFromFile(resolvedPath);
          for (const c of contacts) allRemoveContacts.add(c);
        }

        if (allRemoveContacts.size === 0) {
          console.log(
            pc.yellow(
              "\nNo valid Nigerian phone numbers found in the provided file(s) to unpatch.\n",
            ),
          );
          return;
        }

        const unmergeResult = unmergeContactsFromFile(
          targetListPath,
          allRemoveContacts,
        );

        console.log(pc.yellow("\n" + "=".repeat(58)));
        console.log(
          pc.bold(pc.yellow(`       UNPATCH REPORT: ${targetLabel}`)),
        );
        console.log("=".repeat(58));
        console.log(
          `${pc.bold("Target List File:")}        ${pc.cyan(targetListPath)}`,
        );
        console.log(
          `${pc.bold("Source File(s):")}          ${fileArgs.join(", ")}`,
        );
        console.log(
          `${pc.bold("Valid Extracts Found:")}    ${pc.yellow(unmergeResult.uniqueExtractsCount.toLocaleString())}`,
        );
        console.log(
          `${pc.bold("Contacts Removed:")}        ${pc.red("-" + unmergeResult.removedCount.toLocaleString())}`,
        );
        console.log(
          `${pc.bold("Total Contacts in List:")}  ${pc.magenta(unmergeResult.totalCount.toLocaleString())}`,
        );
        console.log("=".repeat(58) + "\n");
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

/**
 * Print Command
 */
program
  .command("print <target>")
  .description(
    "Print all phone numbers in a room or list in XXXX XXX XXXX format",
  )
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
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Links Command
 */
program
  .command("links")
  .description(
    `Extract all newly found WhatsApp group invite links from all chats, record them to ${getSavedLinksFile()}, print, and copy them`,
  )
  .action(async () => {
    try {
      const { db } = await loadDbAndGroups();
      const allExtractedLinks = await extractWhatsAppGroupLinks(db);

      if (allExtractedLinks.length === 0) {
        console.log(
          pc.yellow("\nNo WhatsApp group invite links found in backup.\n"),
        );
        return;
      }

      const recordedLinks = new Set(getSavedLinks());
      const newLinks = allExtractedLinks.filter(
        (link) => !recordedLinks.has(link),
      );

      if (newLinks.length === 0) {
        console.log(
          pc.green(
            `\nAll ${allExtractedLinks.length} WhatsApp group invite links found in backup are already recorded in ${getSavedLinksFile()}.\n`,
          ),
        );
        return;
      }

      saveLinks(newLinks);

      const clipboardText = newLinks.join("\n");
      const copied = await copyToClipboard(clipboardText);

      // Print newly found links strictly one per line to terminal
      for (const link of newLinks) {
        console.log(link);
      }

      if (copied) {
        console.log(
          pc.dim(
            `\n📋 Copied ${newLinks.length.toLocaleString()} newly found link(s) to clipboard.\n`,
          ),
        );
      }
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Ignore Command
 */
program
  .command("ignore [action]")
  .description(
    "Mark WhatsApp groups as ignored so they are excluded from rooms and scans, or list them with 'wape ignore list'",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(
    async (
      action?: string,
      options?: {
        backup?: string;
        key?: string;
      },
    ) => {
      try {
        if (action?.toLowerCase() === "list") {
          let groups: GroupSummary[] | undefined;
          try {
            const res = await loadDbAndGroups(options?.backup, options?.key);
            groups = res.groups;
          } catch {
            // Backup not provided or not decryptable - fallback to stored metadata
          }
          printIgnoredGroups(groups);
          return;
        }

        console.log(pc.cyan("\n📱 wape - WhatsApp Group Ignore Manager\n"));
        console.log(pc.dim("Decrypting / preparing SQLite database..."));
        const { groups } = await loadDbAndGroups(options?.backup, options?.key);

        if (groups.length === 0) {
          console.log(pc.yellow("No group chats found in the backup."));
          return;
        }

        await ignoreGroupsInteractive(groups);
      } catch (error) {
        console.error(
          pc.red(
            `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

/**
 * Ignored Groups Overview Command
 */
program
  .command("ignored")
  .description("List all WhatsApp groups marked as ignored")
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(async (options?: { backup?: string; key?: string }) => {
    try {
      let groups: GroupSummary[] | undefined;
      try {
        const res = await loadDbAndGroups(options?.backup, options?.key);
        groups = res.groups;
      } catch {
        // Backup not provided or not decryptable - fallback to stored metadata
      }
      printIgnoredGroups(groups);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Unignore Command
 */
program
  .command("unignore")
  .description(
    "Unmark previously ignored groups so they can be added to rooms again",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(async (options?: { backup?: string; key?: string }) => {
    try {
      let groups: GroupSummary[] | undefined;
      try {
        const res = await loadDbAndGroups(options?.backup, options?.key);
        groups = res.groups;
      } catch {
        // Fallback to unignore using stored metadata
      }
      await unignoreGroupsInteractive(groups);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

/**
 * Lists overview
 */
program
  .command("lists")
  .description(
    `List all known contact files in ${getWapeListsDir()}/ and their current contact counts`,
  )
  .action(() => {
    const knownLists = getAllKnownLists();
    console.log(
      pc.cyan(`\n📁 wape Contact Lists Repository (${getWapeListsDir()}/)\n`),
    );
    console.log("=".repeat(65));
    knownLists.forEach((l) => {
      const contacts = readContactsFromFile(l.path);
      console.log(
        `  ${pc.bold(l.name.padEnd(25))} ${pc.yellow(contacts.size.toLocaleString().padStart(8))} contacts ${pc.dim(`(${l.path})`)}`,
      );
    });
    console.log("=".repeat(65) + "\n");
  });

/**
 * Configuration Command
 */
const configCmd = program
  .command("config")
  .description(`View or update ${getWapeConfigFile()} settings`);

configCmd
  .command("get")
  .description(`View current ${getWapeConfigFile()} configuration`)
  .action(() => {
    const cfg = getAppConfig();
    console.log(pc.cyan(`\n⚙️  wape Configuration (${getWapeConfigFile()})\n`));
    console.log("=".repeat(65));
    console.log(
      `${pc.bold("Key:")}         ${cfg.key ? pc.yellow(cfg.key.slice(0, 12) + "..." + cfg.key.slice(-6)) : pc.dim("(not set)")}`,
    );
    console.log(
      `${pc.bold("Backup Path:")} ${cfg.backupPath ? pc.green(cfg.backupPath) : pc.dim("(auto-discovery)")}`,
    );
    console.log("=".repeat(65) + "\n");
  });

configCmd
  .command("set")
  .description("Set configuration values")
  .option("-k, --key <key>", "Decryption key (64 hex characters or base64)")
  .option("-b, --backup <path>", "Path to WhatsApp backup file")
  .action((opts: { key?: string; backup?: string }) => {
    if (!opts.key && !opts.backup) {
      console.log(
        pc.yellow("Please provide --key <key> or --backup <path> to set."),
      );
      return;
    }
    const update: { key?: string; backupPath?: string } = {};
    if (opts.key) update.key = opts.key.trim();
    if (opts.backup) update.backupPath = opts.backup.trim();
    saveAppConfig(update);
    console.log(
      pc.green(`\n✅ Configuration updated in ${getWapeConfigFile()}\n`),
    );
  });

configCmd.action(() => {
  configCmd.outputHelp();
});

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse(process.argv);
}
