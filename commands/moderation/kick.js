const { SlashCommandBuilder } = require('discord.js');
const { hasPermission, checkHierarchy } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member from the NYSRP server.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member to kick')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for kicking')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_KICK)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to kick members in NYSRP.')],
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');
        const reason = interaction.options.getString('reason');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember) {
            return interaction.reply({
                embeds: [createErrorEmbed('User Not Found', 'The specified user is not in this server.')],
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

        if (!targetMember.kickable) {
            return interaction.reply({
                embeds: [createErrorEmbed('Kick Failed', 'The bot cannot kick this member due to Discord role hierarchy.')],
                ephemeral: true
            });
        }

        await interaction.deferReply();
        const { caseId } = await ModerationService.kick(
            interaction.guild,
            interaction.user,
            targetMember,
            reason
        );

        const responseEmbed = createSuccessEmbed(
            'Member Kicked',
            `Successfully kicked <@${targetUser.id}> from NYSRP.`,
            null,
            [
                {
                    title: 'Kick Details',
                    items: [
                        `**Member:** ${targetUser.tag}`,
                        `**Reason:** ${reason}`,
                        `**Case ID:** ${caseId}`
                    ]
                }
            ],
            'This action has been logged in the moderation system.'
        );

        await interaction.editReply({ embeds: [responseEmbed] });
    }
};
