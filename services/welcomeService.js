const ConfigService = require('./configService');
const { createNYSRPEmbed } = require('../utils/embedBuilder');
const { getValidatedChannel } = require('../utils/channelValidator');
const { getImage } = require('../utils/imageManager');
const config = require('../config');
const logger = require('../utils/logger');

class WelcomeService {
    /**
     * Build standard NYSRP Welcome Embed and Payload
     * @param {GuildMember} member
     * @returns {{ content: string, embeds: Array, files: Array }}
     */
    static buildWelcomePayload(member) {
        const guildConfig = ConfigService.getConfig(member.guild.id);
        const rulesChannelMention = guildConfig.rules_channel
            ? `<#${guildConfig.rules_channel}>`
            : 'the rules channel';

        const infoChannelMention = guildConfig.info_channel
            ? `<#${guildConfig.info_channel}>`
            : 'the information channel';

        const memberCount = member.guild.memberCount;
        const serverName = member.guild.name || config.branding.serverName;

        const welcomeEmbed = createNYSRPEmbed({
            title: '𝙒𝙚𝙡𝙘𝙤𝙢𝙚 𝙩𝙤 𝙉𝙔𝙎𝙍𝙋',
            introduction: `Welcome to ${config.branding.emoji} **${serverName}**, <@${member.id}>! We're glad to have you join our community.`,
            important: 'Please review the server rules and information before participating.',
            sections: [
                {
                    title: 'Getting Started',
                    items: [
                        `Read the server rules in ${rulesChannelMention}`,
                        `Review the server information in ${infoChannelMention}`,
                        'Check the roleplay requirements',
                        'Explore the available channels',
                        'Contact Staff if you need assistance'
                    ]
                },
                {
                    title: 'Community Information',
                    items: [
                        `**Member Count:** #${memberCount}`,
                        `**Server:** ${serverName}`
                    ]
                }
            ],
            closing: 'We hope you enjoy your time with **New York State Roleplay**!',
            color: config.branding.color
        });

        if (member.guild.iconURL()) {
            welcomeEmbed.setThumbnail(
                member.guild.iconURL({
                    extension: 'png',
                    dynamic: true
                })
            );
        }

        // Attach Welcome image if available
        const welcomeImage = getImage('welcome');
        const files = [];

        if (welcomeImage) {
            welcomeEmbed.setImage(welcomeImage.url);
            files.push(welcomeImage.attachment);
        }

        return {
            content: `Welcome <@${member.id}>!`,
            embeds: [welcomeEmbed],
            files
        };
    }

    static async handleMemberJoin(member) {
        const welcomeChannelId = config.channels.welcome;
        const welcomeChannel = await getValidatedChannel(
            member.guild,
            welcomeChannelId,
            'Welcome'
        );

        if (!welcomeChannel) return;

        try {
            const payload = this.buildWelcomePayload(member);
            await welcomeChannel.send(payload);
        } catch (err) {
            logger.warn(
                `Failed sending welcome embed to guild ${member.guild.id}: ${err.message}`
            );
        }
    }
}

module.exports = WelcomeService;