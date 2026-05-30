import {
  actionLabelForCategory,
  classifyBookingItem,
  confidenceForAction,
  fallbackUrlForCategory,
  isGenericProviderUrl,
  isGoogleMapsUrl,
  isUrlCompatibleWithCategory,
  isZenHotelsHotelPageUrl,
  isZenHotelsSearchUrl,
  sourceForUrl,
  urlParts,
} from "./plan-guard.js";

const LINK_VERIFIER_VERSION = "2026-05-30";
const DEFAULT_TIMEOUT_MS = Number(process.env.LINK_VERIFY_TIMEOUT_MS || 3500);
const DEFAULT_CONCURRENCY = Number(process.env.LINK_VERIFY_CONCURRENCY || 4);
const DEFAULT_CACHE_TTL_MS = Number(process.env.LINK_VERIFY_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const DEFAULT_MAX_CACHE_ENTRIES = Number(process.env.LINK_VERIFY_MAX_CACHE_ENTRIES || 750);
const BODY_SNIPPET_BYTES = Number(process.env.LINK_VERIFY_BODY_BYTES || 65536);

const verificationCache = new Map();

const NOT_FOUND_PATTERNS = [
  /\b(page|content|listing|offer|hotel|activity|experience)\s+(not\s+found|not\s+available|does\s+not\s+exist|doesn't\s+exist)\b/i,
  /\b(this|that)\s+(page|listing|offer|hotel|activity|experience)\s+(is\s+)?(unavailable|no\s+longer\s+available|missing)\b/i,
  /\b404\b.{0,80}\b(not\s+found|page\s+not\s+found|error)\b/i,
  /\b(page\s+not\s+found|not\s+found\s+404|error\s+404)\b/i,
  /\bsorry,?\s+(we\s+)?(could\s+not|couldn't|can't|cannot)\s+find\b/i,
  /\boops\b.{0,100}\b(not\s+found|missing|unavailable)\b/i,
];

const BLOCKED_HEAD_STATUSES = new Set([401, 403, 405, 406, 501]);
const DEFINITIVE_FAILURE_REASONS = new Set([
  "bad_status",
  "forbidden",
  "not_found",
  "gone",
  "soft_not_found",
  "too_many_requests",
]);

function clean(value) {
  return String(value || "").trim();
}

function compactUrl(rawUrl = "") {
  try {
    return new URL(clean(rawUrl)).toString();
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeStatusText(status) {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  if (status === 429) return "too_many_requests";
  if (status >= 400) return "bad_status";
  return "ok";
}

function normalizeBodySnippet(value = "") {
  return clean(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 6000);
}

function detectSoftNotFound(snippet = "") {
  const normalized = normalizeBodySnippet(snippet);
  if (!normalized) return false;
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function readBodySnippet(response, maxBytes = BODY_SNIPPET_BYTES) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let received = 0;

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = value.slice(0, Math.max(0, maxBytes - received));
      chunks.push(decoder.decode(chunk, { stream: true }));
      received += chunk.byteLength;
      if (received >= maxBytes) break;
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response body may already be closed.
    }
  }

  return chunks.join("");
}

function cacheKey(rawUrl = "") {
  return compactUrl(rawUrl);
}

function getCached(rawUrl, cache, ttlMs) {
  const key = cacheKey(rawUrl);
  if (!key || !cache?.has(key)) return null;
  const cached = cache.get(key);
  if (!cached || Date.now() - cached.cachedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return {
    ...cached.result,
    cached: true,
  };
}

function setCached(rawUrl, result, cache, maxEntries) {
  const key = cacheKey(rawUrl);
  if (!key || !cache) return;
  if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, {
    cachedAt: Date.now(),
    result: {
      ...result,
      cached: false,
    },
  });
}

async function fetchWithTimeout(rawUrl, method, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      method,
      ok: false,
      status: 0,
      reason: "fetch_unavailable",
      finalUrl: rawUrl,
      bodyChecked: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(rawUrl, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "NuviaTravel-LinkVerifier/1.0 (+https://nuvia.travel)",
        ...(method === "GET" ? { range: `bytes=0-${BODY_SNIPPET_BYTES - 1}` } : {}),
      },
    });

    const status = Number(response.status || 0);
    const finalUrl = response.url || rawUrl;
    let snippet = "";
    let bodyChecked = false;

    if (method === "GET" && status >= 200 && status < 400) {
      snippet = await readBodySnippet(response, BODY_SNIPPET_BYTES);
      bodyChecked = true;
    }

    const softNotFound = method === "GET" && detectSoftNotFound(snippet);
    const ok = status >= 200 && status < 400 && !softNotFound;

    return {
      method,
      ok,
      status,
      reason: softNotFound ? "soft_not_found" : safeStatusText(status),
      finalUrl,
      bodyChecked,
    };
  } catch (error) {
    return {
      method,
      ok: false,
      status: 0,
      reason: error?.name === "AbortError" ? "timeout" : "network_error",
      finalUrl: rawUrl,
      bodyChecked: false,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function combineAttempts(rawUrl, attempts, checkedAt) {
  const last = attempts[attempts.length - 1] || {};
  return {
    version: LINK_VERIFIER_VERSION,
    url: rawUrl,
    ok: Boolean(last.ok),
    status: Number(last.status || 0),
    method: last.method || "NONE",
    reason: last.reason || "unknown",
    finalUrl: last.finalUrl || rawUrl,
    bodyChecked: Boolean(last.bodyChecked),
    cached: false,
    checkedAt,
    attempts: attempts.map((attempt) => ({
      method: attempt.method,
      status: attempt.status,
      reason: attempt.reason,
      ok: attempt.ok,
    })),
  };
}

export async function verifyUrl(rawUrl = "", options = {}) {
  const url = compactUrl(rawUrl);
  const checkedAt = nowIso();

  if (!url) {
    return {
      version: LINK_VERIFIER_VERSION,
      url: rawUrl,
      ok: false,
      status: 0,
      method: "NONE",
      reason: "invalid_url",
      finalUrl: rawUrl,
      bodyChecked: false,
      cached: false,
      checkedAt,
      attempts: [],
    };
  }

  const cache = options.cache === false ? null : options.cache || verificationCache;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = getCached(url, cache, ttlMs);
  if (cached) return cached;

  const attempts = [];
  const head = await fetchWithTimeout(url, "HEAD", options);
  attempts.push(head);

  if (head.ok || BLOCKED_HEAD_STATUSES.has(head.status)) {
    const get = await fetchWithTimeout(url, "GET", options);
    attempts.push(get);
    if (!get.ok && head.ok && ["network_error", "timeout"].includes(get.reason)) {
      attempts.push({
        ...head,
        reason: "head_ok_body_unverified",
        bodyChecked: false,
      });
    }
  }

  const result = combineAttempts(url, attempts, checkedAt);
  setCached(url, result, cache, options.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  return result;
}

function isDefinitiveFailure(result = {}) {
  if (!result || result.ok) return false;
  if (DEFINITIVE_FAILURE_REASONS.has(result.reason)) return true;
  return Number(result.status || 0) >= 400;
}

function verificationSummary(result = {}) {
  return {
    ok: Boolean(result.ok),
    status: Number(result.status || 0),
    method: result.method || "NONE",
    reason: result.reason || "unknown",
    finalUrl: result.finalUrl || result.url || "",
    bodyChecked: Boolean(result.bodyChecked),
    cached: Boolean(result.cached),
    checkedAt: result.checkedAt || nowIso(),
  };
}

function directVerifiedForCategory(category, rawUrl = "", verification = {}) {
  if (!verification.ok) return false;
  if (category === "hotel") return isZenHotelsHotelPageUrl(rawUrl) || isGoogleMapsUrl(rawUrl);
  if (category === "activity") return !isGenericProviderUrl(rawUrl);
  return !isGenericProviderUrl(rawUrl);
}

function liveConfidence(category, rawUrl, verification, corrected) {
  if (!verification.ok) return "none";
  const base = confidenceForAction(category, rawUrl, { corrected });
  if (!verification.bodyChecked && base === "high") return "medium";
  return base;
}

function applyUrlToItem(item, category, rawUrl, verification, options = {}) {
  const corrected = Boolean(options.corrected || item.bookingAction?.corrected);
  const confidence = liveConfidence(category, rawUrl, verification, corrected);
  const source = sourceForUrl(category, rawUrl, options.source);

  item.booking_url = rawUrl;
  item.bookingAction = {
    ...(item.bookingAction || {}),
    type: category,
    label: actionLabelForCategory(category, rawUrl),
    url: rawUrl,
    source,
    confidence,
    referralApplied: category === "hotel" && urlParts(rawUrl).host === "zenhotels.com",
    actionable: Boolean(rawUrl),
    verified: directVerifiedForCategory(category, rawUrl, verification),
    exactProperty: category === "hotel" ? isZenHotelsHotelPageUrl(rawUrl) : undefined,
    corrected,
    liveVerified: Boolean(verification.ok),
    linkVerification: verificationSummary(verification),
  };

  item.sourceConfidence = {
    ...(item.sourceConfidence || {}),
    category,
    confidence,
    source,
    liveVerified: Boolean(verification.ok),
  };
}

function clearItemUrl(item, category, verification, reason = "link_unavailable") {
  delete item.booking_url;
  item.bookingAction = {
    ...(item.bookingAction || {}),
    type: category,
    label: "Link unavailable",
    url: "",
    source: reason,
    confidence: "none",
    referralApplied: false,
    actionable: false,
    verified: false,
    exactProperty: category === "hotel" ? false : undefined,
    corrected: true,
    liveVerified: false,
    linkVerification: verificationSummary(verification),
  };

  item.sourceConfidence = {
    ...(item.sourceConfidence || {}),
    category,
    confidence: "none",
    source: reason,
    liveVerified: false,
  };
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
    liveVerified: actions.filter((action) => action.liveVerified).length,
    referralApplied: actions.filter((action) => action.referralApplied).length,
    confidence,
    warnings: [
      actions.some((action) => !action.actionable) ? "Some items do not have an actionable booking URL." : "",
      actions.some((action) => action.confidence === "none") ? "Some booking links were unavailable during live verification." : "",
      actions.some((action) => action.corrected) ? "Some booking actions were corrected by plan guardrails." : "",
    ].filter(Boolean),
  };
}

function collectEvents(plan = {}) {
  return (Array.isArray(plan.itinerary) ? plan.itinerary : [])
    .flatMap((day, dayIndex) =>
      (Array.isArray(day.events) ? day.events : [])
        .map((event, eventIndex) => ({ event, path: `itinerary[${dayIndex}].events[${eventIndex}]` }))
    );
}

async function mapLimit(items, limit, worker) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const promise = Promise.resolve().then(() => worker(item));
    results.push(promise);
    executing.add(promise);
    const cleanup = () => executing.delete(promise);
    promise.then(cleanup, cleanup);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

async function verifyCostItem(item, index, plan, options) {
  const category = classifyBookingItem(item);
  const action = item.bookingAction || {};
  const originalUrl = clean(action.url || item.booking_url || item.bookingUrl);
  const path = `costBreakdown[${index}]`;

  if (!originalUrl) {
    clearItemUrl(item, category, { reason: "missing_url", checkedAt: nowIso() }, "missing_url");
    return {
      path,
      category,
      status: "missing",
      originalUrl: "",
      finalUrl: "",
      issue: "missing_url",
    };
  }

  if (!isUrlCompatibleWithCategory(category, originalUrl)) {
    clearItemUrl(item, category, { reason: "category_mismatch", checkedAt: nowIso() }, "category_mismatch");
    return {
      path,
      category,
      status: "cleared",
      originalUrl,
      finalUrl: "",
      issue: "category_mismatch",
    };
  }

  const originalVerification = await verifyUrl(originalUrl, options);
  if (originalVerification.ok) {
    applyUrlToItem(item, category, originalUrl, originalVerification);
    return {
      path,
      category,
      status: "passed",
      originalUrl,
      finalUrl: originalUrl,
      verification: verificationSummary(originalVerification),
    };
  }

  const fallback = fallbackUrlForCategory(category, item, plan);
  if (fallback && fallback !== originalUrl && isUrlCompatibleWithCategory(category, fallback)) {
    const fallbackVerification = await verifyUrl(fallback, options);
    if (fallbackVerification.ok) {
      applyUrlToItem(item, category, fallback, fallbackVerification, {
        corrected: true,
        source: `${category}_verified_fallback`,
      });
      return {
        path,
        category,
        status: "replaced",
        originalUrl,
        finalUrl: fallback,
        issue: originalVerification.reason,
        verification: verificationSummary(originalVerification),
        fallbackVerification: verificationSummary(fallbackVerification),
      };
    }
  }

  if (isDefinitiveFailure(originalVerification)) {
    clearItemUrl(item, category, originalVerification);
    return {
      path,
      category,
      status: "cleared",
      originalUrl,
      finalUrl: "",
      issue: originalVerification.reason,
      verification: verificationSummary(originalVerification),
    };
  }

  applyUrlToItem(item, category, originalUrl, originalVerification);
  item.bookingAction.liveVerified = false;
  item.bookingAction.verified = false;
  return {
    path,
    category,
    status: "unverified",
    originalUrl,
    finalUrl: originalUrl,
    issue: originalVerification.reason,
    verification: verificationSummary(originalVerification),
  };
}

async function verifyEventUrl(event, path, options) {
  const category = classifyBookingItem(event);
  const originalUrl = clean(event.booking_url || event.bookingUrl);
  if (!originalUrl) return null;

  const verification = await verifyUrl(originalUrl, options);
  if (verification.ok) {
    event.linkVerification = verificationSummary(verification);
    return {
      path,
      category,
      status: "passed",
      originalUrl,
      finalUrl: originalUrl,
      verification: verificationSummary(verification),
    };
  }

  if (isDefinitiveFailure(verification)) {
    delete event.booking_url;
    event.linkVerification = verificationSummary(verification);
    return {
      path,
      category,
      status: "cleared",
      originalUrl,
      finalUrl: "",
      issue: verification.reason,
      verification: verificationSummary(verification),
    };
  }

  event.linkVerification = verificationSummary(verification);
  return {
    path,
    category,
    status: "unverified",
    originalUrl,
    finalUrl: originalUrl,
    issue: verification.reason,
    verification: verificationSummary(verification),
  };
}

export async function verifyPlanLinks(plan = {}, options = {}) {
  if (!plan || typeof plan !== "object") return plan;

  const enabled = options.enabled ?? process.env.VERIFY_BOOKING_LINKS !== "false";
  const costItems = Array.isArray(plan.costBreakdown) ? plan.costBreakdown : [];
  if (!enabled) {
    plan.linkVerification = {
      version: LINK_VERIFIER_VERSION,
      enabled: false,
      checkedAt: nowIso(),
      total: costItems.length,
      warnings: ["Live link verification is disabled."],
    };
    return plan;
  }

  const concurrency = Math.max(1, Number(options.concurrency || DEFAULT_CONCURRENCY));
  const costResults = await mapLimit(costItems.map((item, index) => ({ item, index })), concurrency, ({ item, index }) =>
    verifyCostItem(item, index, plan, options)
  );
  const eventResults = (await mapLimit(collectEvents(plan), concurrency, ({ event, path }) =>
    verifyEventUrl(event, path, options)
  )).filter(Boolean);

  const results = [...costResults, ...eventResults];
  const counts = results.reduce((acc, result) => {
    const key = result.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  plan.bookingActionSummary = summarizeBookingActions(costItems);
  plan.linkVerification = {
    version: LINK_VERIFIER_VERSION,
    enabled: true,
    checkedAt: nowIso(),
    total: results.length,
    costItems: costResults.length,
    events: eventResults.length,
    passed: counts.passed || 0,
    replaced: counts.replaced || 0,
    cleared: counts.cleared || 0,
    unverified: counts.unverified || 0,
    missing: counts.missing || 0,
    counts,
    warnings: [
      counts.replaced ? "Some broken links were replaced with verified fallback links." : "",
      counts.cleared ? "Some broken links were removed because no verified fallback was available." : "",
      counts.unverified ? "Some links could not be live-verified and were marked unverified." : "",
    ].filter(Boolean),
    issues: results
      .filter((result) => ["replaced", "cleared", "unverified", "missing"].includes(result.status))
      .map((result) => ({
        code: `link_${result.status}`,
        severity: result.status === "unverified" ? "warning" : "error",
        message: `Link verification ${result.status} ${result.category} URL.`,
        path: result.path,
        details: {
          category: result.category,
          originalUrl: result.originalUrl,
          finalUrl: result.finalUrl,
          issue: result.issue,
          verification: result.verification,
          fallbackVerification: result.fallbackVerification,
        },
      })),
  };

  return plan;
}

export default {
  verifyPlanLinks,
  verifyUrl,
};
