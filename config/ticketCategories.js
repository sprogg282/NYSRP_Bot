/**
 * NYSRP Ticket Category Definitions
 */

const TICKET_CATEGORIES = [
    {
        id: 'general_support',
        label: 'General Support',
        description: 'General inquiries and assistance regarding NYSRP.',
        emoji: '💬'
    },
    {
        id: 'staff_support',
        label: 'Staff Support',
        description: 'Assistance for official NYSRP staff members.',
        emoji: '👮'
    },
    {
        id: 'partnership',
        label: 'Partnership',
        description: 'Submit or inquire about NYSRP community partnerships.',
        emoji: '🤝'
    },
    {
        id: 'report_staff',
        label: 'Report a Staff Member',
        description: 'Report staff misconduct or rule violations.',
        emoji: '🛡️'
    },
    {
        id: 'report_player',
        label: 'Report a Player',
        description: 'Report in-game or server player violations.',
        emoji: '🚨'
    },
    {
        id: 'management',
        label: 'Management',
        description: 'Direct inquiries requiring NYSRP Management attention.',
        emoji: '👑'
    },
    {
        id: 'other',
        label: 'Other',
        description: 'Any issues not covered by the standard categories.',
        emoji: '📁'
    }
];

module.exports = {
    TICKET_CATEGORIES
};
