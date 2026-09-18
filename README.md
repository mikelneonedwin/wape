# wape - WhatsApp Phone Extractor, Room Manager & List Aggregator

A TypeScript CLI toolkit built with **Bun** and **Drizzle ORM** for decrypting WhatsApp `.crypt15` backup databases, organizing WhatsApp groups into persistent **Rooms** in `~/.wape`, extracting unique Nigerian phone numbers, and managing multi-list and room-level inventory comparisons.

---

## 🚀 Setup & Installation

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Configure Decryption Key**:
   Configure your 64-character WhatsApp decryption key (stored in `~/.wape/config.json`):
   ```bash
   bun run wape config set --key <your-64-char-hex-key>
   ```

3. **Backup Auto-Discovery**:
   `wape` automatically detects backup databases matching `msgstore*.db*.crypt*` across `~/Downloads`, `~`, and `~/.wape`. If multiple backups are present, `wape` prompts you to choose which one to use.
   
   To set an explicit backup path:
   ```bash
   bun run wape config set --backup /path/to/msgstore.db.crypt15
   ```

---

## 🛠 Available Commands

### 1. Configuration (`wape config`)
Manage settings stored in `~/.wape/config.json`.

```bash
# View active configuration
bun run wape config get

# Set decryption key or custom backup path
bun run wape config set --key <64-hex-key>
bun run wape config set --backup <path>
```

---

### 2. Room Management (`wape room`)
Rooms group related WhatsApp chats into persistent bundles stored in `~/.wape/rooms.json`. Each room automatically maps to its dedicated contact list file (`~/.wape/lists/<id>.txt`).

```bash
# List all configured rooms with group and contact stats
bun run wape room list

# Create a new room with an explicit ID (aliases: new, add)
bun run wape room create <id>

# View room details, included groups, and exited/missing status (aliases: info, show)
bun run wape room detail [id]

# Edit groups within a room
bun run wape room edit [id]

# Rename a room ID and migrate its contact list file (aliases: reid, mv)
bun run wape room rename <oldId> <newId>

# Delete a room by ID
bun run wape room delete <id>

# Scan all groups inside a room
bun run wape room scan [id]
```

---

### 3. Group & Room Scanning (`wape scan`)
Extracts and sieves unique Nigerian phone numbers from selected groups or configured rooms with live search and community nesting.

```bash
# Interactive scan (choose from a configured room or pick ad-hoc groups)
bun run scan

# Scan directly from a room by ID
bun run scan <room-id>

# Scan and force output to a specific list file in ~/.wape/lists/
bun run scan <room-id> --list leads.txt

# Scan and force output to the global main list (~/.wape/lists/main.txt)
bun run scan <room-id> --global
```

---

### 4. Common Contacts Finder (Intersection) (`wape common`)
Finds contacts present in both target lists or rooms, and prints each number in `"XXXX XXX XXXX"` format (e.g. `0803 123 4567`) line by line for quick copy-pasting.

```bash
# Compare global main.txt and lock.txt (default)
bun run common

# Compare two specific lists or rooms
bun run common <room1_id|list1> <room2_id|list2>
```

---

### 5. Inventory & Union Breakdown (`wape inventory`)
Computes aggregated inventory totals across lists and rooms:

```bash
# Global inventory: displays individual totals for every list in ~/.wape/lists/ and the grand unique union
bun run inventory global

# Comparative inventory: compares two specific lists or rooms (totals, overlap, union)
bun run inventory <target1> <target2>

# Multi-target inventory: aggregates multiple lists or rooms into a combined unique total
bun run inventory <target1> <target2> <target3>
```

---

### 6. Contact Lists Repository (`wape lists`)
Shows all contact list files currently managed in `~/.wape/lists/` and their contact counts.

```bash
bun run lists
```

---

## 📁 Storage Architecture (`~/.wape`)

- **`~/.wape/config.json`**: Global configuration (decryption key and optional backup path).
- **`~/.wape/rooms.json`**: Persistent storage for room definitions and group mappings.
- **`~/.wape/lists/`**: Default repository for custom, global (`main.txt`, `lock.txt`), and room-level (`<id>.txt`) contact list files.
