#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { input, select } from "@inquirer/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { getDatabase } from "../db";
import { ensureDecryptedDatabase } from "../services/decryptor";
import { copyToClipboard } from "../services/clipboard";
import {
  auditExitableGroups,
  auditGroupDemographics,
  detectWhatsAppOwnerPhone,
  extractNigerianNumbersWithGroupMapping,
  extractWhatsAppGroupLinks,
  fetchAllGroups,
  getExitedGroupJids,
  resolveRoomGroups,
  type GroupSummary,
} from "../services/extractor";
import {
  countMessages,
  exportChatMessages,
  findMatchingChats,
  formatSenderPhone,
  resolveTargetChat,
  searchMessages,
  type ExportFilterOptions,
  type ResolvedChat,
} from "../services/chat-exporter";
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
import {
  formatPhoneNumber,
  normalizeNigerianPhoneNumber,
} from "../services/phone";
import {
  addGroupsToRoomInteractive,
  createRoomInteractive,
  formatGroupLabel,
  formatProvenanceGroupItem,
  printExitableAudit,
  printGroups,
  printRoomAudit,
  printRoomDetail,
  printRoomGroups,
  printRoomsTable,
  removeGroupsFromRoomInteractive,
} from "./room-manager";
import {
  ignoreAuditItemsInteractive,
  ignoreGroupsInteractive,
  printIgnoredGroups,
  unignoreGroupsInteractive,
} from "./ignore-manager";
import { searchCheckbox } from "./search-checkbox";
import {
  clearListContacts,
  clearRoomGroups,
  deleteRoom,
  getAllKnownLists,
  getAppConfig,
  getContactProvenance,
  getIgnoredJidSet,
  getRoomById,
  getRooms,
  getSavedLinks,
  getSavedLinksFile,
  getWapeConfigFile,
  isGroupInRoom,
  normalizeListName,
  recordScanProvenance,
  renameRoomId,
  saveAppConfig,
  saveLinks,
  saveNotedComparison,
  type AppConfig,
  type RecordProvenanceGroupItem,
  type Room,
} from "../services/wape-store";

const program = new Command();

program
  .name("wape")
  .description(
    "wape - WhatsApp Phone Number Extractor, Room Manager & List Aggregator",
  )
  .version("1.0.0");

async function loadDbAndGroups(backupPath?: string, backupKey?: string) {
  const dbPath = await ensureDecryptedDatabase({
    backupPath,
    backupKey,
  });
  const db = getDatabase(dbPath);
  const groups = await fetchAllGroups(db);
  return { db, groups };
}

interface ChatExportCommandOptions extends ExportFilterOptions {
  room?: string;
  groupSearch?: string;
  fuzzy?: boolean;
  backup?: string;
  key?: string;
}

interface ChatSearchCommandOptions extends ExportFilterOptions {
  limit?: string;
  count?: boolean;
  backup?: string;
  key?: string;
}

async function handleChatSearch(query: string, opts: ChatSearchCommandOptions) {
  try {
    const { db } = await loadDbAndGroups(opts?.backup, opts?.key);

    if (opts.count) {
      const totalCount = await countMessages(db, query, opts);
      console.log(totalCount);
      return;
    }

    const limitNum = opts.limit ? parseInt(opts.limit, 10) : undefined;
    const results = await searchMessages(db, query, opts, limitNum);

    if (results.length === 0) {
      console.log(pc.yellow(`\nNo messages found matching '${query}'.\n`));
      return;
    }

    console.log(pc.cyan("\n" + "=".repeat(70)));
    console.log(
      pc.bold(
        pc.cyan(
          `🔍 SEARCH RESULTS FOR: "${query}" (${results.length} match${results.length === 1 ? "" : "es"})`,
        ),
      ),
    );
    console.log("=".repeat(70) + "\n");

    results.forEach((r, idx) => {
      const dateStr = new Date(r.timestamp).toLocaleString();
      console.log(
        `${pc.bold((idx + 1).toString().padStart(2, " "))}. ${pc.cyan(`[🏛️  ${r.groupName}]`)} • ${pc.yellow(r.senderDisplay)} • ${pc.dim(dateStr)}`,
      );
      console.log(
        `    ${pc.dim("Message:")} ${r.textData.replace(/\n/g, " ")}\n`,
      );
    });

    console.log("=".repeat(70) + "\n");
  } catch (error) {
    console.error(
      pc.red(
        `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
}

async function handleChatExport(
  target?: string,
  opts?: ChatExportCommandOptions,
) {
  try {
    const { db, groups } = await loadDbAndGroups(opts?.backup, opts?.key);

    let scopedGroups = groups;
    let allowedJidRowIds: Set<number> | undefined;

    if (opts?.room) {
      const cleanRoomId = opts.room.trim().toLowerCase();
      const room = getRoomById(cleanRoomId);
      if (!room) {
        console.error(
          pc.red(
            `\n❌ Error: Room '${opts.room}' not found. Use 'wape rooms list' to see all rooms.\n`,
          ),
        );
        process.exit(1);
      }
      const resolved = resolveRoomGroups(room, groups);
      const activeRowIds = new Set(resolved.activeJidRowIds);
      const activeJids = new Set(
        resolved.activeJidStrings.map((j) => j.toLowerCase()),
      );
      scopedGroups = groups.filter(
        (g) =>
          activeRowIds.has(g.jidRowId) ||
          activeJids.has(g.jidString.toLowerCase()),
      );
      allowedJidRowIds = new Set(scopedGroups.map((g) => g.jidRowId));
    }

    if (opts?.groupSearch) {
      const searchLower = opts.groupSearch.trim().toLowerCase();
      scopedGroups = scopedGroups.filter((g) =>
        g.subject.toLowerCase().includes(searchLower),
      );
      if (scopedGroups.length === 0) {
        console.log(
          pc.yellow(
            `\nNo groups found matching --group-search '${opts.groupSearch}'${opts.room ? ` in room '${opts.room}'` : ""}.\n`,
          ),
        );
        return;
      }
      allowedJidRowIds = new Set(scopedGroups.map((g) => g.jidRowId));
    }

    let resolvedChat: ResolvedChat | null = null;

    if (target && target.trim()) {
      const cleanTarget = target.trim();
      const matches = await findMatchingChats(db, cleanTarget, {
        fuzzy: opts?.fuzzy,
        allowedJidRowIds,
      });

      if (matches.length === 1) {
        resolvedChat = matches[0] ?? null;
      } else if (matches.length > 1) {
        if (!process.stdout.isTTY) {
          resolvedChat = matches[0] ?? null;
        } else {
          const pickedChatId = await select<number>({
            message: `Multiple chats matched '${cleanTarget}'. Select chat to export:`,
            choices: matches.map((m) => ({
              name: `${m.subject || m.username || formatSenderPhone(m.phone) || "Unknown"} ${m.isGroup ? pc.dim("(Group)") : pc.dim("(Direct Chat)")}`,
              value: m.chatId,
            })),
          });
          resolvedChat = matches.find((m) => m.chatId === pickedChatId) ?? null;
        }
      } else {
        console.error(
          pc.red(
            `\n❌ Error: Could not find chat or contact matching: '${cleanTarget}'${!opts?.fuzzy ? pc.dim(" (use --fuzzy to enable partial matching)") : ""}\n`,
          ),
        );
        process.exit(1);
      }
    } else {
      // No target provided: pick from scoped groups
      if (scopedGroups.length === 0) {
        console.log(pc.yellow("\nNo group chats available to export.\n"));
        return;
      }

      if (scopedGroups.length === 1 && opts?.groupSearch && scopedGroups[0]) {
        // Auto-select single matching group from --group-search
        const singleGroup = scopedGroups[0];
        resolvedChat = await resolveTargetChat(db, singleGroup.subject, {
          allowedJidRowIds: new Set([singleGroup.jidRowId]),
        });
      } else {
        if (!process.stdout.isTTY) {
          console.error(
            pc.red(
              "\n❌ Error: Target chat/group or --group-search required when running non-interactively.\n",
            ),
          );
          process.exit(1);
        }

        const pickedJidRowId = await select<number>({
          message: "Select group chat to export transcript:",
          choices: scopedGroups.map((g) => ({
            name: formatGroupLabel(g),
            value: g.jidRowId,
          })),
          pageSize: 16,
        });

        const pickedGroup = scopedGroups.find(
          (g) => g.jidRowId === pickedJidRowId,
        );
        if (pickedGroup) {
          resolvedChat = await resolveTargetChat(db, pickedGroup.subject, {
            allowedJidRowIds: new Set([pickedGroup.jidRowId]),
          });
        }
      }
    }

    if (!resolvedChat) {
      console.error(pc.red("\n❌ Error: Could not resolve target chat.\n"));
      process.exit(1);
    }

    const { text, messageCount } = await exportChatMessages(
      db,
      resolvedChat,
      opts ?? {},
    );

    if (messageCount === 0) {
      console.log(
        pc.yellow(
          `\nNo messages found matching the specified criteria for chat '${resolvedChat.subject || resolvedChat.phone || target || "Selected Chat"}'.\n`,
        ),
      );
      return;
    }

    // If piped / redirected to file or another command, stream raw text to stdout
    if (!process.stdout.isTTY) {
      process.stdout.write(text + "\n");
      return;
    }

    // Default interactive terminal behavior: copy to clipboard and print summary
    const copied = await copyToClipboard(text);
    if (copied) {
      console.log(
        pc.green(
          `\n📋 Copied ${messageCount.toLocaleString()} message(s) to clipboard from chat: ${pc.bold(resolvedChat.subject || resolvedChat.phone || target || "Selected Group")}\n`,
        ),
      );
    } else {
      // If headless/no clipboard available, print directly to terminal
      console.log(text);
    }
  } catch (error) {
    console.error(
      pc.red(
        `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
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
    scanType?: "primary" | "oneoff";
    sourceLabel?: string;
    ownerPhone?: string | null;
    allGroups?: GroupSummary[];
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

  let targetListName: string;

  if (options?.forcedTargetList) {
    targetListName = normalizeListName(options.forcedTargetList);
  } else if (options?.roomContext) {
    targetListName = options.roomContext.targetList
      ? normalizeListName(options.roomContext.targetList)
      : options.roomContext.id;
  } else {
    const knownLists = getAllKnownLists();
    const listChoices = [
      {
        name: `Main List (${pc.bold("main")})`,
        value: "main",
        description: "Primary global contacts list",
      },
      {
        name: `Lock List (${pc.bold("lock")})`,
        value: "lock",
        description: "Secondary/lock global contacts list",
      },
      ...knownLists
        .filter((l) => !l.isGlobal)
        .map((l) => {
          return {
            name: `${pc.bold(l.name)} ${pc.yellow(`(${l.count.toLocaleString()} contacts)`)}`,
            value: l.name,
            description: `List: ${l.name}`,
          };
        }),
      {
        name: "Custom List (enter list name)",
        value: "__custom__",
        description: "Create or append to a custom list in database",
      },
    ];

    console.log("");
    const choice = await select<string>({
      message: "Select destination list:",
      choices: listChoices,
    });

    if (choice === "__custom__") {
      const customName = await input({
        message: "Enter custom list name (e.g. leads):",
        validate: (val) => (val.trim() ? true : "List name cannot be empty."),
      });
      targetListName = normalizeListName(customName.trim());
    } else {
      targetListName = choice;
    }
  }

  console.log(
    pc.dim("\nExtracting and sieving unique Nigerian phone numbers..."),
  );
  const { uniqueNigerianNumbers: uniqueExtracts, groupPhonesMap } =
    await extractNigerianNumbersWithGroupMapping(db, targetGroupJids);

  const mergeResult = mergeContactsIntoFile(targetListName, uniqueExtracts);

  // Record provenance in SQLite
  try {
    const provenanceGroups: RecordProvenanceGroupItem[] = targetGroupJids.map(
      (jidRowId) => {
        const gMeta = options?.allGroups?.find((g) => g.jidRowId === jidRowId);
        const phones = Array.from(groupPhonesMap.get(jidRowId) ?? []);
        return {
          jid: gMeta?.jidString ?? String(jidRowId),
          subject: gMeta?.subject ?? `Group ${jidRowId}`,
          communityName: gMeta?.communityName ?? null,
          phones,
        };
      },
    );

    recordScanProvenance({
      type: options?.scanType ?? "primary",
      label:
        options?.sourceLabel ??
        (options?.scanType === "oneoff" ? "One-off Backup" : "Primary Backup"),
      ownerPhone: options?.ownerPhone ?? null,
      groups: provenanceGroups,
    });
  } catch (_err) {
    // Graceful fallback if provenance record encounters any issue
  }

  console.log(pc.green("\n" + "=".repeat(52)));
  console.log(pc.bold(pc.green("                 EXPORT REPORT")));
  console.log("=".repeat(52));
  console.log(
    `${pc.bold("Target List:")}             ${pc.cyan(targetListName)}`,
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
    `${pc.bold("Total Contacts in List:")}  ${pc.magenta(mergeResult.totalCount.toLocaleString())}`,
  );
  console.log("=".repeat(52) + "\n");
}

async function scanSingleRoom(
  db: ReturnType<typeof getDatabase>,
  groups: Awaited<ReturnType<typeof fetchAllGroups>>,
  room: Room,
  opts?: {
    main?: boolean;
    lock?: boolean;
    targetList?: string;
    scanType?: "primary" | "oneoff";
    sourceLabel?: string;
    ownerPhone?: string | null;
  },
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
  if (opts?.targetList) forcedList = normalizeListName(opts.targetList);
  else if (opts?.main) forcedList = "main";
  else if (opts?.lock) forcedList = "lock";

  await executeGroupExport(db, activeJids, labels, {
    forcedTargetList: forcedList,
    roomContext: room,
    scanType: opts?.scanType ?? "primary",
    sourceLabel:
      opts?.sourceLabel ??
      (opts?.scanType === "oneoff" ? "One-off Backup" : "Primary Backup"),
    ownerPhone: opts?.ownerPhone ?? null,
    allGroups: groups,
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
            forcedList = normalizeListName(options.targetList);
          } else if (options?.main) {
            forcedList = "main";
          } else if (options?.lock) {
            forcedList = "lock";
          }

          await executeGroupExport(db, targetJids, selectedLabels, {
            forcedTargetList: forcedList,
            scanType: "primary",
            sourceLabel: "Primary Backup",
            allGroups: groups,
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
    "-l, --label <label>",
    "Label for this one-off backup (e.g. Alice - Work Phone)",
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
        label?: string;
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

        const detectedOwner = await detectWhatsAppOwnerPhone(db);
        let backupLabel = options?.label?.trim();
        if (!backupLabel) {
          const ownerPromptText = detectedOwner
            ? ` (detected owner: ${formatPhoneNumber(detectedOwner)})`
            : "";
          backupLabel = await input({
            message: `Enter a label for this one-off backup${ownerPromptText}:`,
            validate: (val) =>
              val.trim() ? true : "Backup label cannot be empty.",
          });
        }

        let forcedList: string | undefined;
        if (options?.targetList) {
          forcedList = normalizeListName(options.targetList);
        } else if (options?.main) {
          forcedList = "main";
        } else if (options?.lock) {
          forcedList = "lock";
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
            scanType: "oneoff",
            sourceLabel: backupLabel.trim(),
            ownerPhone: detectedOwner,
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
            scanType: "oneoff",
            sourceLabel: backupLabel.trim(),
            ownerPhone: detectedOwner,
            allGroups: groups,
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

oneoffCmd
  .command("bundle [targets...]")
  .description(
    "Scan groups from a one-off WhatsApp backup into a list/room, run comparison across default rooms, extract newly found group invite links, and copy both to clipboard",
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
    "-l, --label <label>",
    "Label for this one-off backup (e.g. Alice - Work Phone)",
  )
  .option(
    "-t, --target-list <nameOrPath>",
    "Direct output to a specific list file or name",
  )
  .option("--main", "Force output to global main list")
  .option("--lock", "Force output to global lock list")
  .action(
    async (
      targets?: string[],
      options?: {
        key: string;
        backup?: string;
        label?: string;
        targetList?: string;
        main?: boolean;
        lock?: boolean;
      },
    ) => {
      try {
        console.log(pc.cyan("\n📱 wape - One-Off WhatsApp Backup Bundle\n"));
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

        const detectedOwner = await detectWhatsAppOwnerPhone(db);
        let backupLabel = options?.label?.trim();
        if (!backupLabel) {
          const ownerPromptText = detectedOwner
            ? ` (detected owner: ${formatPhoneNumber(detectedOwner)})`
            : "";
          backupLabel = await input({
            message: `Enter a label for this one-off backup${ownerPromptText}:`,
            validate: (val) =>
              val.trim() ? true : "Backup label cannot be empty.",
          });
        }

        let forcedList: string | undefined;
        if (options?.targetList) {
          forcedList = normalizeListName(options.targetList);
        } else if (options?.main) {
          forcedList = "main";
        } else if (options?.lock) {
          forcedList = "lock";
        }

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
          scanType: "oneoff",
          sourceLabel: backupLabel.trim(),
          ownerPhone: detectedOwner,
          allGroups: groups,
        });

        // Resolve targets for comparison
        let resolvedTargets: { label: string; filePath: string }[] = [];
        if (!targets || targets.length === 0) {
          const cfg = getAppConfig();
          if (cfg.defaultCompareRooms && cfg.defaultCompareRooms.length >= 2) {
            resolvedTargets = cfg.defaultCompareRooms.map((t) =>
              resolveTargetToList(t),
            );
          } else {
            const allRooms = getRooms();
            if (allRooms.length >= 2) {
              resolvedTargets = allRooms.map((r) => {
                const listName = r.targetList
                  ? normalizeListName(r.targetList)
                  : r.id;
                return {
                  label: `Room '${r.id}'`,
                  filePath: listName,
                };
              });
            } else {
              resolvedTargets = [
                {
                  label: "Main List",
                  filePath: "main",
                },
                {
                  label: "Lock List",
                  filePath: "lock",
                },
              ];
            }
          }
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

        console.log(
          pc.cyan(
            `\n🔍 Running comparison across: ${resolvedTargets.map((t) => t.label).join(", ")}...\n`,
          ),
        );

        // 1. Calculate comparison diff across targets
        const filePaths = resolvedTargets.map((t) => t.filePath);
        const diff = getComparisonDiff(filePaths);
        const newContacts = diff.newContacts;

        // 2. Extract new group invite links from one-off backup database
        const allExtractedLinks = await extractWhatsAppGroupLinks(db);
        const recordedLinks = new Set(getSavedLinks());
        const newLinks = allExtractedLinks.filter(
          (link) => !recordedLinks.has(link),
        );

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
          console.log(
            pc.dim(`\n📋 Copied ${parts.join(" and ")} to clipboard.\n`),
          );
        }
        process.exit(0);
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
 * One-off Chats Command Group
 */
const oneoffChatsCmd = oneoffCmd
  .command("chats")
  .alias("chat")
  .description("Export and manage WhatsApp chats from a one-off backup")
  .action(() => {
    oneoffChatsCmd.outputHelp();
  });

oneoffChatsCmd
  .command("export [target]")
  .description(
    "Export formatted WhatsApp chat transcript from a one-off backup",
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
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("--room <id>", "Filter groups to only those in the specified room")
  .option(
    "--group-search <query>",
    "Filter groups matching the search query by name",
  )
  .option(
    "--fuzzy",
    "Enable fuzzy/partial matching on target name or phone number",
  )
  .action(handleChatExport);

oneoffChatsCmd
  .command("search <query>")
  .description(
    "Search for messages across WhatsApp groups and chats from a one-off backup",
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
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("-l, --limit <number>", "Limit the number of search results returned")
  .option(
    "-c, --count",
    "Print the total count of matching messages rather than printing the results",
  )
  .action(handleChatSearch);

oneoffCmd
  .command("chats-export [target]", { hidden: true })
  .requiredOption(
    "-k, --key <key>",
    "Decryption key for the one-off backup (required)",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (optional, auto-discovers if omitted)",
  )
  .option(
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("--room <id>", "Filter groups to only those in the specified room")
  .option(
    "--group-search <query>",
    "Filter groups matching the search query by name",
  )
  .option(
    "--fuzzy",
    "Enable fuzzy/partial matching on target name or phone number",
  )
  .action(handleChatExport);

oneoffCmd
  .command("chats-search <query>", { hidden: true })
  .requiredOption(
    "-k, --key <key>",
    "Decryption key for the one-off backup (required)",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (optional, auto-discovers if omitted)",
  )
  .option(
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("-l, --limit <number>", "Limit the number of search results returned")
  .option(
    "-c, --count",
    "Print the total count of matching messages rather than printing the results",
  )
  .action(handleChatSearch);

/**
 * Room Management Commands
 */
const roomCmd = program
  .command("rooms")
  .description("Manage wape rooms (collections of WhatsApp groups)");

roomCmd
  .command("list", { isDefault: false })
  .description("List all configured rooms")
  .action(() => {
    printRoomsTable(getRooms());
    process.exit(0);
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

      printRoomDetail(room, undefined);
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

      printRoomGroups(room, undefined);
    } catch (error) {
      console.error(
        pc.red(
          `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

async function executeRoomAudit(
  id?: string,
  options?: {
    threshold?: string;
    backup?: string;
    key?: string;
    all?: boolean;
    interactiveIgnore?: boolean;
  },
) {
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
        message: "Select room to audit:",
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

    const threshold = parseFloat(options?.threshold ?? "50") || 50;
    const { db, groups } = await loadDbAndGroups(options?.backup, options?.key);

    const resolved = resolveRoomGroups(room, groups);
    const activeCandidates = resolved.resolvedItems.filter(
      (
        item,
      ): item is typeof item & {
        resolvedJidRowId: number;
      } => !item.isMissing && item.resolvedJidRowId !== null,
    );

    const exitedJids = getExitedGroupJids(
      db,
      activeCandidates.map((c) => c.resolvedJidRowId),
    );

    const activeGroups = activeCandidates
      .filter((item) => !exitedJids.has(item.resolvedJidRowId))
      .map((item) => ({
        jidRowId: item.resolvedJidRowId,
        subject: item.subject,
        communityName: item.communityName,
        isCommunityRoot: item.isCommunityRoot,
        isAnnouncement: item.isAnnouncement,
        isSubgroup: item.isSubgroup,
        isStandalone: item.isStandalone,
      }));

    const missingItems = resolved.resolvedItems.filter(
      (item) => item.isMissing,
    );
    const demographics = await auditGroupDemographics(
      db,
      activeGroups,
      threshold,
      { filterExited: false },
    );

    printRoomAudit(
      room,
      demographics,
      missingItems,
      threshold,
      options?.all ?? false,
      exitedJids.size,
    );

    if (options?.interactiveIgnore) {
      const flagged = demographics.filter((d) => d.isFlagged);
      if (flagged.length > 0) {
        const groupsByJidRowId = new Map(groups.map((g) => [g.jidRowId, g]));
        const itemsToIgnore = flagged
          .map((d) => {
            const live = groupsByJidRowId.get(d.groupJidRowId);
            if (!live) return null;
            return {
              jidString: live.jidString,
              subject: d.subject,
              communityName: d.communityName,
              participantCount: d.totalMembers,
              isCommunityRoot: live.isCommunityRoot,
              isAnnouncement: live.isAnnouncement,
              isSubgroup: live.isSubgroup,
              isStandalone: live.isStandalone,
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        await ignoreAuditItemsInteractive(itemsToIgnore);
      }
    }
  } catch (error) {
    console.error(
      pc.red(
        `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
}

roomCmd
  .command("audit [id]")
  .description(
    "Audit WhatsApp groups in a room for non-Nigerian demographic majority (>50%)",
  )
  .option(
    "-t, --threshold <percent>",
    "Non-Nigerian percentage threshold (default: 50)",
    "50",
  )
  .option(
    "-i, --interactive-ignore",
    "Interactively select flagged groups from the audit output to ignore from future audits",
    false,
  )
  .option(
    "-a, --all",
    "Show all groups in the room, including non-flagged ones",
    false,
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(executeRoomAudit);

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
  .description("Assign a new ID to a room")
  .action((oldId: string, newId: string) => {
    const res = renameRoomId(oldId, newId);
    if (!res.success) {
      console.error(pc.red(`\n❌ Error: ${res.error}\n`));
      process.exit(1);
    }

    console.log(
      pc.green(`\n✅ Room '${oldId}' renamed to '${newId}' successfully.\n`),
    );
  });

roomCmd
  .command("delete <id> [ids...]")
  .description("Delete one or more rooms by ID")
  .action(async (id: string, extraIds?: string[]) => {
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
  .command("reset [ids...]")
  .description("Clear groups and/or contact list from one or more rooms")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (ids?: string[], _options?: { yes?: boolean }) => {
    const rooms = getRooms();
    if (rooms.length === 0) {
      console.log(pc.yellow("\nNo rooms found to reset.\n"));
      return;
    }

    let targetIds: string[] = ids ?? [];
    if (targetIds.length === 0) {
      if (!process.stdout.isTTY) {
        console.error(
          pc.red("\n❌ Error: Please specify at least one room ID to reset.\n"),
        );
        process.exit(1);
      }
      const picked = await select<string>({
        message: "Select room to reset:",
        choices: rooms.map((r) => {
          const count = (r.groupIds ?? r.groupJidRowIds ?? []).length;
          return {
            name: `${pc.bold(r.id)} (${count} groups, list: ${r.targetList ?? r.id})`,
            value: r.id,
          };
        }),
      });
      targetIds = [picked];
    }

    for (const rid of targetIds) {
      const room = getRoomById(rid);
      if (!room) {
        console.error(
          pc.red(
            `\n❌ Error: Room '${rid}' not found. Use 'wape rooms list' to see all rooms.\n`,
          ),
        );
        continue;
      }

      const listName = room.targetList
        ? normalizeListName(room.targetList)
        : room.id;
      const groupRes = clearRoomGroups(room.id);
      const listRes = clearListContacts(listName);

      console.log(
        pc.green(
          `\n🧹 Reset room '${room.id}': cleared ${groupRes.clearedGroupsCount} groups and ${listRes.clearedCount.toLocaleString()} contacts from '${listName}'.`,
        ),
      );
    }
    console.log("");
  });

roomCmd
  .command("path <id>")
  .description("Get the contact list name for a room")
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
    const listName = room.targetList
      ? normalizeListName(room.targetList)
      : room.id;
    console.log(listName);
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

      const targetListName = room.targetList
        ? normalizeListName(room.targetList)
        : room.id;
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

      const mergeResult = mergeContactsIntoFile(targetListName, allNewContacts);

      console.log(pc.green("\n" + "=".repeat(58)));
      console.log(pc.bold(pc.green(`        PATCH REPORT: Room '${room.id}'`)));
      console.log("=".repeat(58));
      console.log(
        `${pc.bold("Target List:")}             ${pc.cyan(targetListName)}`,
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

      const targetListName = room.targetList
        ? normalizeListName(room.targetList)
        : room.id;
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
        targetListName,
        allRemoveContacts,
      );

      console.log(pc.yellow("\n" + "=".repeat(58)));
      console.log(
        pc.bold(pc.yellow(`       UNPATCH REPORT: Room '${room.id}'`)),
      );
      console.log("=".repeat(58));
      console.log(
        `${pc.bold("Target List:")}             ${pc.cyan(targetListName)}`,
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

interface ExecuteCompareOptions {
  targets: { label: string; filePath: string; room?: Room | null }[];
  title?: string;
  source?: boolean;
}

async function executeCompare({
  targets,
  title = "Common Contacts Intersection Analysis",
  source,
}: ExecuteCompareOptions) {
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

  const targetRooms = targets
    .map((t) => t.room)
    .filter((r): r is Room => Boolean(r));

  const printGroupList = (
    groups: NonNullable<ReturnType<typeof getContactProvenance>>["groups"],
    options?: { showRooms?: boolean },
  ) => {
    groups.forEach((group) => {
      console.log(`    • ${formatProvenanceGroupItem(group, options)}`);
    });
  };

  for (const contact of diff.currentCommon) {
    const isNew = newSet.has(contact);
    const badge = isNew ? `  ${pc.bold(pc.green("[NEW]"))}` : "";
    console.log(`${formatPhoneNumber(contact)}${badge}`);

    if (source) {
      const provenance = getContactProvenance(contact);

      if (targetRooms.length > 0) {
        const matchedGroups = new Set<string>();

        for (const room of targetRooms) {
          console.log(`  ${pc.cyan(`Room '${room.id}':`)}`);
          const roomGroups =
            provenance?.groups.filter((group) => {
              const inRoom = isGroupInRoom(group, room, targetRooms);
              if (inRoom) matchedGroups.add(group.jid);
              return inRoom;
            }) ?? [];

          if (roomGroups.length > 0) {
            printGroupList(roomGroups, { showRooms: false });
          } else {
            console.log(`    • ${pc.dim("(No identified group source)")}`);
          }
        }

        const otherGroups =
          provenance?.groups.filter((group) => !matchedGroups.has(group.jid)) ??
          [];
        if (otherGroups.length > 0) {
          console.log(`  ${pc.dim("Other Groups:")}`);
          printGroupList(otherGroups);
        }
      } else {
        if (provenance && provenance.groups.length > 0) {
          printGroupList(provenance.groups);
        } else {
          console.log(`    • ${pc.dim("(No identified group source)")}`);
        }
      }
    }
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
  process.exit(0);
}

roomCmd
  .command("compare [rooms...]")
  .description(
    "Find and list common contacts across rooms in XXXX XXX XXXX format",
  )
  .option(
    "-s, --source",
    "Display identified sources alongside each common contact",
  )
  .action(async (roomIds?: string[], options?: { source?: boolean }) => {
    try {
      const allRooms = getRooms();
      let targetRooms: Room[] = [];

      if (!roomIds || roomIds.length === 0) {
        const cfg = getAppConfig();
        if (cfg.defaultCompareRooms && cfg.defaultCompareRooms.length >= 2) {
          for (const id of cfg.defaultCompareRooms) {
            const r = getRoomById(id);
            if (r) targetRooms.push(r);
          }
        }
        if (targetRooms.length < 2) {
          if (allRooms.length < 2) {
            console.error(
              pc.red(
                `\n❌ Error: Please provide at least two rooms to compare (or configure at least 2 rooms).\n`,
              ),
            );
            process.exit(1);
          }
          targetRooms = allRooms;
        }
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
        const listName = r.targetList ? normalizeListName(r.targetList) : r.id;
        return {
          label: `Room '${r.id}'`,
          filePath: listName,
          room: r,
        };
      });

      await executeCompare({
        targets: resolvedTargets,
        title: "Rooms Common Contacts Intersection Analysis",
        source: options?.source,
      });
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
          const cfg = getAppConfig();
          if (cfg.defaultCompareRooms && cfg.defaultCompareRooms.length >= 2) {
            for (const id of cfg.defaultCompareRooms) {
              const r = getRoomById(id);
              if (r) targetRooms.push(r);
            }
          }
          if (targetRooms.length < 2) {
            if (allRooms.length < 2) {
              console.error(
                pc.red(
                  `\n❌ Error: Please provide at least two rooms to bundle (or configure at least 2 rooms).\n`,
                ),
              );
              process.exit(1);
            }
            targetRooms = allRooms;
          }
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
          const listName = r.targetList
            ? normalizeListName(r.targetList)
            : r.id;
          return {
            label: `Room '${r.id}'`,
            filePath: listName,
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
  .option(
    "-s, --source",
    "Display identified sources alongside each common contact",
  )
  .action(async (targets?: string[], options?: { source?: boolean }) => {
    try {
      let resolvedTargets: {
        label: string;
        filePath: string;
        room?: Room | null;
      }[] = [];

      if (!targets || targets.length === 0) {
        const cfg = getAppConfig();
        if (cfg.defaultCompareRooms && cfg.defaultCompareRooms.length >= 2) {
          resolvedTargets = cfg.defaultCompareRooms.map((t) =>
            resolveTargetToList(t),
          );
        } else {
          resolvedTargets = [
            { label: "Main List", filePath: "main" },
            { label: "Lock List", filePath: "lock" },
          ];
        }
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

      await executeCompare({
        targets: resolvedTargets,
        title: "Common Contacts Intersection Analysis",
        source: options?.source,
      });
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
          const cfg = getAppConfig();
          if (cfg.defaultCompareRooms && cfg.defaultCompareRooms.length >= 2) {
            resolvedTargets = cfg.defaultCompareRooms.map((t) =>
              resolveTargetToList(t),
            );
          } else {
            const allRooms = getRooms();
            if (allRooms.length >= 2) {
              resolvedTargets = allRooms.map((r) => {
                const listName = r.targetList
                  ? normalizeListName(r.targetList)
                  : r.id;
                return {
                  label: `Room '${r.id}'`,
                  filePath: listName,
                };
              });
            } else {
              resolvedTargets = [
                {
                  label: "Main List",
                  filePath: "main",
                },
                {
                  label: "Lock List",
                  filePath: "lock",
                },
              ];
            }
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

        console.log(pc.cyan(`\n📊 wape Lists Stats Summary\n`));
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
          `${pc.bold("Target:")}               ${pc.green(target.label)}`,
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
          `  ${pc.bold(labelA?.padEnd(28) ?? "Target A")}: ${pc.yellow(stats.countA.toLocaleString().padStart(8))} contacts`,
        );
        console.log(
          `  ${pc.bold(labelB?.padEnd(28) ?? "Target B")}: ${pc.yellow(stats.countB.toLocaleString().padStart(8))} contacts`,
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
          `  ${pc.bold((labels[idx] ?? "").padEnd(28))}: ${pc.yellow(contacts.size.toLocaleString().padStart(8))} contacts`,
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
  .option("--main", "Patch into global main list")
  .option("--lock", "Patch into global lock list")
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
          targetLabel = "Global Main List";
          targetListPath = "main";
          fileArgs = args;
        } else if (opts.lock) {
          targetLabel = "Global Lock List";
          targetListPath = "lock";
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
          `${pc.bold("Target List:")}             ${pc.cyan(targetListPath)}`,
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
  .option("--main", "Unpatch from global main list")
  .option("--lock", "Unpatch from global lock list")
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
          targetLabel = "Global Main List";
          targetListPath = "main";
          fileArgs = args;
        } else if (opts.lock) {
          targetLabel = "Global Lock List";
          targetListPath = "lock";
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
          `${pc.bold("Target List:")}             ${pc.cyan(targetListPath)}`,
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
 * Chats Command Group
 */
const chatsCmd = program
  .command("chats")
  .alias("chat")
  .description("Export and manage WhatsApp chats");

chatsCmd
  .command("export [target]")
  .description(
    "Export formatted WhatsApp chat transcript for a contact phone number, group, or username",
  )
  .option(
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("--room <id>", "Filter groups to only those in the specified room")
  .option(
    "--group-search <query>",
    "Filter groups matching the search query by name",
  )
  .option(
    "--fuzzy",
    "Enable fuzzy/partial matching on target name or phone number",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(handleChatExport);

chatsCmd
  .command("links")
  .description(
    "Filter through and print WhatsApp group invite links from the WAPE database",
  )
  .option(
    "--since <duration>",
    "Filter links saved since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter links saved starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter links saved up to date (YYYY-MM-DD)")
  .option("--last-month", "Filter links saved during last month")
  .option(
    "--last <number>",
    "Limit to the last N most recently saved links (e.g. --last 20, --last 40)",
  )
  .option(
    "-c, --count",
    "Print the total count of matching links rather than printing the links",
  )
  .action(async (opts: ExportFilterOptions & { count?: boolean }) => {
    try {
      const links = getSavedLinks(opts);

      if (opts.count) {
        console.log(links.length);
        return;
      }

      if (links.length === 0) {
        if (process.stdout.isTTY) {
          console.log(
            pc.yellow(
              "\nNo WhatsApp group invite links found matching the specified criteria.\n",
            ),
          );
        }
        return;
      }

      // If piped / redirected to file or another command, stream raw links to stdout without copying to clipboard
      if (!process.stdout.isTTY) {
        for (const link of links) {
          process.stdout.write(link + "\n");
        }
        return;
      }

      // Default interactive terminal behavior: print links and copy to clipboard
      for (const link of links) {
        console.log(link);
      }

      const copied = await copyToClipboard(links.join("\n"));
      if (copied) {
        console.log(
          pc.dim(
            `\n📋 Copied ${links.length.toLocaleString()} link(s) to clipboard.\n`,
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

chatsCmd
  .command("search <query>")
  .description(
    "Search for messages across WhatsApp groups and chats (e.g. finding group invite links or keywords)",
  )
  .option(
    "--since <duration>",
    "Filter messages since duration (e.g. 30m, 3d, 1w, 2h)",
  )
  .option(
    "--from <dates...>",
    "Filter messages starting from date (YYYY-MM-DD), e.g. --from 2020-10-01 to 2020-10-30",
  )
  .option("--to <date>", "Filter messages up to date (YYYY-MM-DD)")
  .option(
    "--last-month",
    "Filter messages to only those sent during last month",
  )
  .option("-l, --limit <number>", "Limit the number of search results returned")
  .option(
    "-c, --count",
    "Print the total count of matching messages rather than printing the results",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(handleChatSearch);

chatsCmd.action(() => {
  chatsCmd.outputHelp();
});

/**
 * Groups Command
 */
program
  .command("groups")
  .alias("group")
  .description(
    "List all active WhatsApp group chats and their member counts, with optional ranking by member count",
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .option(
    "--rank",
    "Sort and rank groups from highest to lowest member count regardless of community",
  )
  .option("--room <id>", "Filter groups to only those in the specified room")
  .action(
    async (options?: {
      backup?: string;
      key?: string;
      rank?: boolean;
      room?: string;
    }) => {
      try {
        const { groups } = await loadDbAndGroups(options?.backup, options?.key);

        if (groups.length === 0) {
          console.log(pc.yellow("\nNo group chats found in the backup.\n"));
          return;
        }

        let displayGroups = groups;
        let roomId: string | undefined;

        if (options?.room) {
          const cleanRoomId = options.room.trim().toLowerCase();
          const room = getRoomById(cleanRoomId);
          if (!room) {
            console.error(
              pc.red(
                `\n❌ Error: Room '${options.room}' not found. Use 'wape rooms list' to see all rooms.\n`,
              ),
            );
            process.exit(1);
          }
          roomId = room.id;
          const resolved = resolveRoomGroups(room, groups);
          const activeRowIds = new Set(resolved.activeJidRowIds);
          const activeJids = new Set(
            resolved.activeJidStrings.map((j) => j.toLowerCase()),
          );
          displayGroups = groups.filter(
            (g) =>
              activeRowIds.has(g.jidRowId) ||
              activeJids.has(g.jidString.toLowerCase()),
          );
        }

        printGroups(displayGroups, { rank: options?.rank, roomId });
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
 * Audit Command (Demographic room audits & exitable group recommendations)
 */
program
  .command("audit [id]")
  .description(
    "Audit WhatsApp groups: check room demographics (-t, --threshold) or find groups to leave/delete (-e, --exit)",
  )
  .option(
    "-t, --threshold <percent>",
    "Audit room for groups exceeding non-Nigerian percentage threshold (default: 50)",
  )
  .option(
    "-e, --exit",
    "Scan all groups to find inactive, dead, temporary, or spam groups recommended for leaving/deleting",
    false,
  )
  .option("--exitable", "Alias for --exit", false)
  .option(
    "-a, --all",
    "Show all groups in the room, including non-flagged ones (for room demographic audit)",
    false,
  )
  .option(
    "-i, --interactive-ignore",
    "Interactively select flagged groups from the audit output to ignore from future audits",
    false,
  )
  .option(
    "-b, --backup <path>",
    "Path to WhatsApp backup file (.crypt15, .crypt14, .crypt12, or decrypted SQLite .db)",
  )
  .option("-k, --key <key>", "Decryption key for encrypted backups")
  .action(
    async (
      id?: string,
      options?: {
        threshold?: string;
        exit?: boolean;
        exitable?: boolean;
        all?: boolean;
        interactiveIgnore?: boolean;
        backup?: string;
        key?: string;
      },
    ) => {
      if (options?.exit || options?.exitable) {
        try {
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
          }

          const { db, groups } = await loadDbAndGroups(
            options?.backup,
            options?.key,
          );

          let targetGroups = groups;
          if (room) {
            const resolved = resolveRoomGroups(room, groups);
            const activeJids = new Set(
              resolved.resolvedItems
                .filter(
                  (item) => !item.isMissing && item.resolvedJidRowId !== null,
                )
                .map((item) => item.resolvedJidRowId!),
            );
            targetGroups = groups.filter((g) => activeJids.has(g.jidRowId));
          }

          const flagged = await auditExitableGroups(db, targetGroups);
          printExitableAudit(flagged, targetGroups.length, {
            roomContext: room,
          });

          if (options?.interactiveIgnore && flagged.length > 0) {
            const groupsByJidRowId = new Map(
              groups.map((g) => [g.jidRowId, g]),
            );
            const itemsToIgnore = flagged.map((item) => {
              const live = groupsByJidRowId.get(item.groupJidRowId);
              return {
                jidString: live?.jidString ?? String(item.groupJidRowId),
                subject: item.subject,
                communityName: item.communityName,
                participantCount: item.totalMembers,
                isCommunityRoot: item.isCommunityRoot ?? live?.isCommunityRoot,
                isAnnouncement: item.isAnnouncement ?? live?.isAnnouncement,
                isSubgroup: live?.isSubgroup,
                isStandalone: live?.isStandalone,
              };
            });

            await ignoreAuditItemsInteractive(itemsToIgnore);
          }
        } catch (error) {
          console.error(
            pc.red(
              `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          process.exit(1);
        }
        return;
      }

      await executeRoomAudit(id, options);
    },
  );

/**
 * Lists overview
 */
program
  .command("lists")
  .description(
    "List all configured contact lists and their current contact counts",
  )
  .action(() => {
    const knownLists = getAllKnownLists();
    console.log(pc.cyan(`\n📁 wape Contact Lists\n`));
    console.log("=".repeat(50));
    knownLists.forEach((l) => {
      console.log(
        `  ${pc.bold(l.name.padEnd(25))} ${pc.yellow(l.count.toLocaleString().padStart(8))} contacts`,
      );
    });
    console.log("=".repeat(50) + "\n");
  });

/**
 * Reset Command (Lists or Rooms)
 */
program
  .command("reset [targets...]")
  .description("Reset (empty) one or more contact lists or rooms")
  .option("--room", "Target a room instead of a list")
  .option("--list", "Target a list instead of a room")
  .action(
    async (
      targets?: string[],
      options?: { room?: boolean; list?: boolean },
    ) => {
      const inputs = targets ? [...targets] : [];

      if (inputs.length === 0) {
        if (!process.stdout.isTTY) {
          console.error(
            pc.red(
              "\n❌ Error: Please specify at least one list or room name to reset.\n",
            ),
          );
          process.exit(1);
        }

        // Interactive prompt to select what to reset
        const allLists = getAllKnownLists();
        const allRooms = getRooms();

        type TargetChoice = {
          type: "list" | "room";
          name: string;
          label: string;
        };
        const choices: { name: string; value: TargetChoice }[] = [];

        allLists.forEach((l) => {
          choices.push({
            name: `📋 List: ${l.name} (${l.count.toLocaleString()} contacts)`,
            value: {
              type: "list",
              name: l.isGlobal ? l.name.replace(/ \(Global\)$/, "") : l.name,
              label: l.name,
            },
          });
        });

        allRooms.forEach((r) => {
          const count = (r.groupIds ?? r.groupJidRowIds ?? []).length;
          choices.push({
            name: `🏠 Room: ${r.id} (${count} groups, list: ${r.targetList ?? r.id})`,
            value: { type: "room", name: r.id, label: r.id },
          });
        });

        if (choices.length === 0) {
          console.log(pc.yellow("\nNo lists or rooms found to reset.\n"));
          return;
        }

        const selected = await select<TargetChoice>({
          message: "Select list or room to reset:",
          choices,
        });

        if (selected.type === "room") {
          const room = getRoomById(selected.name);
          if (room) {
            const listName = room.targetList
              ? normalizeListName(room.targetList)
              : room.id;
            const groupRes = clearRoomGroups(room.id);
            const listRes = clearListContacts(listName);
            console.log(
              pc.green(
                `\n🧹 Reset room '${room.id}': cleared ${groupRes.clearedGroupsCount} groups and ${listRes.clearedCount.toLocaleString()} contacts from '${listName}'.\n`,
              ),
            );
          }
        } else {
          const res = clearListContacts(selected.name);
          console.log(
            pc.green(
              `\n🧹 Reset list '${selected.name}': cleared ${res.clearedCount.toLocaleString()} contacts.\n`,
            ),
          );
        }
        return;
      }

      for (const target of inputs) {
        const clean = target.trim();
        if (!clean) continue;

        if (options?.room) {
          const room = getRoomById(clean);
          if (!room) {
            console.error(
              pc.red(
                `\n❌ Error: Room '${clean}' not found. Use 'wape rooms list' to see all rooms.\n`,
              ),
            );
            continue;
          }
          const listName = room.targetList
            ? normalizeListName(room.targetList)
            : room.id;
          const groupRes = clearRoomGroups(room.id);
          const listRes = clearListContacts(listName);
          console.log(
            pc.green(
              `\n🧹 Reset room '${room.id}': cleared ${groupRes.clearedGroupsCount} groups and ${listRes.clearedCount.toLocaleString()} contacts from '${listName}'.`,
            ),
          );
          continue;
        }

        if (options?.list) {
          const res = clearListContacts(clean);
          if (!res.success) {
            console.error(
              pc.red(
                `\n❌ Error: List '${clean}' not found. Use 'wape lists' to see all lists.\n`,
              ),
            );
            continue;
          }
          console.log(
            pc.green(
              `\n🧹 Reset list '${clean}': cleared ${res.clearedCount.toLocaleString()} contacts.`,
            ),
          );
          continue;
        }

        // Neither flag explicitly passed: check if matching room exists first
        const room = getRoomById(clean);
        if (room) {
          const listName = room.targetList
            ? normalizeListName(room.targetList)
            : room.id;
          const groupRes = clearRoomGroups(room.id);
          const listRes = clearListContacts(listName);
          console.log(
            pc.green(
              `\n🧹 Reset room '${room.id}': cleared ${groupRes.clearedGroupsCount} groups and ${listRes.clearedCount.toLocaleString()} contacts from '${listName}'.`,
            ),
          );
          continue;
        }

        // Check if matching list exists
        const listRes = clearListContacts(clean);
        if (listRes.success) {
          console.log(
            pc.green(
              `\n🧹 Reset list '${clean}': cleared ${listRes.clearedCount.toLocaleString()} contacts.`,
            ),
          );
        } else {
          console.error(
            pc.red(
              `\n❌ Error: No room or list found matching '${clean}'. Use 'wape rooms list' or 'wape lists'.\n`,
            ),
          );
        }
      }
      console.log("");
    },
  );

/**
 * Contact Source / Provenance Command
 */
const sourceCmd = program
  .command("source [numbers...]")
  .description(
    "Display all groups, communities, backup sources, and lists one or more contacts have been identified in",
  )
  .action((numbers?: string[]) => {
    let inputs = numbers ? [...numbers] : [];

    // If no numbers were passed as CLI arguments, check if stdin has piped data
    if (inputs.length === 0 && !process.stdin.isTTY) {
      try {
        const stdinData = readFileSync(0, "utf-8");
        const lines = stdinData
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        inputs = lines;
      } catch {
        // Fall back gracefully if reading stdin fails
      }
    }

    if (inputs.length === 0) {
      console.log(sourceCmd.helpInformation());
      return;
    }

    const validEntries: { raw: string; normalized: string }[] = [];
    for (const num of inputs) {
      const clean = num.trim();
      if (!clean) continue;
      const normalized = normalizeNigerianPhoneNumber(clean);
      if (!normalized) {
        console.error(
          pc.red(`\n❌ Error: Invalid Nigerian phone number: '${num}'\n`),
        );
        process.exit(1);
      }
      validEntries.push({ raw: num, normalized });
    }

    if (validEntries.length === 0) {
      console.log(sourceCmd.helpInformation());
      return;
    }

    for (let i = 0; i < validEntries.length; i++) {
      const entry = validEntries[i]!;
      const normalized = entry.normalized;
      const provenance = getContactProvenance(normalized);

      if (
        !provenance ||
        (provenance.groups.length === 0 &&
          provenance.rooms.length === 0 &&
          provenance.lists.length === 0)
      ) {
        console.log(
          pc.yellow(
            `\nNo provenance records found for contact: ${formatPhoneNumber(normalized)} (${normalized})\n`,
          ),
        );
        continue;
      }

      console.log(pc.cyan("\n" + "=".repeat(66)));
      console.log(
        pc.bold(
          pc.cyan(
            `📱 CONTACT SOURCE REPORT: ${formatPhoneNumber(normalized)} (${normalized})`,
          ),
        ),
      );
      console.log("=".repeat(66));
      console.log(
        `${pc.bold("Total Groups Identified In:")} ${pc.magenta(provenance.totalGroupsCount.toString())}`,
      );

      if (provenance.groups.length > 0) {
        console.log(pc.bold(pc.underline("\nIDENTIFIED GROUPS:")));
        provenance.groups.forEach((g, gIdx) => {
          console.log(
            `  ${pc.bold(`${gIdx + 1}.`)} ${formatProvenanceGroupItem(g)}`,
          );
        });
      }

      console.log(pc.bold(pc.underline("\nROOMS:")));
      if (provenance.rooms.length > 0) {
        provenance.rooms.forEach((r) => {
          console.log(`  • ${pc.green(r)}`);
          const matchingGroups = provenance.groups.filter((g) =>
            g.rooms?.includes(r),
          );
          if (matchingGroups.length > 0) {
            matchingGroups.forEach((g) => {
              const comm = g.communityName
                ? `${pc.cyan(`[🏛️ ${g.communityName}]`)} `
                : "";
              console.log(`    • ${comm}${g.subject}`);
            });
          } else {
            console.log(`    • ${pc.dim("(Present via list only)")}`);
          }
        });
      } else {
        console.log(pc.dim("  (None)"));
      }

      if (provenance.lists.length > 0) {
        console.log(pc.bold(pc.underline("\nPRESENT IN LISTS:")));
        provenance.lists.forEach((l) => {
          console.log(`  • ${pc.green(l)}`);
        });
      }
      console.log("\n" + "=".repeat(66) + "\n");
    }
  });

/**
 * Configuration Command
 */
const configCmd = program
  .command("config")
  .description(`View or update ${getWapeConfigFile()} settings`);

configCmd
  .command("get [setting]")
  .description(`View current ${getWapeConfigFile()} configuration`)
  .action((setting?: string) => {
    const cfg = getAppConfig();
    if (setting) {
      const cleanKey = setting.trim().toLowerCase();
      if (cleanKey === "key") {
        console.log(cfg.key ?? "(not set)");
      } else if (cleanKey === "backup" || cleanKey === "backuppath") {
        console.log(cfg.backupPath ?? "(not set)");
      } else if (
        cleanKey === "default-compare" ||
        cleanKey === "defaultcomparerooms"
      ) {
        console.log(cfg.defaultCompareRooms?.join(", ") ?? "(not set)");
      } else {
        console.log(pc.yellow(`Unknown setting '${setting}'.`));
      }
      return;
    }
    console.log(pc.cyan(`\n⚙️  wape Configuration (${getWapeConfigFile()})\n`));
    console.log("=".repeat(65));
    console.log(
      `${pc.bold("Key:")}                   ${cfg.key ? pc.yellow(cfg.key.slice(0, 12) + "..." + cfg.key.slice(-6)) : pc.dim("(not set)")}`,
    );
    console.log(
      `${pc.bold("Backup Path:")}           ${cfg.backupPath ? pc.green(cfg.backupPath) : pc.dim("(auto-discovery)")}`,
    );
    console.log(
      `${pc.bold("Default Compare Rooms:")} ${cfg.defaultCompareRooms && cfg.defaultCompareRooms.length > 0 ? pc.cyan(cfg.defaultCompareRooms.join(", ")) : pc.dim("(not set)")}`,
    );
    console.log("=".repeat(65) + "\n");
  });

configCmd
  .command("set")
  .description("Set configuration values")
  .option("-k, --key <key>", "Decryption key (64 hex characters or base64)")
  .option("-b, --backup <path>", "Path to WhatsApp backup file")
  .option(
    "-d, --default-compare <rooms...>",
    "Default rooms to use for compare and bundle operations (e.g. -d room1 room2)",
  )
  .option(
    "--clear-default-compare",
    "Clear configured default rooms for compare and bundle operations",
  )
  .action(
    (opts: {
      key?: string;
      backup?: string;
      defaultCompare?: string[];
      clearDefaultCompare?: boolean;
    }) => {
      if (
        !opts.key &&
        !opts.backup &&
        !opts.defaultCompare &&
        !opts.clearDefaultCompare
      ) {
        console.log(
          pc.yellow(
            "Please provide --key <key>, --backup <path>, --default-compare <rooms...>, or --clear-default-compare to update config.",
          ),
        );
        return;
      }
      const update: AppConfig & { clearDefaultCompare?: boolean } = {};
      if (opts.key) update.key = opts.key.trim();
      if (opts.backup) update.backupPath = opts.backup.trim();
      if (opts.clearDefaultCompare) {
        update.clearDefaultCompare = true;
      }
      if (opts.defaultCompare) {
        if (opts.defaultCompare.length < 2) {
          console.error(
            pc.red(
              "\n❌ Error: Please provide at least two rooms for default-compare (e.g. --default-compare room1 room2)\n",
            ),
          );
          process.exit(1);
        }
        update.defaultCompareRooms = [
          opts.defaultCompare[0]!.trim().toLowerCase(),
          opts.defaultCompare[1]!.trim().toLowerCase(),
        ];
      }
      saveAppConfig(update);
      console.log(
        pc.green(`\n✅ Configuration updated in ${getWapeConfigFile()}\n`),
      );
    },
  );

configCmd.action(() => {
  configCmd.outputHelp();
});

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
} else {
  program
    .parseAsync(process.argv)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
