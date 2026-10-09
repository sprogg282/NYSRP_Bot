const WelcomeService = require('../services/welcomeService');
const logger = require('../utils/logger');

module.exports = {
    name: 'guildMemberAdd',
    async execute(member) {
        logger.info(`Member joined guild ${member.guild.name}: ${member.user.tag} (${member.id})`);
        await WelcomeService.handleMemberJoin(member);
    }
};
