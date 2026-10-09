const { PermissionFlagsBits } = require('discord.js');
const logger = require('./logger');

/**
 * Validates whether a guild channel exists, is text-based, and bot has required permissions to send log embeds.
 * 
 * @param {Guild} guild - Discord Guild instance
 * @param {string} channelId - Target Channel ID
 * @param {string} logType - Purpose label for diagnostics (e.g. 'Command Log')
 * @returns {Promise<TextChannel|null>} Validated channel object or null
 */
async function getValidatedChannel(guild, channelId, logType = 'Log') {
    if (!guild || !channelId) return null;

    try {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
            logger.warn(`[Channel Validation Failure] ${logType} channel with ID ${channelId} was not found in guild ${guild.name} (${guild.id}).`);
            return null;
        }

        if (!channel.isTextBased()) {
            logger.warn(`[Channel Validation Failure] ${logType} channel ${channel.name} (${channelId}) is not a text-based channel.`);
            return null;
        }

        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        if (me) {
            const permissions = channel.permissionsFor(me);
            const missing = [];
            if (!permissions.has(PermissionFlagsBits.ViewChannel)) missing.push('ViewChannel');
            if (!permissions.has(PermissionFlagsBits.SendMessages)) missing.push('SendMessages');
            if (!permissions.has(PermissionFlagsBits.EmbedLinks)) missing.push('EmbedLinks');

            if (missing.length > 0) {
                logger.warn(`[Channel Validation Failure] Missing permissions [${missing.join(', ')}] in ${logType} channel ${channel.name} (${channelId}).`);
                return null;
            }
        }

        return channel;
    } catch (err) {
        logger.warn(`[Channel Validation Exception] Failed validating ${logType} channel ${channelId}: ${err.message}`);
        return null;
    }
}

module.exports = {
    getValidatedChannel
};
