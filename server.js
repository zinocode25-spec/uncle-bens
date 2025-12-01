/**
 * Uncle Ben's Pizza - Production Backend Server
 *
 * Deploys to Render.com.
 * Environment variables are set in the Render dashboard.
 */

require('dotenv').config(); // Load environment variables from a .env file
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // For security headers
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); // Use node-fetch v2 for CommonJS compatibility
const { sendHubtelSMS } = require('./utils/sms');

// --- Configuration (Loaded from .env file) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; // Use the secure SERVICE KEY
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const port = process.env.PORT || 5000;

// --- Initialization ---
const app = express();
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- Middleware ---
app.use(helmet()); // Apply security headers first
app.use(cors({
    // This allows requests from your Netlify frontend AND your local machine for testing.
    origin: [process.env.FRONTEND_URL, 'http://127.0.0.1:5500'],
    
}));
app.use(express.json()); // Enable parsing of JSON request bodies
app.disable('x-powered-by'); // Disable for security

/**
 * @route   POST /api/paystack-callback
 * @desc    Receives a payment reference from the frontend, verifies it with Paystack,
 *          and saves the order to Supabase if payment was successful.
 * @access  Public
 */
app.post('/api/paystack-callback', async (req, res, next) => {
    const { reference, order } = req.body;

    // 1. Robust Input Validation
    if (!reference || !order || !order.total || !order.items || order.items.length === 0) {
        return res.status(400).json({ ok: false, error: 'Invalid order data. Please try again.' });
    }

    try {
        // 2. Securely Verify Transaction with Paystack from the Backend
        const paystackVerifyUrl = `https://api.paystack.co/transaction/verify/${reference}`;
        const paystackResponse = await fetch(paystackVerifyUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${paystackSecretKey}`,
            },
        });

        const paystackData = await paystackResponse.json();

        // If verification fails or payment was not successful, reject the request.
        if (!paystackData.status || paystackData.data.status !== 'success') {
            return res.status(400).json({ ok: false, error: 'Payment verification failed.' });
        }

        // 3. CRITICAL: Verify the amount paid matches the order total
        const paidAmountKobo = paystackData.data.amount; // Amount from Paystack is in kobo
        const expectedAmountKobo = Math.round(order.total * 100); // Convert order total to kobo

        if (paidAmountKobo < expectedAmountKobo) { // Use '<' to allow for tips/overpayment
            // This is a critical security check to prevent payment fraud.
            return res.status(400).json({ ok: false, error: 'Payment amount mismatch. Contact support.' });
        }

        // 4. If verification and amount check pass, save the order to Supabase
        const { data: savedOrder, error: dbError } = await supabase
            .from('orders')
            .insert({
                ...order,
                payment_reference: reference, // Ensure payment reference is saved
                status: 'received', // Set initial status
                seen: false,
            })
            .select()
            .single();

        if (dbError) {
            // IMPORTANT: If this fails, you have a successful payment but no order record.
            // A robust logging/alerting system should be in place here for manual intervention.
            console.error(`[CRITICAL] DB insert failed for verified payment ref: ${reference}. Error:`, dbError);
            return res.status(500).json({ ok: false, error: 'Your payment was successful, but we failed to save your order. Please contact support immediately.' });
        }

        // 5. Success Response
        res.status(201).json({ ok: true, message: 'Your order has been placed successfully!', order: savedOrder });

    } catch (err) {
        // Pass error to the centralized error handler
        next(err);
    }
});

// --- Centralized Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('[CRITICAL] Unhandled server error:', err);
    // Avoid leaking stack trace to the client in production
    res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

// --- Supabase Realtime Listener for Reservation Status Changes ---
function setupReservationStatusListener() {
    console.log('[Realtime] Setting up Supabase Realtime listener for reservations...');

    const channel = supabase
        .channel('reservation-status-changes')
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'reservations'
            },
            async (payload) => {
                console.log('[Realtime] Reservation update detected:', payload.new.id);

                try {
                    const oldStatus = payload.old?.status || null;
                    const newStatus = payload.new?.status || null;
                    const phoneNumber = payload.new?.phone || null;

                    // Only send SMS for specific status changes
                    const statusMessages = {
                        'confirmed': 'Your reservation has been confirmed. We look forward to serving you!',
                        'completed': 'Your reservation has been completed. Thank you for choosing us!',
                        'cancelled': 'Your reservation has been cancelled. If this was not you, please contact us.'
                    };

                    // Normalize status to lowercase for comparison
                    const normalizedNewStatus = newStatus?.toLowerCase()?.trim();
                    
                    // Skip if new status is not one we track
                    if (!normalizedNewStatus || !statusMessages[normalizedNewStatus]) {
                        console.log(`[Realtime] Status "${newStatus}" does not require SMS notification.`);
                        return;
                    }

                    // Only process if status actually changed (skip if unchanged)
                    // Note: oldStatus might be null if not provided by Supabase, which is acceptable
                    const normalizedOldStatus = oldStatus?.toLowerCase()?.trim();
                    if (normalizedOldStatus === normalizedNewStatus) {
                        console.log(`[Realtime] Status unchanged for reservation ${payload.new.id} (${normalizedNewStatus}), skipping SMS.`);
                        return;
                    }

                    // Validate phone number
                    if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
                        console.warn(`[Realtime] No valid phone number found for reservation ${payload.new.id}, cannot send SMS.`);
                        return;
                    }

                    // Send SMS notification
                    const message = statusMessages[normalizedNewStatus];
                    console.log(`[Realtime] Sending SMS to ${phoneNumber} for reservation ${payload.new.id} (status: ${newStatus} -> ${normalizedNewStatus})`);
                    
                    const smsResult = await sendHubtelSMS(phoneNumber, message);
                    
                    if (smsResult.success) {
                        console.log(`[Realtime] ✓ SMS sent successfully to ${phoneNumber} for reservation ${payload.new.id}`);
                    } else {
                        console.error(`[Realtime] ✗ Failed to send SMS to ${phoneNumber} for reservation ${payload.new.id}:`, smsResult.error);
                        // Note: We don't throw here to avoid crashing the server
                    }

                } catch (error) {
                    // Log error but don't crash the server
                    console.error(`[Realtime] Error processing reservation status change for reservation ${payload.new?.id}:`, error);
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[Realtime] ✓ Successfully subscribed to reservation status changes');
            } else if (status === 'CHANNEL_ERROR') {
                console.error('[Realtime] ✗ Error subscribing to reservation status changes');
            } else {
                console.log(`[Realtime] Subscription status: ${status}`);
            }
        });

    return channel;
}

// --- Server Start ---
app.listen(port, () => {
    // This log is helpful for confirming the server started in Render's logs.
    console.log(`Server listening on port ${port}`);
    
    // Setup Realtime listener after server starts
    if (supabaseUrl && supabaseServiceKey) {
        try {
            setupReservationStatusListener();
        } catch (error) {
            console.error('[Realtime] Failed to setup reservation status listener:', error);
            // Don't crash the server if Realtime setup fails
        }
    } else {
        console.warn('[Realtime] Supabase credentials not configured, skipping Realtime listener setup.');
    }
});