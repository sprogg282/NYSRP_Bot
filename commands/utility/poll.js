const { SlashCommandBuilder } = require('discord.js');
const { hasPermission } = require('../../utils/permissionCheck');
const { PERMISSIONS } = require('../../config/permissions');
const PollService = require('../../services/pollService');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const logger = require('../../utils/logger');

const optionNames = Array.from({ length: 10 }, (_, index) => `option${index + 1}`);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create and manage persistent NYSRP polls')
        .addSubcommand(subcommand => {
            subcommand
                .setName('create')
                .setDescription('Create a poll with up to 10 answer options')
                .addStringOption(option => option
                    .setName('question')
                    .setDescription('The question to ask')
                    .setMaxLength(200)
                    .setRequired(true))
                .addIntegerOption(option => option
                    .setName('duration')
                    .setDescription('How long voting stays open, in minutes (1-10080)')
                    .setMinValue(1)
                    .setMaxValue(10080)
                    .setRequired(true))
                .addStringOption(option => option
                    .setName(optionNames[0])
                    .setDescription('Answer option 1')
                    .setMaxLength(80)
                    .setRequired(true))
                .addStringOption(option => option
                    .setName(optionNames[1])
                    .setDescription('Answer option 2')
                    .setMaxLength(80)
                    .setRequired(true))
                .addBooleanOption(option => option
                    .setName('multiple')
                    .setDescription('Allow voters to select more than one answer'));
            optionNames.slice(2).forEach((name, index) => {
                subcommand.addStringOption(option => option
                    .setName(name)
                    .setDescription(`Answer option ${index + 3} (optional)`)
                    .setMaxLength(80));
            });
            return subcommand;
        })
        .addSubcommand(subcommand => subcommand
            .setName('close')
            .setDescription('Close a poll and publish its final results')
            .addIntegerOption(option => option
                .setName('id')
                .setDescription('The poll ID shown in its title')
                .setMinValue(1)
                .setRequired(true))),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [createErrorEmbed('Polls', 'Polls can only be created or managed inside a server.')],
                ephemeral: true
            });
        }
        if (!hasPermission(interaction.member, PERMISSIONS.POLL_MANAGE)) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage polls.')],
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: true });

        try {
            if (subcommand === 'create') {
                if (!interaction.channel?.isTextBased() || typeof interaction.channel.send !== 'function') {
                    throw new Error('Polls can only be posted in a text channel.');
                }

                const options = optionNames.map(name => interaction.options.getString(name))
                    .map(value => value?.trim() || null);
                const firstMissingIndex = options.findIndex(option => option === null);
                if (firstMissingIndex !== -1 && options.slice(firstMissingIndex).some(Boolean)) {
                    throw new Error('Answer options must be entered in order without gaps.');
                }
                const answers = options.filter(Boolean);
                const question = interaction.options.getString('question', true);
                const duration = interaction.options.getInteger('duration', true);
                const allowMultiple = interaction.options.getBoolean('multiple') ?? false;
                const result = await PollService.createPoll(
                    interaction.channel,
                    interaction.user.id,
                    question,
                    answers,
                    duration,
                    allowMultiple
                );

                return interaction.editReply({
                    embeds: [createSuccessEmbed(
                        'Poll Created',
                        `Poll **#${result.pollId}** has been posted in <#${interaction.channel.id}> and will close <t:${Math.floor(result.closesAt / 1000)}:R>.`,
                        null,
                        [{ title: 'Question', items: [question.trim()] }]
                    )]
                });
            }

            if (subcommand === 'close') {
                const pollId = interaction.options.getInteger('id', true);
                const result = await PollService.closePollForGuild(
                    pollId,
                    interaction.guild.id,
                    interaction.client,
                    interaction.user.id
                );
                const message = result.messageMissing
                    ? `Poll **#${pollId}** is closed and its final results remain saved, but its Discord message no longer exists.`
                    : result.alreadyClosed
                        ? `Poll **#${pollId}** was already closed.`
                        : `Poll **#${pollId}** is closed and its final results are published.`;
                return interaction.editReply({
                    embeds: [createSuccessEmbed('Poll Closed', message)]
                });
            }
        } catch (error) {
            logger.error(`[Polls] /poll ${subcommand} failed:`, error);
            return interaction.editReply({
                embeds: [createErrorEmbed('Poll Operation Failed', error.message)]
            });
        }
    }
};
