// server/chat.routes.js
// Guaranteed triggers for dates/guests/plan in the same turn.
// npm i openai dotenv
// .env => OPENAI_API_KEY=sk-...

import { Router } from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const router = Router();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------- Tool declarations -------------------------- */
const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Call when you need the user's travel dates. Keep your text minimal; client shows a date picker.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Call when you need the number of travelers (adults/children). Client shows a guest picker.",
      parameters: {
        type: "object",
        properties: {
          minInfo: { type: "string", description: "Optional note, e.g. 'adults and children'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Call when destination + dates + guests known (or the user explicitly asks to build). Returns a lightweight plan card.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          dates: { type: "string" },
          description: { type: "string" },
          image: { type: "string" },
          price: { type: "string" },
        },
        required: ["location", "dates", "description", "image", "price"],
      },
    },
  },
];

/* -------------------------- System instructions ------------------------ */
const SYSTEM = `
You are a proactive, friendly travel planner.

UI RULES (non-negotiable):
- If you need DATES, call request_dates. Do NOT just ask in text.
- If you need GUESTS, call request_guests.
- When ready, call create_plan.

You may include one short friendly line along with a tool call ("Pick dates below 👇").
Never wait for "ok". Never ask for dates/guests without also calling the tool.
Keep replies crisp, warm, helpful.
`;

/* -------------------------------- Helpers ------------------------------ */
function toOpenAIMessages(history = []) {
  return history.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.text }
      : m.role === "system"
      ? { role: "system", content: m.text }
      : { role: "assistant", content: m.text }
  );
}

// very light slot detection as a server-side fallback (guarantees trigger)
function deriveSlots(history = []) {
  const allUserText = history
    .filter((m) => m.role === "user" && typeof m.text === "string")
    .map((m) => m.text)
    .join("\n")
    .toLowerCase();

  const datesKnown =
    /📅/.test(allUserText) ||
    /from\s+\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/i.test(allUserText);

  const guestsKnown =
    /👤/.test(allUserText) ||
    (/(adult|adults|children|kids|\bguests?\b|\bpeople\b)/i.test(allUserText) && /\d/.test(allUserText));

  const destinationKnown =
    /(barcelona|paris|rome|london|madrid|dubai|tokyo|new york|milan|istanbul|bali|amsterdam)/i.test(
      allUserText
    ) || /\b(to|in|for)\s+[A-Z][a-z]+/.test(allUserText);

  const location =
    (allUserText.match(
      /(barcelona|paris|rome|london|madrid|dubai|tokyo|new york|milan|istanbul|bali|amsterdam)/i
    ) || [])[0] || "Your Trip";

  return { datesKnown, guestsKnown, destinationKnown, location };
}

function looksLikeDateAsk(text = "") {
  const t = text.toLowerCase();
  return /(travel dates?|when.*(going|travel|trip)|what dates|select dates|pick dates)/i.test(t);
}
function looksLikeGuestAsk(text = "") {
  const t = text.toLowerCase();
  return /(how many (people|guests|travellers|travelers)|adults|children)/i.test(t);
}

/* -------------------------------- Route -------------------------------- */
router.post("/chat/travel", async (req, res) => {
  try {
    const { messages = [] } = req.body || {};
    const convo = [{ role: "system", content: SYSTEM }, ...toOpenAIMessages(messages)];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: convo,
      tools,
      tool_choice: "auto",
      temperature: 0.6,
    });

    let aiText = completion.choices?.[0]?.message?.content || "";
    let signal = null;

    // If the model called a tool — use that
    const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall) {
      const { name } = toolCall.function;
      let args = {};
      try {
        args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch {}
      if (name === "request_dates") {
        signal = { type: "dateNeeded" };
        if (!aiText) aiText = "Great — pick your travel dates below 👇";
      } else if (name === "request_guests") {
        signal = { type: "guestsNeeded", payload: args };
        if (!aiText) aiText = "Awesome — how many are traveling? 👇";
      } else if (name === "create_plan") {
        signal = { type: "planReady", payload: args };
        if (!aiText) aiText = "Here’s your plan ✨";
      }
    }

    // If no tool call, but the AI text *sounds like* it's asking for dates/guests, force it.
    if (!signal && looksLikeDateAsk(aiText)) {
      signal = { type: "dateNeeded" };
      aiText = aiText || "Pick your travel dates below 👇";
    }
    if (!signal && looksLikeGuestAsk(aiText)) {
      signal = { type: "guestsNeeded", payload: { minInfo: "adults and children" } };
      aiText = aiText || "How many travelers? 👇";
    }

    // HARD FALLBACK by slots
    if (!signal) {
      const slots = deriveSlots(messages);

      if (slots.destinationKnown && !slots.datesKnown) {
        signal = { type: "dateNeeded" };
        aiText = aiText || "Nice — pick your travel dates below 👇";
      } else if (slots.destinationKnown && slots.datesKnown && !slots.guestsKnown) {
        signal = { type: "guestsNeeded", payload: { minInfo: "adults and children" } };
        aiText = aiText || "Great — how many travelers? 👇";
      } else if (slots.destinationKnown && slots.datesKnown && slots.guestsKnown) {
        signal = {
          type: "planReady",
          payload: {
            location: capitalize(slots.location),
            dates: guessDatesFromHistory(messages) || "Your dates",
            description: "A balanced mix of icons, food spots, and local-only gems.",
            image: "https://images.unsplash.com/photo-1543342384-1bbd4b285d05?q=80&w=1600&auto=format&fit=crop",
            price: "$1,230.00",
          },
        };
        aiText = aiText || "Here’s a draft you can tweak ✨";
      } else {
        aiText = aiText || "Tell me where you’d like to go 🌍";
      }
    }

    return res.json({ aiText, signal });
  } catch (err) {
    console.error("chat_failed:", err);
    return res.status(500).json({ error: "chat_failed", message: err?.message || "Unknown error" });
  }
});

function guessDatesFromHistory(history) {
  const txt = history
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join(" ");
  const m = txt.match(/📅.*?(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (m) return `${m[1]} – ${m[2]}`;
  return null;
}

function capitalize(s = "") {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default router;
