const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const { RANK_ORDER, findRank } = require('../../config/ranks');
const StaffService = require('../../services/staffService');
const { createNYSRPEmbed, createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const logger = require('../../utils/logger');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staff')
        .setDescription('NYSRP Staff Management Commands')
        
        // /staff promote
        .addSubcommand(sub =>
            sub.setName('promote')
                .setDescription('Promote a staff member to a higher rank.')
                .addUserOption(opt => opt.setName('target').setDescription('The staff member to promote').setRequired(true))
                .addStringOption(opt => opt.setName('rank').setDescription('The new rank to assign').setRequired(true)
                    .addChoices(...RANK_ORDER.map(rank => ({ name: rank.name, value: rank.key }))))
                .addStringOption(opt => opt.setName('reason').setDescription('Reason for the promotion').setRequired(true).setMinLength(1).setMaxLength(500)))

        // /staff demote
        .addSubcommand(sub =>
            sub.setName('demote')
                .setDescription('Demote a staff member to a lower rank.')
                .addUserOption(opt => opt.setName('target').setDescription('The staff member to demote').setRequired(true))
                .addStringOption(opt => opt.setName('rank').setDescription('The new rank to assign').setRequired(true)
                    .addChoices(...RANK_ORDER.map(rank => ({ name: rank.name, value: rank.key }))))
                .addStringOption(opt => opt.setName('reason').setDescription('Reason for the demotion').setRequired(true).setMinLength(1).setMaxLength(500)))

        // /staff view
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View detailed profile of a staff member.')
                .addUserOption(opt => opt.setName('target').setDescription('The staff member to inspect').setRequired(true)))

        // /staff list
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all active NYSRP staff members by rank.'))

        // /staff profile
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription('View your own NYSRP staff profile and statistics.'))

        // /staff history
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('View rank promotion and demotion history for a staff member.')
                .addUserOption(opt => opt.setName('target').setDescription('The staff member').setRequired(true)))

        // /staff info
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Display NYSRP staff structure statistics.')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'promote' || subcommand === 'demote') {
            if (!interaction.guild || !interaction.member) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Server Only', 'Staff rank changes can only be used inside a server.')],
                    ephemeral: true
                });
            }

            let executorMember;
            try {
                executorMember = await interaction.guild.members.fetch({
                    user: interaction.user.id,
                    force: true
                });
            } catch (err) {
                logger.warn(`Could not refresh staff rank executor ${interaction.user.id} in guild ${interaction.guild.id}: ${err.message}`);
            }
            if (!executorMember) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Member Not Found', 'Your server membership could not be verified.')],
                    ephemeral: true
                });
            }

            const requiredPerm = subcommand === 'promote' ? PERMISSIONS.STAFF_PROMOTE : PERMISSIONS.STAFF_DEMOTE;
            if (!hasPermission(executorMember, requiredPerm)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', `You do not have permission to ${subcommand} staff members.`)],
                    ephemeral: true
                });
            }

            const targetUser = interaction.options.getUser('target');
            const rankInput = interaction.options.getString('rank');
            const reason = interaction.options.getString('reason').trim();

            let targetMember = null;
            try {
                targetMember = await interaction.guild.members.fetch({ user: targetUser.id, force: true });
            } catch (err) {
                logger.warn(`Could not fetch staff rank target ${targetUser.id} in guild ${interaction.guild.id}: ${err.message}`);
            }

            if (!targetMember) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Member Not Found', 'Target user is not in this server.')],
                    ephemeral: true
                });
            }

            const targetNewRank = findRank(rankInput);
            if (!targetNewRank) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Invalid Rank', `\`${rankInput}\` is not a valid NYSRP rank.`)],
                    ephemeral: true
                });
            }

            const isPromotion = subcommand === 'promote';
            const validation = StaffService.validateRankChange({
                guild: interaction.guild,
                executorMember,
                targetMember,
                newRankName: targetNewRank.name,
                isPromotion
            });
            if (!validation.allowed) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Action Blocked', validation.reason)],
                    ephemeral: true
                });
            }

            const roleValidation = await StaffService.validateRoleConfiguration(
                interaction.guild,
                targetMember,
                targetNewRank
            );
            if (!roleValidation.allowed) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Role Configuration Error', roleValidation.reason)],
                    ephemeral: true
                });
            }

            const actionName = isPromotion ? 'Promotion' : 'Demotion';
            const confirmationId = interaction.id;
            const confirmationEmbed = createNYSRPEmbed({
                title: `𝙎𝙩𝙖𝙛𝙛 ${actionName} Confirmation`,
                introduction: `Please confirm the ${actionName.toLowerCase()} for <@${targetMember.id}>.`,
                sections: [
                    {
                        title: 'Rank Change',
                        items: [
                            `**Current Rank:** ${validation.currentRank.name}`,
                            `**New Rank:** ${targetNewRank.name}`,
                            `**Reason:** ${reason}`,
                            `**Requested By:** ${interaction.user.tag}`
                        ]
                    }
                ],
                closing: 'This confirmation expires in 60 seconds.',
                color: config.branding.color
            });

            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`staff_rank_confirm_${confirmationId}`)
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`staff_rank_cancel_${confirmationId}`)
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                embeds: [confirmationEmbed],
                components: [buttons],
                ephemeral: true
            });

            StaffService.registerConfirmation(confirmationId);
            let confirmation;
            try {
                const confirmationMessage = await interaction.fetchReply();
                confirmation = await confirmationMessage.awaitMessageComponent({
                    filter: component =>
                        component.user.id === interaction.user.id
                        && (component.customId === `staff_rank_confirm_${confirmationId}`
                            || component.customId === `staff_rank_cancel_${confirmationId}`),
                    time: 60_000
                });
            } catch (err) {
                if (/time/i.test(err.message)) {
                    logger.debug(`Staff ${actionName.toLowerCase()} confirmation expired for target ${targetMember.id}.`);
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Confirmation Expired', 'No rank changes were made. Run the command again if you still want to proceed.')],
                        components: []
                    });
                }
                logger.error(`Could not collect staff rank confirmation for target ${targetMember.id}:`, err);
                return interaction.editReply({
                    embeds: [createErrorEmbed('Confirmation Unavailable', 'The confirmation could not be processed. No rank changes were made; please run the command again.')],
                    components: []
                });
            } finally {
                StaffService.endConfirmation(confirmationId);
            }

            await confirmation.deferUpdate();
            if (confirmation.customId === `staff_rank_cancel_${confirmationId}`) {
                return interaction.editReply({
                    embeds: [createErrorEmbed('Rank Change Cancelled', 'No rank changes were made.')],
                    components: []
                });
            }

            try {
                try {
                    targetMember = await interaction.guild.members.fetch({
                        user: targetUser.id,
                        force: true
                    });
                } catch (err) {
                    logger.warn(`Staff rank target ${targetUser.id} left or could not be refreshed in guild ${interaction.guild.id}: ${err.message}`);
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Member Not Found', 'The selected member is no longer available in this server. No rank changes were made.')],
                        components: []
                    });
                }

                try {
                    executorMember = await interaction.guild.members.fetch({
                        user: interaction.user.id,
                        force: true
                    });
                } catch (err) {
                    logger.warn(`Could not refresh staff rank executor ${interaction.user.id} in guild ${interaction.guild.id}: ${err.message}`);
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Member Not Found', 'Your server membership could not be refreshed. No rank changes were made.')],
                        components: []
                    });
                }

                const refreshedValidation = StaffService.validateRankChange({
                    guild: interaction.guild,
                    executorMember,
                    targetMember,
                    newRankName: targetNewRank.name,
                    isPromotion
                });
                if (!refreshedValidation.allowed) {
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Action Blocked', refreshedValidation.reason)],
                        components: []
                    });
                }

                const finalRoleValidation = await StaffService.validateRoleConfiguration(
                    interaction.guild,
                    targetMember,
                    targetNewRank
                );
                if (!finalRoleValidation.allowed) {
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Role Configuration Error', finalRoleValidation.reason)],
                        components: []
                    });
                }

                const { embed } = await StaffService.updateRank({
                    guild: interaction.guild,
                    executorMember,
                    targetMember,
                    newRankName: targetNewRank.name,
                    reason,
                    isPromotion
                });

                return interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                if (StaffService.isUserFacingError(err)) {
                    logger.warn(`Staff ${actionName.toLowerCase()} blocked for ${targetMember.id}: ${err.message}`);
                } else {
                    logger.error(`Error completing staff ${actionName.toLowerCase()} for ${targetMember.id}:`, err);
                }
                return interaction.editReply({
                    embeds: [createErrorEmbed(
                        'Rank Change Failed',
                        StaffService.isUserFacingError(err)
                            ? err.message
                            : 'The rank change could not be completed. Check the configured staff roles and bot role hierarchy; technical details were logged.'
                    )],
                    components: []
                });
            }
        }

        if (subcommand === 'view' || subcommand === 'profile') {
            if (!hasPermission(interaction.member, PERMISSIONS.STAFF_VIEW)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to view staff profiles.')],
                    ephemeral: true
                });
            }

            const targetUser = subcommand === 'profile' ? interaction.user : interaction.options.getUser('target');
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

            if (!targetMember) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Member Not Found', 'Specified user is not in this server.')],
                    ephemeral: true
                });
            }

            const profile = StaffService.getProfile(interaction.guild, targetMember);

            const profileEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙋𝙧𝙤𝙛𝙞𝙡𝙚',
                introduction: `Official NYSRP Staff Profile for <@${targetUser.id}>.`,
                sections: [
                    {
                        title: 'Staff Overview',
                        items: [
                            `**Username:** ${targetUser.tag}`,
                            `**Discord ID:** \`${targetUser.id}\``,
                            `**Current Rank:** ${profile.rank.name}`,
                            `**Hierarchy Level:** Level ${profile.rank.level}`,
                            `**Staff Status:** ${profile.staffStatus}`,
                            profile.joinedStaffAt ? `**Joined Staff:** <t:${Math.floor(profile.joinedStaffAt / 1000)}:D>` : '**Joined Staff:** N/A'
                        ]
                    },
                    {
                        title: 'Staff Activity & Statistics',
                        items: [
                            `**Promotions Received:** ${profile.promotionsCount}`,
                            `**Demotions Received:** ${profile.demotionsCount}`,
                            `**Moderation Actions Handled:** ${profile.modCount}`
                        ]
                    }
                ],
                closing: 'Data retrieved from NYSRP Staff Database.'
            });

            return interaction.reply({ embeds: [profileEmbed] });
        }

        if (subcommand === 'list') {
            if (!hasPermission(interaction.member, PERMISSIONS.STAFF_LIST)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to view staff list.')],
                    ephemeral: true
                });
            }

            const grouped = StaffService.getStaffList(interaction.guild);

            const sections = [];
            for (const rank of RANK_ORDER) {
                const userIds = grouped[rank.name] || [];
                if (userIds.length > 0) {
                    sections.push({
                        title: rank.name,
                        items: userIds.map(id => `<@${id}>`)
                    });
                }
            }

            if (sections.length === 0) {
                sections.push({
                    title: 'Active Staff Roster',
                    items: ['No explicit staff members recorded in database yet. Assign staff ranks using `/staff promote`.']
                });
            }

            const listEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙍𝙤𝙨𝙩𝙚𝙧',
                introduction: 'Current active staff roster for New York State Roleplay.',
                sections,
                closing: 'Official NYSRP Staff Directory.'
            });

            return interaction.reply({ embeds: [listEmbed] });
        }

        if (subcommand === 'history') {
            if (!hasPermission(interaction.member, PERMISSIONS.STAFF_HISTORY)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to view staff history.')],
                    ephemeral: true
                });
            }

            const targetUser = interaction.options.getUser('target');
            const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

            if (!targetMember) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Member Not Found', 'Specified user is not in this server.')],
                    ephemeral: true
                });
            }

            const profile = StaffService.getProfile(interaction.guild, targetMember);

            if (profile.history.length === 0) {
                return interaction.reply({
                    embeds: [createNYSRPEmbed({
                        title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙃𝙞𝙨𝙩𝙤𝙧𝙮',
                        introduction: `No rank history records found for <@${targetUser.id}>.`,
                        closing: 'Record clean.'
                    })]
                });
            }

            const items = profile.history.slice(0, 10).map(h => {
                const dateStr = `<t:${Math.floor(h.timestamp / 1000)}:d>`;
                return `**${h.action_type}** | ${h.previous_rank || 'Member'} ➔ **${h.new_rank}** by <@${h.performed_by}> - ${h.reason} (${dateStr})`;
            });

            const historyEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙃𝙞𝙨𝙩𝙤𝙧𝙮',
                introduction: `Displaying rank history for <@${targetUser.id}> (${targetUser.tag}).`,
                sections: [
                    {
                        title: 'Rank History Log',
                        items
                    }
                ],
                closing: 'Logged by NYSRP Staff Management.'
            });

            return interaction.reply({ embeds: [historyEmbed] });
        }

        if (subcommand === 'info') {
            const grouped = StaffService.getStaffList(interaction.guild);
            let totalStaff = 0;
            const statsItems = [];

            for (const rank of RANK_ORDER) {
                const count = (grouped[rank.name] || []).length;
                totalStaff += count;
                statsItems.push(`**${rank.name}:** ${count} member(s)`);
            }

            const infoEmbed = createNYSRPEmbed({
                title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙄𝙣𝙛𝙤𝙧𝙢𝙖𝙩𝙞𝙤𝙣',
                introduction: 'Overview of New York State Roleplay staff structure and department breakdown.',
                important: `Total Recorded Staff: ${totalStaff}`,
                sections: [
                    {
                        title: 'Rank Breakdown',
                        items: statsItems
                    }
                ],
                closing: 'New York State Roleplay Management Directory.'
            });

            return interaction.reply({ embeds: [infoEmbed] });
        }
    }
};
