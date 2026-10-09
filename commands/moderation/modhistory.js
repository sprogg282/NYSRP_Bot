const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const ModerationService = require('../../services/moderationService');
const { createNYSRPEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('modhistory')
        .setDescription('View moderation case history for a user.')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('The member whose history to view')
                .setRequired(true)),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.MODERATION_HISTORY)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to view moderation history.')],
                ephemeral: true
            });
        }

        const targetUser = interaction.options.getUser('target');
        const history = ModerationService.getHistory(interaction.guild.id, targetUser.id);

        if (history.length === 0) {
            return interaction.reply({
                embeds: [createNYSRPEmbed({
                    title: '𝙉𝙔𝙎𝙍𝙋 𝙈𝙤𝙙𝙚𝙧𝙖𝙩𝙞𝙤𝙣 𝙃𝙞𝙨𝙩𝙤𝙧𝙮',
                    introduction: `No moderation records found for <@${targetUser.id}> (${targetUser.tag}).`,
                    closing: 'This user has a clean moderation record in New York State Roleplay.'
                })]
            });
        }

        const items = history.slice(0, 10).map(c => {
            const caseIdStr = `#${String(c.case_id).padStart(4, '0')}`;
            const dateStr = `<t:${Math.floor(c.timestamp / 1000)}:d>`;
            return `**${caseIdStr}** | **${c.action}** by <@${c.moderator_id}> - ${c.reason} (${dateStr})`;
        });

        const historyEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙈𝙤𝙙𝙚𝙧𝙖𝙩𝙞𝙤𝙣 𝙃𝙞𝙨𝙩𝙤𝙧𝙮',
            introduction: `Displaying moderation record history for <@${targetUser.id}> (${targetUser.tag}).`,
            important: `Total Cases Recorded: ${history.length}`,
            sections: [
                {
                    title: 'Recent Cases',
                    items
                }
            ],
            closing: 'Records maintained by NYSRP Moderation System.'
        });

        await interaction.reply({ embeds: [historyEmbed] });
    }
};
