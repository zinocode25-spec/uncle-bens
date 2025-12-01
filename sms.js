/**
 * Hubtel SMS Utility
 * 
 * Sends SMS notifications via Hubtel SMS API
 * https://sms.hubtel.com/v1/messages/send
 */

const fetch = require('node-fetch');

// Load Hubtel configuration from environment variables
const HUBTEL_CLIENT_ID = process.env.HUBTEL_CLIENT_ID;
const HUBTEL_CLIENT_SECRET = process.env.HUBTEL_CLIENT_SECRET;
const HUBTEL_FROM = process.env.HUBTEL_FROM;

/**
 * Validates and formats phone number for Ghana
 * Converts numbers starting with 0 to international format (+233)
 * @param {string} phoneNumber - The phone number to format
 * @returns {string|null} - Formatted phone number or null if invalid
 */
function formatPhoneNumber(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
        return null;
    }

    // Remove all whitespace and special characters except +
    let cleaned = phoneNumber.trim().replace(/\s+/g, '');

    // If empty after cleaning, return null
    if (!cleaned) {
        return null;
    }

    // If already in international format (+233...), validate and return
    if (cleaned.startsWith('+233')) {
        // Remove the + and validate length (should be 12 digits: 233 + 9 digits)
        const digitsOnly = cleaned.substring(1).replace(/\D/g, '');
        if (digitsOnly.length === 12 && digitsOnly.startsWith('233')) {
            return cleaned;
        }
    }

    // If starts with 0, convert to +233 format
    if (cleaned.startsWith('0')) {
        // Remove the leading 0 and add +233
        const withoutZero = cleaned.substring(1).replace(/\D/g, '');
        if (withoutZero.length === 9) {
            return `+233${withoutZero}`;
        }
    }

    // If starts with 233 (without +), add +
    if (cleaned.startsWith('233') && cleaned.length === 12) {
        return `+${cleaned}`;
    }

    // If it's 9 digits, assume it's a local number and add +233
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (digitsOnly.length === 9) {
        return `+233${digitsOnly}`;
    }

    // If nothing matches, return the cleaned number as-is (might be valid)
    return cleaned;
}

/**
 * Sends SMS via Hubtel API
 * @param {string} to - Recipient phone number
 * @param {string} message - SMS message content
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendHubtelSMS(to, message) {
    // Validate Hubtel credentials
    if (!HUBTEL_CLIENT_ID || !HUBTEL_CLIENT_SECRET || !HUBTEL_FROM) {
        const error = 'Hubtel credentials not configured. Please set HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET, and HUBTEL_FROM environment variables.';
        console.error(`[SMS Error] ${error}`);
        return { success: false, error };
    }

    // Validate and format phone number
    const formattedPhone = formatPhoneNumber(to);
    if (!formattedPhone) {
        const error = `Invalid phone number: ${to}`;
        console.error(`[SMS Error] ${error}`);
        return { success: false, error };
    }

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        const error = 'Message cannot be empty';
        console.error(`[SMS Error] ${error}`);
        return { success: false, error };
    }

    try {
        // Create Basic Auth header
        const credentials = Buffer.from(`${HUBTEL_CLIENT_ID}:${HUBTEL_CLIENT_SECRET}`).toString('base64');
        
        // Prepare request payload
        const payload = {
            From: HUBTEL_FROM,
            To: formattedPhone,
            Content: message.trim(),
            Type: 0, // 0 for plain text SMS
            RegisteredDelivery: 1 // Request delivery receipt
        };

        // Send SMS via Hubtel API
        const response = await fetch('https://sms.hubtel.com/v1/messages/send', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseData = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = responseData.message || responseData.error || `HTTP ${response.status}: ${response.statusText}`;
            console.error(`[SMS Error] Failed to send SMS to ${formattedPhone}:`, error);
            return { success: false, error };
        }

        // Success
        console.log(`[SMS Success] SMS sent successfully to ${formattedPhone}. Response ID: ${responseData.ResponseCode || 'N/A'}`);
        return { success: true };

    } catch (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        console.error(`[SMS Error] Exception while sending SMS to ${formattedPhone}:`, errorMessage);
        return { success: false, error: errorMessage };
    }
}

module.exports = {
    sendHubtelSMS,
    formatPhoneNumber // Export for testing purposes
};

