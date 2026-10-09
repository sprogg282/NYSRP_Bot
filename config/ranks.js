/**
 * NYSRP Staff Ranks and Hierarchy Definitions
 * Rank levels are numeric: higher level = higher authority.
 */

const RANKS = {
    OWNER: {
        name: 'Owner',
        level: 9,
        key: 'OWNER',
        defaultRoleId: null
    },
    CO_OWNER: {
        name: 'Co-Owner',
        level: 8,
        key: 'CO_OWNER',
        defaultRoleId: null
    },
    MANAGEMENT: {
        name: 'Management',
        level: 7,
        key: 'MANAGEMENT',
        defaultRoleId: null
    },
    INTERNAL_AFFAIRS: {
        name: 'Internal Affairs',
        level: 6,
        key: 'INTERNAL_AFFAIRS',
        defaultRoleId: null
    },
    DIRECTOR: {
        name: 'Director',
        level: 5,
        key: 'DIRECTOR',
        defaultRoleId: null
    },
    ADMINISTRATOR: {
        name: 'Administrator',
        level: 4,
        key: 'ADMINISTRATOR',
        defaultRoleId: null
    },
    JUNIOR_ADMINISTRATOR: {
        name: 'Junior Administrator',
        level: 3,
        key: 'JUNIOR_ADMINISTRATOR',
        defaultRoleId: null
    },
    MODERATOR: {
        name: 'Moderator',
        level: 2,
        key: 'MODERATOR',
        defaultRoleId: null
    },
    JUNIOR_MODERATOR: {
        name: 'Junior Moderator',
        level: 1,
        key: 'JUNIOR_MODERATOR',
        defaultRoleId: null
    }
};

// Sorted array of ranks from highest (Owner) to lowest (Junior Moderator)
const RANK_ORDER = Object.values(RANKS).sort((a, b) => b.level - a.level);

/**
 * Find rank object by key, name, or alias
 * @param {string} searchName 
 * @returns {object|null}
 */
function findRank(searchName) {
    if (!searchName) return null;
    const clean = searchName.trim().toUpperCase().replace(/[\s_-]+/g, '');
    return Object.values(RANKS).find(r => {
        const rClean = r.name.toUpperCase().replace(/[\s_-]+/g, '');
        const rKey = r.key.replace(/[\s_-]+/g, '');
        return rClean === clean || rKey === clean;
    }) || null;
}

module.exports = {
    RANKS,
    RANK_ORDER,
    findRank
};
