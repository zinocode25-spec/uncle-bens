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

// --- Configuration (Loaded from .env file) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; // Use the secure SERVICE KEY
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const port = process.env.PORT || 5000;

// --- Initialization ---
const app = express();
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// --- Middleware Configuration ---
// --- Middleware ---
app.use(helmet()); // Apply security headers first
app.use(cors({
    // As requested, open CORS for maximum flexibility during development and production.
    // This allows requests from your Netlify frontend, local machine, etc.
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
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

// --- Server Start ---
app.listen(port, () => {
    // This log is helpful for confirming the server started in Render's logs.
    console.log(`Server listening on port ${port}`);
});