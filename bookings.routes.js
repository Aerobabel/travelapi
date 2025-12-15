import { Router } from "express";

const router = Router();

// In-memory store for demo purposes (optional)
const bookings = [];

router.post("/bookings", async (req, res) => {
    try {
        const {
            type = "hotel",
            itemId,
            subId, // e.g. roomId or flightId
            price,
            currency = "USD",
            checkIn,
            checkOut,
            guests,
            paymentDetails, // mocked
        } = req.body;

        if (!itemId || !price) {
            return res.status(400).json({ error: "Missing booking details" });
        }

        // SIMULATE PAYMENT DELAY
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const bookingId = `bk_${Date.now().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 6)}`;

        const newBooking = {
            id: bookingId,
            status: "confirmed",
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

        res.json({
            success: true,
            booking: newBooking,
            message: "Booking confirmed successfully!",
        });
    } catch (error) {
        console.error("Booking error:", error);
        res.status(500).json({ error: "Booking failed payment processing." });
    }
});

router.get("/bookings", (req, res) => {
    res.json({ bookings });
});

export default router;
