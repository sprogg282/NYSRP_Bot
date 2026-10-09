const { SlashCommandBuilder } = require('discord.js');
const { hasPermission, checkHierarchy } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Place a NYSRP member in timeout.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member to timeout')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('duration')
                .setDescription('Duration in minutes')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(40320)) // 28 days max
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for the timeout')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_TIMEOUT)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to timeout members in NYSRP.')],
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');
        const duration = interaction.options.getInteger('duration');
        const reason = interaction.options.getString('reason');

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember) {
            return interaction.reply({
                embeds: [createErrorEmbed('Member Not Found', 'The target user is not currently in this server.')],
                ephemeral: true
            });
        }

        const hierarchy = checkHierarchy(interaction.member, targetMember);
        if (!hierarchy.allowed) {
            return interaction.reply({
                embeds: [createErrorEmbed('Action Blocked', hierarchy.reason)],
                ephemeral: true
            });
        }

        await interaction.deferReply();
        const { caseId } = await ModerationService.timeout(
            interaction.guild,
            interaction.user,
            targetMember,
            duration,
            reason
        );

        const responseEmbed = createSuccessEmbed(
            'Member Timed Out',
            `Successfully placed <@${targetUser.id}> in timeout for ${duration} minutes.`,
            null,
            [
                {
                    title: 'Timeout Details',
                    items: [
                        `**Member:** ${targetUser.tag}`,
                        `**Duration:** ${duration} minutes`,
                        `**Reason:** ${reason}`,
                        `**Case ID:** ${caseId}`
                    ]
                }
            ],
            'The timeout action has been logged.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
