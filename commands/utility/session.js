const { SlashCommandBuilder } = require('discord.js');
const SessionService = require('../../services/sessionService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('session')
        .setDescription('NYSRP Session Vote & SSU Management Commands')

        // /session start
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a community vote for a new NYSRP session.'))

        // /session ssu-start
        .addSubcommand(sub =>
            sub.setName('ssu-start')
                .setDescription('Manually start the SSU (requires 5 YES votes).'))

        // /session ssu-end
        .addSubcommand(sub =>
            sub.setName('ssu-end')
                .setDescription('End the active SSU.'))

        // /session end
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('Completely close the current NYSRP session.'))

        // /session status
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Display the current NYSRP session and SSU status.')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'start') {
            await interaction.deferReply({ ephemeral: true });
            const result = await SessionService.startVote(interaction.guild, interaction.member);
            return interaction.editReply({ embeds: [result.embed] });
        }

        if (subcommand === 'ssu-start') {
            await interaction.deferReply({ ephemeral: true });
            const result = await SessionService.ssuStart(interaction.guild, interaction.member);
            return interaction.editReply({ embeds: [result.embed] });
        }

        if (subcommand === 'ssu-end') {
            await interaction.deferReply({ ephemeral: true });
            const result = await SessionService.ssuEnd(interaction.guild, interaction.member);
            return interaction.editReply({ embeds: [result.embed] });
        }

        if (subcommand === 'end') {
            await interaction.deferReply({ ephemeral: true });
            const result = await SessionService.endSession(interaction.guild, interaction.member);
            return interaction.editReply({ embeds: [result.embed] });
        }

        if (subcommand === 'status') {
            const statusEmbed = SessionService.getStatus(interaction.guild);
            return interaction.reply({ embeds: [statusEmbed] });
        }
    }
};
