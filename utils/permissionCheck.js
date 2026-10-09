const { RANKS, RANK_ORDER, findRank } = require('../config/ranks');
const { PERMISSIONS, MIN_RANK_LEVEL } = require('../config/permissions');
const db = require('../database/db');

/**
 * Get configured rank roles for a guild from database
 * @param {string} guildId 
 * @returns {Object} rank -> roleId
 */
function getGuildRankRoles(guildId) {
    const row = db.prepare('SELECT rank_roles FROM guild_config WHERE guild_id = ?').get(guildId);
    if (!row || !row.rank_roles) return {};
    try {
        return JSON.parse(row.rank_roles);
    } catch {
        return {};
    }
}

/**
 * Get member's rank object in a guild
 * @param {GuildMember} member 
 * @returns {Object} Rank object from RANKS
 */
function getMemberRank(member) {
    if (!member || !member.guild) return RANKS.JUNIOR_MODERATOR; // default fallback if unknown

    // Server Owner automatically gets Owner rank
    if (member.guild.ownerId === member.id) {
        return RANKS.OWNER;
    }

    // Check staff_members database table first for explicit staff rank assignment
    const staffRow = db.prepare('SELECT rank FROM staff_members WHERE guild_id = ? AND user_id = ?').get(member.guild.id, member.id);
    if (staffRow) {
        const found = findRank(staffRow.rank);
        if (found) return found;
    }

    // Check Discord roles mapped in guild config
    const rankRoles = getGuildRankRoles(member.guild.id);
    let highestRank = null;

    for (const [rankKey, roleId] of Object.entries(rankRoles)) {
        if (roleId && member.roles.cache.has(roleId)) {
            const rankObj = findRank(rankKey);
            if (rankObj && (!highestRank || rankObj.level > highestRank.level)) {
                highestRank = rankObj;
            }
        }
    }

    if (highestRank) return highestRank;

    // Check role names matching rank names if explicit IDs aren't set
    for (const rank of RANK_ORDER) {
        const hasMatchingRole = member.roles.cache.some(r => 
            r.name.toLowerCase() === rank.name.toLowerCase() ||
            r.name.toLowerCase().includes(rank.name.toLowerCase())
        );
        if (hasMatchingRole) {
            return rank;
        }
    }

    // If member has Administrator permission on Discord, map to Administrator rank if unranked
    if (member.permissions.has('Administrator')) {
        return RANKS.ADMINISTRATOR;
    }

    // Default to unranked / lowest fallback if not staff
    return { name: 'Member', level: 0, key: 'MEMBER' };
}

/**
 * Check if a member has a specific permission node
 * @param {GuildMember} member 
 * @param {string} permissionNode 
 * @returns {boolean}
 */
function hasPermission(member, permissionNode) {
    if (!member) return false;
    
    // Guild owner has all permissions
    if (member.guild && member.guild.ownerId === member.id) return true;

    const rank = getMemberRank(member);
    const requiredLevel = MIN_RANK_LEVEL[permissionNode];

    if (requiredLevel === undefined) return false;

    return rank.level >= requiredLevel;
}

/**
 * Validates hierarchy rules between an executor and a target member.
 * Returns { allowed: boolean, reason: string|null }
 */
function checkHierarchy(executorMember, targetMember, targetNewRank = null) {
    if (executorMember.id === targetMember.id) {
        return { allowed: false, reason: 'You cannot perform rank or moderation actions on yourself.' };
    }

    const executorRank = getMemberRank(executorMember);
    const targetRank = getMemberRank(targetMember);

    // Guild Owner can manage anyone
    if (executorMember.guild.ownerId === executorMember.id) {
        return { allowed: true, reason: null };
    }

    // Target is Server Owner
    if (targetMember.guild.ownerId === targetMember.id) {
        return { allowed: false, reason: 'You cannot perform actions on the Server Owner.' };
    }

    // Cannot target someone with equal or higher rank
    if (targetRank.level >= executorRank.level) {
        return { 
            allowed: false, 
            reason: `You cannot manage **${targetMember.user.tag}** because their rank (**${targetRank.name}**) is equal to or higher than your rank (**${executorRank.name}**).` 
        };
    }

    // If assigning a new rank, cannot promote someone to equal or higher than executor's own rank
    if (targetNewRank) {
        const newRankObj = findRank(targetNewRank.name || targetNewRank);
        if (newRankObj && newRankObj.level >= executorRank.level) {
            return { 
                allowed: false, 
                reason: `You cannot assign rank **${newRankObj.name}** because it is equal to or higher than your own rank (**${executorRank.name}**).` 
            };
        }
    }

    return { allowed: true, reason: null };
}

module.exports = {
    getMemberRank,
    getGuildRankRoles,
    hasPermission,
    checkHierarchy
};
