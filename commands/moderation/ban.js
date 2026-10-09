const { SlashCommandBuilder } = require('discord.js');
const { hasPermission, checkHierarchy } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the NYSRP server.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member to ban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for banning')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_BAN)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to ban members in NYSRP.')],
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
            if (!targetMember.bannable) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Ban Failed', 'The bot cannot ban this member due to Discord role hierarchy.')],
                    ephemeral: true
                });
            }
        }

        await interaction.deferReply();
        const { caseId } = await ModerationService.ban(
            interaction.guild,
            interaction.user,
            targetUser,
            reason
        );

        const responseEmbed = createSuccessEmbed(
            'Member Banned',
            `Successfully banned **${targetUser.tag}** from NYSRP.`,
            null,
            [
                {
                    title: 'Ban Details',
                    items: [
                        `**Member:** ${targetUser.tag} (${targetUser.id})`,
                        `**Reason:** ${reason}`,
                        `**Case ID:** ${caseId}`
                    ]
                }
            ],
            'This ban has been recorded in the NYSRP database.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
