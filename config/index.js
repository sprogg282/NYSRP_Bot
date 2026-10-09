require('dotenv').config();

module.exports = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    prefix: process.env.PREFIX || '/',

    // Centralized Official NYSRP Color (#FD8701)
    branding: {
        serverName: 'New York State Roleplay',
        abbreviation: 'NYSRP',
        emoji: '<:NYSRP:1515439585398886501>',
        color: '#FD8701',        // Official NYSRP Embed Color
        errorColor: '#FD8701',   // Official NYSRP Embed Color
        successColor: '#FD8701', // Official NYSRP Embed Color
        warningColor: '#FD8701', // Official NYSRP Embed Color
        divider: '━━━━━━━━━━━━━━━━━━'
    },

    // Centralized Channel Configuration
    channels: {
        commandLogs: '1515409909779271770',
        moderationLogs: '1515410238830809099',
        ticketPanel: '1515395877316071508',
        ticketTranscripts: '1515410320997486662',
        ticketFeedback: '1515395906764148892',
        staffActions: '1515395913873494147',
        welcome: '1515395920663941221',
        session: '1515413881256677496',
        suggestions: '1556342057914867785'
    },

    // Centralized Role Configuration
    roles: {
        ssuPermission: '1545826232178839573'
    },

    // Session Vote & SSU Configuration
    sessionVote: {
        requiredYesVotes: 5,
        cooldownMinutes: 30
    }
};
