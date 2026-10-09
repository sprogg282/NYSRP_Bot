const { AttachmentBuilder } = require('discord.js');
const config = require('../config');

/**
 * Generates an HTML transcript file buffer from channel messages.
 * 
 * @param {TextChannel} channel 
 * @param {Object} ticketData 
 * @returns {Promise<{ attachment: AttachmentBuilder, messageCount: number }>}
 */
async function generateTranscript(channel, ticketData) {
    // Fetch up to 100 recent messages in chronological order
    let fetchedMessages = await channel.messages.fetch({ limit: 100 });
    const messages = Array.from(fetchedMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const createdDate = new Date(ticketData.created_at || channel.createdTimestamp).toLocaleString();
    const closedDate = new Date().toLocaleString();

    let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NYSRP Ticket Transcript - #${ticketData.ticket_id || '0000'}</title>
    <style>
        body {
            background-color: #0F172A;
            color: #F8FAFC;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #003366 0%, #1E3A8A 100%);
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
        }
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            font-size: 14px;
            background: rgba(0, 0, 0, 0.2);
            padding: 12px;
            border-radius: 6px;
        }
        .chat-container {
            background: #1E293B;
            border-radius: 8px;
            padding: 20px;
        }
        .message {
            display: flex;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #334155;
        }
        .avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            margin-right: 15px;
        }
        .msg-body {
            flex-grow: 1;
        }
        .msg-header {
            display: flex;
            align-items: baseline;
            gap: 10px;
            margin-bottom: 4px;
        }
        .username {
            font-weight: bold;
            color: #38BDF8;
        }
        .timestamp {
            font-size: 11px;
            color: #94A3B8;
        }
        .content {
            font-size: 14px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .embed-box {
            background: #0F172A;
            border-left: 4px solid #003366;
            padding: 10px;
            border-radius: 4px;
            margin-top: 6px;
            font-size: 13px;
        }
        .footer {
            margin-top: 20px;
            text-align: center;
            font-size: 12px;
            color: #64748B;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚔 New York State Roleplay - Ticket Transcript</h1>
        <div class="info-grid">
            <div><strong>Ticket ID:</strong> #${ticketData.ticket_id || '0000'}</div>
            <div><strong>Channel:</strong> #${channel.name}</div>
            <div><strong>Category:</strong> ${ticketData.category || 'General Support'}</div>
            <div><strong>Creator ID:</strong> ${ticketData.creator_id || 'Unknown'}</div>
            <div><strong>Claimed By:</strong> ${ticketData.claimed_by ? `<@${ticketData.claimed_by}>` : 'Unclaimed'}</div>
            <div><strong>Created At:</strong> ${createdDate}</div>
            <div><strong>Closed At:</strong> ${closedDate}</div>
            <div><strong>Closed By:</strong> ${ticketData.closed_by || 'System'}</div>
        </div>
    </div>

    <div class="chat-container">
`;

    for (const msg of messages) {
        if (msg.author.bot && msg.embeds.length > 0 && msg.content === '') {
            // Render bot embed summary line
            const avatarUrl = msg.author.displayAvatarURL({ extension: 'png' });
            const timeStr = new Date(msg.createdTimestamp).toLocaleString();
            htmlContent += `
        <div class="message">
            <img class="avatar" src="${avatarUrl}" alt="Avatar">
            <div class="msg-body">
                <div class="msg-header">
                    <span class="username">${escapeHtml(msg.author.tag)}</span>
                    <span class="timestamp">${timeStr}</span>
                </div>
                <div class="embed-box">
                    <strong>[BOT EMBED]</strong> ${escapeHtml(msg.embeds[0].title || '')} - ${escapeHtml(msg.embeds[0].description || '')}
                </div>
            </div>
        </div>`;
            continue;
        }

        const avatarUrl = msg.author.displayAvatarURL({ extension: 'png' });
        const timeStr = new Date(msg.createdTimestamp).toLocaleString();
        const contentStr = escapeHtml(msg.content || '[No Text Content]');

        htmlContent += `
        <div class="message">
            <img class="avatar" src="${avatarUrl}" alt="Avatar">
            <div class="msg-body">
                <div class="msg-header">
                    <span class="username">${escapeHtml(msg.author.tag)}</span>
                    <span class="timestamp">${timeStr}</span>
                </div>
                <div class="content">${contentStr}</div>
            </div>
        </div>`;
    }

    htmlContent += `
    </div>
    <div class="footer">
        Generated by NYSRP Official Ticket System • ${new Date().toISOString()}
    </div>
</body>
</html>`;

    const buffer = Buffer.from(htmlContent, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: `transcript-ticket-${ticketData.ticket_id || '0000'}.html` });

    return {
        attachment,
        messageCount: messages.length
    };
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = {
    generateTranscript
};
