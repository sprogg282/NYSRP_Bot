/**
 * NYSRP Permission Node Definitions and Default Minimum Rank Requirements
 */

const PERMISSIONS = {
    // Moderation Permissions
    MODERATION_WARN: 'MODERATION_WARN',
    MODERATION_KICK: 'MODERATION_KICK',
    MODERATION_BAN: 'MODERATION_BAN',
    MODERATION_UNBAN: 'MODERATION_UNBAN',
    MODERATION_TIMEOUT: 'MODERATION_TIMEOUT',
    MODERATION_PURGE: 'MODERATION_PURGE',
    MODERATION_HISTORY: 'MODERATION_HISTORY',

    // Staff Management Permissions
    STAFF_VIEW: 'STAFF_VIEW',
    STAFF_LIST: 'STAFF_LIST',
    STAFF_PROFILE: 'STAFF_PROFILE',
    STAFF_PROMOTE: 'STAFF_PROMOTE',
    STAFF_DEMOTE: 'STAFF_DEMOTE',
    STAFF_HISTORY: 'STAFF_HISTORY',
    STAFF_INFO: 'STAFF_INFO',
    SUGGESTION_MANAGE: 'SUGGESTION_MANAGE',

    // Support / Ticket Permissions
    TICKET_MANAGE: 'TICKET_MANAGE',

    // Log Access
    LOGS_VIEW: 'LOGS_VIEW',

    // System Configuration
    BOT_CONFIGURE: 'BOT_CONFIGURE'
};

// Default Minimum Rank Level for each permission node
const MIN_RANK_LEVEL = {
    [PERMISSIONS.MODERATION_WARN]: 1,     // Junior Moderator+
    [PERMISSIONS.MODERATION_TIMEOUT]: 1,  // Junior Moderator+
    [PERMISSIONS.MODERATION_KICK]: 2,     // Moderator+
    [PERMISSIONS.MODERATION_BAN]: 3,      // Junior Administrator+
    [PERMISSIONS.MODERATION_UNBAN]: 4,    // Administrator+
    [PERMISSIONS.MODERATION_PURGE]: 2,    // Moderator+
    [PERMISSIONS.MODERATION_HISTORY]: 1,  // Junior Moderator+

    [PERMISSIONS.STAFF_VIEW]: 1,         // Junior Moderator+
    [PERMISSIONS.STAFF_LIST]: 1,         // Junior Moderator+
    [PERMISSIONS.STAFF_PROFILE]: 1,      // Junior Moderator+
    [PERMISSIONS.STAFF_INFO]: 1,         // Junior Moderator+
    [PERMISSIONS.STAFF_HISTORY]: 4,      // Administrator+
    [PERMISSIONS.STAFF_PROMOTE]: 6,      // Internal Affairs+
    [PERMISSIONS.STAFF_DEMOTE]: 6,       // Internal Affairs+
    [PERMISSIONS.SUGGESTION_MANAGE]: 6,   // Internal Affairs+

    [PERMISSIONS.TICKET_MANAGE]: 1,      // Junior Moderator+

    [PERMISSIONS.LOGS_VIEW]: 4,          // Administrator+

    [PERMISSIONS.BOT_CONFIGURE]: 7       // Management+
};

module.exports = {
    PERMISSIONS,
    MIN_RANK_LEVEL
};
