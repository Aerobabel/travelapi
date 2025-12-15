import { Router } from "express";
import Stripe from "stripe";

const router = Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
});

// In-memory store (for demo)
const bookings = [];

router.post("/bookings", async (req, res) => {
    try {
        const {
            type = "hotel",
            itemId,
            subId,
            price, // expected in DOLLARS (e.g. 150.00)
            currency = "usd",
            checkIn,
            checkOut,
            guests,
        } = req.body;

        if (!itemId || !price) {
            return res.status(400).json({ error: "Missing booking details" });
        }

        // Stripe expects amount in CENTS (smallest currency unit)
        const amount = Math.round(price * 100);

        if (amount < 50) {
            return res.status(400).json({ error: "Amount too small for Stripe" });
        }

        // Create PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: currency.toLowerCase(),
            // In a real app, you might add customer info or metadata here:
            metadata: { itemId, type, subId },
            automatic_payment_methods: {
                enabled: true,
            },
        });

        const bookingId = `bk_${Date.now().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 6)}`;

        // Note: In a production app, you would create the booking record with status 'pending'
        // and only mark 'confirmed' upon webhook 'payment_intent.succeeded'.
        // For this MVP, we create a 'pending' record and return the clientSecret to frontend.

        const newBooking = {
            id: bookingId,
            paymentIntentId: paymentIntent.id,
            status: "pending_payment",
            createdAt: new Date(),
            details: {
                type,
                itemId,
                subId,
                price,
                currency,
                checkIn,
                checkOut,
                guests,
            },
        };

        bookings.push(newBooking);

        // Return clientSecret to frontend so it can prompt for card
        res.json({
            success: true,
            clientSecret: paymentIntent.client_secret,
            booking: newBooking,
            message: "Payment initialized",
        });
    } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).json({ error: error.message || "Payment initialization failed." });
    }
});

router.get("/bookings", (req, res) => {
    res.json({ bookings });
});

export default router;
