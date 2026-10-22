const { AttachmentBuilder } = require('discord.js');
const config = require('../config');

const PAGE_SIZE = 100;
const MAX_PART_BYTES = 7 * 1024 * 1024;

async function fetchAllMessages(channel) {
    const messages = [];
    const seenIds = new Set();
    let before;

    while (true) {
        const page = await channel.messages.fetch({
            limit: PAGE_SIZE,
            ...(before ? { before } : {})
        });
        const pageMessages = Array.from(page.values());

        if (pageMessages.length === 0) break;

        for (const message of pageMessages) {
            if (!seenIds.has(message.id)) {
                seenIds.add(message.id);
                messages.push(message);
            }
        }

        const oldestMessage = pageMessages.reduce((oldest, message) => {
            if (!oldest || BigInt(message.id) < BigInt(oldest.id)) return message;
            return oldest;
        }, null);

        if (!oldestMessage || oldestMessage.id === before) {
            throw new Error(`Transcript pagination did not advance in channel ${channel.id}.`);
        }

        before = oldestMessage.id;
        if (pageMessages.length < PAGE_SIZE) break;
    }

    return messages.sort((a, b) => {
        const timestampDifference = a.createdTimestamp - b.createdTimestamp;
        return timestampDifference || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    });
}

function safeExternalUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

function renderEmbed(embed, index) {
    const title = embed.title
        ? `<div class="embed-title">${escapeHtml(embed.title)}</div>`
        : '';
    const titleUrl = safeExternalUrl(embed.url);
    const description = embed.description
        ? `<div class="embed-description">${escapeHtml(embed.description)}</div>`
        : '';
    const author = embed.author?.name
        ? `<div class="embed-author">${escapeHtml(embed.author.name)}</div>`
        : '';
    const fields = Array.isArray(embed.fields)
        ? embed.fields.map(field => `
            <div class="embed-field${field.inline ? ' inline' : ''}">
                <strong>${escapeHtml(field.name)}</strong>
                <div>${escapeHtml(field.value)}</div>
            </div>`).join('')
        : '';
    const footer = embed.footer?.text
        ? `<div class="embed-footer">${escapeHtml(embed.footer.text)}</div>`
        : '';
    const imageUrl = safeExternalUrl(embed.image?.url);
    const thumbnailUrl = safeExternalUrl(embed.thumbnail?.url);
    const linkedTitle = titleUrl
        ? `<a href="${escapeHtml(titleUrl)}" rel="noreferrer">${title}</a>`
        : title;
    const image = imageUrl
        ? `<a href="${escapeHtml(imageUrl)}" rel="noreferrer">${escapeHtml(imageUrl)}</a>`
        : '';
    const thumbnail = thumbnailUrl
        ? `<a href="${escapeHtml(thumbnailUrl)}" rel="noreferrer">${escapeHtml(thumbnailUrl)}</a>`
        : '';
    const color = Number.isInteger(embed.color)
        ? ` style="border-left-color: #${embed.color.toString(16).padStart(6, '0')}"`
        : '';

    return `
        <section class="embed"${color}>
            <div class="embed-label">Embed ${index + 1}${embed.type ? ` · ${escapeHtml(embed.type)}` : ''}</div>
            ${author}${linkedTitle}${description}
            ${fields ? `<div class="embed-fields">${fields}</div>` : ''}
            ${thumbnail ? `<div class="embed-media">Thumbnail: ${thumbnail}</div>` : ''}
            ${image ? `<div class="embed-media">Image: ${image}</div>` : ''}
            ${embed.video?.url ? `<div class="embed-media">Video: ${escapeHtml(embed.video.url)}</div>` : ''}
            ${footer}
        </section>`;
}

function renderMessage(message) {
    const author = message.author || {};
    const authorName = author.tag || author.globalName || author.username || 'Unknown author';
    const avatarUrl = safeExternalUrl(author.displayAvatarURL?.({ extension: 'png' }));
    const createdAt = new Date(message.createdTimestamp).toISOString();
    const editedAt = message.editedTimestamp
        ? new Date(message.editedTimestamp).toISOString()
        : null;
    const content = message.content
        ? `<div class="content">${escapeHtml(message.content)}</div>`
        : '';
    const attachments = Array.from(message.attachments?.values?.() || []).map(attachment => {
        const url = safeExternalUrl(attachment.url);
        const name = attachment.name || 'Attachment';
        const link = url
            ? `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(name)}</a>`
            : escapeHtml(name);
        const contentType = attachment.contentType
            ? ` · ${escapeHtml(attachment.contentType)}`
            : '';
        const size = Number.isFinite(attachment.size)
            ? ` · ${attachment.size.toLocaleString()} bytes`
            : '';
        return `<li>${link}${contentType}${size}</li>`;
    }).join('');
    const embeds = Array.from(message.embeds || []).map(renderEmbed).join('');
    const avatar = avatarUrl
        ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="">`
        : '<div class="avatar placeholder"></div>';
    const metadata = [
        `User ID: ${escapeHtml(author.id || 'Unavailable')}`,
        `Message ID: ${escapeHtml(message.id)}`,
        message.webhookId ? `Webhook ID: ${escapeHtml(message.webhookId)}` : null,
        message.pinned ? 'Pinned' : null,
        message.type !== undefined ? `Type: ${escapeHtml(message.type)}` : null
    ].filter(Boolean).join(' · ');

    return `
        <article class="message">
            ${avatar}
            <div class="message-body">
                <header class="message-header">
                    <strong>${escapeHtml(authorName)}</strong>
                    <span>${escapeHtml(author.id || 'ID unavailable')}</span>
                    <time datetime="${escapeHtml(createdAt)}">${escapeHtml(createdAt)}</time>
                    ${editedAt ? `<span>Edited ${escapeHtml(editedAt)}</span>` : ''}
                </header>
                <div class="metadata">${metadata}</div>
                ${content || (!attachments && !embeds ? '<div class="content muted">No text content</div>' : '')}
                ${attachments ? `<ul class="attachments">${attachments}</ul>` : ''}
                ${embeds}
            </div>
        </article>`;
}

function renderDocument(messageBlocks, ticketData, channel, generatedAt, partNumber, partCount) {
    const createdAt = new Date(ticketData.created_at || channel.createdTimestamp).toISOString();
    const closedAt = new Date(ticketData.closed_at || generatedAt).toISOString();
    const closeLabel = ticketData.closed_by
        ? `${ticketData.closed_by}${ticketData.closed_by_id ? ` (${ticketData.closed_by_id})` : ''}`
        : 'System / not recorded';

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NYSRP Ticket Transcript #${escapeHtml(ticketData.ticket_id || '0000')}</title>
    <style>
        :root { color-scheme: dark; --accent: ${escapeHtml(config.branding.color)}; }
        body { margin: 0; padding: 24px; background: #171717; color: #f4f4f4; font: 15px/1.55 system-ui, sans-serif; }
        main { max-width: 1100px; margin: auto; }
        .header, .chat { padding: 20px; border: 1px solid #373737; border-radius: 12px; background: #222; }
        .header { border-left: 6px solid var(--accent); margin-bottom: 16px; }
        h1 { margin: 0 0 14px; font-size: 24px; }
        .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px 18px; }
        .message { display: flex; gap: 12px; padding: 16px 0; border-bottom: 1px solid #3a3a3a; }
        .message:last-child { border-bottom: 0; }
        .avatar { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
        .placeholder { background: #444; }
        .message-body { min-width: 0; flex: 1; }
        .message-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
        .message-header strong { color: var(--accent); }
        .message-header span, time, .metadata, .muted { color: #aaa; font-size: 12px; }
        .content { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 6px; }
        a { color: #ffc078; overflow-wrap: anywhere; }
        .attachments { margin: 8px 0; padding-left: 20px; }
        .embed { margin-top: 10px; padding: 10px 12px; border-left: 4px solid var(--accent); border-radius: 4px; background: #181818; }
        .embed-label, .embed-footer, .embed-media { color: #aaa; font-size: 12px; }
        .embed-title { margin: 3px 0; font-weight: 700; }
        .embed-description { white-space: pre-wrap; overflow-wrap: anywhere; }
        .embed-fields { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .embed-field { flex: 1 1 100%; overflow-wrap: anywhere; }
        .embed-field.inline { flex-basis: 30%; }
        .footer { margin-top: 14px; color: #aaa; text-align: center; font-size: 12px; }
        @media (max-width: 600px) { body { padding: 10px; } .header, .chat { padding: 14px; } }
    </style>
</head>
<body>
<main>
    <header class="header">
        <h1>${escapeHtml(config.branding.serverName)} — Ticket Transcript</h1>
        <div class="details">
            <div><strong>Ticket:</strong> #${escapeHtml(ticketData.ticket_id || '0000')}</div>
            <div><strong>Channel:</strong> #${escapeHtml(channel.name)} (${escapeHtml(channel.id)})</div>
            <div><strong>Guild ID:</strong> ${escapeHtml(channel.guild?.id || 'Unavailable')}</div>
            <div><strong>Category:</strong> ${escapeHtml(ticketData.category || 'General Support')}</div>
            <div><strong>Creator ID:</strong> ${escapeHtml(ticketData.creator_id || 'Unknown')}</div>
            <div><strong>Claimed By ID:</strong> ${escapeHtml(ticketData.claimed_by || 'Unclaimed')}</div>
            <div><strong>Created:</strong> <time>${escapeHtml(createdAt)}</time></div>
            <div><strong>Closed:</strong> <time>${escapeHtml(closedAt)}</time></div>
            <div><strong>Closed by:</strong> ${escapeHtml(closeLabel)}</div>
            <div><strong>Transcript part:</strong> ${partNumber} / ${partCount}</div>
        </div>
    </header>
    <section class="chat">${messageBlocks.join('\n')}</section>
    <div class="footer">Generated by the NYSRP ticket system at ${escapeHtml(generatedAt.toISOString())}</div>
</main>
</body>
</html>`;
}

async function generateTranscript(channel, ticketData) {
    const messages = await fetchAllMessages(channel);
    const blocks = messages.map(renderMessage);
    const parts = [];
    let currentPart = [];
    let currentBytes = 0;

    for (const block of blocks) {
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (blockBytes > MAX_PART_BYTES - 2048) {
            throw new Error(`A message in ticket #${ticketData.ticket_id} is too large to place in a Discord transcript attachment.`);
        }
        if (currentPart.length > 0 && currentBytes + blockBytes > MAX_PART_BYTES - 2048) {
            parts.push(currentPart);
            currentPart = [];
            currentBytes = 0;
        }
        currentPart.push(block);
        currentBytes += blockBytes;
    }

    if (currentPart.length > 0 || parts.length === 0) parts.push(currentPart);

    const generatedAt = new Date();
    const baseName = `transcript-ticket-${ticketData.ticket_id || '0000'}`;
    const attachments = parts.map((part, index) => {
        const html = renderDocument(part, ticketData, channel, generatedAt, index + 1, parts.length);
        if (Buffer.byteLength(html, 'utf8') > MAX_PART_BYTES) {
            throw new Error(`Transcript part ${index + 1} exceeds the safe Discord upload size.`);
        }
        const suffix = parts.length > 1 ? `-part-${String(index + 1).padStart(3, '0')}` : '';
        return new AttachmentBuilder(Buffer.from(html, 'utf8'), {
            name: `${baseName}${suffix}.html`
        });
    });

    return {
        attachments,
        messageCount: messages.length,
        partCount: attachments.length
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = {
    generateTranscript,
    fetchAllMessages,
    escapeHtml
};
