const { AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Centralized NYSRP Image Manager
 * 
 * Maps system keys to image files in the photos/ folder.
 * Provides AttachmentBuilder instances for use in Discord embeds.
 */

// Root photos directory
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');

/**
 * Map of system keys → filenames in the photos/ folder.
 * Filenames must match the actual files exactly (including spaces and extension).
 */
const IMAGE_MAP = {
    welcome:      'Welcome.png',
    support:      'Support.png',
    sessionVote:  'Session Vote.png',
    sessionStart: 'Session Start.png',
    sessionEnd:   'Session End.png'
};

/**
 * Get an AttachmentBuilder and the attachment:// URL for a given system key.
 * 
 * @param {string} key - One of the IMAGE_MAP keys (e.g. 'welcome', 'support', 'sessionVote')
 * @returns {{ attachment: AttachmentBuilder, url: string } | null}
 *   - attachment: The discord.js AttachmentBuilder to include in the message `files` array
 *   - url: The `attachment://filename` string to use in embed .setImage() or .setThumbnail()
 *   - Returns null if the key is unknown or the file doesn't exist
 */
function getImage(key) {
    const filename = IMAGE_MAP[key];
    if (!filename) {
        logger.warn(`[ImageManager] Unknown image key: "${key}"`);
        return null;
    }

    const filePath = path.join(PHOTOS_DIR, filename);

    if (!fs.existsSync(filePath)) {
        logger.warn(`[ImageManager] Image file not found: ${filePath}`);
        return null;
    }

    // Use a sanitized attachment name (replace spaces with underscores) for the attachment:// URL
    const attachmentName = filename.replace(/\s+/g, '_');

    const attachment = new AttachmentBuilder(filePath, { name: attachmentName });

    return {
        attachment,
        url: `attachment://${attachmentName}`
    };
}

/**
 * List all available image keys and their file status
 * @returns {Object<string, { filename: string, exists: boolean }>}
 */
function listImages() {
    const result = {};
    for (const [key, filename] of Object.entries(IMAGE_MAP)) {
        const filePath = path.join(PHOTOS_DIR, filename);
        result[key] = {
            filename,
            exists: fs.existsSync(filePath)
        };
    }
    return result;
}

module.exports = { getImage, listImages, IMAGE_MAP };
