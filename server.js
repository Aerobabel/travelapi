// server.js
import 'dotenv/config';   
import express from "express";
import cors from "cors";

// Your existing routers
import hotelsRouter from "./hotels.routes.js";
import transfersRouter from "./transfers.routes.js";
import chatRoutes from "./chat.routes.js";

// New: cruises router (mock, no DB)
import cruisesRouter from "./cruises.routes.js";

const app = express();

/* ----------------------------- Middleware ----------------------------- */

// CORS (wide-open by default; tighten via CORS_ORIGIN if you like)
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));

// JSON body parsing
app.use(express.json({ limit: "1mb" }));

// (Optional) trust proxy if deploying behind a proxy (Vercel/Render/etc.)
// app.set("trust proxy", true);

/* ------------------------------- Routes -------------------------------- */

// Mount all routers at root so paths remain:
// - /hotels/... (from hotels.routes.js)
// - /transfers/... (from transfers.routes.js)
// - /cruises/... (from cruises.routes.js)
app.use(hotelsRouter);
app.use(transfersRouter);
app.use(cruisesRouter);
app.use(chatRoutes);

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* --------------------------- Error Handling --------------------------- */

// 404 for unknown routes
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// Central error handler (keeps JSON shape consistent)
app.use((err, _req, res, _next) => {
  console.error("API Error:", err);
  const code = err.status || err.statusCode || 500;
  res.status(code).json({
    error: err.message || "Internal Server Error",
    code,
  });
});

/* -------------------------------- Start -------------------------------- */

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`Travel API running on http://localhost:${PORT}`);
});
