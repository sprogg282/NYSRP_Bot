# <:NYSRP:1515439585398886501> New York State Roleplay (NYSRP) Discord Bot

An enterprise-grade, modular Discord community management bot built for **New York State Roleplay (NYSRP)**.

Built with **Node.js**, **discord.js v14**, and **SQLite (`better-sqlite3`)**.

---

## 🌟 Key Features & Core Systems

- **🚨 Moderation System**: Case management (`#0001` auto-incrementing case IDs), warn, kick, ban, unban, timeout, untimeout, purge, and moderation history tracking with automated log broadcasts and DMs.
- **🔐 Permissions & Rank System**: 9-tier NYSRP staff authority hierarchy (`Owner` ➔ `Junior Moderator`) with strict server-side hierarchy protection preventing unauthorized actions, self-promotions, or rank bypasses.
- **📈 Promotion / Demotion System**: Full rank change audit trail, role synchronization, and NYSRP formatted staff update logs.
- **👮 Staff Management System**: Comprehensive staff directory, roster list, individual staff profiles, performance metrics, and history logs.
- **🎫 Ticket System**: Interactive support panel with select menu categories, private ticket channels, role permissions, HTML transcript generation, claim, lock, unlock, and delete controls.
- **💡 Suggestion System**: Persistent suggestion panel, modal submissions, up/down voting, staff decisions, and a restart-safe rolling call-to-action in the configured suggestions channel.
- **👋 Welcome System**: Automated welcome embeds adhering strictly to the NYSRP master embed style.
- **⚙️ Centralized Guild Configuration**: Dynamic channel, category, and rank-to-role mappings saved per guild in SQLite.

---

## 📐 Official NYSRP Embed Standard

All standard bot embeds enforce the official **NYSRP Master Embed Format**:

```
<:NYSRP:1515439585398886501> NYSRP Title

> Professional introduction blockquote.

> **IMPORTANT:** Crucial notice or instruction.

━━━━━━━━━━━━━━━━━━

📌 Section Name:
• Bullet detail point 1
• Bullet detail point 2

━━━━━━━━━━━━━━━━━━

Professional closing message.
```

*(Note: Ticket Transcripts are the only exception and use a dedicated HTML transcript layout).*

---

## 📁 Directory Structure

```
NYSRP_Bot/
├── index.js                     # Main bot entry point (node index.js)
├── package.json                 # Dependencies & project scripts
├── .env                         # Secret tokens & IDs (git-ignored)
├── .env.example                 # Environment configuration template
├── .gitignore                   # Git ignore rules
├── README.md                    # System documentation
│
├── config/
│   ├── index.js                 # Environment & branding configuration
│   ├── ranks.js                 # NYSRP Rank hierarchy definitions (Levels 1-9)
│   ├── permissions.js           # Granular permission nodes
│   └── ticketCategories.js      # Support ticket categories
│
├── database/
│   ├── db.js                    # SQLite database connection (better-sqlite3)
│   └── schema.sql               # Database table initialization schema
│
├── utils/
│   ├── embedBuilder.js          # Master NYSRP Embed formatting helper
│   ├── logger.js                # Timestamped console logging utility
│   ├── permissionCheck.js       # Rank authority & permission check engine
│   └── transcriptGenerator.js   # Ticket HTML transcript builder
│
├── services/
│   ├── moderationService.js     # Moderation actions, DB tracking & logging
│   ├── staffService.js          # Rank promotions, demotions & roster profiles
│   ├── ticketService.js         # Ticket channel management & state handling
│   ├── suggestionService.js     # Suggestion panel, submissions, votes & decisions
│   ├── welcomeService.js        # Member join event welcome handler
│   └── configService.js         # Guild settings management
│
├── handlers/
│   ├── commandHandler.js        # Slash command loader & REST API deployment
│   ├── eventHandler.js          # Discord event dispatcher
│   └── componentHandler.js      # Button & Select menu interaction router
│
├── commands/
│   ├── moderation/              # /warn, /kick, /ban, /unban, /timeout, /untimeout, /purge, /modhistory
│   ├── staff/                   # /staff (view, list, profile, promote, demote, history, info)
│   ├── tickets/                 # /ticket (panel, close, lock, unlock, add, remove)
│   ├── configuration/           # /config (set-channel, set-category, set-role, view)
│   └── utility/                 # /ping, /help
│
└── events/
    ├── ready.js                 # Ready event & presence status
    ├── interactionCreate.js    # Interaction routing
    └── guildMemberAdd.js        # Welcome system trigger
```

---

## 🔐 Permission Hierarchy & Authority Levels

| Level | Rank Name | Primary Authority & Role |
| :--- | :--- | :--- |
| **9** | **Owner** | Full administrative control & system config |
| **8** | **Co-Owner** | Server administration & staff oversight |
| **7** | **Management** | Senior staff management & configuration |
| **6** | **Internal Affairs** | Staff promotions, demotions & investigations |
| **5** | **Director** | Departmental management |
| **4** | **Administrator** | Bans, unbans, logs, staff history |
| **3** | **Junior Administrator** | Bans, kicks, timeouts |
| **2** | **Moderator** | Kicks, timeouts, purges |
| **1** | **Junior Moderator** | Warnings, timeouts, tickets |

### Hierarchy Rules Enforced:
1. Members cannot execute staff/moderation actions on users with equal or higher rank.
2. Members cannot promote anyone to or above their own rank level.
3. Self-promotion and self-demotion are blocked.

Suggestion decisions require the existing rank-based **Suggestion Manage** permission (Internal Affairs+).

## 💡 Suggestion System

The bot creates and persists the suggestion panel and rolling call-to-action in channel `1556342057914867785`. Members submit ideas with the panel button; suggestions and votes are stored in SQLite. A suggestion's upvote/downvote buttons allow one active vote per member, and staff decisions require a reason. The bot needs View Channel, Send Messages, Embed Links, and Read Message History in the suggestion channel. Only the tracked call-to-action message is replaced after a suggestion is submitted; suggestion posts are preserved. The panel and call-to-action IDs are recovered on bot startup.

### Promotion & Demotion
- Use `/staff promote` or `/staff demote`, select the target rank, and provide a reason. Changes move exactly one level in the configured rank order and require confirmation within 60 seconds.
- The rank definitions in `config/ranks.js` are shared by staff commands and permissions; each rank must have its own Discord role mapped with `/config set-role`.
- The bot needs **Manage Roles**, and its highest role must be above the rank roles it adds or removes. Discord role changes are verified before the staff database and history are updated.
- The server owner, bot application owner, and members assigned the protected **Owner** rank cannot be changed with these commands. Successful changes are recorded in staff history and sent to the configured Staff Log channel.

---

## 🛠️ Prerequisites & Installation

### Requirements
- **Node.js**: v18.0.0 or higher (v24.x tested and supported)
- **Discord Bot Token**: Obtained from [Discord Developer Portal](https://discord.com/developers/applications)

### Installation Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment (`.env`)**:
   Copy `.env.example` to `.env` and fill in your Discord Application details:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   CLIENT_ID=your_application_client_id
   GUILD_ID=your_guild_id
   PREFIX=/
   ```

3. **Discord Gateway Intents**:
   In the Discord Developer Portal under **Bot**:
   - Enable **Presence Intent**
   - Enable **Server Members Intent**
   - Enable **Message Content Intent**

---

## 🚀 How to Start the Bot

Launch the bot using the primary startup command:

```bash
node index.js
```

Upon starting:
- SQLite tables will be initialized automatically in `./data/nysrp.db`.
- All 13 slash commands will deploy to your target guild automatically.
- Console logs will confirm bot readiness.

---

## ⚙️ Initial Server Configuration

Once the bot is online in your server, set up channels and roles using `/config`:

1. **Set Channels**:
   - `/config set-channel type:Welcome Channel channel:#welcome`
   - `/config set-channel type:Rules Channel channel:#rules`
   - `/config set-channel type:Info Channel channel:#info`
   - `/config set-channel type:Moderation Log Channel channel:#mod-logs`
   - `/config set-channel type:Staff Log Channel channel:#staff-logs`
   - `/config set-channel type:Ticket Log Channel channel:#ticket-logs`
   - `/config set-channel type:Transcript Channel channel:#transcripts`

2. **Set Categories**:
   - `/config set-category type:Ticket Category category:SUPPORT TICKETS`

3. **Link Discord Roles to NYSRP Ranks**:
   - `/config set-role rank:Moderator role:@Moderator`
   - `/config set-role rank:Administrator role:@Administrator`
   - *(Repeat for all active staff roles)*

4. **Deploy Ticket Support Panel**:
   - `/ticket panel`

---

## ❓ Troubleshooting

- **Slash commands not appearing?**
  Verify `CLIENT_ID` and `GUILD_ID` in `.env`, then run `node index.js` again to re-sync command definitions.
- **Missing Permissions Error?**
  Ensure the bot's Discord role is placed **above** the user roles it attempts to assign or modify.
