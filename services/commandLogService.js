const config = require('../config');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const logger = require('../utils/logger');

class CommandLogService {
    /**
     * Log command execution to official NYSRP Command Logging channel (1515409909779271770)
     * 
     * @param {ChatInputCommandInteraction} interaction 
     * @param {boolean} success 
     * @param {string|null} errorMessage 
     */
    static async logCommand(interaction, success = true, errorMessage = null) {
        if (!interaction || !interaction.guild) return;

        const commandChannelId = config.channels.commandLogs;
        const channel = await getValidatedChannel(interaction.guild, commandChannelId, 'Command Log');
        if (!channel) return;

        // Parse options into clean string representation
        const optionsList = [];
        try {
            if (interaction.options && interaction.options.data) {
                for (const opt of interaction.options.data) {
                    if (opt.type === 1 || opt.type === 2) { // Subcommand or SubcommandGroup
                        optionsList.push(`**Subcommand:** \`${opt.name}\``);
                        if (opt.options) {
                            for (const subOpt of opt.options) {
                                optionsList.push(`• \`${subOpt.name}\`: ${this.formatValue(subOpt.value)}`);
                            }
                        }
                    } else {
                        optionsList.push(`• \`${opt.name}\`: ${this.formatValue(opt.value)}`);
                    }
                }
            }
        } catch {
            // Ignore option parsing error
        }

        const dateString = `<t:${Math.floor(Date.now() / 1000)}:F>`;
        const statusText = success ? 'SUCCESS' : `FAILED (${errorMessage || 'Unknown Error'})`;

        const logEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝘾𝙤𝙢𝙢𝙖𝙣𝙙 𝙀𝙭𝙚𝙘𝙪𝙩𝙞𝙤𝙣',
            introduction: 'A slash command has been executed within the NYSRP Discord server.',
            important: success ? null : `COMMAND FAILURE: ${errorMessage || 'An error occurred during execution.'}`,
            sections: [
                {
                    title: 'Command Execution Information',
                    items: [
                        `**Command:** \`/${interaction.commandName}\``,
                        `**Executor:** <@${interaction.user.id}> (${interaction.user.tag})`,
                        `**Executor ID:** \`${interaction.user.id}\``,
                        `**Channel:** <#${interaction.channel.id}> (\`${interaction.channel.id}\`)`,
                        `**Status:** ${statusText}`,
                        `**Timestamp:** ${dateString}`
                    ]
                },
                optionsList.length > 0 ? {
                    title: 'Command Arguments & Options',
                    items: optionsList
                } : null
            ].filter(Boolean),
            closing: 'Logged by NYSRP Command Audit System.',
            color: config.branding.color // #FD8701
        });

        try {
            await channel.send({ embeds: [logEmbed] });
        } catch (err) {
            logger.warn(`Failed sending command log to ${commandChannelId}: ${err.message}`);
        }
    }

    static formatValue(val) {
        if (val === null || val === undefined) return 'null';
        const str = String(val);
        // Filter sensitive tokens/secrets if ever present
        if (str.includes(config.token) || str.includes('MTUx')) {
            return '[REDACTED_SECRET]';
        }
        return str.length > 100 ? `${str.substring(0, 97)}...` : str;
    }
}

module.exports = CommandLogService;
