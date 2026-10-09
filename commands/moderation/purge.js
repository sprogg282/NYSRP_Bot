const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Purge a specified number of messages from the channel.')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to delete (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_PURGE)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to purge messages in NYSRP.')],
                ephemeral: true
            });
        }

        const amount = interaction.options.getInteger('amount');

        await interaction.deferReply({ ephemeral: true });
        const deletedCount = await ModerationService.purge(interaction.channel, amount);

        const responseEmbed = createSuccessEmbed(
            'Messages Purged',
            `Successfully deleted **${deletedCount}** message(s) from <#${interaction.channel.id}>.`,
            null,
            [
                {
                    title: 'Purge Information',
                    items: [
                        `**Channel:** <#${interaction.channel.id}>`,
                        `**Requested:** ${amount}`,
                        `**Deleted:** ${deletedCount}`,
                        `**Moderator:** <@${interaction.user.id}>`
                    ]
                }
            ],
            'This action has been completed.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
