const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Revoke a ban for a user.')
        .addStringOption(option =>
            option.setName('user_id')
                .setDescription('The Discord User ID to unban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('The reason for unbanning')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_UNBAN)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to unban members in NYSRP.')],
                ephemeral: true
            });
        }

        const userId = interaction.options.getString('user_id');
        const reason = interaction.options.getString('reason');

        await interaction.deferReply();
        try {
            const targetUser = await interaction.client.users.fetch(userId);
            const { caseId } = await ModerationService.unban(
                interaction.guild,
                interaction.user,
                targetUser,
                reason
            );

            const responseEmbed = createSuccessEmbed(
                'Ban Revoked',
                `Successfully unbanned **${targetUser.tag}** from NYSRP.`,
                null,
                [
                    {
                        title: 'Unban Details',
                        items: [
                            `**User:** ${targetUser.tag} (${targetUser.id})`,
                            `**Reason:** ${reason}`,
                            `**Case ID:** ${caseId}`
                        ]
                    }
                ],
                'The ban revocation has been logged.'
            );

            await interaction.editReply({ embeds: [responseEmbed] });
        } catch (err) {
            await interaction.editReply({
                embeds: [createErrorEmbed('Unban Failed', `Could not unban user ID \`${userId}\`. Ensure the user is banned and ID is valid.`)]
            });
        }
    }
};
