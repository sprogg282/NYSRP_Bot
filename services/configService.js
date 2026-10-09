const db = require('../database/db');
const config = require('../config');

class ConfigService {
    /**
     * Get guild configuration with centralized channel defaults
     * @param {string} guildId 
     * @returns {Object}
     */
    static getConfig(guildId) {
        let row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
        if (!row) {
            db.prepare('INSERT INTO guild_config (guild_id, rank_roles) VALUES (?, ?)').run(guildId, '{}');
            row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
        }

        // Apply centralized default fallbacks if guild DB values are null
        row.welcome_channel = row.welcome_channel || config.channels.welcome;
        row.moderation_log_channel = row.moderation_log_channel || config.channels.moderationLogs;
        row.staff_log_channel = row.staff_log_channel || config.channels.staffActions;
        row.ticket_log_channel = row.ticket_log_channel || config.channels.commandLogs;
        row.transcript_channel = row.transcript_channel || config.channels.ticketTranscripts;

        try {
            row.rank_roles = JSON.parse(row.rank_roles || '{}');
        } catch {
            row.rank_roles = {};
        }

        return row;
    }

    /**
     * Update a channel configuration column
     * @param {string} guildId 
     * @param {string} type 
     * @param {string} channelId 
     */
    static setChannel(guildId, type, channelId) {
        this.getConfig(guildId);
        const columnMap = {
            welcome: 'welcome_channel',
            rules: 'rules_channel',
            info: 'info_channel',
            moderation_log: 'moderation_log_channel',
            staff_log: 'staff_log_channel',
            ticket_log: 'ticket_log_channel',
            transcript: 'transcript_channel'
        };

        const columnName = columnMap[type];
        if (!columnName) throw new Error(`Invalid channel config type: ${type}`);

        db.prepare(`UPDATE guild_config SET ${columnName} = ? WHERE guild_id = ?`).run(channelId, guildId);
    }

    /**
     * Update a category configuration column
     * @param {string} guildId 
     * @param {string} type 
     * @param {string} categoryId 
     */
    static setCategory(guildId, type, categoryId) {
        this.getConfig(guildId);
        if (type !== 'ticket') throw new Error(`Invalid category config type: ${type}`);
        db.prepare('UPDATE guild_config SET ticket_category = ? WHERE guild_id = ?').run(categoryId, guildId);
    }

    /**
     * Set role mapping for a specific NYSRP rank
     * @param {string} guildId 
     * @param {string} rankKey 
     * @param {string} roleId 
     */
    static setRankRole(guildId, rankKey, roleId) {
        const configData = this.getConfig(guildId);
        configData.rank_roles[rankKey] = roleId;
        db.prepare('UPDATE guild_config SET rank_roles = ? WHERE guild_id = ?')
            .run(JSON.stringify(configData.rank_roles), guildId);
    }
}

module.exports = ConfigService;
