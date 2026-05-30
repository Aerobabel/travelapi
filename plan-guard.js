const PLAN_GUARD_VERSION = "2026-05-30";

const ZEN_PARTNER_SLUG = process.env.ZEN_PARTNER_SLUG || "285572.affiliate.37e8";
const ZEN_UTM_CAMPAIGN = process.env.ZEN_UTM_CAMPAIGN || "en-en, deeplink, affiliate";
const ZEN_UTM_MEDIUM = process.env.ZEN_UTM_MEDIUM || "api2";
const ZEN_UTM_SOURCE = process.env.ZEN_UTM_SOURCE || ZEN_PARTNER_SLUG;
const ZEN_UTM_TERM = process.env.ZEN_UTM_TERM || "None";
const ZEN_LANG = process.env.ZEN_LANG || "en";
const ZEN_CURRENCY = process.env.ZEN_CURRENCY || "USD";
const ZEN_PARTNER_EXTRA = process.env.ZEN_PARTNER_EXTRA || "None";

const ACTIVITY_PROVIDER_HOSTS = [
  "getyourguide.com",
  "viator.com",
  "headout.com",
  "tiqets.com",
  "klook.com",
  "musement.com",
  "civitatis.com",
  "feverup.com",
  "airbnb.com",
];

const ACTIVITY_PROVIDER_NAMES = [
  "getyourguide",
  "get your guide",
  "viator",
  "headout",
  "tiqets",
  "klook",
  "musement",
  "civitatis",
  "fever",
  "airbnb experiences",
];

const clean = (value) => String(value || "").trim();

const normalizeText = (value = "") =>
  clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.:/?&=\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const itemText = (item = {}) =>
  normalizeText([
    item.item,
    item.title,
    item.provider,
    item.details,
    item.description,
    item.iconType,
    item.bookingAction?.type,
    item.booking_action?.type,
  ].filter(Boolean).join(" "));

export function urlParts(rawUrl = "") {
  try {
    const url = new URL(clean(rawUrl));
    return {
      url,
      host: url.hostname.replace(/^www\./i, "").toLowerCase(),
      path: (url.pathname || "/").replace(/\/+$/, "") || "/",
    };
  } catch {
    return { url: null, host: "", path: "" };
  }
}

export function classifyBookingItem(item = {}) {
  const explicit = normalizeText(item.bookingAction?.type || item.booking_action?.type || item.type);
  const text = itemText(item);

  if (/\btransfer\b|\btaxi\b|\bchauffeur\b|\bdriver\b|\bshuttle\b|\bgettransfer\b|\bhotel to airport\b|\bfrom airport\b|\bto airport\b/.test(text)) {
    return "transfer";
  }
  if (/\binsurance\b|\baxa\b|\ballianz\b/.test(text)) return "insurance";
  if (item.raw || /\bflight\b|\bfly\b|\bairline\b|\bairways\b|\bticket flight\b/.test(text)) return "flight";

  const hasActivityProvider = ACTIVITY_PROVIDER_NAMES.some((name) => text.includes(name));
  const hasActivityIntent = /\btour\b|\bticket\b|\bexcursion\b|\bactivity\b|\bexperience\b|\battraction\b|\bmuseum\b|\bguide\b/.test(text);
  if (hasActivityProvider || hasActivityIntent) return "activity";

  if (/\bhotel\b|\bstay\b|\baccommodation\b|\blodging\b|\bresort\b|\bzenhotels\b|\bratehawk\b|\bbooking\.com\b|\bbed\b/.test(text)) {
    return "hotel";
  }

  if (["flight", "hotel", "transfer", "insurance", "activity"].includes(explicit)) return explicit;
  return "other";
}

export function isZenHotelsSearchUrl(rawUrl = "") {
  const { host, path } = urlParts(rawUrl);
  return host === "zenhotels.com" && path === "/hotels";
}

export function isZenHotelsHotelPageUrl(rawUrl = "") {
  const { host, path } = urlParts(rawUrl);
  return host === "zenhotels.com" && (path === "/hotel" || path.startsWith("/hotel/"));
}

export function isGoogleMapsUrl(rawUrl = "") {
  const { host, path } = urlParts(rawUrl);
  return host === "google.com" && path.startsWith("/maps");
}

export function isActivityProviderUrl(rawUrl = "") {
  const { host } = urlParts(rawUrl);
  return ACTIVITY_PROVIDER_HOSTS.some((providerHost) => host === providerHost || host.endsWith(`.${providerHost}`));
}

export function isGenericProviderUrl(rawUrl = "") {
  const { host, path } = urlParts(rawUrl);
  if (!host) return true;
  if (host === "zenhotels.com") return path === "/" || path === "/hotels";
  if (host === "google.com" && path === "/search") return true;
  if (host.includes("gettransfer")) return path === "/";
  if (host.includes("airbnb")) return path === "/" || path === "/experiences";
  if (isActivityProviderUrl(rawUrl)) return path === "/";
  return false;
}

export function isUrlCompatibleWithCategory(category, rawUrl = "") {
  const { host, path } = urlParts(rawUrl);
  if (!host) return false;

  if (category === "transfer") {
    return host.includes("gettransfer") || isGoogleMapsUrl(rawUrl);
  }

  if (category === "insurance") {
    return host.includes("axa-schengen") ||
      host.includes("allianz-travel") ||
      host.includes("allianztravelinsurance");
  }

  if (category === "flight") {
    if (host.includes("airbnb") || isActivityProviderUrl(rawUrl)) return false;
    return host.includes("skyscanner") ||
      host.includes("duffel") ||
      host.includes("amadeus") ||
      host.includes("google.com") ||
      host.includes("kayak") ||
      host.includes("expedia");
  }

  if (category === "hotel") {
    if (host.includes("airbnb") && path.includes("experiences")) return false;
    if (host.includes("gettransfer") || host.includes("axa") || host.includes("allianz")) return false;
    return host === "zenhotels.com" ||
      host.includes("booking.com") ||
      host.includes("ratehawk") ||
      host.includes("hotels.com") ||
      host.includes("airbnb") ||
      isGoogleMapsUrl(rawUrl);
  }

  if (category === "activity") {
    if (host.includes("gettransfer") || host.includes("axa") || host.includes("allianz")) return false;
    if (host === "zenhotels.com" && path.startsWith("/hotel")) return false;
    return true;
  }

  return true;
}

function buildSkyscannerUrl(item = {}) {
  const raw = item.raw || {};
  const origin = clean(raw.origin || raw.originCode || item.origin || item.originCode).toLowerCase();
  const destination = clean(raw.destination || raw.destinationCode || item.destination || item.destinationCode).toLowerCase();
  const date = clean(raw.departDate || raw.departureDate || item.departDate || item.date).slice(2, 10).replace(/-/g, "");
  if (origin && destination && date) {
    return `https://www.skyscanner.com/transport/flights/${origin}/${destination}/${date}`;
  }
  return "https://www.skyscanner.com/transport/flights/";
}

function buildZenSearchUrl(item = {}, plan = {}) {
  const query = [
    item.provider,
    item.item,
    item.title,
    plan.location,
    plan.country,
  ].filter(Boolean).join(" ").trim();
  const params = new URLSearchParams({
    cur: plan.currency || ZEN_CURRENCY,
    lang: ZEN_LANG,
    partner_slug: ZEN_PARTNER_SLUG,
    utm_campaign: ZEN_UTM_CAMPAIGN,
    utm_medium: ZEN_UTM_MEDIUM,
    utm_source: ZEN_UTM_SOURCE,
    utm_term: ZEN_UTM_TERM,
    partner_extra: ZEN_PARTNER_EXTRA,
  });
  if (query) params.set("q", query);
  return `https://www.zenhotels.com/hotels/?${params.toString()}`;
}

function activityProviderSearchUrl(provider = "", query = "") {
  const p = normalizeText(provider);
  const q = encodeURIComponent(clean(query));
  if (p.includes("getyourguide") || p.includes("get your guide")) return `https://www.getyourguide.com/s/?q=${q}`;
  if (p.includes("viator")) return `https://www.viator.com/searchResults/all?text=${q}`;
  if (p.includes("headout")) return `https://www.headout.com/search/?q=${q}`;
  if (p.includes("tiqets")) return `https://www.tiqets.com/en/search/?q=${q}`;
  if (p.includes("klook")) return `https://www.klook.com/search/result/?query=${q}`;
  if (p.includes("airbnb")) return `https://www.airbnb.com/s/experiences?query=${q}`;
  return "";
}

export function fallbackUrlForCategory(category, item = {}, plan = {}) {
  if (category === "transfer") return "https://gettransfer.com";
  if (category === "insurance") {
    const provider = normalizeText(item.provider);
    return provider.includes("allianz")
      ? "https://www.allianz-travel.com"
      : "https://www.axa-schengen.com";
  }
  if (category === "flight") return buildSkyscannerUrl(item);
  if (category === "hotel") return buildZenSearchUrl(item, plan);
  if (category === "activity") {
    return activityProviderSearchUrl(
      item.provider,
      [item.item, item.title, item.provider, plan.location].filter(Boolean).join(" ")
    );
  }
  return "";
}

export function actionLabelForCategory(category, rawUrl = "") {
  if (category === "hotel") {
    if (isGoogleMapsUrl(rawUrl)) return "View hotel";
    if (isZenHotelsSearchUrl(rawUrl)) return "Search hotels";
    return "Book hotel";
  }
  if (category === "transfer") return "Book transfer";
  if (category === "insurance") return "Get insurance";
  if (category === "flight") return "Find flight";
  if (category === "activity") return isGoogleMapsUrl(rawUrl) ? "Open place" : "Find tickets";
  return isGoogleMapsUrl(rawUrl) ? "Open place" : "Open link";
}

export function sourceForUrl(category, rawUrl = "", fallbackSource = "") {
  const { host } = urlParts(rawUrl);
  if (!host) return fallbackSource || "missing";
  if (category === "transfer" && host.includes("gettransfer")) return fallbackSource || "transfer_provider";
  if (category === "insurance" && host.includes("axa")) return fallbackSource || "insurance_provider";
  if (category === "insurance" && host.includes("allianz")) return fallbackSource || "insurance_provider";
  if (category === "flight" && host.includes("skyscanner")) return fallbackSource || "flight_search";
  if (category === "hotel" && isZenHotelsHotelPageUrl(rawUrl)) return fallbackSource || "zen_exact_property";
  if (category === "hotel" && isZenHotelsSearchUrl(rawUrl)) return fallbackSource || "zen_search";
  if (isGoogleMapsUrl(rawUrl)) return fallbackSource || "google_maps";
  if (isActivityProviderUrl(rawUrl)) return fallbackSource || "activity_provider";
  return fallbackSource || "provider_link";
}

export function confidenceForAction(category, rawUrl = "", { corrected = false } = {}) {
  if (!rawUrl) return "none";
  if (!isUrlCompatibleWithCategory(category, rawUrl)) return "low";
  if (corrected) return "medium";
  if (category === "hotel" && isZenHotelsSearchUrl(rawUrl)) return "medium";
  if (category === "hotel" && isZenHotelsHotelPageUrl(rawUrl)) return "high";
  if (category === "transfer" || category === "insurance" || category === "flight") return "medium";
  if (category === "activity" && !isGenericProviderUrl(rawUrl)) return "high";
  return isGenericProviderUrl(rawUrl) ? "medium" : "high";
}

function verifiedForAction(category, rawUrl = "", confidence = "none") {
  if (!rawUrl || confidence === "low" || confidence === "none") return false;
  if (category === "hotel") return isZenHotelsHotelPageUrl(rawUrl) || isGoogleMapsUrl(rawUrl);
  if (category === "activity") return !isGenericProviderUrl(rawUrl);
  return !isGenericProviderUrl(rawUrl);
}

function issue(code, severity, message, path, details = {}) {
  return { code, severity, message, path, details };
}

function summarizeBookingActions(items = []) {
  const actions = items.map((item) => item.bookingAction).filter(Boolean);
  const confidence = actions.reduce((acc, action) => {
    const key = action.confidence || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    total: items.length,
    actionable: actions.filter((action) => action.actionable).length,
    verified: actions.filter((action) => action.verified).length,
    referralApplied: actions.filter((action) => action.referralApplied).length,
    confidence,
    warnings: [
      actions.some((action) => !action.actionable) ? "Some items do not have an actionable booking URL." : "",
      actions.some((action) => action.confidence === "low") ? "Some actions are low-confidence provider links." : "",
      actions.some((action) => action.corrected) ? "Some booking actions were corrected by plan guardrails." : "",
    ].filter(Boolean),
  };
}

export function guardBookingItem(item = {}, { plan = {}, path = "costBreakdown[]" } = {}) {
  const issues = [];
  const category = classifyBookingItem(item);
  const action = item.bookingAction || item.booking_action || {};
  const originalUrl = clean(action.url || action.booking_url || item.booking_url || item.bookingUrl);
  let url = originalUrl;
  let corrected = false;
  let fallbackSource = "";

  if (url && !isUrlCompatibleWithCategory(category, url)) {
    issues.push(issue(
      "booking_url_category_mismatch",
      "error",
      `Replaced ${category} booking URL because it pointed to an incompatible provider.`,
      path,
      { originalUrl, category }
    ));
    url = "";
    corrected = true;
  }

  if (!url || isGenericProviderUrl(url)) {
    const fallback = fallbackUrlForCategory(category, item, plan);
    if (fallback && fallback !== url) {
      issues.push(issue(
        url ? "booking_url_generic_fallback" : "booking_url_missing_fallback",
        url ? "warning" : "info",
        `Using ${category} fallback booking action.`,
        path,
        { originalUrl: url || originalUrl, fallback }
      ));
      url = fallback;
      corrected = true;
      fallbackSource = `${category}_fallback`;
    }
  }

  if (url) item.booking_url = url;

  const confidence = confidenceForAction(category, url, { corrected });
  item.bookingAction = {
    type: category,
    label: actionLabelForCategory(category, url),
    url: url || "",
    source: sourceForUrl(category, url, fallbackSource),
    confidence,
    referralApplied: category === "hotel" && urlParts(url).host === "zenhotels.com",
    actionable: Boolean(url),
    verified: verifiedForAction(category, url, confidence),
    exactProperty: category === "hotel" ? isZenHotelsHotelPageUrl(url) : undefined,
    corrected,
  };

  item.sourceConfidence = {
    ...(item.sourceConfidence || {}),
    category,
    confidence,
    source: item.bookingAction.source,
  };

  return { item, category, originalUrl, finalUrl: url, corrected, issues };
}

function allEvents(plan = {}) {
  return (Array.isArray(plan.itinerary) ? plan.itinerary : [])
    .flatMap((day, dayIndex) =>
      (Array.isArray(day.events) ? day.events : [])
        .map((event, eventIndex) => ({ event, path: `itinerary[${dayIndex}].events[${eventIndex}]` }))
    );
}

export function guardPlan(plan = {}, options = {}) {
  if (!plan || typeof plan !== "object") return plan;

  const issues = [];
  const costItems = Array.isArray(plan.costBreakdown) ? plan.costBreakdown : [];
  plan.costBreakdown = costItems;

  let correctedCount = 0;
  const categoryCounts = {};

  costItems.forEach((item, index) => {
    const result = guardBookingItem(item, { plan, path: `costBreakdown[${index}]` });
    categoryCounts[result.category] = (categoryCounts[result.category] || 0) + 1;
    if (result.corrected) correctedCount += 1;
    issues.push(...result.issues);
  });

  for (const { event, path } of allEvents(plan)) {
    const category = classifyBookingItem(event);
    if (category === "transfer") {
      event.type = "transfer";
      event.icon = event.icon && event.icon !== "flight" ? event.icon : "transfer";
      if (/\bflight segment\b/i.test(clean(event.title))) event.title = "Private transfer";
    }
    if (event.booking_url && !isUrlCompatibleWithCategory(category, event.booking_url)) {
      issues.push(issue(
        "event_url_category_mismatch",
        "warning",
        `Removed incompatible ${category} event booking URL.`,
        path,
        { originalUrl: event.booking_url, category }
      ));
      delete event.booking_url;
      correctedCount += 1;
    }
  }

  const severityCounts = issues.reduce((acc, item) => {
    acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  }, {});

  plan.guardrails = {
    version: PLAN_GUARD_VERSION,
    status: severityCounts.error ? "corrected" : issues.length ? "warnings" : "passed",
    correctedCount,
    categoryCounts,
    issueCounts: severityCounts,
    issues,
  };
  plan.bookingActionSummary = summarizeBookingActions(costItems);

  if (options.throwOnError && severityCounts.error) {
    const error = new Error("Plan guard detected unrecoverable booking issues");
    error.guardrails = plan.guardrails;
    throw error;
  }

  return plan;
}

export default {
  classifyBookingItem,
  guardBookingItem,
  guardPlan,
  isUrlCompatibleWithCategory,
};
