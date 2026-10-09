const db = require('../database/db');
const ConfigService = require('./configService');
const config = require('../config');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const logger = require('../utils/logger');

class ModerationService {
    /**
     * Log moderation case to DB and moderation log channel (1515410238830809099)
     */
    static async recordAndLogCase({ guild, moderator, targetUser, action, reason, duration = null }) {
        const timestamp = Date.now();
        const info = db.prepare(`
            INSERT INTO moderation_cases (guild_id, user_id, moderator_id, action, reason, duration, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(guild.id, targetUser.id, moderator.id, action, reason, duration, timestamp);

        const caseIdNumber = info.lastInsertRowid;
        const formattedCaseId = `#${String(caseIdNumber).padStart(4, '0')}`;
        const dateString = `<t:${Math.floor(timestamp / 1000)}:F>`;

        const logEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙈𝙤𝙙𝙚𝙧𝙖𝙩𝙞𝙤𝙣 𝘼𝙘𝙩𝙞𝙤𝙣',
            introduction: 'A moderation action has been taken against a member of the NYSRP community.',
            important: 'This action has been recorded in the NYSRP moderation system.',
            sections: [
                {
                    title: 'Moderation Information',
                    items: [
                        `**Member:** <@${targetUser.id}>`,
                        `**Action:** ${action}`,
                        `**Reason:** ${reason}`,
                        `**Moderator:** <@${moderator.id}>`,
                        `**Case ID:** ${formattedCaseId}`,
                        duration ? `**Duration:** ${duration}` : null,
                        `**Date:** ${dateString}`
                    ].filter(Boolean)
                }
            ],
            closing: 'This action has been recorded for future reference.',
            color: config.branding.color // #FD8701
        });

        // Try to DM target user
        try {
            const dmEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙈𝙤𝙙𝙚𝙧𝙖𝙩𝙞𝙤𝙣 𝙉𝙤𝙩𝙞𝙛𝙞𝙘𝙖𝙩𝙞𝙤𝙣',
                introduction: `You have received a moderation action in **New York State Roleplay**.`,
                important: 'Please ensure you review and adhere to all NYSRP server guidelines.',
                sections: [
                    {
                        title: 'Case Information',
                        items: [
                            `**Action:** ${action}`,
                            `**Reason:** ${reason}`,
                            `**Case ID:** ${formattedCaseId}`,
                            duration ? `**Duration:** ${duration}` : null,
                            `**Date:** ${dateString}`
                        ].filter(Boolean)
                    }
                ],
                closing: 'If you wish to appeal this action, please open a ticket in the official NYSRP Discord.',
                color: config.branding.color // #FD8701
            });
            await targetUser.send({ embeds: [dmEmbed] });
        } catch {
            // User DM closed
        }

        // Send to Moderation Log Channel (1515410238830809099)
        const configData = ConfigService.getConfig(guild.id);
        const modLogChannelId = configData.moderation_log_channel || config.channels.moderationLogs;

        const logChannel = await getValidatedChannel(guild, modLogChannelId, 'Moderation Log');
        if (logChannel) {
            try {
                await logChannel.send({ embeds: [logEmbed] });
            } catch (err) {
                logger.warn(`Could not send mod log to channel ${modLogChannelId}: ${err.message}`);
            }
        }

        return { caseId: formattedCaseId, logEmbed };
    }

    static async warn(guild, moderator, targetUser, reason) {
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser,
            action: 'Warn',
            reason
        });
    }

    static async kick(guild, moderator, targetMember, reason) {
        await targetMember.kick(reason);
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser: targetMember.user,
            action: 'Kick',
            reason
        });
    }

    static async ban(guild, moderator, targetUser, reason) {
        await guild.members.ban(targetUser.id, { reason });
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser,
            action: 'Ban',
            reason
        });
    }

    static async unban(guild, moderator, targetUser, reason) {
        await guild.members.unban(targetUser.id, reason);
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser,
            action: 'Unban',
            reason
        });
    }

    static async timeout(guild, moderator, targetMember, durationMinutes, reason) {
        const ms = durationMinutes * 60 * 1000;
        await targetMember.timeout(ms, reason);
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser: targetMember.user,
            action: 'Timeout',
            reason,
            duration: `${durationMinutes} minutes`
        });
    }

    static async untimeout(guild, moderator, targetMember, reason) {
        await targetMember.timeout(null, reason);
        return await this.recordAndLogCase({
            guild,
            moderator,
            targetUser: targetMember.user,
            action: 'Untimeout',
            reason
        });
    }

    static async purge(channel, amount) {
        const deleted = await channel.bulkDelete(amount, true);
        return deleted.size;
    }

    static getHistory(guildId, userId) {
        return db.prepare(`
            SELECT * FROM moderation_cases 
            WHERE guild_id = ? AND user_id = ? 
            ORDER BY timestamp DESC
        `).all(guildId, userId);
    }
}

module.exports = ModerationService;
