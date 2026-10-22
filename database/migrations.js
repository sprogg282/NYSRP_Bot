function hasColumn(db, tableName, columnName) {
    return db.pragma(`table_info(${tableName})`).some(column => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, definition) {
    if (!hasColumn(db, tableName, columnName)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

const migrations = [
    {
        version: 1,
        apply(db) {
            addColumnIfMissing(
                db,
                'tickets',
                'priority',
                "TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'))"
            );
            addColumnIfMissing(db, 'tickets', 'close_previous_status', 'TEXT');
            addColumnIfMissing(db, 'tickets', 'closing_started_at', 'INTEGER');
            addColumnIfMissing(db, 'tickets', 'transcript_message_ids', "TEXT NOT NULL DEFAULT '[]'");
            addColumnIfMissing(db, 'tickets', 'transcript_part_count', 'INTEGER NOT NULL DEFAULT 0');
            addColumnIfMissing(db, 'tickets', 'transcript_delivered_at', 'INTEGER');
            addColumnIfMissing(db, 'tickets', 'transcript_delivery_nonce', 'TEXT');

            db.exec(`
                CREATE TABLE IF NOT EXISTS ticket_priority_history (
                    change_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticket_id INTEGER NOT NULL,
                    guild_id TEXT NOT NULL,
                    changed_by TEXT NOT NULL,
                    previous_priority TEXT NOT NULL,
                    new_priority TEXT NOT NULL,
                    changed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tickets_guild_status_priority
                    ON tickets (guild_id, status, priority);
            `);
        }
    },
    {
        version: 2,
        apply(db) {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_polls_guild_status_close
                    ON polls (guild_id, status, closes_at);
                CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_option
                    ON poll_votes (poll_id, option_index);
            `);
        }
    },
    {
        version: 3,
        apply(db) {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_events_guild_status_end
                    ON events (guild_id, status, ends_at);
                CREATE INDEX IF NOT EXISTS idx_event_entries_event
                    ON event_entries (event_id, entered_at);
            `);
        }
    },
    {
        version: 4,
        apply(db) {
            addColumnIfMissing(
                    db,
                    'sessions',
                    'vote_passed_notified',
                    'INTEGER NOT NULL DEFAULT 1 CHECK (vote_passed_notified IN (0, 1))'
            );
            db.exec(`
                    CREATE INDEX IF NOT EXISTS idx_sessions_guild_status
                        ON sessions (guild_id, status);
            `);
        }
    },
    {
        version: 5,
        apply(db) {
            db.exec(`
                        CREATE TABLE IF NOT EXISTS erlc_status_panels (
                            guild_id TEXT PRIMARY KEY,
                            channel_id TEXT NOT NULL,
                            message_id TEXT NOT NULL,
                            updated_at INTEGER NOT NULL
                        );
            `);
        }
    }
];

function applyMigrations(db) {
    let currentVersion = db.pragma('user_version', { simple: true });
    for (const migration of migrations) {
        if (migration.version <= currentVersion) continue;
        db.transaction(() => {
            migration.apply(db);
            db.pragma(`user_version = ${migration.version}`);
        })();
        currentVersion = migration.version;
    }
}

module.exports = { applyMigrations };
