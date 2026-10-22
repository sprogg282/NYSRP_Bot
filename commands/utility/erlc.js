const { SlashCommandBuilder } = require('discord.js');
const ERLCService = require('../../services/erlcService');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const logger = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('erlc')
        .setDescription('View the live ER:LC private server status')
        .addSubcommand(subcommand => subcommand
            .setName('status')
            .setDescription('Show the latest ER:LC server data'))
        .addSubcommand(subcommand => subcommand
            .setName('panel')
            .setDescription('Create or refresh the automatic status panel in this channel')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [createErrorEmbed('ER:LC Status', 'ER:LC status is only available inside a server.')],
                ephemeral: true
            });
        }

        if (subcommand === 'status') {
            await interaction.deferReply();
            try {
                const snapshot = await ERLCService.refreshStatus();
                return interaction.editReply(ERLCService.buildPayload(snapshot));
            } catch (error) {
                logger.error('[ER:LC] Could not load status:', error);
                return interaction.editReply({
                    embeds: [createErrorEmbed('ER:LC Status Unavailable', error.message)]
                });
            }
        }

        if (subcommand === 'panel') {
            if (!hasPermission(interaction.member, PERMISSIONS.BOT_CONFIGURE)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage the ER:LC status panel.')],
                    ephemeral: true
                });
            }
            if (!interaction.channel?.isTextBased() || typeof interaction.channel.send !== 'function') {
                return interaction.reply({
                    embeds: [createErrorEmbed('ER:LC Status', 'The status panel must be posted in a text channel.')],
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });
            try {
                const panel = await ERLCService.setupPanel(interaction.channel);
                return interaction.editReply({
                    embeds: [createSuccessEmbed(
                        'ER:LC Status Panel',
                        `The automatic ER:LC status panel is active in <#${interaction.channel.id}>.`,
                        null,
                        [{ title: 'Panel Message', items: [`Message ID: ${panel.messageId}`] }]
                    )]
                });
            } catch (error) {
                logger.error('[ER:LC] Could not set up status panel:', error);
                return interaction.editReply({
                    embeds: [createErrorEmbed('ER:LC Panel Setup Failed', error.message)]
                });
            }
        }
    }
};
