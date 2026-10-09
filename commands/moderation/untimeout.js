const { SlashCommandBuilder } = require('discord.js');
const { hasPermission, checkHierarchy } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription('Remove timeout from a NYSRP member.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member to untimeout')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for removing timeout')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_TIMEOUT)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage timeouts in NYSRP.')],
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');
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
        const { caseId } = await ModerationService.untimeout(
            interaction.guild,
            interaction.user,
            targetMember,
            reason
        );

        const responseEmbed = createSuccessEmbed(
            'Timeout Removed',
            `Successfully removed timeout from <@${targetUser.id}>.`,
            null,
            [
                {
                    title: 'Untimeout Details',
                    items: [
                        `**Member:** ${targetUser.tag}`,
                        `**Reason:** ${reason}`,
                        `**Case ID:** ${caseId}`
                    ]
                }
            ],
            'The untimeout action has been logged.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
