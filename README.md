# wape - WhatsApp Phone Extractor, Room Manager & List Aggregator

A TypeScript CLI toolkit for decrypting WhatsApp backup databases, organizing WhatsApp groups into persistent **Rooms** in `~/.wape`, extracting unique Nigerian phone numbers, and managing multi-list and room-level comparisons.

> Note: `wape` uses [`wa-crypt-tools`](https://github.com/ElDavoo/wa-crypt-tools) under the hood and supports various WhatsApp backup versions (e.g. `.crypt12`, `.crypt14`, `.crypt15`), essentially any variant that can be cracked provided you supply the correct 64-character hex decryption key.

---

## 🚀 Setup & Installation

This toolkit requires a JavaScript/TypeScript package manager (Bun, pnpm, or npm) and Python 3 (for decryption).

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/mikelneonedwin/wape.git
cd wape
bun install   # or: npm install / pnpm install
```

### 2. Setup Python Virtual Environment

`wape` expects a Python virtual environment at `.venv` containing `wa-crypt-tools`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install wa-crypt-tools
```

### 3. Link Globally (Optional but Recommended)

Link `wape` to your global path to use the `wape` command anywhere in your terminal:

```bash
bun link      # or: npm link / pnpm link
```

_(If you prefer not to link globally, you can prefix any command with `bun run wape <command>` or `bun run <command>`)_.

### 4. Configure Decryption Key

Provide your 64-character WhatsApp decryption key (stored in `~/.wape/config.json`):

```bash
wape config set --key <your-64-char-hex-key>
```

### 5. Backup Auto-Discovery

`wape` automatically detects backup databases matching `msgstore*.db*.crypt*` across `~/Downloads`, `~`, and `~/.wape`. When multiple backup files exist, `wape` automatically selects the newest one based on the date it landed on the drive.

To bypass auto-discovery and set an explicit path:

```bash
wape config set --backup /path/to/msgstore.db.crypt15
```

---

## 🛠 Available Commands

### 1. Configuration (`wape config`)

Manage settings stored in `~/.wape/config.json`.

```bash
# View active configuration
wape config get

# Set decryption key or custom backup path
wape config set --key <64-hex-key>
wape config set --backup <path>

# Lock in two default rooms for bundle and compare operations
wape config set --default-compare room1 room2
```

---

### 2. Contact Provenance & Origin Lookup (`wape source`)

Inspect any Nigerian phone number to view all WhatsApp groups, parent communities, backup sources (primary vs. labeled one-offs), and lists it was identified in:

```bash
# Inspect contact origins
wape source 08012345678
```

---

### 3. Room Management (`wape rooms`)

Rooms group related WhatsApp chats into persistent bundles stored in `~/.wape/rooms.json`. Each room automatically maps to its dedicated contact list file (`~/.wape/lists/<id>.txt`).

```bash
# List all configured rooms with group and contact stats
wape rooms list

# Create a new room with an explicit ID
wape rooms new <id>

# View room details, included groups, and exited/missing status
wape rooms info [id]

# Print out only the groups configured in a room
wape rooms groups [id]

# Print absolute path to a room's contact list file
wape rooms path <id>

# Patch/import contacts from external text/vCard (.vcf) file(s) into a room's list
wape rooms patch <id> <file1.vcf> [file2.txt...]

# Unpatch/remove contacts present in external text/vCard (.vcf) file(s) from a room's list
wape rooms unpatch <id> <file1.vcf> [file2.txt...]

# Add new groups to an existing room (filters out groups already in this room or other rooms)
wape rooms add [id]

# Remove groups from an existing room
wape rooms remove [id]

# Rename a room ID and migrate its contact list file
wape rooms rename <oldId> <newId>

# Delete one or more rooms by ID
wape rooms delete <id> [id2...]

# Compare contact lists across rooms (defaults to all configured rooms)
wape rooms compare
wape rooms compare <id1> <id2> [id3...]

# Display identified group sources alongside each common contact
wape rooms compare --source
wape rooms compare <id1> <id2> --source

# Compare rooms and bundle new contacts + new links to clipboard
wape rooms bundle <id1> <id2> [id3...]

# Scan ALL configured rooms (or pass specific room IDs)
wape rooms scan
wape rooms scan <id> [id2...]
wape rooms scan --main
wape rooms scan --lock
```

---

### 3. Group & Room Scanning (`wape scan`)

Extracts and sieves unique Nigerian phone numbers from selected groups or configured rooms with live search and community nesting.

```bash
# Interactive scan (choose from a configured room or pick ad-hoc groups)
wape scan

# Scan directly from a room by ID (saves to lists/<room-id>.txt)
wape scan <room-id>

# Scan and direct output to a specific list file or global lists
wape scan -t leads.txt
wape scan <room-id> --main
wape scan <room-id> --lock

# Include ignored groups in ad-hoc selection
wape scan --include-ignored
```

---

### 4. Ignored Groups Management (`wape ignore`, `wape ignored`, `wape unignore`)

Mark personal, family, or irrelevant WhatsApp groups as ignored to prevent them from ever being added to any room (`wape rooms new`, `wape rooms add`) or appearing in ad-hoc scans (`wape scan`). Ignored groups are stored persistently by WhatsApp JID in `~/.wape/ignored-groups.json`.

```bash
# Interactively mark groups as ignored
wape ignore

# View all currently ignored groups with their communities and member counts
wape ignored
wape ignore list

# Interactively unmark / restore previously ignored groups
wape unignore
```

---

### 5. One-Off Databases & Keys (`wape oneoff`)

Scan temporary or one-off WhatsApp backup databases using a dedicated one-off decryption key without touching or overwriting `config.json`. The `--key` (`-k`) option is required, while `--backup` (`-b`) is optional (falls back to auto-discovery if omitted).

```bash
# Scan groups from a one-off backup and select destination interactively
wape oneoff scan -k <64-char-hex-key> -b /path/to/one-off.crypt15

# One-off scan using backup auto-discovery, targeting an existing list
wape oneoff scan -k <64-char-hex-key> -t leads
wape oneoff scan -k <64-char-hex-key> --main
wape oneoff scan -k <64-char-hex-key> --lock

# Extract group invite links from a one-off backup
wape oneoff links -k <64-char-hex-key> -b /path/to/one-off.crypt15
```

---

### 6. Compare Contacts (Intersection) (`wape compare`)

Finds contacts present in ALL target lists, rooms, or vCard (`.vcf`) files, and prints each number in `"XXXX XXX XXXX"` format (e.g. `0803 123 4567`) line by line for quick copy-pasting. You can compare across 2 or more targets simultaneously.

`wape compare` automatically maintains an order-independent record in `~/.wape/comparisons.json`. Any newly discovered common contacts are highlighted with a `[NEW]` badge, automatically copied to your clipboard (each item on its own new line with the `[NEW]` tag), and recorded so they are no longer marked as new on subsequent comparisons.

```bash
# Compare global main.txt and lock.txt (default if no targets provided)
wape compare

# Compare two or more specific lists or rooms
wape compare <target1> <target2> [target3...]

# Display identified group sources alongside each common contact
wape compare --source
wape compare <target1> <target2> --source

# Compare a VCF file with a room or list
wape compare contacts.vcf my-room
```

---

### 7. Bundle Contacts & Group Links (`wape bundle`)

Performs a general room scan of all configured rooms to update their contact lists, compares the target rooms or lists to filter down strictly to **newly discovered common contacts**, extracts all **new WhatsApp group invite links** from the backup database, prints only the new items to the terminal, and copies both together to your clipboard in a single step.

```bash
# Compare rooms and bundle new contacts + new links
wape bundle gunner norm
wape bundle roomA roomB roomC

# Bundle ad-hoc lists or .vcf files
wape bundle list1.txt leads.vcf

# Default (compares all configured rooms or main & lock)
wape bundle
```

---

### 8. Stats & Union Breakdown (`wape stats`)

Computes aggregated stats totals across lists and rooms:

- **0 arguments**: Global overview of all lists in `lists/` and grand unique union.
- **1 argument**: Contact count and stats for that specific list or room.
- **2 arguments**: Comparative analysis (totals, overlap, and union).
- **>2 arguments**: Aggregates all targets into a combined unique total.

```bash
# Global overview of all lists and grand unique union
wape stats

# Stats for a single specific list or room
wape stats <target>

# Comparative stats (compares totals, overlap, and union for two lists)
wape stats <target1> <target2>

# Multi-target stats (aggregates multiple lists or rooms into a combined unique total)
wape stats <target1> <target2> <target3>
```

---

### 9. Patch & Import Contacts (`wape patch`)

Import and merge contacts from external text or vCard (`.vcf`) file(s) directly into global lists (`main.txt` / `lock.txt`) or any target room/custom list file:

```bash
# Patch external text or VCF file(s) into global main list
wape patch --main leads.txt contacts.vcf

# Patch external text or VCF file(s) into global lock list
wape patch --lock locked_numbers.vcf

# Patch external text or VCF file(s) into a specific room or custom list target
wape patch <target> contacts.vcf extra.txt
```

---

### 10. Unpatch & Remove Contacts (`wape unpatch`)

Remove contacts present in external text or vCard (`.vcf`) file(s) from global lists (`main.txt` / `lock.txt`) or any target room/custom list file:

```bash
# Unpatch/remove contacts in VCF file(s) from global main list
wape unpatch --main contacts.vcf

# Unpatch/remove contacts in VCF file(s) from global lock list
wape unpatch --lock contacts.vcf

# Unpatch/remove contacts in VCF file(s) from a specific room or custom list target
wape unpatch <target> contacts.vcf
```

---

### 11. Print Contacts (`wape print`)

Prints all phone numbers in a specific room or list, strictly one per line, in `"XXXX XXX XXXX"` format.

```bash
wape print <target>
```

---

### 12. Contact Lists Repository (`wape lists`)

Shows all contact list files currently managed in the active lists directory and their contact counts.

```bash
wape lists
```

---

### 13. WhatsApp Group Links Extractor (`wape links`)

Scans all messages (groups and direct 1-on-1 DMs) across your decrypted WhatsApp backup for group invite links (`https://chat.whatsapp.com/...`), cleans search parameters, filters out links previously saved in `links.json`, automatically records newly found links into `links.json`, prints them one per line to the terminal, and copies them to your clipboard.

```bash
wape links
```

---

### 14. Chat Transcript Export (`wape chats export`)

Exports formatted WhatsApp chat transcripts for a contact phone number, direct message chat, group, or username in the native WhatsApp copied format (`[DD/MM, HH:mm] Sender: Message`).

By default, copies the transcript to your clipboard when run interactively, or streams the raw transcript directly to `stdout` when piped or redirected:

```bash
# Export chat by phone number (copies to clipboard by default)
wape chats export 08076488738

# Stream directly to stdout when piped
wape chats export 08076488738 | grep "curl"

# Time and date filtering flags
wape chats export 08076488738 --since 30m
wape chats export 08076488738 --since 3d
wape chats export 08076488738 --from 2025-02-12
wape chats export 08076488738 --to 2026-02-01
wape chats export 08076488738 --last-month
```

### 15. Chat Links Filtering (`wape chats links`)

Filters through messages across all chats to extract WhatsApp group invite links, supporting optional `--since`, `--from`, `--to`, `--last`, and `--count` flags. By default, prints the links and copies them to the clipboard. When piped or redirected, streams the raw links directly to `stdout` without copying to the clipboard:

```bash
# Print and copy all extracted group invite links
wape chats links

# Filter links extracted from messages in the last 7 days
wape chats links --since 7d

# Limit to the last N most recent links
wape chats links --last 20
wape chats links --since 30d --last 40

# Count the matching links without printing or copying them
wape chats links --count
wape chats links --since 7d --count

# Filter links within a date window
wape chats links --from 2026-01-01 --to 2026-03-31

# Stream directly to stdout when piped (clipboard copying disabled)
wape chats links --since 1w | sort -u
```

### 16. Message Origin Search (`wape chats search`)

Searches across all WhatsApp groups and chats for messages matching a keyword or URL pattern (ideal for finding WhatsApp group invite links). Displays the group name, sender name/phone, timestamp, and message text:

```bash
# Search for WhatsApp group invite links
wape chats search "chat.whatsapp.com"

# Count matching messages without printing full results
wape chats search "chat.whatsapp.com" --count
wape chats search "modools" --since 7d --count

# Filter by time range and limit results
wape chats search "modools" --since 7d --limit 10
```

---

## 📁 Storage Architecture & Custom Directory (`WAPE_HOME`)

By default, `wape` stores all data inside `~/.wape`. You can override this to any custom directory by setting the `WAPE_HOME` environment variable:

```bash
export WAPE_HOME="/path/to/custom/wape/dir"
```

Directory structure:

- **`wape.db`**: Embedded SQLite database containing all contact indexes, list memberships, room definitions, group mappings, provenance relations, saved links, and comparisons.
- **`config.json`**: Global environment configuration (decryption key, backup path, and default comparison rooms).
- **`lists/`**: Plain-text exports for global (`main.txt`, `lock.txt`) and room-level (`<id>.txt`) contact list files.
