const { SlashCommandBuilder } = require('discord.js');
const { createNYSRPEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('View available commands and systems guide for NYSRP Bot.'),

    async execute(interaction) {
        const helpEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝘾𝙤𝙢𝙢𝙖𝙣𝙙 𝘿𝙞𝙧𝙚𝙘𝙩𝙤𝙧𝙮',
            introduction: 'Official command directory and system overview for New York State Roleplay Bot.',
            sections: [
                {
                    title: '🚨 Moderation Commands',
                    items: [
                        '`/warn <target> <reason>` - Issue formal warning',
                        '`/kick <target> <reason>` - Kick user from server',
                        '`/ban <target> <reason>` - Ban user from server',
                        '`/unban <user_id> <reason>` - Revoke ban',
                        '`/timeout <target> <duration> <reason>` - Timeout user',
                        '`/untimeout <target> <reason>` - Remove timeout',
                        '`/purge <amount>` - Bulk delete channel messages',
                        '`/modhistory <target>` - View user moderation history'
                    ]
                },
                {
                    title: '👮 Staff Management Commands',
                    items: [
                        '`/staff promote <target> <rank> <reason>` - Promote staff member',
                        '`/staff demote <target> <rank> <reason>` - Demote staff member',
                        '`/staff view <target>` - View staff profile',
                        '`/staff list` - List staff roster grouped by rank',
                        '`/staff profile` - View your staff profile',
                        '`/staff history <target>` - View rank change history',
                        '`/staff info` - View staff department stats'
                    ]
                },
                {
                    title: '🎫 Ticket Support Commands',
                    items: [
                        '`/ticket panel` - Deploy support creation panel',
                        '`/ticket close` - Close ticket and build transcript',
                        '`/ticket lock` - Lock ticket messaging',
                        '`/ticket unlock` - Restore ticket messaging',
                        '`/ticket add <user>` - Add user to ticket',
                        '`/ticket remove <user>` - Remove user from ticket'
                    ]
                },
                {
                    title: '⚙️ Configuration Commands',
                    items: [
                        '`/config set-channel <type> <channel>` - Set system channel',
                        '`/config set-category <type> <category>` - Set system category',
                        '`/config set-role <rank> <role>` - Map Discord role to rank',
                        '`/config view` - View current guild configuration'
                    ]
                }
            ],
            closing: 'For further assistance, please contact NYSRP Staff Management.'
        });

        await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
    }
};
