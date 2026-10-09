const db = require('../database/db');
const { PermissionFlagsBits } = require('discord.js');
const ConfigService = require('./configService');
const config = require('../config');
const {
    getMemberRank,
    getGuildRankRoles,
    hasPermission,
    checkHierarchy
} = require('../utils/permissionCheck');
const { findRank, RANK_ORDER } = require('../config/ranks');
const { PERMISSIONS } = require('../config/permissions');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const logger = require('../utils/logger');

class StaffRankError extends Error {}

class StaffService {
    static activeRankChanges = new Set();
    static activeConfirmations = new Set();

    static registerConfirmation(confirmationId) {
        this.activeConfirmations.add(confirmationId);
    }

    static endConfirmation(confirmationId) {
        this.activeConfirmations.delete(confirmationId);
    }

    static isConfirmationActive(customId) {
        const confirmationId = customId.replace(/^staff_rank_(?:confirm|cancel)_/, '');
        return this.activeConfirmations.has(confirmationId);
    }

    static isUserFacingError(error) {
        return error instanceof StaffRankError;
    }

    static validateRankChange({ guild, executorMember, targetMember, newRankName, isPromotion }) {
        if (!guild || !executorMember || !targetMember || targetMember.guild.id !== guild.id) {
            return { allowed: false, reason: 'The guild or one of the selected members is unavailable.' };
        }

        const requiredPermission = isPromotion ? PERMISSIONS.STAFF_PROMOTE : PERMISSIONS.STAFF_DEMOTE;
        if (!hasPermission(executorMember, requiredPermission)) {
            return { allowed: false, reason: `You do not have permission to ${isPromotion ? 'promote' : 'demote'} staff members.` };
        }

        const applicationOwner = guild.client.application?.owner;
        const applicationOwnerId = applicationOwner?.ownerId || applicationOwner?.id;
        if (targetMember.id === guild.ownerId || targetMember.id === applicationOwnerId) {
            return { allowed: false, reason: 'The server owner and bot application owner are protected from staff rank changes.' };
        }

        if (executorMember.id === targetMember.id) {
            return { allowed: false, reason: 'You cannot change your own staff rank.' };
        }

        const staffRow = db.prepare(
            'SELECT rank FROM staff_members WHERE guild_id = ? AND user_id = ?'
        ).get(guild.id, targetMember.id);
        const configuredRoles = getGuildRankRoles(guild.id);
        const heldMappedRanks = Object.entries(configuredRoles)
            .filter(([, roleId]) => roleId && targetMember.roles.cache.has(roleId))
            .map(([rankKey]) => findRank(rankKey))
            .filter(Boolean);
        const persistedRank = staffRow ? findRank(staffRow.rank) : null;
        const recognizedRanks = [...heldMappedRanks, ...(persistedRank ? [persistedRank] : [])];
        if (recognizedRanks.length === 0) {
            return { allowed: false, reason: 'The selected member is not currently a staff member.' };
        }
        const currentRank = recognizedRanks.reduce(
            (highest, rank) => rank.level > highest.level ? rank : highest
        );
        if (currentRank.key === 'OWNER') {
            return { allowed: false, reason: 'The Owner rank is protected from promotion and demotion commands.' };
        }

        const newRank = findRank(newRankName);
        if (!newRank) {
            return { allowed: false, reason: `“${newRankName}” is not a configured NYSRP rank.` };
        }

        const hierarchy = checkHierarchy(executorMember, targetMember, newRank);
        if (!hierarchy.allowed) return hierarchy;
        const executorRank = getMemberRank(executorMember);
        if (executorMember.id !== guild.ownerId && currentRank.level >= executorRank.level) {
            return {
                allowed: false,
                reason: `You cannot manage **${targetMember.user.tag}** because their assigned staff role (**${currentRank.name}**) is equal to or higher than your rank (**${executorRank.name}**).`
            };
        }

        const currentIndex = RANK_ORDER.findIndex(rank => rank.key === currentRank.key);
        const newIndex = RANK_ORDER.findIndex(rank => rank.key === newRank.key);
        const expectedIndex = isPromotion ? currentIndex - 1 : currentIndex + 1;
        if (expectedIndex < 0 || expectedIndex >= RANK_ORDER.length) {
            return {
                allowed: false,
                reason: `The member is already at the ${isPromotion ? 'highest' : 'lowest'} configured rank they can reach.`
            };
        }
        if (newIndex !== expectedIndex) {
            return {
                allowed: false,
                reason: `${isPromotion ? 'Promotion' : 'Demotion'} must move exactly one rank from **${currentRank.name}** to **${RANK_ORDER[expectedIndex].name}**.`
            };
        }

        return { allowed: true, currentRank, newRank };
    }

    static async validateRoleConfiguration(guild, targetMember, newRank) {
        const rankRoles = getGuildRankRoles(guild.id);
        const newRoleId = rankRoles[newRank.key];
        if (!newRoleId) {
            return {
                allowed: false,
                reason: `No Discord role is mapped to **${newRank.name}**. A bot administrator must configure it with \`/config set-role\`.`
            };
        }

        const duplicateMapping = Object.entries(rankRoles).find(
            ([key, roleId]) => key !== newRank.key && roleId === newRoleId
        );
        if (duplicateMapping) {
            const duplicateRank = findRank(duplicateMapping[0]);
            return {
                allowed: false,
                reason: `The Discord role mapped to **${newRank.name}** is also mapped to ${duplicateRank ? `**${duplicateRank.name}**` : `\`${duplicateMapping[0]}\``}. Each rank must have a unique role.`
            };
        }

        let botMember = guild.members.me;
        if (!botMember) {
            try {
                botMember = await guild.members.fetchMe();
            } catch {
                return { allowed: false, reason: 'I could not verify my server permissions. Please check that the bot is still in the server.' };
            }
        }
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return { allowed: false, reason: 'I need the **Manage Roles** permission to change staff ranks.' };
        }

        let newRole;
        try {
            newRole = await guild.roles.fetch(newRoleId);
        } catch {
            newRole = null;
        }
        if (!newRole) {
            return { allowed: false, reason: `The Discord role configured for **${newRank.name}** could not be found. Check it with \`/config view\`.` };
        }
        if (!newRole.editable) {
            return {
                allowed: false,
                reason: `I cannot manage the **${newRank.name}** role. Move my bot role above it in Server Settings → Roles.`
            };
        }

        const oldRoleIds = [...new Set(Object.values(rankRoles))]
            .filter(roleId => roleId && roleId !== newRoleId && targetMember.roles.cache.has(roleId));
        const oldRoles = [];
        for (const roleId of oldRoleIds) {
            let role;
            try {
                role = await guild.roles.fetch(roleId);
            } catch {
                role = null;
            }
            if (!role) {
                return { allowed: false, reason: 'One of the member’s current staff roles is no longer available. Correct the rank role mappings before retrying.' };
            }
            if (!role.editable) {
                return {
                    allowed: false,
                    reason: `I cannot remove the existing staff role **${role.name}**. Move my bot role above it in Server Settings → Roles.`
                };
            }
            oldRoles.push(role);
        }

        return { allowed: true, newRole, oldRoles, rankRoles };
    }

    static async restoreRankRoles(guild, targetId, roleIds, originallyHeld, reason) {
        let member = await guild.members.fetch({ user: targetId, force: true });
        for (const roleId of roleIds) {
            const currentlyHeld = member.roles.cache.has(roleId);
            const shouldBeHeld = originallyHeld.has(roleId);
            if (currentlyHeld && !shouldBeHeld) {
                member = await member.roles.remove(roleId, reason);
            } else if (!currentlyHeld && shouldBeHeld) {
                member = await member.roles.add(roleId, reason);
            }
        }

        member = await guild.members.fetch({ user: targetId, force: true });
        const restored = roleIds.every(roleId => member.roles.cache.has(roleId) === originallyHeld.has(roleId));
        if (!restored) throw new Error('Discord did not confirm the previous staff role state.');
    }

    /**
     * Promote or Demote a staff member and log to Staff Actions channel (1515395913873494147)
     */
    static async updateRank({ guild, executorMember, targetMember, newRankName, reason, isPromotion = true }) {
        const lockKey = `${guild.id}:${targetMember.id}`;
        if (this.activeRankChanges.has(lockKey)) {
            throw new StaffRankError('A rank change for this member is already being processed. Please wait and try again.');
        }

        this.activeRankChanges.add(lockKey);
        try {
            return await this.applyRankChange({
                guild,
                executorMember,
                targetMember,
                newRankName,
                reason,
                isPromotion
            });
        } finally {
            this.activeRankChanges.delete(lockKey);
        }
    }

    static async applyRankChange({ guild, executorMember, targetMember, newRankName, reason, isPromotion = true }) {
        const validation = this.validateRankChange({
            guild,
            executorMember,
            targetMember,
            newRankName,
            isPromotion
        });
        if (!validation.allowed) {
            throw new StaffRankError(validation.reason);
        }

        const { currentRank: previousRank, newRank } = validation;
        const roleValidation = await this.validateRoleConfiguration(guild, targetMember, newRank);
        if (!roleValidation.allowed) throw new StaffRankError(roleValidation.reason);

        const timestamp = Date.now();
        const actionType = isPromotion ? 'Promotion' : 'Demotion';
        const actionReason = `NYSRP ${actionType.toLowerCase()} by ${executorMember.user.tag} (${executorMember.id})`;
        const initialRoles = new Set(targetMember.roles.cache.keys());
        const affectedRoleIds = [...new Set([
            roleValidation.newRole.id,
            ...roleValidation.oldRoles.map(role => role.id)
        ])];
        let phase = 'discord';
        let actionId;

        try {
            let member = targetMember;
            if (!member.roles.cache.has(roleValidation.newRole.id)) {
                member = await member.roles.add(roleValidation.newRole, actionReason);
            }
            for (const oldRole of roleValidation.oldRoles) {
                if (member.roles.cache.has(oldRole.id)) {
                    member = await member.roles.remove(oldRole, actionReason);
                }
            }

            member = await guild.members.fetch({ user: targetMember.id, force: true });
            if (!member.roles.cache.has(roleValidation.newRole.id)
                || roleValidation.oldRoles.some(role => member.roles.cache.has(role.id))) {
                throw new Error('Discord did not confirm the requested staff role change.');
            }

            phase = 'database';
            const saveAction = db.transaction(() => {
                db.prepare(`
                    INSERT INTO staff_members (guild_id, user_id, rank, staff_status, joined_staff_at)
                    VALUES (?, ?, ?, 'ACTIVE', ?)
                    ON CONFLICT(guild_id, user_id) DO UPDATE SET
                        rank = excluded.rank,
                        staff_status = 'ACTIVE'
                `).run(guild.id, targetMember.id, newRank.name, timestamp);

                const result = db.prepare(`
                    INSERT INTO staff_actions (guild_id, target_id, performed_by, action_type, previous_rank, new_rank, reason, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    guild.id,
                    targetMember.id,
                    executorMember.id,
                    actionType.toUpperCase(),
                    previousRank.name,
                    newRank.name,
                    reason,
                    timestamp
                );
                return result.lastInsertRowid;
            });
            actionId = saveAction();
        } catch (err) {
            logger.error(
                `Failed ${actionType.toLowerCase()} for ${targetMember.user.tag} (${targetMember.id}) in guild ${guild.id}; requested by ${executorMember.user.tag} (${executorMember.id}), ${previousRank.name} -> ${newRank.name}, reason: ${reason}, status: FAILED.`,
                err
            );
            let rollbackSucceeded = true;
            try {
                await this.restoreRankRoles(guild, targetMember.id, affectedRoleIds, initialRoles, actionReason);
            } catch (rollbackError) {
                rollbackSucceeded = false;
                logger.error(`Could not restore rank roles for ${targetMember.id} in guild ${guild.id}:`, rollbackError);
            }

            const message = phase === 'database'
                ? 'The role change could not be recorded. Discord roles were rolled back; please try again or contact an administrator.'
                : 'Discord could not apply the rank roles. No rank change was recorded.';
            throw new StaffRankError(rollbackSucceeded
                ? message
                : `${message} Automatic role rollback was incomplete; an administrator must check the member’s roles.`);
        }

        const dateString = `<t:${Math.floor(timestamp / 1000)}:F>`;

        const logEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙩𝙖𝙛𝙛 𝙐𝙥𝙙𝙖𝙩𝙚',
            introduction: `A staff rank has been updated by ${executorMember.user.tag}.`,
            important: 'All staff rank changes are recorded and may be reviewed by NYSRP Management.',
            sections: [
                {
                    title: 'Staff Update Information',
                    items: [
                        `**Staff Member:** <@${targetMember.id}>`,
                        `**Username:** ${targetMember.user.tag}`,
                        `**Discord ID:** \`${targetMember.id}\``,
                        `**Previous Rank:** ${previousRank.name}`,
                        `**New Rank:** ${newRank.name}`,
                        `**Action:** ${actionType}`,
                        '**Status:** Successful',
                        `**Reason:** ${reason}`,
                        `**Handled By:** ${executorMember.user.tag} (<@${executorMember.id}>)`,
                        `**Action ID:** #${actionId}`,
                        `**Date:** ${dateString}`
                    ]
                }
            ],
            closing: 'The Discord role change was verified and the staff history was recorded.',
            color: config.branding.color // #FD8701
        });

        try {
            const configData = ConfigService.getConfig(guild.id);
            const staffLogChannelId = configData.staff_log_channel || config.channels.staffActions;
            const staffLogChannel = await getValidatedChannel(guild, staffLogChannelId, 'Staff Action Log');
            if (staffLogChannel) {
                await staffLogChannel.send({ embeds: [logEmbed] });
            } else {
                logger.warn(`Staff rank change #${actionId} was saved, but the staff log channel is unavailable.`);
            }
        } catch (err) {
            logger.warn(`Staff rank change #${actionId} was saved, but its staff log could not be sent: ${err.message}`);
        }

        return { actionId, embed: logEmbed, newRank };
    }

    /**
     * Get profile of a staff member
     */
    static getProfile(guild, member) {
        const staffRow = db.prepare('SELECT * FROM staff_members WHERE guild_id = ? AND user_id = ?').get(guild.id, member.id);
        const rank = getMemberRank(member);

        const actions = db.prepare('SELECT * FROM staff_actions WHERE guild_id = ? AND target_id = ? ORDER BY timestamp DESC').all(guild.id, member.id);
        const promotionsCount = actions.filter(a => a.action_type === 'PROMOTION').length;
        const demotionsCount = actions.filter(a => a.action_type === 'DEMOTION').length;

        const modCount = db.prepare('SELECT COUNT(*) as count FROM moderation_cases WHERE guild_id = ? AND moderator_id = ?').get(guild.id, member.id).count;

        return {
            member,
            rank,
            staffStatus: staffRow ? staffRow.staff_status : (rank.level > 0 ? 'ACTIVE' : 'NON_STAFF'),
            joinedStaffAt: staffRow ? staffRow.joined_staff_at : null,
            promotionsCount,
            demotionsCount,
            modCount,
            history: actions
        };
    }

    /**
     * Get staff list grouped by rank
     */
    static getStaffList(guild) {
        const staffMembers = db.prepare('SELECT * FROM staff_members WHERE guild_id = ?').all(guild.id);
        const grouped = {};

        for (const rank of RANK_ORDER) {
            grouped[rank.name] = [];
        }

        for (const row of staffMembers) {
            const rank = findRank(row.rank);
            if (rank) {
                if (!grouped[rank.name]) grouped[rank.name] = [];
                grouped[rank.name].push(row.user_id);
            }
        }

        return grouped;
    }
}

module.exports = StaffService;
