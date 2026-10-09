const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const { RANK_ORDER, findRank } = require('../../config/ranks');
const ConfigService = require('../../services/configService');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure NYSRP bot channels, categories, and staff role mappings.')

        // /config set-channel
        .addSubcommand(sub =>
            sub.setName('set-channel')
                .setDescription('Set a channel configuration.')
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Channel configuration type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Welcome Channel', value: 'welcome' },
                            { name: 'Rules Channel', value: 'rules' },
                            { name: 'Info Channel', value: 'info' },
                            { name: 'Moderation Log Channel', value: 'moderation_log' },
                            { name: 'Staff Log Channel', value: 'staff_log' },
                            { name: 'Ticket Log Channel', value: 'ticket_log' },
                            { name: 'Transcript Channel', value: 'transcript' }
                        ))
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Target text channel')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText)))

        // /config set-category
        .addSubcommand(sub =>
            sub.setName('set-category')
                .setDescription('Set a category configuration.')
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Category configuration type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Ticket Category', value: 'ticket' }
                        ))
                .addChannelOption(opt =>
                    opt.setName('category')
                        .setDescription('Target category channel')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildCategory)))

        // /config set-role
        .addSubcommand(sub =>
            sub.setName('set-role')
                .setDescription('Link a Discord role to a NYSRP rank.')
                .addStringOption(opt =>
                    opt.setName('rank')
                        .setDescription('NYSRP Rank')
                        .setRequired(true)
                        .addChoices(
                            ...RANK_ORDER.map(r => ({ name: r.name, value: r.key }))
                        ))
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('Target Discord Role')
                        .setRequired(true)))

        // /config view
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View current NYSRP bot configuration for this server.')),

    async execute(interaction) {
        if (!hasPermission(interaction.member, PERMISSIONS.BOT_CONFIGURE)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to configure NYSRP bot settings.')],
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        if (subcommand === 'set-channel') {
            const type = interaction.options.getString('type');
            const channel = interaction.options.getChannel('channel');

            ConfigService.setChannel(guildId, type, channel.id);

            return interaction.reply({
                embeds: [createSuccessEmbed(
                    'Configuration Updated',
                    `Successfully set **${type}** channel to <#${channel.id}>.`,
                    null,
                    [
                        {
                            title: 'Updated Setting',
                            items: [
                                `**Setting Type:** ${type}`,
                                `**Channel:** <#${channel.id}> (\`${channel.id}\`)`
                            ]
                        }
                    ]
                )]
            });
        }

        if (subcommand === 'set-category') {
            const type = interaction.options.getString('type');
            const category = interaction.options.getChannel('category');

            ConfigService.setCategory(guildId, type, category.id);

            return interaction.reply({
                embeds: [createSuccessEmbed(
                    'Configuration Updated',
                    `Successfully set **${type}** category to **${category.name}**.`,
                    null,
                    [
                        {
                            title: 'Updated Setting',
                            items: [
                                `**Setting Type:** ${type}`,
                                `**Category:** ${category.name} (\`${category.id}\`)`
                            ]
                        }
                    ]
                )]
            });
        }

        if (subcommand === 'set-role') {
            const rankKey = interaction.options.getString('rank');
            const role = interaction.options.getRole('role');
            const rankObj = findRank(rankKey);

            ConfigService.setRankRole(guildId, rankKey, role.id);

            return interaction.reply({
                embeds: [createSuccessEmbed(
                    'Rank Role Mapped',
                    `Successfully mapped rank **${rankObj.name}** to role <@&${role.id}>.`,
                    null,
                    [
                        {
                            title: 'Updated Role Mapping',
                            items: [
                                `**Rank:** ${rankObj.name} (Level ${rankObj.level})`,
                                `**Discord Role:** <@&${role.id}> (\`${role.id}\`)`
                            ]
                        }
                    ]
                )]
            });
        }

        if (subcommand === 'view') {
            const cfg = ConfigService.getConfig(guildId);

            const formatChannel = (id) => id ? `<#${id}>` : '*Not Configured*';
            const formatCategory = (id) => id ? `<#${id}>` : '*Not Configured*';

            const roleItems = RANK_ORDER.map(r => {
                const rId = cfg.rank_roles[r.key];
                return `**${r.name}:** ${rId ? `<@&${rId}>` : '*Unmapped*'}`;
            });

            const configEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝘾𝙤𝙣𝙛𝙞𝙜𝙪𝙧𝙖𝙩𝙞𝙤𝙣 𝙊𝙫𝙚𝙧𝙫𝙞𝙚𝙬',
                introduction: 'Current NYSRP bot system channels, categories, and rank role mappings.',
                sections: [
                    {
                        title: 'Channel Configurations',
                        items: [
                            `**Welcome Channel:** ${formatChannel(cfg.welcome_channel)}`,
                            `**Rules Channel:** ${formatChannel(cfg.rules_channel)}`,
                            `**Info Channel:** ${formatChannel(cfg.info_channel)}`,
                            `**Moderation Log Channel:** ${formatChannel(cfg.moderation_log_channel)}`,
                            `**Staff Log Channel:** ${formatChannel(cfg.staff_log_channel)}`,
                            `**Ticket Log Channel:** ${formatChannel(cfg.ticket_log_channel)}`,
                            `**Transcript Channel:** ${formatChannel(cfg.transcript_channel)}`
                        ]
                    },
                    {
                        title: 'Category Configurations',
                        items: [
                            `**Ticket Category:** ${formatCategory(cfg.ticket_category)}`
                        ]
                    },
                    {
                        title: 'Rank Role Mappings',
                        items: roleItems
                    }
                ],
                closing: 'Use `/config set-channel`, `/config set-category`, and `/config set-role` to modify.'
            });

            return interaction.reply({ embeds: [configEmbed] });
        }
    }
};
