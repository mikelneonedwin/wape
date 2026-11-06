# wape - WhatsApp Phone Extractor, Room Manager & List Aggregator

A TypeScript CLI toolkit for decrypting WhatsApp backup databases, organizing WhatsApp groups into persistent Rooms in `~/.wape`, extracting unique Nigerian phone numbers, and managing multi-list and room-level comparisons.

> Note: `wape` uses [`wa-crypt-tools`](https://github.com/ElDavoo/wa-crypt-tools) under the hood and supports various WhatsApp backup versions (such as `.crypt12`, `.crypt14`, `.crypt15`), essentially any variant that can be decrypted provided you supply the matching 64-character hex decryption key.

---

## 🚀 Setup & Installation

This toolkit requires a JavaScript/TypeScript runtime (Bun, pnpm, or npm) and Python 3 (for decryption tools).

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

If you prefer not to link globally, you can prefix any command with `bun run wape <command>` or `bun run <command>`.

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

## ⚡ Daily Workflows

The root CLI is centered on five everyday verbs for extraction, comparison, and analysis.

### 1. Group & Room Scanning (`wape scan`)

Extracts and sieves unique Nigerian phone numbers from selected groups or configured rooms with live search and community nesting.

```bash
# Interactive scan (choose from a configured room or pick ad-hoc groups)
wape scan

# Scan directly from a room by ID (saves to lists/<room-id>.txt)
wape scan my-room

# Direct output to a specific list name or file
wape scan my-room --to leads
wape scan my-room --to main
wape scan my-room --to lock

# Include ignored groups in ad-hoc selection
wape scan --include-ignored

# Scan using an ad-hoc backup and key with an audit label
wape scan -k <key> -b /path/to/backup.crypt15 -l "Work Phone"
```

### 2. Bundle Contacts & Group Links (`wape bundle`)

Performs a general room scan of all configured rooms to update their contact lists, compares the target rooms or lists to filter down strictly to newly discovered common contacts, extracts all new WhatsApp group invite links from the backup database, prints only the new items to the terminal, and copies both together to your clipboard in a single step.

```bash
# Compare specific rooms and bundle new contacts + new links
wape bundle gunner norm
wape bundle roomA roomB roomC

# Bundle ad-hoc lists or .vcf files
wape bundle list1.txt leads.vcf

# Default bundle (uses defaultCompareRooms or compares all configured rooms)
wape bundle
```

### 3. Compare Contacts (`wape compare`)

Finds contacts present in all target lists, rooms, or vCard (`.vcf`) files, and prints each number in `XXXX XXX XXXX` format (such as `0803 123 4567`) line by line for quick copy-pasting. You can compare across two or more targets simultaneously.

`wape compare` automatically maintains an order-independent record in SQLite. Any newly discovered common contacts are highlighted with a `[NEW]` badge, automatically copied to your clipboard, and recorded so they are no longer marked as new on subsequent comparisons.

```bash
# Compare global main and lock lists (default if no targets provided)
wape compare

# Compare two or more specific lists or rooms
wape compare <target1> <target2> [target3...]

# Compare a VCF file with a room or list
wape compare contacts.vcf my-room

# Optional source tracing: inspect where common contacts originated
wape compare roomA roomB --source
wape compare roomA roomB -s
```

### 4. Contact Statistics & Unions (`wape stats`)

Computes aggregated stats totals across lists and rooms:

- Running without arguments prints a global inventory across all lists and the grand unique union.
- Passing one target shows the contact count for that specific list or room.
- Passing two targets performs a comparative analysis with intersection, union, and overlap percentage.
- Passing three or more targets aggregates all lists into a combined grand unique total.

```bash
# Global overview of all lists and grand unique union
wape stats

# Stats for a single specific list or room
wape stats my-room

# Comparative stats (totals, overlap, and union for two lists)
wape stats roomA roomB

# Multi-target stats (aggregates multiple lists or rooms into a combined unique total)
wape stats roomA roomB roomC
```

### 5. Contact Origin Lookup (`wape source`)

Inspect any Nigerian phone number to view all WhatsApp groups, parent communities, backup sources (primary vs. labeled ad-hoc runs), and lists where that contact was found.

```bash
# Inspect contact origins
wape source 08012345678
wape source 08012345678 08098765432

# Pipe numbers from a list or terminal command
cat leads.txt | wape source
```

---

## 🏠 Room Management (`wape rooms`)

Rooms group related WhatsApp chats into persistent bundles stored in the database. Each room automatically maps to its dedicated contact list file (`~/.wape/lists/<id>.txt`).

```bash
# List all configured rooms with group and contact counts (default action)
wape rooms
wape rooms list

# Show room details, included groups, and exited/missing status
wape rooms show <id>

# Create a new room with an explicit ID
wape rooms new <id>

# Add new groups to an existing room
wape rooms add [id]

# Remove groups from an existing room
wape rooms remove [id]

# Rename a room ID and migrate its contact list file
wape rooms rename <oldId> <newId>

# Delete one or more rooms by ID
wape rooms delete <id> [id2...]

# Print the contact list name for a room
wape rooms path <id>
```

---

## 👥 Group Curation & Auditing (`wape groups`)

List all active WhatsApp group chats and their member counts, organized hierarchically by parent community or ranked globally by membership size.

```bash
# List all active WhatsApp groups grouped by community with member counts
wape groups
wape groups list

# Rank all groups from most to least members regardless of community
wape groups --rank

# Filter groups to a specific configured room
wape groups --room <room-id>

# Search historical groups recorded from past scans
wape groups --history "Design"
wape groups --history --rank
```

### Group Audits (`wape groups audit`)

Audit your WhatsApp groups to manage room demographics or identify inactive, spam, or exitable groups to leave and prune:

```bash
# Audit a room for non-Nigerian demographic majority (default: >50%)
wape groups audit [id]

# Room demographic audit with custom threshold percentage (-t, --threshold)
wape groups audit [id] -t 40

# Show all groups in the room, including non-flagged ones
wape groups audit [id] --all

# Scan all groups across your backup to recommend groups to leave or delete (-e, --exit)
wape groups audit -e

# Audit only groups within a specific configured room for exit recommendations
wape groups audit [id] -e

# Interactively select flagged groups from audit output to ignore from future audits
wape groups audit [id] -i
wape groups audit -e -i
```

The exitable audit (`-e, --exit`) detects:

- Left but undeleted chats where you have exited but cached history remains.
- Inactive or dead groups with zero messages in more than 90 days.
- Temporary or expired event groups whose activity spiked and flatlined.
- Turnstile groups dominated by join and leave notifications.
- Spam groups dominated by standalone promotional links with zero discussion.
- Depleted or abandoned groups with two or fewer participants.

### Ignored Groups (`wape groups ignore`, `unignore`, `ignored`)

Mark personal, family, or irrelevant WhatsApp groups as ignored to prevent them from ever being added to rooms or appearing in ad-hoc scans. Ignored groups are stored persistently by WhatsApp JID.

```bash
# Interactively mark groups as ignored
wape groups ignore

# View all currently ignored groups with their communities and member counts
wape groups ignored

# Interactively unmark / restore previously ignored groups
wape groups unignore
```

---

## 📋 Contact Lists Repository (`wape lists`)

Manage contact list files, view counts, and import or remove contacts using external text and vCard files.

```bash
# List all managed contact lists and their contact counts (default action)
wape lists

# Print all phone numbers in a specific room or list in "XXXX XXX XXXX" format
wape lists print <target>
wape print <target>

# Import and merge contacts from external text or vCard (.vcf) files
wape lists import <target> contacts.vcf extra.txt
wape lists import main leads.vcf
wape lists import lock locked_numbers.vcf

# Remove contacts present in external files from a list or room
wape lists remove <target> contacts.vcf
wape lists remove main unsubscribed.txt

# Empty contacts from a specific list
wape lists clear <target>

# Compute stats across lists
wape lists stats roomA roomB
```

---

## 🔗 WhatsApp Group Invite Links (`wape links`)

Discover new WhatsApp group invite links from messages or search through your local history of recorded links.

### 1. Extract New Links from Backups (`wape links`)

Scans all messages (groups and direct chats) across your decrypted WhatsApp backup for group invite links (`https://chat.whatsapp.com/...`), cleans tracking parameters, filters out links previously saved, records newly found links into storage, prints them to the terminal, and copies them to your clipboard.

```bash
# Extract all new group invite links from the current backup
wape links

# Extract links from an ad-hoc backup
wape links -b /path/to/backup.crypt15 -k <key>
```

### 2. Search Link History (`wape links history`)

Filter through previously saved group invite links using duration or date window flags. When run in an interactive terminal, it copies matching links to your clipboard. When piped or redirected, it streams raw URLs directly to standard output without touching your clipboard.

```bash
# Print and copy all extracted group invite links
wape links history

# Filter links extracted from messages in the last 7 days
wape links history --since 7d

# Limit to the last N most recent links
wape links history --last 20
wape links history --since 30d --last 40

# Count the matching links without printing them
wape links history --count
wape links history --since 7d --count

# Filter links within a date window
wape links history --from 2026-01-01 --to 2026-03-31

# Stream directly to stdout when piped (clipboard copying disabled)
wape links history --since 1w | sort -u
```

---

## 💬 Chat Transcripts & Message Search (`wape chats`)

Export formatted WhatsApp chat transcripts or search message contents across all conversations.

### 1. Chat Transcript Export (`wape chats export`)

Exports formatted WhatsApp chat transcripts for a contact phone number, direct message chat, group, or username in native WhatsApp copied format (`[DD/MM, HH:mm] Sender: Message`).

By default, copies the transcript to your clipboard when run interactively, or streams the raw transcript directly to `stdout` when piped or redirected.

```bash
# Interactively select from all group chats
wape chats export

# Filter interactive group picker to only groups in a specific room
wape chats export --room Marketing

# Search groups by name (auto-selects if one match, or filters picker)
wape chats export --group-search "Design" --room Marketing --since 3d

# Export exact group or contact by name or phone number
wape chats export "Design Team"
wape chats export 08076488738

# Enable fuzzy/partial matching on target name or phone
wape chats export "Design" --fuzzy

# Stream directly to stdout when piped
wape chats export 08076488738 | grep "curl"

# Time and date filtering flags
wape chats export 08076488738 --since 30m
wape chats export 08076488738 --since 3d
wape chats export 08076488738 --from 2025-02-12
wape chats export 08076488738 --to 2026-02-01
wape chats export 08076488738 --last-month
```

### 2. Message Content Search (`wape chats search`)

Searches across all WhatsApp groups and chats for messages matching a keyword or URL pattern. Displays the group name, sender, timestamp, and message text:

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

## 🧰 Ad-Hoc & Secondary Backups

You do not need separate commands to inspect one-off or client backups. Any command that reads backup data (`scan`, `bundle`, `groups`, `chats`, `links`) accepts `-b, --backup <path>`, `-k, --key <hex>`, and optional `-l, --label <name>`.

When passed, `wape` decrypts and processes that database without overwriting your global `~/.wape/config.json`. The optional `--label` flag tags contact provenance so you can later trace numbers back to that specific client or phone using `wape source`.

```bash
# Scan groups from a client backup directly into a list
wape scan -k <key> -b /path/to/client.crypt15 -l "Client A" --to leads

# Extract links from a secondary backup
wape links -k <key> -b /path/to/client.crypt15

# Search messages in a one-off database
wape chats search "invoice" -k <key> -b /path/to/client.crypt15
```

---

## ⚙️ Configuration (`wape config`)

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

## 📁 Storage Architecture & Custom Directory (`WAPE_HOME`)

By default, `wape` stores all data inside `~/.wape`. You can override this to any custom directory by setting the `WAPE_HOME` environment variable:

```bash
export WAPE_HOME="/path/to/custom/wape/dir"
```

Directory structure:

- `wape.db`: Embedded SQLite database containing all contact indexes, list memberships, room definitions, group mappings, provenance relations, saved links, and comparisons.
- `config.json`: Global environment configuration (decryption key, backup path, and default comparison rooms).
- `lists/`: Plain-text contact lists exported or imported by rooms and custom list commands.
