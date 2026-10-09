const { EmbedBuilder } = require('discord.js');
const config = require('../config');

/**
 * Creates an Embed formatted strictly according to the NYSRP Master Embed rules.
 * Uses official NYSRP Embed Colour: #FD8701
 * 
 * @param {Object} options
 * @param {string} options.title - The title text
 * @param {string} options.introduction - Professional intro paragraph
 * @param {string} [options.important] - Optional important notice
 * @param {Array<{title: string, items: Array<string>}>} [options.sections] - Sections containing bullet points
 * @param {string} [options.closing] - Optional closing message at the bottom
 * @param {string} [options.color] - Hex color override (defaults to official NYSRP color #FD8701)
 * @param {string} [options.footerText] - Footer text (defaults to NYSRP Branding)
 * @returns {EmbedBuilder}
 */
function createNYSRPEmbed({
    title,
    introduction,
    important = null,
    sections = [],
    closing = null,
    color = config.branding.color, // Always #FD8701
    footerText = 'New York State Roleplay • Official Community Management'
}) {
    const divider = config.branding.divider;
    let descriptionText = '';

    // Header title
    const fullHeader = `${config.branding.emoji} **${title}**`;

    // Introduction blockquote
    if (introduction) {
        const formattedIntro = introduction
            .split('\n')
            .map(line => line.trim() ? `> ${line.replace(/^>\s*/, '')}` : '>')
            .join('\n');
        descriptionText += `${formattedIntro}\n\n`;
    }

    // Important Notice blockquote
    if (important) {
        const formattedImportant = important
            .split('\n')
            .map((line, i) => i === 0 
                ? `> **IMPORTANT:** ${line.replace(/^>\s*(\*\*IMPORTANT:\*\*)?\s*/i, '')}` 
                : `> ${line.replace(/^>\s*/, '')}`)
            .join('\n');
        descriptionText += `${formattedImportant}\n\n`;
    }

    // Divider after intro/important
    if (sections.length > 0 || closing) {
        descriptionText += `${divider}\n\n`;
    }

    // Information Sections
    sections.forEach((sec) => {
        if (sec.title) {
            descriptionText += `📌 **${sec.title}:**\n`;
        }
        if (Array.isArray(sec.items)) {
            sec.items.forEach(item => {
                descriptionText += `• ${item}\n`;
            });
        }
        descriptionText += '\n';
    });

    // Divider before closing if sections existed
    if (sections.length > 0 && closing) {
        descriptionText += `${divider}\n\n`;
    }

    // Closing
    if (closing) {
        descriptionText += `${closing}\n`;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(fullHeader)
        .setDescription(descriptionText.trim())
        .setTimestamp()
        .setFooter({ text: footerText });

    return embed;
}

/**
 * Helper for Standard Success Embed (Uses official NYSRP #FD8701)
 */
function createSuccessEmbed(title, description, important = null, sections = [], closing = null) {
    return createNYSRPEmbed({
        title,
        introduction: description,
        important,
        sections,
        closing,
        color: config.branding.color // #FD8701
    });
}

/**
 * Helper for Standard Error Embed (Uses official NYSRP #FD8701)
 */
function createErrorEmbed(title, description, important = null, sections = [], closing = null) {
    return createNYSRPEmbed({
        title,
        introduction: description,
        important: important || 'If you believe this is an error, please contact NYSRP Staff Management.',
        sections,
        closing,
        color: config.branding.color // #FD8701
    });
}

module.exports = {
    createNYSRPEmbed,
    createSuccessEmbed,
    createErrorEmbed
};
