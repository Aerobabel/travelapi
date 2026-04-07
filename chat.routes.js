// server/chat.routes.js
import Amadeus from "amadeus";
import dotenv from "dotenv";
import { Router } from "express";
import OpenAI from "openai";

dotenv.config();

// --- 0. GLOBAL SAFETY & FETCH POLYFILL --------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED PROMISE REJECTION]", reason);
});

let FETCH_SOURCE = "native";
try {
  if (typeof globalThis.fetch !== "function") {
    // ESM top-level await is allowed
    const nodeFetch = (await import("node-fetch")).default;
    globalThis.fetch = nodeFetch;
    FETCH_SOURCE = "node-fetch";
  }
} catch (e) {
  console.error("[chat] fetch polyfill error:", e?.message);
}

const router = Router();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Amadeus client
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.AMADEUS_HOSTNAME || 'production',
});

const SERPAPI_KEY = process.env.SERPAPI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const RATEHAWK_BASE_URL = (
  process.env.RATEHAWK_API_BASE_URL || "https://api.worldota.net/api/b2b/v3"
).replace(/\/+$/, "");
const RATEHAWK_KEY_ID = process.env.RATEHAWK_KEY_ID || "";
const RATEHAWK_API_KEY = process.env.RATEHAWK_API_KEY || "";
const RATEHAWK_KEY_TYPE = String(process.env.RATEHAWK_KEY_TYPE || "").trim().toLowerCase();
const RATEHAWK_TIMEOUT_MS = Number(process.env.RATEHAWK_TIMEOUT_MS || 4500);
const RATEHAWK_RESIDENCY_DEFAULT = String(process.env.RATEHAWK_RESIDENCY || "us")
  .trim()
  .toLowerCase();

const ZEN_PARTNER_SLUG = process.env.ZEN_PARTNER_SLUG || "285572.affiliate.37e8";
const ZEN_UTM_CAMPAIGN = process.env.ZEN_UTM_CAMPAIGN || "en-en, deeplink, affiliate";
const ZEN_UTM_MEDIUM = process.env.ZEN_UTM_MEDIUM || "api2";
const ZEN_UTM_SOURCE = process.env.ZEN_UTM_SOURCE || ZEN_PARTNER_SLUG;
const ZEN_UTM_TERM = process.env.ZEN_UTM_TERM || "None";
const ZEN_LANG = process.env.ZEN_LANG || "en";
const ZEN_CURRENCY = process.env.ZEN_CURRENCY || "USD";
const ZEN_PARTNER_EXTRA = process.env.ZEN_PARTNER_EXTRA || "None";
const ZEN_GUESTS_DEFAULT = process.env.ZEN_GUESTS_DEFAULT || "";

const newReqId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const logInfo = (id, ...args) => console.log(`[chat][${id}]`, ...args);
const logError = (id, ...args) => console.error(`[chat][${id}]`, ...args);

// --- 1. IN-MEMORY PROFILE/MEMORY -------------------------------------------
const userMem = new Map();
const imageCache = new Map();
const zenHotelPageCache = new Map();
const rateHawkHotelInfoCache = new Map();

function getMem(userId) {
  if (!userMem.has(userId)) {
    userMem.set(userId, {
      profile: {
        origin_city: null,
        nationality: null,

        preferred_travel_type: [],
        travel_alone_or_with: null,
        desired_experience: [],

        flight_preferences: {
          class: null,
        },
        flight_priority: [],

        // --- AFFILIATE: RateHawk/ZenHotels ---
        affiliate_id: "285572.affiliate.37e8", // Derived from user link

        accommodation: {
          preferred_type: null,
          prefer_view: null,
        },

        budget: {
          prefer_comfort_or_saving: "balanced",
        },
        guest_counts: {
          adults: null,
          children: 0,
        },

        preferred_formats: [],
        liked_activities: [],
        multi_cities: [],
      },
      lastFlights: [],
      lastHotels: [],
      lastActivities: [],
      lastRestaurants: [],
      lastHotelSearch: null,
      lastActivitySearch: null,
    });
  }
  return userMem.get(userId);
}

// --- 2. HELPERS -------------------------------------------------------------

/** Strip markdown formatting from AI text so the mobile app gets clean plain text. */
const stripMarkdown = (text) => {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")   // ***bold italic***
    .replace(/\*\*(.*?)\*\*/g, "$1")        // **bold**
    .replace(/\*(.*?)\*/g, "$1")            // *italic*
    .replace(/^#{1,4}\s+/gm, "")            // ### headers
    .replace(/^[-*]\s+/gm, "• ")            // - bullets → •
    .replace(/^---+$/gm, "")                // --- horizontal rules
    .replace(/`([^`]+)`/g, "$1")            // `inline code`
    .replace(/\n{3,}/g, "\n\n")             // collapse triple+ newlines
    .trim();
};

const getCode = (label) => {
  if (!label) return null;
  const s = String(label).trim();
  const m = /\(([A-Za-z]{3})\)/.exec(s);
  if (m) return m[1].toUpperCase();
  const parts = s.split(',').map(t => t.trim());
  const last = parts[parts.length - 1] || s;
  if (/^[A-Za-z]{3}$/i.test(last)) return last.toUpperCase();
  if (/^[A-Za-z]{3}$/i.test(s)) return s.toUpperCase();
  return null;
};

const normalizeOffer = (fo, dictionaries = {}) => {
  const priceObj = fo?.price || {};
  const price = Number(priceObj.grandTotal || priceObj.total || 0);

  const it = fo?.itineraries?.[0];
  const segs = it?.segments || [];
  // Outbound
  const seg0 = segs[0];
  const segLast = segs[segs.length - 1];

  // Return Leg?
  const retIt = fo?.itineraries?.[1];
  const retSegs = retIt?.segments || [];
  const retSeg0 = retSegs[0];
  const retSegLast = retSegs[retSegs.length - 1];

  const departISO = seg0?.departure?.at || '';
  const arriveISO = segLast?.arrival?.at || '';
  const intlDate = new Date(departISO);
  const departDate = departISO ? departISO.slice(0, 10) : '';

  const depart = departISO.slice(11, 16);
  const arrive = arriveISO.slice(11, 16);

  const carrierCode = seg0?.carrierCode || fo?.validatingAirlineCodes?.[0] || '';
  const carrierName = dictionaries?.carriers?.[carrierCode]
    ? dictionaries.carriers[carrierCode].replace(/\bAIRLINES\b/i, '').trim() // Clean "TURKISH AIRLINES" -> "TURKISH" for better matching? No keep full name.
    : carrierCode;

  const carrier = dictionaries?.carriers?.[carrierCode] || carrierCode;
  const flNum = seg0?.number || '';
  const flightNumber = (carrierCode && flNum) ? `${carrierCode}${flNum}` : '';

  const isoDuration = it?.duration || '';
  const duration = isoDuration.replace('PT', '').toLowerCase();

  const stops = Math.max(0, segs.length - 1);

  let layover = '';
  if (segs.length > 1) {
    try {
      const arr1 = new Date(segs[0].arrival.at);
      const dep2 = new Date(segs[1].departure.at);
      const diffMs = dep2 - arr1;
      if (diffMs > 0) {
        const hours = Math.floor(diffMs / 3600000);
        const mins = Math.round((diffMs % 3600000) / 60000);
        const durStr = `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
        const stopCode = segs[0].arrival.iataCode;
        layover = `${durStr} ${stopCode}`;
      }
    } catch (e) {
      // ignore date parse errors
    }

  }

  // Calculate Return Layover
  let retLayover = '';
  if (retSegs.length > 1) {
    try {
      const arr1 = new Date(retSegs[0].arrival.at);
      const dep2 = new Date(retSegs[1].departure.at);
      const diffMs = dep2 - arr1;
      if (diffMs > 0) {
        const hours = Math.floor(diffMs / 3600000);
        const mins = Math.round((diffMs % 3600000) / 60000);
        const durStr = `${hours}h${mins > 0 ? ` ${mins}m` : ''}`;
        const stopCode = retSegs[0].arrival.iataCode;
        retLayover = `${durStr} ${stopCode}`;
      }
    } catch (e) { }
  }

  return {
    price,
    airline: carrier,
    flightNumber,
    duration,
    stops,
    layover,
    departDate,
    origin: seg0?.departure?.iataCode,
    destination: segLast?.arrival?.iataCode,
    booking_url: `https://www.skyscanner.com/transport/flights/${seg0?.departure?.iataCode}/${segLast?.arrival?.iataCode}/${departDate.slice(2, 10).replace(/-/g, '')}`,

    // RETURN LEG DATA
    returnDepart: retSeg0 ? retSeg0.departure.at.slice(11, 16) : null,
    returnArrive: retSegLast ? retSegLast.arrival.at.slice(11, 16) : null,
    returnDuration: retIt ? retIt.duration.replace('PT', '').toLowerCase() : null,
    returnStops: retIt ? Math.max(0, retIt.segments.length - 1) : 0,
    returnDate: retSeg0 ? retSeg0.departure.at.slice(0, 10) : null,
    returnLayover: retLayover,
    isRoundTrip: !!retIt
  };
};

const FALLBACK_IMAGE_URL =
  "https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?auto=format&fit=crop&q=80";

async function pickPhoto(dest, reqId) {
  const key = (dest || "").toLowerCase().trim();
  if (imageCache.has(key)) return imageCache.get(key);
  if (!UNSPLASH_ACCESS_KEY) return FALLBACK_IMAGE_URL;

  const query = encodeURIComponent(`${dest} travel tourist landmark`);
  const url = `https://api.unsplash.com/search/photos?query=${query}&per_page=1&orientation=landscape`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) return FALLBACK_IMAGE_URL;
    const data = await res.json();
    const img = data?.results?.[0]?.urls?.regular || FALLBACK_IMAGE_URL;
    imageCache.set(key, img);
    return img;
  } catch (e) {
    logError(reqId, "Unsplash error:", e);
    return FALLBACK_IMAGE_URL;
  }
}

const extractMultiCities = (text = "") => {
  const parts = text
    .split(/to|->|→|,|then|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  return parts.length > 1 ? parts : [];
};

function updateProfileFromHistory(messages, mem) {
  const lastUser = messages.filter((m) => m.role === "user").pop();
  if (!lastUser) return;

  let text = "";
  if (typeof lastUser.content === "string") {
    text = lastUser.content;
  } else if (Array.isArray(lastUser.content)) {
    const t = lastUser.content.find((c) => c.type === "text");
    if (t) text = t.text || "";
  } else if (lastUser.text) {
    text = lastUser.text;
  }

  text = String(text || "");
  const lower = text.toLowerCase();
  const profile = mem.profile;

  const fromMatch = lower.match(/from\s+([a-z\s]+)/i);
  if (fromMatch?.[1]) profile.origin_city = fromMatch[1].trim();

  const natMatch = lower.match(/i am from\s+([a-z\s]+)/i);
  if (natMatch?.[1]) profile.nationality = natMatch[1].trim();

  ["beach", "active", "urban", "relaxing"].forEach((t) => {
    if (lower.includes(t) && !profile.preferred_travel_type.includes(t))
      profile.preferred_travel_type.push(t);
  });
  ["solo", "family", "friends"].forEach((t) => {
    if (lower.includes(t)) profile.travel_alone_or_with = t;
  });
  ["fun", "relaxation", "photography", "luxury", "local culture"].forEach(
    (t) => {
      if (lower.includes(t) && !profile.desired_experience.includes(t))
        profile.desired_experience.push(t);
    }
  );
  ["economy", "premium economy", "business", "first"].forEach((cls) => {
    if (lower.includes(cls)) profile.flight_preferences.class = cls;
  });
  ["price", "comfort", "duration"].forEach((p) => {
    if (lower.includes(p) && !profile.flight_priority.includes(p))
      profile.flight_priority.push(p);
  });
  ["hotel", "apartment", "villa", "hostel"].forEach((t) => {
    if (lower.includes(t)) profile.accommodation.preferred_type = t;
  });
  ["sea", "mountains", "city"].forEach((v) => {
    if (lower.includes(v)) profile.accommodation.prefer_view = v;
  });
  ["comfort", "saving", "balanced", "budget"].forEach((b) => {
    if (lower.includes(b)) profile.budget.prefer_comfort_or_saving = b;
  });
  if (lower.includes("cheap") || lower.includes("affordable")) {
    profile.budget.prefer_comfort_or_saving = "saving";
  }
  const guestsMatch =
    text.match(/guests:\s*(\d+)\s*adult(?:\(s\))?\s*,\s*(\d+)\s*child(?:\(ren\))?/i) ||
    text.match(/there will be\s*(\d+)\s*adult(?:\(s\))?\s*and\s*(\d+)\s*child(?:\(ren\))?/i) ||
    text.match(/(\d+)\s*adult(?:\(s\))?(?:\s*(?:,|and)\s*(\d+)\s*child(?:\(ren\))?)?/i);
  if (guestsMatch?.[1]) {
    const adults = Number(guestsMatch[1]);
    const children = Number(guestsMatch[2] || 0);
    if (Number.isFinite(adults) && adults > 0) {
      profile.guest_counts = {
        adults: Math.floor(adults),
        children: Number.isFinite(children) && children > 0 ? Math.floor(children) : 0,
      };
    }
  } else if (profile.travel_alone_or_with === "solo") {
    profile.guest_counts = { adults: 1, children: 0 };
  }

  const cities = extractMultiCities(text);
  if (cities.length > 1) profile.multi_cities = cities;
}

function formatDateToMMMDD(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  return `${month} ${day}`;
}

// Simple weather filler so frontend always has something to show
function ensureWeather(plan) {
  if (!plan.weather || typeof plan.weather !== "object") {
    plan.weather = { temp: 24, icon: "☀️" };
    return;
  }
  if (typeof plan.weather.temp !== "number") {
    plan.weather.temp = 24;
  }
  if (!plan.weather.icon || typeof plan.weather.icon !== "string" || plan.weather.icon.length < 3) {
    plan.weather.icon = "partly-sunny";
  }
}

// --- 2.1 AFFILIATE HELPERS ------------------------------------------------
const sanitizeText = (val) => String(val || "").trim();
const ACTIVITY_PROVIDER_HOSTS = [
  "getyourguide.com",
  "viator.com",
  "headout.com",
  "tiqets.com",
  "klook.com",
];
const LOOKUP_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "their",
  "tour",
  "tours",
  "activity",
  "activities",
  "ticket",
  "tickets",
  "experience",
  "experiences",
  "things",
  "must",
  "best",
  "book",
]);

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLookupText(value = "") {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[_/]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLookupText(value = "") {
  return normalizeLookupText(value)
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !LOOKUP_STOPWORDS.has(part));
}

function prettifyProviderSlug(slug = "") {
  const cleaned = sanitizeText(slug);
  if (!cleaned) return "";
  return cleaned
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerFromUrl(rawUrl = "") {
  const candidate = sanitizeText(rawUrl);
  if (!candidate) return "";
  try {
    const host = new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
    if (host.includes("getyourguide")) return "GetYourGuide";
    if (host.includes("viator")) return "Viator";
    if (host.includes("headout")) return "Headout";
    if (host.includes("tiqets")) return "Tiqets";
    if (host.includes("klook")) return "Klook";
    const parts = host.split(".");
    const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return prettifyProviderSlug(slug);
  } catch (e) {
    return "";
  }
}

function isKnownActivityProviderName(value = "") {
  const lower = sanitizeText(value).toLowerCase();
  return ["getyourguide", "viator", "headout", "tiqets", "klook"].some((name) =>
    lower.includes(name)
  );
}

function stripActivitySiteSuffix(title = "", provider = "") {
  let cleaned = sanitizeText(title);
  if (!cleaned) return "";

  const providerPattern = sanitizeText(provider)
    ? new RegExp(
      `\\s*(?:\\||-|–|—|•)\\s*${escapeRegExp(sanitizeText(provider))}(?:\\s+.*)?$`,
      "i"
    )
    : null;

  if (providerPattern) cleaned = cleaned.replace(providerPattern, "").trim();
  cleaned = cleaned
    .replace(/\s*(?:\||-|–|—|•)\s*(GetYourGuide|Viator|Headout|Tiqets|Klook)(?:\s+.*)?$/i, "")
    .trim();

  return cleaned;
}

function isGenericProviderHomepage(rawUrl = "") {
  const candidate = sanitizeText(rawUrl);
  if (!candidate) return true;

  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const segments = (parsed.pathname || "/").split("/").filter(Boolean);

    if (host.includes("getyourguide")) {
      return (
        segments.length === 0 ||
        (segments.length === 1 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]))
      );
    }

    if (
      host.includes("viator") ||
      host.includes("headout") ||
      host.includes("tiqets") ||
      host.includes("klook")
    ) {
      return segments.length === 0;
    }

    return false;
  } catch (e) {
    return false;
  }
}

function parseActivitiesSearchQuery(rawQuery = "") {
  const cleaned = sanitizeText(String(rawQuery || "").replace("__activities__", ""));
  if (!cleaned) {
    return { location: "", intent: "", specific: false, raw: "" };
  }

  const parts = cleaned
    .split(/\s*(?:\||::|>>)\s*/)
    .map((part) => sanitizeText(part))
    .filter(Boolean);
  if (parts.length >= 2) {
    return {
      location: parts[0],
      intent: parts.slice(1).join(" "),
      specific: true,
      raw: cleaned,
    };
  }

  const naturalMatch = /^(?<intent>.+?)\s+(?:in|at|near)\s+(?<location>[a-z0-9][a-z0-9\s,'-]{1,})$/i.exec(
    cleaned
  );
  if (naturalMatch?.groups?.intent && naturalMatch?.groups?.location) {
    return {
      location: sanitizeText(naturalMatch.groups.location),
      intent: sanitizeText(naturalMatch.groups.intent),
      specific: true,
      raw: cleaned,
    };
  }

  return { location: cleaned, intent: "", specific: false, raw: cleaned };
}

async function fetchSerpJson(params = {}, reqId = "") {
  const url = `https://serpapi.com/search.json?${new URLSearchParams({
    api_key: SERPAPI_KEY,
    ...params,
  }).toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    logError(reqId || "n/a", `[SerpAPI ${res.status}]`, raw.slice(0, 200));
    throw new Error(`SerpAPI request failed with status ${res.status}`);
  }
  return await res.json();
}

function dedupeActivityResults(results = []) {
  const seen = new Set();
  const out = [];

  for (const entry of Array.isArray(results) ? results : []) {
    if (!entry) continue;
    const provider = sanitizeText(entry.provider);
    const title = stripActivitySiteSuffix(entry.title, provider);
    const key = normalizeLookupText(`${title} ${provider}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, title });
  }

  return out;
}

function pickActivityFromMemory(activityLikeText = "", activities = []) {
  if (!Array.isArray(activities) || activities.length === 0) return null;

  const candidate = sanitizeText(activityLikeText);
  const candidateNorm = normalizeLookupText(candidate);
  const candidateTokens = new Set(tokenizeLookupText(candidate));
  if (!candidateNorm && candidateTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const activity of activities) {
    const title = stripActivitySiteSuffix(activity?.title || "", activity?.provider || "");
    const activityText = [title, activity?.description, activity?.provider, activity?.type]
      .filter(Boolean)
      .join(" ");
    const titleNorm = normalizeLookupText(title);
    const activityTokens = new Set(tokenizeLookupText(activityText));
    if (!titleNorm && activityTokens.size === 0) continue;

    let score = 0;
    if (titleNorm && candidateNorm && (candidateNorm.includes(titleNorm) || titleNorm.includes(candidateNorm))) {
      score += 8;
    }

    let overlap = 0;
    for (const token of candidateTokens) {
      if (activityTokens.has(token)) overlap += 1;
    }
    score += overlap;

    if (activity?.booking_url && !isGenericProviderHomepage(activity.booking_url)) score += 0.5;
    if (activity?.source === "organic") score += 0.5;

    if (score > bestScore) {
      best = { ...activity, title };
      bestScore = score;
    }
  }

  return bestScore >= 2 ? best : null;
}

function formatZenDate(input) {
  const raw = sanitizeText(input);
  if (!raw) return null;

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatZenDateRange(checkIn, checkOut) {
  const start = formatZenDate(checkIn);
  const end = formatZenDate(checkOut);
  if (!start || !end) return null;
  return `${start}-${end}`;
}

function normalizeZenGuests(guests = "") {
  const g = sanitizeText(guests);
  if (!g) return null;
  // Keep official format: "2", "2-2", "2and9", "2and9.12-2"
  if (/^\d+(and\d+(?:\.\d+)*)?(?:-\d+(and\d+(?:\.\d+)*)?)*$/.test(g)) return g;
  const numeric = Number(g);
  if (Number.isFinite(numeric) && numeric > 0) return String(Math.floor(numeric));
  return null;
}

function deriveZenGuestsFromProfile(profile = {}, explicitGuests = null) {
  const explicit = sanitizeText(explicitGuests);
  if (explicit) return normalizeZenGuests(explicit);

  const adults = Number(profile?.guest_counts?.adults);
  if (Number.isFinite(adults) && adults > 0) return String(Math.floor(adults));

  const travelMode = sanitizeText(profile?.travel_alone_or_with).toLowerCase();
  if (travelMode === "solo") return "1";

  return null;
}

function deriveZenGuestsForHotelSearch(args = {}, profile = {}) {
  const guests = sanitizeText(args?.guests);
  if (guests) return normalizeZenGuests(guests);

  const adults = Number(args?.adults);
  if (Number.isFinite(adults) && adults > 0) {
    return String(Math.floor(adults));
  }

  return deriveZenGuestsFromProfile(profile);
}

function buildZenParams({ checkIn, checkOut, guests, lang, cur, partnerExtra }) {
  const params = new URLSearchParams({
    cur: cur || ZEN_CURRENCY,
    lang: lang || ZEN_LANG,
    partner_slug: ZEN_PARTNER_SLUG,
    utm_campaign: ZEN_UTM_CAMPAIGN,
    utm_medium: ZEN_UTM_MEDIUM,
    utm_source: ZEN_UTM_SOURCE,
    utm_term: ZEN_UTM_TERM,
    partner_extra: sanitizeText(partnerExtra) || ZEN_PARTNER_EXTRA,
  });
  const normalizedGuests = normalizeZenGuests(guests);
  if (normalizedGuests) params.set("guests", normalizedGuests);
  const dates = formatZenDateRange(checkIn, checkOut);
  if (dates) params.set("dates", dates);
  return params;
}

function getRateHawkAuthHeaders() {
  const mode = RATEHAWK_KEY_TYPE;

  if (mode === "basic") {
    if (!RATEHAWK_KEY_ID || !RATEHAWK_API_KEY) return null;
    const token = Buffer.from(`${RATEHAWK_KEY_ID}:${RATEHAWK_API_KEY}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  if (mode === "x-api-key" || mode === "x_api_key" || mode === "api_key") {
    if (!RATEHAWK_API_KEY) return null;
    return { "X-API-KEY": RATEHAWK_API_KEY };
  }

  if (mode === "bearer") {
    if (!RATEHAWK_API_KEY) return null;
    return { Authorization: `Bearer ${RATEHAWK_API_KEY}` };
  }

  // Auto-detect if key type is not explicitly set.
  if (RATEHAWK_KEY_ID && RATEHAWK_API_KEY) {
    const token = Buffer.from(`${RATEHAWK_KEY_ID}:${RATEHAWK_API_KEY}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (RATEHAWK_API_KEY) return { "X-API-KEY": RATEHAWK_API_KEY };
  return null;
}

async function fetchRateHawkMulticomplete(query, reqId) {
  const authHeaders = getRateHawkAuthHeaders();
  const q = sanitizeText(query);
  if (!authHeaders || !q) return null;

  const url = `${RATEHAWK_BASE_URL}/search/multicomplete/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATEHAWK_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        query: q,
        language: ZEN_LANG,
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const raw = await r.text().catch(() => "");
      logError(reqId || "n/a", `[RateHawk multicomplete ${r.status}]`, raw.slice(0, 200));
      return null;
    }
    return await r.json();
  } catch (e) {
    logError(reqId || "n/a", "RateHawk multicomplete failed", e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildHotelNameHintsFromMulticomplete(payload = {}) {
  const hotels =
    payload?.hotels ||
    payload?.result?.hotels ||
    payload?.data?.hotels ||
    [];
  const map = new Map();
  if (!Array.isArray(hotels)) return map;
  for (const h of hotels) {
    const name = sanitizeText(
      h?.name || h?.hotel_name || h?.hotelName || h?.title || ""
    );
    if (!name) continue;
    const hid = h?.hid || h?.hotel_id || h?.hotelId || null;
    const id = h?.id || null;
    if (hid !== null && hid !== undefined) map.set(String(hid), name);
    if (id !== null && id !== undefined) map.set(String(id), name);
  }
  return map;
}

function deriveRateHawkResidency(profile = {}) {
  const raw = sanitizeText(profile?.nationality).toLowerCase();
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return RATEHAWK_RESIDENCY_DEFAULT || "us";
}

function buildRateHawkGuestsPayload(zenGuests = null) {
  const normalized = normalizeZenGuests(zenGuests);
  if (!normalized) {
    return [{ adults: 1, children: [] }];
  }

  const rooms = normalized
    .split("-")
    .map((segment) => {
      const s = sanitizeText(segment);
      if (!s) return null;
      const m = /^(\d+)(?:and(\d+(?:\.\d+)*))?$/.exec(s);
      if (!m) return null;
      const adults = Math.max(1, Math.floor(Number(m[1]) || 1));
      const children = (m[2] || "")
        .split(".")
        .map((age) => Math.floor(Number(age)))
        .filter((age) => Number.isFinite(age) && age >= 0 && age <= 17);
      return { adults, children };
    })
    .filter(Boolean);

  return rooms.length > 0 ? rooms : [{ adults: 1, children: [] }];
}

function toDisplayHotelName(value = "") {
  const raw = sanitizeText(value);
  if (!raw) return "Hotel";
  if (raw.includes("_")) {
    return raw
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return raw;
}

function extractRateTotalFromRate(rate = {}) {
  const paymentTypes = Array.isArray(rate?.payment_options?.payment_types)
    ? rate.payment_options.payment_types
    : [];
  let best = Number.POSITIVE_INFINITY;

  for (const pt of paymentTypes) {
    const n = Number(
      pt?.show_amount ??
      pt?.showPrice ??
      pt?.amount ??
      pt?.price ??
      0
    );
    if (Number.isFinite(n) && n > 0 && n < best) best = n;
  }
  if (Number.isFinite(best) && best > 0) return best;

  const daily = Array.isArray(rate?.daily_prices)
    ? rate.daily_prices.reduce((sum, x) => sum + (Number(x) || 0), 0)
    : 0;
  return Number.isFinite(daily) && daily > 0 ? daily : 0;
}

function extractRateHawkSerpHotels(payload = {}, nameHints = new Map()) {
  const hotels =
    payload?.hotels ||
    payload?.result?.hotels ||
    payload?.data?.hotels ||
    [];
  if (!Array.isArray(hotels)) return [];

  const rows = [];
  for (const h of hotels) {
    const rates = Array.isArray(h?.rates) ? h.rates : [];
    let bestRate = null;
    let bestTotal = Number.POSITIVE_INFINITY;
    for (const r of rates) {
      const total = extractRateTotalFromRate(r);
      if (!Number.isFinite(total) || total <= 0) continue;
      if (total < bestTotal) {
        bestRate = r;
        bestTotal = total;
      }
    }
    if (!bestRate || !Number.isFinite(bestTotal) || bestTotal <= 0) continue;

    const hid = h?.hid || h?.hotel_id || h?.hotelId || null;
    const legacyId = h?.id ? String(h.id) : null;
    const hintName =
      (hid !== null && hid !== undefined && nameHints.get(String(hid))) ||
      (legacyId && nameHints.get(legacyId)) ||
      null;
    const fallbackName =
      hintName ||
      sanitizeText(h?.name || h?.hotel_name || h?.hotelName || "") ||
      toDisplayHotelName(legacyId || "");
    const quality = Number(
      bestRate?.rg_ext?.class || bestRate?.rg_ext?.quality || 0
    );

    rows.push({
      hotelId: hid !== null && hid !== undefined ? String(hid) : (legacyId || fallbackName),
      hid: hid !== null && hid !== undefined ? String(hid) : null,
      legacyId,
      name: fallbackName || "Hotel",
      rating: Number.isFinite(quality) ? quality : 0,
      total: Number(bestTotal) || 0,
      regionId:
        h?.region_id !== undefined && h?.region_id !== null
          ? String(h.region_id)
          : null,
      matchHash: sanitizeText(bestRate?.match_hash || ""),
      searchHash: sanitizeText(bestRate?.search_hash || ""),
    });
  }
  return rows;
}

async function resolveZenRegionForCity(city, reqId) {
  const payload = await fetchRateHawkMulticomplete(city, reqId);
  if (!payload) return { regionId: null, regionName: null, payload: null };

  const regions =
    payload?.regions ||
    payload?.result?.regions ||
    payload?.data?.regions ||
    [];
  const cityRaw = sanitizeText(city);
  if (Array.isArray(regions) && regions.length > 0) {
    const scored = regions
      .map((r) => ({
        id: r?.id || r?.region_id || r?.regionId || null,
        name: sanitizeText(r?.name || r?.title || r?.label || ""),
        score: scoreHotelNameMatch(cityRaw, r?.name || r?.title || r?.label || ""),
      }))
      .filter((r) => r.id !== null && r.id !== undefined)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best) {
      return {
        regionId: String(best.id),
        regionName: best.name || cityRaw,
        payload,
      };
    }
  }

  const hotels =
    payload?.hotels ||
    payload?.result?.hotels ||
    payload?.data?.hotels ||
    [];
  if (Array.isArray(hotels)) {
    const first = hotels.find((h) => h?.region_id || h?.regionId || h?.region?.id);
    const regionId = first?.region_id || first?.regionId || first?.region?.id || null;
    if (regionId) {
      return {
        regionId: String(regionId),
        regionName: cityRaw,
        payload,
      };
    }
  }

  return { regionId: null, regionName: null, payload };
}

async function fetchRateHawkSerpRegion({
  regionId,
  checkIn,
  checkOut,
  guests,
  residency,
  currency = ZEN_CURRENCY,
  lang = ZEN_LANG,
  hotelsLimit = 60,
  reqId = null,
} = {}) {
  const authHeaders = getRateHawkAuthHeaders();
  if (!authHeaders || !regionId) return null;

  const url = `${RATEHAWK_BASE_URL}/search/serp/region/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATEHAWK_TIMEOUT_MS);

  try {
    const body = {
      region_id: Number(regionId) || String(regionId),
      checkin: sanitizeText(checkIn),
      checkout: sanitizeText(checkOut),
      residency: sanitizeText(residency || RATEHAWK_RESIDENCY_DEFAULT || "us"),
      language: sanitizeText(lang || ZEN_LANG || "en"),
      currency: sanitizeText(currency || ZEN_CURRENCY || "USD"),
      guests: buildRateHawkGuestsPayload(guests),
      hotels_limit: Math.max(10, Number(hotelsLimit) || 60),
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const raw = await r.text().catch(() => "");
      logError(reqId || "n/a", `[RateHawk serp/region ${r.status}]`, raw.slice(0, 300));
      return null;
    }
    return await r.json();
  } catch (e) {
    logError(reqId || "n/a", "RateHawk serp/region failed", e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRateHawkHotelInfo({ hid = null, id = null, reqId = null } = {}) {
  const cacheKey = hid ? `hid:${hid}` : id ? `id:${id}` : null;
  if (!cacheKey) return null;
  if (rateHawkHotelInfoCache.has(cacheKey)) return rateHawkHotelInfoCache.get(cacheKey);

  const authHeaders = getRateHawkAuthHeaders();
  if (!authHeaders) return null;

  const url = `${RATEHAWK_BASE_URL}/hotel/info/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATEHAWK_TIMEOUT_MS);

  try {
    const body = {
      language: ZEN_LANG,
    };
    if (hid !== null && hid !== undefined) body.hid = Number(hid) || String(hid);
    else if (id) body.id = String(id);

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!r.ok) {
      const raw = await r.text().catch(() => "");
      logError(reqId || "n/a", `[RateHawk hotel/info ${r.status}]`, raw.slice(0, 200));
      return null;
    }
    const payload = await r.json();
    const info = payload?.data || payload?.result || payload || null;
    if (info) rateHawkHotelInfoCache.set(cacheKey, info);
    return info;
  } catch (e) {
    logError(reqId || "n/a", "RateHawk hotel/info failed", e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHotelName(value = "") {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreHotelNameMatch(expectedName = "", candidateName = "") {
  const expected = normalizeHotelName(expectedName);
  const candidate = normalizeHotelName(candidateName);
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 1;
  if (expected.includes(candidate) || candidate.includes(expected)) {
    const minLen = Math.min(expected.length, candidate.length);
    const maxLen = Math.max(expected.length, candidate.length) || 1;
    return 0.7 + (minLen / maxLen) * 0.2;
  }

  const expectedTokens = new Set(expected.split(" ").filter(Boolean));
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (!expectedTokens.size || !candidateTokens.size) return 0;

  let overlap = 0;
  for (const token of expectedTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(expectedTokens.size, candidateTokens.size);
}

function pickHotelFromMemory(hotelLikeText = "", hotels = []) {
  const list = Array.isArray(hotels) ? hotels : [];
  if (list.length === 0) return null;

  const target = sanitizeText(hotelLikeText);
  if (!target) return list[0] || null;

  const ranked = list
    .map((h) => ({
      ...h,
      score: scoreHotelNameMatch(target, h?.name || ""),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best && best.score >= 0.55) return best;
  return null;
}

function extractZenIds(payload = {}, expectedHotelName = "") {
  const hotels =
    payload?.hotels ||
    payload?.result?.hotels ||
    payload?.data?.hotels ||
    [];
  const regions =
    payload?.regions ||
    payload?.result?.regions ||
    payload?.data?.regions ||
    [];

  const hotelCandidates = Array.isArray(hotels)
    ? hotels
      .map((hotel) => {
        const hotelId =
          hotel?.id ||
          hotel?.hotel_id ||
          hotel?.hotelId ||
          hotel?.hid ||
          null;
        const regionId =
          hotel?.region_id ||
          hotel?.regionId ||
          hotel?.region?.id ||
          null;
        const name =
          hotel?.name ||
          hotel?.hotel_name ||
          hotel?.hotelName ||
          hotel?.title ||
          hotel?.full_name ||
          hotel?.label ||
          "";
        return {
          hotelId: hotelId ? String(hotelId) : null,
          regionId: regionId ? String(regionId) : null,
          hotelUrl:
            hotel?.url ||
            hotel?.hotel_url ||
            hotel?.deeplink ||
            hotel?.link ||
            hotel?.seo_url ||
            hotel?.search_url ||
            null,
          name,
        };
      })
      .filter((c) => c.hotelId || c.regionId || c.hotelUrl)
    : [];

  const firstRegion = Array.isArray(regions) ? regions[0] : null;
  const firstRegionId =
    firstRegion?.id ||
    firstRegion?.region_id ||
    firstRegion?.regionId ||
    null;

  const matchTarget = sanitizeText(expectedHotelName);
  if (matchTarget && hotelCandidates.length > 0) {
    const ranked = hotelCandidates
      .map((c) => ({
        ...c,
        score: scoreHotelNameMatch(matchTarget, c.name),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.score >= 0.55) {
      return {
        hotelId: best.hotelId,
        regionId: best.regionId,
        hotelUrl: best.hotelUrl || null,
      };
    }
    // If the hotel-name match is weak, avoid linking to a wrong property.
    return {
      hotelId: null,
      regionId: best?.regionId || (firstRegionId ? String(firstRegionId) : null),
      hotelUrl: null,
    };
  }

  const firstHotel = hotelCandidates[0] || null;

  const hotelId = firstHotel?.hotelId || null;

  const regionId =
    firstHotel?.regionId ||
    firstRegionId ||
    null;

  return {
    hotelId: hotelId ? String(hotelId) : null,
    regionId: regionId ? String(regionId) : null,
    hotelUrl: firstHotel?.hotelUrl || null,
  };
}

async function resolveZenIds({ hotelName = "", city = "", reqId } = {}) {
  const tries = [];
  const name = sanitizeText(hotelName);
  const place = sanitizeText(city);
  if (name && place) tries.push(`${name} ${place}`);
  if (name) tries.push(name);
  if (place) tries.push(place);

  for (const q of tries) {
    const payload = await fetchRateHawkMulticomplete(q, reqId);
    if (!payload) continue;
    const ids = extractZenIds(payload, name);
    if (ids.hotelId || ids.regionId || ids.hotelUrl) return ids;
  }
  return { hotelId: null, regionId: null, hotelUrl: null };
}

function buildZenSerpUrl(regionId, params) {
  const p = new URLSearchParams(params.toString());
  p.set("q", String(regionId));
  return `https://www.zenhotels.com/hotels/?${p.toString()}`;
}

function buildZenSearchUrl(query, params) {
  const p = new URLSearchParams(params.toString());
  const q = sanitizeText(query);
  if (q) p.set("q", q);
  return `https://www.zenhotels.com/hotels/?${p.toString()}`;
}

function normalizeZenHotelPageUrl(raw = "") {
  const candidate = sanitizeText(raw);
  if (!candidate) return null;
  const withHost = candidate.startsWith("http")
    ? candidate
    : `https://www.zenhotels.com${candidate.startsWith("/") ? "" : "/"}${candidate}`;
  try {
    const u = new URL(withHost);
    const host = (u.hostname || "").replace(/^www\./, "").toLowerCase();
    if (host !== "zenhotels.com") return null;
    if (!/^\/hotel\//i.test(u.pathname || "")) return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function appendQueryParams(url, params) {
  try {
    const u = new URL(url);
    const existing = new URLSearchParams(u.search || "");
    for (const [k, v] of params.entries()) {
      if (!existing.has(k)) existing.set(k, v);
    }
    u.search = existing.toString();
    return u.toString();
  } catch {
    return url;
  }
}

async function resolveZenHotelPageViaSerp({ hotelName = "", city = "", reqId = null } = {}) {
  if (!SERPAPI_KEY) return null;
  const name = sanitizeText(hotelName);
  if (!name) return null;

  const place = sanitizeText(city);
  const cacheKey = `${name.toLowerCase()}|${place.toLowerCase()}`;
  if (zenHotelPageCache.has(cacheKey)) return zenHotelPageCache.get(cacheKey);

  const query = `site:zenhotels.com/hotel "${name}" ${place}`.trim();
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&num=6`;

  try {
    const data = await fetch(url).then((r) => r.json());
    const links = (data?.organic_results || [])
      .map((r) => normalizeZenHotelPageUrl(r?.link))
      .filter(Boolean);
    const chosen = links[0] || null;
    if (chosen) zenHotelPageCache.set(cacheKey, chosen);
    return chosen;
  } catch (e) {
    logError(reqId || "n/a", "Zen hotel page lookup failed", e?.message || e);
    return null;
  }
}

async function createAffiliateLink({
  hotelName = "",
  city = "",
  checkIn = null,
  checkOut = null,
  guests = null,
  hotelId = null,
  regionId = null,
  partnerExtra = ZEN_PARTNER_EXTRA,
  reqId = null,
} = {}) {
  const params = buildZenParams({
    checkIn,
    checkOut,
    guests,
    partnerExtra,
  });

  let resolvedHotelId = hotelId ? String(hotelId) : null;
  let resolvedRegionId = regionId ? String(regionId) : null;
  let resolvedHotelUrl = null;

  if (!resolvedHotelId && !resolvedRegionId) {
    const resolved = await resolveZenIds({ hotelName, city, reqId });
    resolvedHotelId = resolved.hotelId;
    resolvedRegionId = resolved.regionId;
    resolvedHotelUrl = normalizeZenHotelPageUrl(resolved.hotelUrl);
  }

  if (resolvedHotelUrl) return appendQueryParams(resolvedHotelUrl, params);

  const resolvedBySearch = await resolveZenHotelPageViaSerp({ hotelName, city, reqId });
  if (resolvedBySearch) return appendQueryParams(resolvedBySearch, params);

  const nameAndCityQuery = [sanitizeText(hotelName), sanitizeText(city)]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (nameAndCityQuery) return buildZenSearchUrl(nameAndCityQuery, params);

  if (resolvedRegionId) return buildZenSerpUrl(resolvedRegionId, params);

  // Fallback keeps attribution even if destination lookup fails.
  return buildZenSearchUrl(sanitizeText(city), params);
}

// --- 3. SERPAPI SEARCH LAYER -----------------------------------------------

async function performGoogleSearch(rawQuery, reqId) {
  if (!SERPAPI_KEY) {
    logInfo(reqId, "[SEARCH] No SERPAPI_KEY, returning stub");
    return `Search skipped (no SERPAPI_KEY). Query: ${rawQuery}`;
  }

  const query = rawQuery || "";
  logInfo(reqId, `[SEARCH] "${query}"`);
  const startsWith = (prefix) => query.startsWith(prefix);

  try {
    // --- RESTAURANTS ---
    if (startsWith("__restaurants__")) {
      const loc = query.replace("__restaurants__", "").trim();
      const data = await fetchSerpJson({
        engine: "google_local",
        q: loc + " best restaurants",
        hl: "en",
        type: "search",
      }, reqId);
      const base = data.local_results || data.places || [];
      const results = base.slice(0, 7).map((r) => ({
        title: r.title,
        price: r.price,
        rating: r.rating,
        type: r.type,
        address: r.address,
        latitude: r.gps_coordinates?.latitude,
        longitude: r.gps_coordinates?.longitude,
      }));
      return JSON.stringify(results);
    }

    // --- HOTELS ---
    if (startsWith("__hotels__")) {
      return "Hotel search via search_google is disabled because it is not date-aware. Use search_hotels with checkIn/checkOut for availability and accurate pricing.";
    }

    // --- FLIGHTS ---
    if (startsWith("__flights__")) {
      const cleaned = query.replace("__flights__", "").trim();
      const data = await fetchSerpJson({
        engine: "google_flights",
        q: cleaned,
        currency: "USD",
      }, reqId);
      const flights = data.best_flights || data.other_flights || [];
      const simplerFlights = flights.slice(0, 5).map((f) => {
        const leg = (f.flights && f.flights[0]) || {};
        const dep = leg.departure_airport || {};
        const arr = leg.arrival_airport || {};
        const depCode = dep.code || dep.airport_code || "";
        const arrCode = arr.code || arr.airport_code || "";
        const route = depCode && arrCode ? `${depCode} → ${arrCode}` : "";

        return {
          airline: leg.airline,
          flight_number: leg.flight_number,
          departure_time: dep.time,
          arrival_time: arr.time,
          departure_airport_code: depCode,
          departure_airport_name: dep.name,
          arrival_airport_code: arrCode,
          arrival_airport_name: arr.name,
          duration: f.total_duration,
          price: f.price,
          route,
        };
      });

      return simplerFlights.length > 0
        ? JSON.stringify(simplerFlights)
        : "No direct flight data found via API. Use estimates based on 'Approx 500-800 USD'.";
    }

    // --- ACTIVITIES ---
    if (startsWith("__activities__")) {
      const parsed = parseActivitiesSearchQuery(query);
      const location = parsed.location;
      const intent = parsed.intent;
      const specific = parsed.specific;

      const localQuery = specific && intent
        ? `${intent} in ${location}`
        : `${location} must do things`;

      const organicQueries = specific && intent
        ? [
          `${intent} ${location} site:getyourguide.com OR site:viator.com OR site:headout.com OR site:tiqets.com OR site:klook.com`,
          `${intent} ${location}`,
        ]
        : [
          `${location} tours site:getyourguide.com OR site:viator.com OR site:headout.com`,
        ];

      const [localData, ...organicPayloads] = await Promise.all([
        fetchSerpJson({
          engine: "google_local",
          q: localQuery,
          hl: "en",
          type: "search",
        }, reqId).catch(() => null),
        ...organicQueries.map((q) =>
          fetchSerpJson({ q, hl: "en", num: "10" }, reqId).catch(() => null)
        ),
      ]);

      const localBase = localData?.local_results || localData?.places || [];
      const localResults = localBase.slice(0, specific ? 6 : 10).map((r) => ({
        title: r.title,
        type: r.type || "activity",
        rating: r.rating,
        description: r.description,
        latitude: r.gps_coordinates?.latitude,
        longitude: r.gps_coordinates?.longitude,
        source: "local",
      }));

      const organicResults = [];
      for (const payload of organicPayloads) {
        const rows = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
        for (const r of rows) {
          const bookingUrl = sanitizeText(r?.link || "");
          const bookingUrlLower = bookingUrl.toLowerCase();
          const provider = providerFromUrl(bookingUrl);
          if (
            specific &&
            (!bookingUrl ||
              !ACTIVITY_PROVIDER_HOSTS.some((host) => bookingUrlLower.includes(host)))
          ) {
            continue;
          }
          organicResults.push({
            title: stripActivitySiteSuffix(r?.title || "", provider),
            type: specific ? "bookable_tour" : "activity",
            rating: null,
            description: r?.snippet,
            provider,
            booking_url: bookingUrl,
            source: "organic",
          });
        }
        if (specific && organicResults.length > 0) break;
      }

      const results = dedupeActivityResults(
        specific ? [...organicResults, ...localResults] : [...organicResults, ...localResults]
      ).slice(0, 10);

      return JSON.stringify(results);
    }

    // --- FALLBACK ---
    const data = await fetchSerpJson({ q: query, num: "8" }, reqId);

    const out = [];
    if (data.organic_results) {
      data.organic_results.slice(0, 6).forEach((r) => {
        out.push(`Result: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}`);
      });
    }
    return out.join("\n\n") || "No relevant details found.";
  } catch (err) {
    logError(reqId, "SerpAPI Error", err);
    return "Search API failed. Proceed with best estimates.";
  }
}

function chunkArray(arr = [], size = 25) {
  const chunkSize = Math.max(1, Number(size) || 25);
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

function getOfferTotal(offer = {}) {
  const priceObj = offer?.price || {};
  const total = Number(priceObj.grandTotal || priceObj.total || priceObj.base || 0);
  return Number.isFinite(total) ? total : 0;
}

function pickBestOffer(hotelItem = {}, checkIn = "", checkOut = "") {
  const offers = Array.isArray(hotelItem?.offers) ? hotelItem.offers : [];
  if (offers.length === 0) return null;

  const wantedCheckIn = sanitizeText(checkIn);
  const wantedCheckOut = sanitizeText(checkOut);
  const sameDateOffers = offers.filter((offer) => {
    const offerCheckIn = sanitizeText(offer?.checkInDate || offer?.checkIn || "");
    const offerCheckOut = sanitizeText(offer?.checkOutDate || offer?.checkOut || "");
    if (!wantedCheckIn || !wantedCheckOut) return true;
    if (!offerCheckIn || !offerCheckOut) return true;
    return offerCheckIn === wantedCheckIn && offerCheckOut === wantedCheckOut;
  });

  const pool = sameDateOffers.length > 0 ? sameDateOffers : offers;
  let best = null;
  let bestPrice = Number.POSITIVE_INFINITY;
  for (const offer of pool) {
    const total = getOfferTotal(offer);
    if (!Number.isFinite(total) || total <= 0) continue;
    if (total < bestPrice) {
      best = offer;
      bestPrice = total;
    }
  }
  return best;
}

function selectHotelsByBudgetMode(candidates = [], budgetMode = "balanced", limit = 8) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (list.length === 0) return [];
  const cap = Math.max(1, Number(limit) || 8);
  const mode = sanitizeText(budgetMode).toLowerCase();

  const byPrice = [...list].sort((a, b) => a.total - b.total);
  if (mode === "saving" || mode === "budget") {
    return byPrice.slice(0, cap);
  }

  if (mode === "comfort") {
    return [...list]
      .sort((a, b) => {
        if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
        return a.total - b.total;
      })
      .slice(0, cap);
  }

  // Balanced: keep part of the cheapest set, then fill with higher-rated options.
  const picks = [];
  const pickedIds = new Set();
  const cheapCount = Math.max(2, Math.floor(cap / 2));
  for (const h of byPrice) {
    if (picks.length >= cheapCount) break;
    picks.push(h);
    pickedIds.add(h.hotelId);
  }

  const rated = [...list]
    .filter((h) => !pickedIds.has(h.hotelId))
    .sort((a, b) => {
      if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
      return a.total - b.total;
    });

  for (const h of rated) {
    if (picks.length >= cap) break;
    picks.push(h);
  }
  return picks;
}

// --- 4. TOOLS ---------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "request_dates",
      description:
        "Trigger the date picker UI. Call this IMMEDIATELY once the destination is clear or the user shows interest in planning a trip. NEVER ask about dates via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_guests",
      description:
        "Trigger the guest picker UI. Call this IMMEDIATELY after (or together with) dates are requested. NEVER ask 'how many people' via text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_google",
      description:
        "Search Google for restaurants or activities only. Use prefixes: '__restaurants__ Rome', '__activities__ Tokyo'. If the user wants a specific tour/activity, use '__activities__ DESTINATION | SPECIFIC REQUEST' (example: '__activities__ Dubai | helicopter ride'). Do not use this tool for flights or hotels.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_flights",
      description: "Search for real flights using Amadeus. Always include return_date for round-trip pricing (much cheaper). Results are sorted cheapest-first.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "IATA code (e.g. LON, NYC) or City Name" },
          destination: { type: "string", description: "IATA code (e.g. PAR, TYO) or City Name" },
          date: { type: "string", description: "Departure date YYYY-MM-DD" },
          return_date: { type: "string", description: "Return date YYYY-MM-DD. ALWAYS provide for round-trip." },
        },
        required: ["origin", "destination", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_hotels",
      description: "Search for real hotels using RateHawk/ZenHotels with date-aware availability and pricing.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City Name or IATA code" },
          checkIn: { type: "string", description: "YYYY-MM-DD" },
          checkOut: { type: "string", description: "YYYY-MM-DD" },
          adults: { type: "number", description: "Number of adults, if known" },
          children: { type: "number", description: "Number of children, if known" },
          guests: { type: "string", description: "Provider guest format (e.g. '1', '2', '2-1')" },
        },
        required: ["city", "checkIn", "checkOut"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Finalize the trip. ONLY call this after you have searched for and found real flights, real hotels, and real activities, and you have dates + guests from tools.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          country: { type: "string" },
          dateRange: { type: "string" },
          description: { type: "string" },
          price: { type: "number", description: "Total estimated cost" },
          weather: {
            type: "object",
            properties: {
              temp: { type: "number" },
              icon: { type: "string" },
            },
          },
          itinerary: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: {
                  type: "string",
                  description: "ISO format '2025-11-20'",
                },
                day: {
                  type: "string",
                  description:
                    "ISO format '2025-11-20' (backend reformats to 'Nov 20')",
                },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["activity", "food", "travel", "stay"],
                      },
                      icon: { type: "string" },
                      time: {
                        type: "string",
                        description:
                          "24h format e.g. '14:00'. Must always be present.",
                      },
                      duration: { type: "string" },
                      title: { type: "string" },
                      details: { type: "string" },
                      provider: {
                        type: "string",
                        description:
                          "REAL NAME of place/airline/hotel/tour operator. Never generic.",
                      },
                      approxPrice: { type: "number" },
                      latitude: { type: "number" },
                      longitude: { type: "number" },
                      booking_url: {
                        type: "string",
                        description: "Direct booking page for the exact event when available. Avoid generic provider homepages.",
                      },
                    },
                    required: ["type", "title", "details", "provider"],
                  },
                },
              },
              required: ["date", "day", "events"],
            },
          },
          costBreakdown: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: { type: "string" },
                provider: { type: "string" },
                details: { type: "string" },
                price: { type: "number" },
                iconType: { type: "string" },
                iconValue: { type: "string" },
                booking_url: { type: "string", description: "Official homepage or direct booking deep link. For tours/activities, prefer the exact attraction page over a provider homepage." },
              },
            },
          },
          multiCity: { type: "boolean" },
          cities: { type: "array", items: { type: "string" } },
          visa: { type: "string" },
          currency: { type: "string" },
          flights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                route: { type: "string" },
                airline: { type: "string" },
                flightNumber: { type: "string" },
                cabinClass: { type: "string" },
                departTime: { type: "string" },
                arriveTime: { type: "string" },
                price: { type: "number" },
                duration: { type: "string" },
                stops: { type: "number" },
              },
            },
          },
          alternatives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                reason: { type: "string" },
                weatherSummary: { type: "string" },
              },
            },
          },
        },
        required: ["location", "price", "itinerary"],
      },
    },
  },
];

// --- 5. SYSTEM PROMPT -------------------------------------------------------

const getSystemPrompt = (profile) => `
You are an elite AI TRAVEL ARCHITECT inside a mobile app.

You CAN see and interpret images. When the user sends a photo:
- Carefully analyze the scene (architecture, landscape, language on signs, style).
- Infer likely location(s) and type of place (city, beach resort, mountain village, etc.).
- NEVER say "I can't identify locations from images" or "I can't see images".
- If uncertain, say things like "This looks similar to Santorini or another Greek island" and ask which they prefer.
- Treat a user’s image as a strong signal they want a trip inspired by that scene.

PROFILE CONTEXT:
- Origin city: ${profile.origin_city || "Unknown (you MUST ask 'Where are you flying from?')"}
- Nationality: ${profile.nationality || "Unknown"}
- Travel Style: ${profile.preferred_travel_type.join(", ") || "Any"}
- Budget: ${profile.budget.prefer_comfort_or_saving}
- Existing multi-city intent: ${profile.multi_cities.join(" → ") || "none"}

=====================================
DISCOVERY PHASE (MANDATORY QUESTIONS)
=====================================
As soon as the user shows travel intent (mentions a destination, sends a travel photo, or says "plan a trip"):

3. 1. If DESTINATION is unknown:
   - Ask: "Where would you like to go?"
2. If ORIGIN is unknown:
   - Ask: "Where are you flying from?" (Do NOT assume Istanbul)
3. Always clarify:
   - Budget: "Do you prefer saving money, comfort, or something balanced?"
   - Travel style: "What kind of trip vibe: beach, active, urban, relaxing, nightlife, or culture?"
   - With whom: "Are you going solo, with a partner, with friends, or with family?"

Keep questions short, natural, and human in WhatsApp-style responses (usually 1-3 short sentences).
- If you need several details, combine them into one flowing message instead of putting every item on its own line.
- Ask like a helpful travel agent, not like a checklist or form.
- Good style: "Send me your departure city and rough dates, and if you know it, the airport too."
- Bad style: "Departure city:\nDates:\nAirport:\nBudget:"

=====================================
DATES & GUESTS: ALWAYS TOOL, NEVER TEXT
=====================================
- You are FORBIDDEN from asking dates or number of travelers in plain text.
- As soon as:
  - destination is reasonably clear (from text, image, or link), AND
  - the user shows planning intent (e.g., "I want to go there", "plan something like this")
- You MUST:
  1. If the user JUST provided the dates in text (e.g. "I want to go Oct 12-15"), ACCEPT them. Do not ask again.
  2. If dates are missing, call \`request_dates\` immediately.
  3. After that, call \`request_guests\` in a later turn (never via text questions).

NEVER write sentences like:
- "When do you want to travel?"
- "What dates are you thinking?"
- "How many people are going?"

=====================================
REAL-WORLD RESEARCH (MANDATORY)
=====================================
When you have:
- clear destination (or your best inferred guess), AND
- travel intent, AND
- dates + guests (from tools),

You MUST:
- Call \`search_flights\` for flight options (origin/dest can be city names, I'll convert them).
  - ALWAYS provide return_date to get round-trip pricing (much cheaper than one-way).
  - Prioritize the CHEAPEST realistic options for the user.
- Call \`search_hotels\` for accommodation.
- Call \`search_google\` ONLY for:
  - "__restaurants__ DESTINATION"
  - "__activities__ DESTINATION"

Your goal:
- Use **real flights** from search results:
  - Airlines, flight numbers, realistic prices.
  - Include airports by real IATA codes (e.g., HEL, CDG, JFK).

  >>> HARD RULE FOR FLIGHT WORDING <<<
  - NEVER write vague phrases like "depart from Abuja to Moscow".
  - ALWAYS anchor flights to specific airports and the airline/flight number.
  - Use this pattern in titles and details:
    - "Turkish Airlines TK624 from Nnamdi Azikiwe International Airport (ABV) in Abuja to Sheremetyevo International Airport (SVO) in Moscow".
    - Short title example: "Flight ABV → SVO (Turkish Airlines TK624)".

- Use **real hotels**:
  - Real property names, approximate nightly rates, and ratings. 
  - Respect budget preference:
    - "saving/budget" -> prioritize lowest-priced available options.
    - "comfort" -> prioritize high-rated options (still with realistic prices).
    - "balanced" -> include a mix of value and quality, not only the cheapest.
- Use **real restaurants and activities**:
  - Real venue/tour names, taken from search results.
  - If the user asks for a specific tour or attraction, search it explicitly using \`__activities__ DESTINATION | SPECIFIC REQUEST\` so you can surface direct booking pages.
  - Prefer direct deep links to the exact activity page (GetYourGuide/Viator/etc.), not provider homepages.
  - **CRITICAL:** Search for "hidden gems", "local favorites", "best kept secrets", and "unique experiences".
  - **DIVERSITY:** Ensure the plan has a mix of culture, culinary, relaxation, and active elements.
  - **LOGISTICS:** Group activities by neighborhood to minimize travel time. Don't zigzag across the city.

=====================================
ITINERARY & create_plan
=====================================
When you call \`create_plan\`:

- \`itinerary[*].date\` and \`itinerary[*].day\`:
  - MUST be ISO-like "YYYY-MM-DD". The backend will display them as "Nov 20".

- Every event:
  - MUST have a specific, realistic time in 24h format (e.g., "09:00", "14:30", "19:30").
  - MUST have a \`provider\` field with a REAL entity name (hotel, restaurant, airline, tour operator).
  - MUST NOT be generic like "Nice restaurant", "Local hotel", "Beach time".
  - For travel events, mention airport names + codes and airline:
    - Example details: "Turkish Airlines TK624, Nnamdi Azikiwe International Airport (ABV) → Sheremetyevo International Airport (SVO)".

- Flights in \`flights\`:
  - Use airline name, flight number, and realistic departure/arrival times and approximate price.
  - Derive from \`search_flights\` tool results.

- Hotels:
  - Use hotel names, prices, and ratings from \`search_hotels\` tool results for the selected date range.

- Restaurants / Food:
  - Use restaurant names from \`__restaurants__\` results.

  - Use attraction or tour names from \`__activities__\` results or your best known real-world names.
  - **CRITICAL**: If the search results provided 'latitude' and 'longitude', you MUST include them in the event object.
  - If the search results provided a \`booking_url\` for the exact activity, include that deep link in the event or cost breakdown instead of a generic provider homepage.

- Cost Breakdown (\`costBreakdown\`):
  - You MUST explicitly include these items if valid for the trip:
    - "Transfers" (e.g. "Transfer to hotel", "Transfer to airport") -> Provider "GetTransfer" or local.
    - "Insurance" (e.g. "Medical Insurance", "Visa Insurance") -> Provider "Axa" or "Allianz".
    - "Excursions" (e.g. "City Tour", "Museum Ticket") -> Provider "GetYourGuide" or local.
  - Make sure to assign realistic prices to them.
  - If a searched excursion has a direct \`booking_url\`, pass that link through to the relevant excursion line item.

>>> HARD RULE: NO TEXT-ONLY FULL ITINERARIES <<<
- You are FORBIDDEN from writing a full day-by-day itinerary in normal chat messages.
- Do NOT send messages like:
  - "Day 1: ... Day 2: ..." or big lists of activities per day.
- All detailed "Day X / morning / afternoon / evening" content MUST be inside the \`itinerary\` array of the \`create_plan\` tool.
- In normal chat, you may mention at most 2–3 highlight examples in ONE short sentence.

>>> WHEN TO CALL create_plan <<<
As soon as you have:
- origin city
- destination
- dates & guests (from tools)
- at least one realistic flight option
- at least one realistic hotel option
- a set of 4–8 good activities/places

You MUST call \`create_plan\` IMMEDIATELY in that SAME assistant message.
- Do NOT send a message like "I'll build a plan now" or "Let me put this together" WITHOUT also calling the tool in that same message.
- Do NOT wait for the user to say "go on", "continue", or confirm before calling the tool.
- The tool call and any short text MUST be in the SAME assistant turn. Never announce it in one message and build it in the next.
- If you have enough data, just call \`create_plan\` right away. No preamble needed.

=====================================
CHAT STYLE & FORMATTING
=====================================
- Messages must be short and conversational (WhatsApp-style).
- Do NOT dump long essays.
- Never print long bullet lists of activities in normal chat when you could instead finalize a plan via \`create_plan\`.
- Sound warm, clear, and human. Avoid robotic checklist phrasing.
- Prefer one compact paragraph or 2-3 short sentences that flow naturally.
- Use line breaks sparingly. Only start a new line when it truly improves readability or separates 2 distinct ideas.
- Do NOT put each requested detail on its own separate line.
- If asking for multiple trip details, group them into one natural sentence or two related sentences.

>>> CRITICAL: NO MARKDOWN FORMATTING <<<
- NEVER use asterisks (*) for bold, italic, or emphasis. Write plain text only.
- NEVER use markdown: no **, no *, no ##, no ---, no backticks, no bullet lists with -.
- Write like you're texting a friend on WhatsApp. Clean, natural, easy to read.
- Prefer commas and natural sentence flow first. Use line breaks only when needed, not by default.
- Wrong: "**Paris** is a *great* choice! Here's what I found:"
- Right: "Paris is a great choice! Here's what I found:"
- If listing a few things, keep them in a compact sentence or short paragraph when possible; only use simple line breaks if that is clearly easier to read.

=====================================
TOOLS AND ORDER (ONE TOOL PER MESSAGE)
=====================================
- You must call AT MOST one tool in each assistant message.
- Sequence:
  1. Clarify origin + preferences (budget, style, with whom).
  2. Call \`request_dates\`.
  3. Call \`request_guests\`.
  4. Call \`search_flights\`.
  5. Call \`search_hotels\`.
  6. Call \`search_google\` for restaurants/activities only.
  7. Call \`create_plan\` once, when you have enough info.

Never say "I can't do X because I don't have browsing" — you DO have a search tool, also create more than 2 itineraries for each day.
`;

// --- 6. NORMALIZE MESSAGES --------------------------------------------------

function normalizeMessages(messages = []) {
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        // vision: text + image_url array is passed as-is
        return { role: "user", content: m.content };
      }
      let role = m.role;
      if (role === "ai") role = "assistant";
      if (role === "plan") role = "assistant";

      let content = m.content || m.text || "";
      if (role === "assistant" && m.payload) {
        content = "[Previous plan displayed to user]";
      }
      return { role, content: String(content) };
    });
}

// --- 7. MAIN ROUTE ----------------------------------------------------------

router.post("/travel", async (req, res) => {
  const reqId = newReqId();

  try {
    const { messages = [], userId = "anonymous" } = req.body || {};
    const mem = getMem(userId);
    updateProfileFromHistory(messages, mem);

    if (!hasKey || !client) {
      return res.json({ aiText: "API Key missing. Cannot plan trip." });
    }

    const systemPrompt = getSystemPrompt(mem.profile);
    const baseHistory = [
      { role: "system", content: systemPrompt },
      ...normalizeMessages(messages),
    ];

    const runConversation = async (conversation, depth = 0) => {
      // --- SAFETY VALVE ---
      if (depth > 7) {
        logInfo(reqId, "Forcing plan creation due to depth");
        conversation.push({
          role: "system",
          content:
            "SYSTEM INTERVENTION: You have gathered enough information. Stop asking questions. Use the data you have found (or make reasonable real-world estimates) and call the 'create_plan' tool IMMEDIATELY.",
        });
      } else if (depth > 9) {
        return { aiText: "I'm having trouble finalizing. Let's start fresh." };
      }

      let completion;
      try {
        completion = await client.chat.completions.create({
          model: "gpt-5.2",
          messages: conversation,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
        });
      } catch (err) {
        logError(reqId, "OpenAI Error", err);
        return { aiText: "My planning brain is offline briefly." };
      }

      const msg = completion.choices[0]?.message;
      if (!msg) return { aiText: "No response." };

      // --- TOOL CALL HANDLING (STRICT SINGLE TOOL) ---
      if (msg.tool_calls?.length) {
        const toolCall = msg.tool_calls[0];
        const toolName = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          logError(reqId, "[Tool args parse error]", e);
        }

        logInfo(reqId, `[Tool] ${toolName}`, args);

        const assistantMsgSanitized = {
          ...msg,
          tool_calls: [toolCall],
        };
        const newHistory = [...conversation, assistantMsgSanitized];

        // A. SEARCH -> recurse
        if (toolName === "search_google") {
          const result = await performGoogleSearch(args.query, reqId);
          const searchQuery = sanitizeText(args.query);
          if (searchQuery.startsWith("__activities__")) {
            try {
              const parsed = JSON.parse(result);
              mem.lastActivities = Array.isArray(parsed)
                ? parsed
                  .filter((row) => sanitizeText(row?.title))
                  .map((row) => ({
                    ...row,
                    title: stripActivitySiteSuffix(row.title, row.provider),
                  }))
                : [];
              mem.lastActivitySearch = {
                query: searchQuery,
                at: new Date().toISOString(),
              };
            } catch (e) {
              mem.lastActivities = [];
            }
          } else if (searchQuery.startsWith("__restaurants__")) {
            try {
              const parsed = JSON.parse(result);
              mem.lastRestaurants = Array.isArray(parsed) ? parsed : [];
            } catch (e) {
              mem.lastRestaurants = [];
            }
          }
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }

        // A2. SEARCH FLIGHTS (AMADEUS)
        if (toolName === "search_flights") {
          let result = "No flights found.";
          try {
            const originCode = getCode(args.origin) || args.origin.toUpperCase();
            const destCode = getCode(args.destination) || args.destination.toUpperCase();

            // Build origin-destinations (round-trip if return_date provided)
            const originDestinations = [
              {
                id: '1',
                originLocationCode: originCode,
                destinationLocationCode: destCode,
                departureDateTimeRange: { date: args.date }
              }
            ];
            if (args.return_date) {
              originDestinations.push({
                id: '2',
                originLocationCode: destCode,
                destinationLocationCode: originCode,
                departureDateTimeRange: { date: args.return_date }
              });
            }

            const response = await amadeus.shopping.flightOffersSearch.post(JSON.stringify({
              currencyCode: 'USD',
              originDestinations,
              travelers: [{ id: '1', travelerType: 'ADULT' }],
              sources: ['GDS'],
              searchCriteria: {
                maxFlightOffers: 20,
                flightFilters: {
                  cabinRestrictions: [{
                    cabin: "ECONOMY",
                    coverage: "MOST_SEGMENTS",
                    originDestinationIds: ["1"]
                  }]
                }
              }
            }));
            const data = response.data;
            const dictionaries = response.result?.dictionaries || {};

            // Sort by price ascending to surface cheapest options first
            const sorted = (data || [])
              .map(o => normalizeOffer(o, dictionaries))
              .sort((a, b) => (a.price || 9999) - (b.price || 9999));

            const top = sorted.slice(0, 10);
            if (top.length) {
              mem.lastFlights = top;

              result = top.map((n, i) => {
                const route = `${n.origin || originCode}->${n.destination || destCode}`;
                const stopsPart = n.stops === 0 ? "Direct" : `${n.stops} stop${n.stops > 1 ? 's' : ''}`;
                const retPart = n.isRoundTrip ? " (round-trip)" : "";
                return `${i + 1}. ${n.airline} ${n.flightNumber} ${route}: ${n.depart}-${n.arrive} (${n.duration}, ${stopsPart})${retPart} — $${n.price}`;
              }).join('\n');
              result = `Found ${sorted.length} options. Top ${top.length} cheapest:\n${result}`;
            }
          } catch (e) {
            result = `Flight search failed: ${e?.response?.result?.errors?.[0]?.detail || e.message}`;
            logError(reqId, "Amadeus Flight Error", e);
          }
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }

        // A3. SEARCH HOTELS (RATEHAWK / ZENHOTELS)
        if (toolName === "search_hotels") {
          let result = "No hotels found.";
          try {
            const cityRaw = sanitizeText(args.city);
            const checkIn = sanitizeText(args.checkIn);
            const checkOut = sanitizeText(args.checkOut);
            const zenGuests = deriveZenGuestsForHotelSearch(args, mem?.profile);
            if (!cityRaw || !checkIn || !checkOut) {
              result = "Hotel search requires city, checkIn and checkOut.";
            } else if (!getRateHawkAuthHeaders()) {
              result = "Hotel search is unavailable: RateHawk/Zen credentials are missing.";
            } else {
              const budgetMode = sanitizeText(mem?.profile?.budget?.prefer_comfort_or_saving || "balanced").toLowerCase();
              const region = await resolveZenRegionForCity(cityRaw, reqId);
              const regionId = region?.regionId ? String(region.regionId) : null;
              if (!regionId) {
                result = `Could not resolve destination region for "${cityRaw}".`;
              } else {
                const serp = await fetchRateHawkSerpRegion({
                  regionId,
                  checkIn,
                  checkOut,
                  guests: zenGuests,
                  residency: deriveRateHawkResidency(mem?.profile),
                  currency: "USD",
                  lang: ZEN_LANG,
                  hotelsLimit: 80,
                  reqId,
                });

                const hints = buildHotelNameHintsFromMulticomplete(region?.payload || {});
                const candidates = extractRateHawkSerpHotels(serp, hints);

                if (candidates.length === 0) {
                  result = `No available hotels were found for ${cityRaw} from ${checkIn} to ${checkOut}.`;
                } else {
                  let ranked = selectHotelsByBudgetMode(candidates, budgetMode, 8);

                  // Fetch content only for shortlisted hotels to improve names and rating quality.
                  const enriched = await Promise.all(
                    ranked.map(async (h) => {
                      const info = await fetchRateHawkHotelInfo({
                        hid: h.hid || null,
                        id: h.legacyId || null,
                        reqId,
                      });
                      const infoName = sanitizeText(info?.name || info?.hotel_name || "");
                      const stars = Number(
                        info?.star_rating ??
                        info?.star ??
                        info?.stars ??
                        h.rating ??
                        0
                      );
                      return {
                        ...h,
                        name: infoName || h.name,
                        rating: Number.isFinite(stars) ? stars : (h.rating || 0),
                      };
                    })
                  );

                  ranked = selectHotelsByBudgetMode(enriched, budgetMode, 8);

                  mem.lastHotels = ranked.map((h) => ({
                    hotelId: h.hotelId,
                    hid: h.hid || null,
                    legacyId: h.legacyId || null,
                    regionId: h.regionId || regionId,
                    name: h.name,
                    total: Number(h.total) || 0,
                    rating: Number(h.rating) || 0,
                    checkIn,
                    checkOut,
                    city: cityRaw,
                  }));
                  mem.lastHotelSearch = {
                    provider: "ratehawk",
                    city: cityRaw,
                    regionId,
                    checkIn,
                    checkOut,
                    guests: zenGuests,
                    budgetMode,
                    at: new Date().toISOString(),
                  };

                  const lines = await Promise.all(
                    ranked.map(async (h) => {
                      const affLink = await createAffiliateLink({
                        hotelName: h.name,
                        city: cityRaw,
                        checkIn,
                        checkOut,
                        guests: zenGuests,
                        hotelId: h.hid || h.hotelId || null,
                        regionId: h.regionId || regionId,
                        reqId,
                      });
                      const ratingPart = h.rating > 0 ? `, rating ${h.rating}` : "";
                      const idPart = h.hid ? `hid:${h.hid}` : h.hotelId;
                      return `Hotel ${h.name} (${idPart}): from $${h.total.toFixed(2)} total for ${checkIn} to ${checkOut}${ratingPart}. Book here: ${affLink}`;
                    })
                  );

                  const modeLine =
                    budgetMode === "comfort"
                      ? "Preference mode: comfort (higher-rated options first, still price-aware)."
                      : budgetMode === "saving" || budgetMode === "budget"
                        ? "Preference mode: budget (lowest-price options first)."
                        : "Preference mode: balanced (mix of value picks and well-rated stays).";
                  result = `${modeLine}\n${lines.join("\n")}`;
                }
              }
            }
          } catch (e) {
            result = `Hotel search failed: ${e?.response?.result?.errors?.[0]?.detail || e.message}`;
            logError(reqId, "RateHawk Hotel Error", e);
          }
          newHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
          return runConversation(newHistory, depth + 1);
        }


        // B. DATES / GUESTS -> return signal to frontend
        if (toolName === "request_dates") {
          return {
            aiText: "Choose your travel dates.",
            signal: { type: "dateNeeded" },
            assistantMessage: assistantMsgSanitized,
          };
        }

        if (toolName === "request_guests") {
          return {
            aiText: "Select how many people are traveling.",
            signal: { type: "guestsNeeded" },
            assistantMessage: assistantMsgSanitized,
          };
        }

        // C. CREATE PLAN -> finalize and return
        if (toolName === "create_plan") {
          logInfo(reqId, "[TOOL] create_plan called. Keys:", Object.keys(args));
          const plan = { ...args };

          if (!plan.itinerary) plan.itinerary = [];
          if (!plan.flights) plan.flights = [];

          // FALLBACK: If LLM forgot to pass flights back, use memory
          if (plan.flights.length === 0) {
            if (mem.lastFlights && mem.lastFlights.length > 0) {
              logInfo(reqId, "Restoring flights from memory fallback (count: " + mem.lastFlights.length + ")");
              plan.flights = mem.lastFlights;
            } else {
              logInfo(reqId, "No flights in plan AND no flights in memory fallback.");
            }
          }

          if (!plan.costBreakdown) plan.costBreakdown = [];

          // FORCE USD
          plan.currency = "USD";

          if (!plan.cities) plan.cities = [];
          if (plan.cities.length > 1) plan.multiCity = true;

          ensureWeather(plan);

          try {
            const q = plan.multiCity && plan.cities.length > 0 ? plan.cities[0] : plan.location;
            plan.image = await pickPhoto(q || "travel", reqId);
          } catch (e) {
            plan.image = FALLBACK_IMAGE_URL;
          }

          // --- ENRICH FLIGHTS FROM MEMORY ---
          if (plan.flights && plan.flights.length > 0 && mem.lastFlights && mem.lastFlights.length > 0) {
            plan.flights.forEach(f => {
              const fNum = (f.flightNumber || "").replace(/\s+/g, '').toUpperCase();
              if (fNum) {
                const match = mem.lastFlights.find(mf =>
                  (mf.flightNumber || "").replace(/\s+/g, '').toUpperCase() === fNum ||
                  (mf.airline === f.airline && mf.price === f.price)
                );
                if (match) {
                  f.layover = match.layover;
                  f.departDate = match.departDate;
                  f.stops = match.stops;
                  f.depart = match.depart;
                  f.arrive = match.arrive;
                  f.origin = match.origin;
                  f.destination = match.destination;
                  f.booking_url = match.booking_url;

                  f.isRoundTrip = match.isRoundTrip;
                  f.returnDate = match.returnDate;
                  f.returnDepart = match.returnDepart;
                  f.returnArrive = match.returnArrive;
                  f.returnDuration = match.returnDuration;
                  f.returnStops = match.returnStops;
                  f.returnLayover = match.returnLayover;
                  if (match.duration) f.duration = match.duration;
                }
              }
              if (!f.departDate && f.departTime && f.departTime.includes('T')) {
                f.departDate = f.departTime.split('T')[0];
              } else if (!f.departDate && f.departTime && f.departTime.match(/^\d{4}-\d{2}-\d{2}/)) {
                f.departDate = f.departTime.slice(0, 10);
              }
            });
          }

          // --- ITINERARY SYNC ---
          if (plan.flights && plan.flights.length > 0 && plan.itinerary) {
            plan.flights.forEach(f => {
              if (f.departDate) {
                const day = plan.itinerary.find(d => (d.date && d.date.startsWith(f.departDate)) || (d.day && d.day.startsWith(f.departDate)));
                if (day && day.events) {
                  const ev = day.events.find(e => e.type === 'travel' || (e.title && e.title.toLowerCase().includes('flight')));
                  if (ev) {
                    if (f.duration) ev.duration = f.duration;
                    if (f.flightNumber && (!ev.title || !ev.title.includes(f.flightNumber))) {
                      ev.title = `Flight ${f.flightNumber} (${f.airline})`;
                      ev.provider = f.airline;
                    }
                  }
                }
              }
              if (f.returnDate) {
                const day = plan.itinerary.find(d => (d.date && d.date.startsWith(f.returnDate)) || (d.day && d.day.startsWith(f.returnDate)));
                if (day && day.events) {
                  const ev = day.events.find(e => e.type === 'travel' || (e.title && e.title.toLowerCase().includes('flight')));
                  if (ev) {
                    if (f.returnDuration) ev.duration = f.returnDuration;
                    if (!ev.title || !ev.title.includes('Return')) ev.title = `Return Flight (${f.airline})`;
                  }
                }
              }
            });
          }

          // Calculate Dates for Affiliate Links
          const lastItin = plan.itinerary[plan.itinerary.length - 1];
          const firstItin = plan.itinerary[0];
          const tripStart = firstItin?.date || new Date().toISOString().slice(0, 10);
          const tripEnd = lastItin?.date || tripStart;

          // Format itinerary dates
          plan.itinerary.forEach((day) => {
            if (day.date) { const nice = formatDateToMMMDD(day.date); day.date = nice; day.day = nice; }
            else if (day.day) { const nice = formatDateToMMMDD(day.day); day.date = nice; day.day = nice; }
            if (Array.isArray(day.events)) {
              day.events.forEach((ev, idx) => {
                if (!ev.time) ev.time = ["09:00", "13:00", "17:00", "20:00"][idx] || "10:00";
                if (!ev.duration) ev.duration = "2h";
                if (ev.type === "activity") {
                  const matchedActivity = pickActivityFromMemory(
                    [ev.title, ev.details, ev.provider].filter(Boolean).join(" "),
                    mem?.lastActivities || []
                  );
                  if (matchedActivity) {
                    if ((!ev.booking_url || isGenericProviderHomepage(ev.booking_url)) && matchedActivity.booking_url) {
                      ev.booking_url = matchedActivity.booking_url;
                    }
                    if ((!ev.provider || isKnownActivityProviderName(ev.provider)) && matchedActivity.provider) {
                      ev.provider = matchedActivity.provider;
                    }
                    const lat = Number(matchedActivity.latitude);
                    const lng = Number(matchedActivity.longitude);
                    if (!Number.isFinite(Number(ev.latitude)) && Number.isFinite(lat)) ev.latitude = lat;
                    if (!Number.isFinite(Number(ev.longitude)) && Number.isFinite(lng)) ev.longitude = lng;
                  }
                }
              });
            }
          });

          // --- COST BREAKDOWN ENRICHMENT ---
          // 1. Flights
          if (plan.costBreakdown.length === 0 && plan.flights.length > 0) {
            // Create logic omitted for brevity, simpler below:
          }
          if (plan.flights.length > 0) {
            // Filter existing flights
            plan.costBreakdown = plan.costBreakdown.filter(item => {
              const lower = (item.item || "").toLowerCase();
              return !(lower.includes("flight") || lower.includes("fly") || lower.includes("airline"));
            });
            // Add simplified flight
            const f0 = plan.flights[0];
            let details = f0.route || "Round trip";
            plan.costBreakdown.unshift({
              item: "Fly Tickets",
              provider: f0.airline || "Airline",
              details: details,
              price: Number(f0.price) || 0,
              iconType: "plane",
              iconValue: "✈️",
              booking_url: f0.booking_url,
              raw: { ...f0, depart: f0.depart || f0.departTime, arrive: f0.arrive || f0.arriveTime }
            });
          }

          // 2. Enrich Logos & URLs
          const hotelContext = mem?.lastHotelSearch || {};
          const hotelCheckIn = sanitizeText(hotelContext.checkIn) || tripStart;
          const hotelCheckOut = sanitizeText(hotelContext.checkOut) || tripEnd;
          const zenGuestsForPlan = deriveZenGuestsFromProfile(mem?.profile);
          for (const item of plan.costBreakdown) {
            const lowerItem = (item.item || "").toLowerCase();
            const lowerProv = (item.provider || "").toLowerCase();
            const lowerDetails = (item.details || "").toLowerCase();
            const isAirbnb = lowerProv.includes("airbnb");
            const isHotelLike =
              !isAirbnb &&
              (
                lowerProv.includes("booking.com") ||
                lowerProv.includes("zenhotels") ||
                lowerProv.includes("ratehawk") ||
                item.iconType === "bed" ||
                lowerItem.includes("hotel") ||
                lowerItem.includes("stay") ||
                lowerItem.includes("accommodation")
              );
            const matchedActivity = pickActivityFromMemory(
              [item.item, item.details, item.provider].filter(Boolean).join(" "),
              mem?.lastActivities || []
            );
            const needsSpecificActivityLink =
              !item.booking_url || isGenericProviderHomepage(item.booking_url);

            if (isHotelLike) {
              const matchedHotel = pickHotelFromMemory(item.provider || item.item, mem?.lastHotels || []);
              if (matchedHotel?.total && matchedHotel.total > 0) {
                item.price = Number(matchedHotel.total.toFixed(2));
                if (!item.provider || item.provider.toLowerCase().includes("hotel")) {
                  item.provider = matchedHotel.name;
                }
                if (!item.details || /hotel|stay|accommodation/i.test(String(item.details))) {
                  item.details = `${hotelCheckIn} to ${hotelCheckOut}`;
                }
              }

              item.booking_url = await createAffiliateLink({
                hotelName: matchedHotel?.name || item.provider || item.item,
                city: matchedHotel?.city || hotelContext.city || plan.location,
                checkIn: hotelCheckIn,
                checkOut: hotelCheckOut,
                guests: zenGuestsForPlan,
                hotelId: matchedHotel?.hotelId || null,
                reqId,
              });
            } else {
              if (
                matchedActivity &&
                needsSpecificActivityLink &&
                matchedActivity.booking_url
              ) {
                item.booking_url = matchedActivity.booking_url;
              }
              if (
                matchedActivity &&
                (!item.provider || isKnownActivityProviderName(item.provider)) &&
                matchedActivity.provider
              ) {
                item.provider = matchedActivity.provider;
              }
              if (!item.details && matchedActivity?.description) {
                item.details = matchedActivity.description;
              }

              if (
                !item.booking_url &&
                matchedActivity &&
                (lowerProv.includes("getyourguide") ||
                  lowerProv.includes("viator") ||
                  lowerProv.includes("headout") ||
                  lowerProv.includes("tiqets") ||
                  lowerProv.includes("klook") ||
                  lowerItem.includes("tour") ||
                  lowerItem.includes("ticket") ||
                  lowerItem.includes("excursion") ||
                  lowerDetails.includes("tour") ||
                  lowerDetails.includes("ticket") ||
                  lowerDetails.includes("excursion"))
              ) {
                item.booking_url = matchedActivity.booking_url || item.booking_url;
              }
            }

            if (!item.booking_url) {
              if (lowerProv.includes("gettransfer") || lowerItem.includes("transfer")) item.booking_url = "https://gettransfer.com";
              else if (lowerProv.includes("axa")) item.booking_url = "https://www.axa-schengen.com";
              else if (lowerProv.includes("allianz")) item.booking_url = "https://www.allianz-travel.com";
              else if (lowerProv.includes("getyourguide")) item.booking_url = "https://www.getyourguide.com";
              else if (lowerProv.includes("viator")) item.booking_url = "https://www.viator.com";
              else if (isAirbnb) item.booking_url = "https://www.airbnb.com";
            }

            // Domain/Favicon logic
            let domain = "";
            if (item.booking_url) { try { domain = new URL(item.booking_url).hostname.replace('www.', ''); } catch (e) { } }
            if (!domain && item.provider) { /* simplify */ domain = item.provider.replace(/\s/g, '').toLowerCase() + ".com"; }
            if (domain) { item.iconType = 'image'; item.iconValue = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`; }
          }

          // Recalculate Total
          if (plan.costBreakdown.length > 0) {
            plan.price = plan.costBreakdown.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
          }

          return {
            aiText: `I've built a plan for ${plan.location}.`,
            signal: { type: "planReady", payload: plan },
            assistantMessage: assistantMsgSanitized,
          };
        }
      }

      // No tool calls -> Standard text response (also guard against manual date questions)
      let text = msg.content || "";
      const lower = (text || "").toLowerCase();

      // If the model starts dumping an itinerary, intercept and push it to create_plan
      const looksLikeItinerary =
        lower.includes("day 1") ||
        lower.includes("day one") ||
        lower.includes("itinerary") ||
        /day\s+\d+[:\-]/i.test(text || "");

      if (looksLikeItinerary && depth < 7) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text itinerary. Forcing model to use create_plan instead."
        );

        const newConversation = [
          ...conversation,
          msg,
          {
            role: "system",
            content:
              "SYSTEM REMINDER: Do NOT write day-by-day itineraries in plain text. You already have enough information. Now you MUST call the 'create_plan' tool and put all days/activities inside its 'itinerary' field. In the chat message, only say a short confirmation like 'Great, I'll build a plan for you now.'",
          },
        ];

        return runConversation(newConversation, depth + 1);
      }

      // Guardrail: if the model mistakenly asks about dates/guests via text, convert to tool signals instead
      const mentionsDates =
        lower.includes("what dates") ||
        lower.includes("when do you want") ||
        lower.includes("when are you planning") ||
        lower.includes("when would you like to travel");

      const mentionsGuests =
        lower.includes("how many people") ||
        lower.includes("how many guests") ||
        (lower.includes("who is traveling") && lower.includes("people"));

      if (mentionsDates) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text question about dates. Returning dateNeeded signal instead."
        );
        return {
          aiText: "Choose your travel dates.",
          signal: { type: "dateNeeded" },
          assistantMessage: msg,
        };
      }

      if (mentionsGuests) {
        logInfo(
          reqId,
          "[Guardrail] Intercepted text question about guests. Returning guestsNeeded signal instead."
        );
        return {
          aiText: "Select how many people are traveling.",
          signal: { type: "guestsNeeded" },
          assistantMessage: msg,
        };
      }

      // Guardrail: if model announces plan building without actually calling create_plan, force it
      const looksLikePlanAnnouncement =
        lower.includes("build") && lower.includes("plan") ||
        lower.includes("putting together") && lower.includes("plan") ||
        lower.includes("crafting") && lower.includes("plan") ||
        lower.includes("creating") && lower.includes("itinerary") ||
        lower.includes("let me put") && lower.includes("together");

      if (looksLikePlanAnnouncement && depth < 7) {
        logInfo(reqId, "[Guardrail] Intercepted plan announcement without tool call. Forcing create_plan.");
        const newConversation = [
          ...conversation,
          msg,
          {
            role: "system",
            content:
              "SYSTEM INTERVENTION: You just announced you'd build a plan but did NOT call the create_plan tool. You MUST call create_plan NOW in this very message. Do not reply with text — call the tool immediately with all the data you have.",
          },
        ];
        return runConversation(newConversation, depth + 1);
      }

      // Anti-dump: shorten overly long messages
      if (typeof text === "string" && text.length > 600) {
        text = text.slice(0, 580) + "…";
      }

      return { aiText: text };
    };

    const response = await runConversation(baseHistory);
    if (response.aiText) response.aiText = stripMarkdown(response.aiText);
    return res.json(response);
  } catch (err) {
    logError(reqId, "Route Error", err);
    return res.status(500).json({ aiText: "Server error." });
  }
});

export default router;
