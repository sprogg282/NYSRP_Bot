-- NYSRP Database Schema Initialization

CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    welcome_channel TEXT,
    rules_channel TEXT,
    info_channel TEXT,
    moderation_log_channel TEXT,
    staff_log_channel TEXT,
    ticket_category TEXT,
    ticket_log_channel TEXT,
    transcript_channel TEXT,
    rank_roles TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS moderation_cases (
    case_id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    duration TEXT,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_actions (
    action_id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    performed_by TEXT NOT NULL,
    action_type TEXT NOT NULL,
    previous_rank TEXT,
    new_rank TEXT NOT NULL,
    reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
    ticket_id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    creator_id TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    claimed_by TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by TEXT
);

CREATE TABLE IF NOT EXISTS staff_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rank TEXT NOT NULL,
    staff_status TEXT DEFAULT 'ACTIVE',
    joined_staff_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS ticket_feedback (
    feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL UNIQUE,
    guild_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    claimed_by TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestion_system_state (
    guild_id TEXT PRIMARY KEY,
    panel_message_id TEXT,
    cta_message_id TEXT
);

CREATE TABLE IF NOT EXISTS suggestions (
    suggestion_id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    author_id TEXT NOT NULL,
    suggestion_text TEXT NOT NULL,
    reason_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNDER_REVIEW',
    decision_by TEXT,
    decision_reason TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote TEXT NOT NULL CHECK (vote IN ('UP', 'DOWN')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (suggestion_id, user_id),
    FOREIGN KEY (suggestion_id) REFERENCES suggestions(suggestion_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VOTING', -- VOTING, VOTE_PASSED, SSU_ACTIVE, SSU_ENDED, CLOSED
    vote_message_id TEXT,
    channel_id TEXT NOT NULL,
    started_by TEXT NOT NULL,
    vote_started_at INTEGER NOT NULL,
    vote_passed_at INTEGER,
    ssu_started_by TEXT,
    ssu_started_at INTEGER,
    ssu_ended_by TEXT,
    ssu_ended_at INTEGER,
    session_ended_at INTEGER,
    required_yes_votes INTEGER DEFAULT 5,
    yes_votes INTEGER DEFAULT 0,
    no_votes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_voters (
    session_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote_choice TEXT NOT NULL, -- YES or NO
    voted_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, user_id)
);
