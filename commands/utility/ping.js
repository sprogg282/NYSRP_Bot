const { SlashCommandBuilder } = require('discord.js');
const { createNYSRPEmbed } = require('../../utils/embedBuilder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check NYSRP bot latency and status.'),

    async execute(interaction) {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true, ephemeral: true });
        const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
        const apiWs = Math.round(interaction.client.ws.ping);

        const pingEmbed = createNYSRPEmbed({
            title: '𝙉𝙔𝙎𝙍𝙋 𝙎𝙮𝙨𝙩𝙚𝙢 𝙎𝙩𝙖𝙩𝙪𝙨',
            introduction: 'Bot responsiveness and connection diagnostics.',
            sections: [
                {
                    title: 'Latency Performance',
                    items: [
                        `**Roundtrip Latency:** \`${roundtrip}ms\``,
                        `**Discord API Latency:** \`${apiWs}ms\``,
                        `**Database Engine:** SQLite (WAL Mode active)`
                    ]
                }
            ],
            closing: 'New York State Roleplay Bot is operational.'
        });

        await interaction.editReply({ content: null, embeds: [pingEmbed] });
    }
};
