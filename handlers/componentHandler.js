const TicketService = require('../services/ticketService');
const FeedbackService = require('../services/feedbackService');
const SessionService = require('../services/sessionService');
const PollService = require('../services/pollService');
const EventService = require('../services/eventService');
const ERLCService = require('../services/erlcService');
const StaffService = require('../services/staffService');
const SuggestionService = require('../services/suggestionService');
const { hasPermission } = require('../utils/permissionCheck');
const { PERMISSIONS } = require('../config/permissions');
const { createSuccessEmbed, createErrorEmbed } = require('../utils/embedBuilder');
const { generateTranscript } = require('../utils/transcriptGenerator');
const logger = require('../utils/logger');

function isStaleInteractionError(error) {
    return error?.code === 10062 // Unknown interaction
        || error?.code === 40060 // Interaction has already been acknowledged
        || error?.code === 10015; // Unknown webhook
}

async function deferTicketCreateInteraction(interaction) {
    if (interaction.deferred || interaction.replied) {
        return true;
    }

    try {
        await interaction.deferReply({ ephemeral: true });
        return true;
    } catch (error) {
        if (isStaleInteractionError(error)) {
            logger.warn(`[Tickets] Skipping ticket_create_select because the interaction is no longer valid: ${error.message}`);
            return false;
        }

        throw error;
    }
}

async function editTicketCreateReply(interaction, payload) {
    try {
        return await interaction.editReply(payload);
    } catch (error) {
        if (isStaleInteractionError(error)) {
            logger.warn(`[Tickets] Could not update ticket_create_select reply: ${error.message}`);
            return null;
        }

        throw error;
    }
}

async function finishSuggestionInteraction(interaction, result) {
    const embed = result.success
        ? createSuccessEmbed('Suggestion System', result.message)
        : createErrorEmbed('Suggestion System', result.message);
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [embed] });
    }
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function reportSuggestionError(interaction, error, operation) {
    logger.error(`[Suggestions] Failed to ${operation}:`, error);
    const message = 'The suggestion action could not be completed. Please try again later.';
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                embeds: [createErrorEmbed('Suggestion System', message)],
                components: []
            });
        } else {
            await interaction.reply({
                embeds: [createErrorEmbed('Suggestion System', message)],
                ephemeral: true
            });
        }
    } catch (replyError) {
        logger.warn(`[Suggestions] Could not respond to failed ${operation} interaction: ${replyError.message}`);
    }
}

/**
 * Handle non-command component interactions (Buttons, Select Menus, Modals)
 * @param {Interaction} interaction 
 */
async function handleComponentInteraction(interaction) {
    if (interaction.isModalSubmit() && interaction.customId === 'suggestion_submit_modal') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await SuggestionService.submitSuggestion(
                interaction,
                interaction.fields.getTextInputValue('suggestion_text').trim(),
                interaction.fields.getTextInputValue('suggestion_reason').trim()
            );
            return await finishSuggestionInteraction(interaction, result);
        } catch (error) {
            return reportSuggestionError(interaction, error, 'submit a suggestion');
        }
    }

    if (interaction.isModalSubmit()) {
        const decisionModal = SuggestionService.parseDecisionModal(interaction.customId);
        if (decisionModal) {
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage suggestions.')],
                    ephemeral: true
                });
            }
            try {
                if (!hasPermission(interaction.member, PERMISSIONS.SUGGESTION_MANAGE)) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage suggestions.')],
                        ephemeral: true
                    });
                }
            } catch (error) {
                return reportSuggestionError(interaction, error, 'check suggestion management permissions');
            }

            await interaction.deferReply({ ephemeral: true });
            try {
                const result = await SuggestionService.decideSuggestion(
                    interaction.guild,
                    interaction.member,
                    decisionModal.suggestionId,
                    decisionModal.action,
                    interaction.fields.getTextInputValue('decision_reason').trim()
                );
                return await finishSuggestionInteraction(interaction, result);
            } catch (error) {
                return reportSuggestionError(interaction, error, 'record a suggestion decision');
            }
        }
    }

    // 1. Modal Submissions (Feedback Modal)
    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('feedback_modal_')) {
            const parts = interaction.customId.split('_'); // feedback_modal_<ticketId>_<stars>
            const ticketId = parseInt(parts[2], 10);
            const stars = parseInt(parts[3], 10);
            const comment = interaction.fields.getTextInputValue('feedback_comment_text');

            await interaction.deferReply({ ephemeral: true });

            await FeedbackService.saveAndBroadcastFeedback({
                guildClient: interaction.client,
                ticketId,
                creatorUser: interaction.user,
                stars,
                comment
            });

            return interaction.editReply({
                embeds: [createSuccessEmbed('Feedback Submitted', 'Thank you! Your feedback has been successfully submitted to NYSRP Support Management.')]
            });
        }
    }

    // 2. String Select Menu: Ticket Category Selection
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_create_select') {
        const categoryId = interaction.values[0];

        const acknowledged = await deferTicketCreateInteraction(interaction);
        if (!acknowledged) return;

        try {
            const ticketChannel = await TicketService.createTicket(
                interaction.guild,
                interaction.user,
                categoryId
            );

            return editTicketCreateReply(interaction, {
                embeds: [createSuccessEmbed(
                    'Ticket Created',
                    `Your support ticket has been created successfully in <#${ticketChannel.id}>.`,
                    null,
                    [
                        {
                            title: 'Ticket Channel',
                            items: [
                                `**Channel:** <#${ticketChannel.id}>`,
                                `**Category:** ${categoryId}`
                            ]
                        }
                    ],
                    'Please navigate to your ticket channel to describe your issue.'
                )]
            });
        } catch (err) {
            return editTicketCreateReply(interaction, {
                embeds: [createErrorEmbed('Ticket Creation Failed', `Could not create ticket channel: ${err.message}`)]
            });
        }
    }

    // 3. Button Interactions
    if (interaction.isButton()) {
        if (interaction.customId === 'erlc_show_join_code'
            || interaction.customId === 'erlc_refresh_status') {
            return ERLCService.handleButton(interaction);
        }

        const eventParticipation = interaction.customId.match(/^(?:event_rsvp|giveaway_enter):(\d+)$/);
        if (eventParticipation) {
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Participation Failed', 'Event participation is only available inside the server where the event was created.')],
                    ephemeral: true
                });
            }
            return EventService.handleParticipation(interaction, Number(eventParticipation[1]));
        }

        const pollVote = interaction.customId.match(/^poll_vote:(\d+):(\d+)$/);
        if (pollVote) {
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Poll Vote Failed', 'Poll voting is only available inside the server where the poll was created.')],
                    ephemeral: true
                });
            }
            return PollService.handleVote(interaction, Number(pollVote[1]), Number(pollVote[2]));
        }

        if (interaction.customId === 'suggestion_panel_submit') {
            try {
                return await interaction.showModal(SuggestionService.buildSubmitModal());
            } catch (error) {
                return reportSuggestionError(interaction, error, 'open the suggestion form');
            }
        }

        const suggestionButton = SuggestionService.parseSuggestionButton(interaction.customId);
        if (suggestionButton?.type === 'vote') {
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Suggestion System', 'Suggestion voting is only available in the suggestion channel.')],
                    ephemeral: true
                });
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                const result = await SuggestionService.toggleVote(
                    interaction.guild,
                    interaction.user.id,
                    suggestionButton.suggestionId,
                    suggestionButton.action
                );
                return await finishSuggestionInteraction(interaction, result);
            } catch (error) {
                return reportSuggestionError(interaction, error, 'record a suggestion vote');
            }
        }

        if (suggestionButton?.type === 'staff') {
            if (!interaction.guild) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage suggestions.')],
                    ephemeral: true
                });
            }
            try {
                if (!hasPermission(interaction.member, PERMISSIONS.SUGGESTION_MANAGE)) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'You do not have permission to manage suggestions.')],
                        ephemeral: true
                    });
                }
            } catch (error) {
                return reportSuggestionError(interaction, error, 'check suggestion management permissions');
            }

            let suggestion;
            try {
                suggestion = SuggestionService.getSuggestion(suggestionButton.suggestionId);
            } catch (error) {
                return reportSuggestionError(interaction, error, 'load a suggestion');
            }
            if (!suggestion || suggestion.guild_id !== interaction.guild.id) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Suggestion Not Found', 'That suggestion could not be found.')],
                    ephemeral: true
                });
            }
            if (suggestion.status === 'CLOSED') {
                return interaction.reply({
                    embeds: [createErrorEmbed('Suggestion Closed', 'This suggestion is already closed.')],
                    ephemeral: true
                });
            }
            try {
                return await interaction.showModal(
                    SuggestionService.buildDecisionModal(suggestionButton.action, suggestionButton.suggestionId)
                );
            } catch (error) {
                return reportSuggestionError(interaction, error, 'open the staff decision form');
            }
        }

        if (interaction.customId.startsWith('staff_rank_confirm_')
            || interaction.customId.startsWith('staff_rank_cancel_')) {
            if (!StaffService.isConfirmationActive(interaction.customId)) {
                return interaction.reply({
                    embeds: [createErrorEmbed('Confirmation Expired', 'This rank change confirmation is no longer active. Run the command again if needed.')],
                    ephemeral: true
                });
            }
            return;
        }

        // Session Vote Buttons (session_vote_yes_<sessionId> or session_vote_no_<sessionId>)
        if (interaction.customId.startsWith('session_vote_yes_')) {
            return await SessionService.processVote(interaction, 'YES');
        }
        if (interaction.customId.startsWith('session_vote_no_')) {
            return await SessionService.processVote(interaction, 'NO');
        }

        // Ticket Feedback Rating Buttons (feedback_rating_<ticketId>_<stars>)
        if (interaction.customId.startsWith('feedback_rating_')) {
            const parts = interaction.customId.split('_');
            const ticketId = parseInt(parts[2], 10);
            const stars = parseInt(parts[3], 10);

            // Prevent duplicate feedback submissions if already submitted
            if (FeedbackService.hasSubmittedFeedback(ticketId)) {
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Feedback Already Submitted', 'You have already submitted feedback for this support ticket. Thank you!')],
                        ephemeral: true
                    });
                }
                return;
            }

            // Build comment modal and show DIRECTLY as initial response to interaction
            const modal = FeedbackService.buildCommentModal(ticketId, stars);
            return await interaction.showModal(modal);
        }

        // Ticket Controls inside Ticket Channel
        const ticket = TicketService.getTicketByChannel(interaction.channel.id);
        if (!ticket) {
            return interaction.reply({
                embeds: [createErrorEmbed('Invalid Ticket', 'This button can only be used inside active NYSRP ticket channels.')],
                ephemeral: true
            });
        }

        const isStaff = hasPermission(interaction.member, PERMISSIONS.TICKET_MANAGE);
        const isCreator = interaction.user.id === ticket.creator_id;

        if (!isStaff && !isCreator) {
            return interaction.reply({
                embeds: [createErrorEmbed('Permission Denied', 'You are not authorized to use control buttons in this ticket.')],
                ephemeral: true
            });
        }

        switch (interaction.customId) {
            case 'ticket_close':
                await interaction.deferReply({ ephemeral: true });
                try {
                    const result = await TicketService.closeTicket(interaction.channel, ticket, interaction.member);
                    if (result.status === 'already_closed') {
                        return interaction.editReply({
                            embeds: [createErrorEmbed('Ticket Already Closed', 'This ticket has already been closed and its transcript was handled.')]
                        });
                    }
                    if (result.status === 'already_closing') {
                        return interaction.editReply({
                            embeds: [createErrorEmbed('Ticket Closure In Progress', 'A close operation is already running for this ticket. Please wait for it to finish.')]
                        });
                    }
                    return interaction.editReply({
                        embeds: [createSuccessEmbed(
                            'Ticket Closed',
                            `The transcript was delivered to the configured archive. Captured **${result.messageCount}** messages in **${result.partCount}** file part(s). The channel will be deleted in 10 seconds.`
                        )]
                    });
                } catch (error) {
                    logger.error(`[Tickets] Close button failed for ticket #${ticket.ticket_id}:`, error);
                    return interaction.editReply({
                        embeds: [createErrorEmbed('Ticket Close Failed', error.message)]
                    });
                }

            case 'ticket_lock':
                if (!isStaff) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'Only NYSRP Staff members can lock tickets.')],
                        ephemeral: true
                    });
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    await TicketService.lockTicket(interaction.channel, ticket, interaction.member);
                    await interaction.editReply({
                        embeds: [createSuccessEmbed('Ticket Locked', 'Channel locked successfully.')]
                    });
                } catch (error) {
                    await interaction.editReply({
                        embeds: [createErrorEmbed('Ticket Lock Failed', error.message)]
                    });
                }
                break;

            case 'ticket_unlock':
                if (!isStaff) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'Only NYSRP Staff members can unlock tickets.')],
                        ephemeral: true
                    });
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    await TicketService.unlockTicket(interaction.channel, ticket, interaction.member);
                    await interaction.editReply({
                        embeds: [createSuccessEmbed('Ticket Unlocked', 'Channel unlocked successfully.')]
                    });
                } catch (error) {
                    await interaction.editReply({
                        embeds: [createErrorEmbed('Ticket Unlock Failed', error.message)]
                    });
                }
                break;

            case 'ticket_claim':
                if (!isStaff) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'Only NYSRP Staff members can claim tickets.')],
                        ephemeral: true
                    });
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    await TicketService.claimTicket(interaction.channel, interaction.member);
                    await interaction.editReply({
                        embeds: [createSuccessEmbed('Ticket Claimed', 'You have claimed this support ticket.')]
                    });
                } catch (err) {
                    await interaction.editReply({
                        embeds: [createErrorEmbed('Claim Failed', err.message)]
                    });
                }
                break;

            case 'ticket_transcript':
                await interaction.deferReply({ ephemeral: true });
                let deliveredBatches = 0;
                try {
                    const transcript = await generateTranscript(interaction.channel, ticket);
                    const batches = [];
                    for (let offset = 0; offset < transcript.attachments.length; offset += 10) {
                        batches.push(transcript.attachments.slice(offset, offset + 10));
                    }
                    await interaction.editReply({
                        content: `Transcript contains ${transcript.messageCount} messages across ${transcript.partCount} file part(s).`,
                        files: batches[0] || []
                    });
                    deliveredBatches = 1;
                    for (const batch of batches.slice(1)) {
                        await interaction.followUp({
                            content: 'Additional transcript files:',
                            files: batch,
                            ephemeral: true
                        });
                        deliveredBatches += 1;
                    }
                } catch (error) {
                    logger.error(`[Tickets] Manual transcript generation failed for ticket #${ticket.ticket_id}:`, error);
                    const report = {
                        embeds: [createErrorEmbed(
                            deliveredBatches
                                ? 'Transcript Partially Delivered'
                                : 'Transcript Failed',
                            deliveredBatches
                                ? `Only ${deliveredBatches} file batch(es) were delivered. The transcript is incomplete; try again after checking the archive. ${error.message}`
                                : `No transcript was delivered because full history could not be generated. The ticket remains available. ${error.message}`
                        )],
                        ephemeral: true
                    };
                    if (deliveredBatches) {
                        await interaction.followUp(report);
                    } else {
                        await interaction.editReply(report);
                    }
                }
                break;

            case 'ticket_delete':
                if (!isStaff) {
                    return interaction.reply({
                        embeds: [createErrorEmbed('Permission Denied', 'Only NYSRP Staff members can force-delete tickets.')],
                        ephemeral: true
                    });
                }
                if (ticket.status !== 'CLOSED' || !ticket.transcript_delivered_at) {
                    return interaction.reply({
                        embeds: [createErrorEmbed(
                            'Transcript Required',
                            'A ticket cannot be force-deleted until its transcript has been delivered successfully. Use Close first.'
                        )],
                        ephemeral: true
                    });
                }
                await interaction.reply({ content: 'Deleting ticket channel immediately...' });
                try {
                    await interaction.channel.delete('NYSRP Ticket Deleted by Staff');
                } catch (error) {
                    logger.warn(`[Tickets] Could not delete closed ticket #${ticket.ticket_id}: ${error.message}`);
                    await interaction.followUp({
                        embeds: [createErrorEmbed('Ticket Deletion Failed', `The transcript is archived, but the channel could not be deleted. ${error.message}`)],
                        ephemeral: true
                    });
                }
                break;

            case 'ticket_add_user':
                await interaction.reply({
                    embeds: [createSuccessEmbed('Add User Help', 'Use command `/ticket add <user>` to add a specific user to this ticket channel.')],
                    ephemeral: true
                });
                break;

            case 'ticket_remove_user':
                await interaction.reply({
                    embeds: [createSuccessEmbed('Remove User Help', 'Use command `/ticket remove <user>` to remove a user from this ticket channel.')],
                    ephemeral: true
                });
                break;
        }
    }
}

module.exports = { handleComponentInteraction };
