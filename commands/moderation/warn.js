const { SlashCommandBuilder } = require('discord.js');
const { hasPermission, checkHierarchy } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Issue a formal warning to a NYSRP member.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member to issue a warning to')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for the warning')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_WARN)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to issue warnings in NYSRP.')],
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (targetMember) {
            const hierarchy = checkHierarchy(interaction.member, targetMember);
            if (!hierarchy.allowed) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Action Blocked', hierarchy.reason)],
                    ephemeral: true
                });
            }
        }

        await interaction.deferReply();
        const { caseId, logEmbed } = await ModerationService.warn(
            interaction.guild,
            interaction.user,
            targetUser,
            reason
        );

        const responseEmbed = createSuccessEmbed(
            'Member Warned',
            `Successfully issued warning **${caseId}** to <@${targetUser.id}>.`,
            null,
            [
                {
                    title: 'Warning Details',
                    items: [
                        `**Member:** <@${targetUser.id}> (${targetUser.tag})`,
                        `**Reason:** ${reason}`,
                        `**Case ID:** ${caseId}`
                    ]
                }
            ],
            'The warning has been recorded in the NYSRP database.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
