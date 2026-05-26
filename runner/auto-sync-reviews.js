#!/usr/bin/env node
"use strict";
/**
 * Auto-sync reviews — ดึงรีวิวลูกค้าจาก Grab Merchant Portal
 *
 * Pattern: คล้าย auto-sync.js แต่จับ feedback APIs
 *
 * APIs (discovered 2026-05-25):
 *   GET  https://api.grab.com/food/merchant/v1/feedback/overview  (rating summary)
 *   POST https://api.grab.com/food/merchant/v1/feedback/reviews   (review list)
 *
 * แต่ละ account ของ Grab Merchant ผูกกับ merchant group หนึ่ง (มี ≥1 สาขา)
 * เมื่อเข้าหน้า /feedback, SPA query ทุกสาขาใน group เดียวกันพร้อมกัน
 *
 * Logic:
 *   1. CDP attach Chrome 9222 (ต้อง login อยู่)
 *   2. Navigate /feedback (sidebar click)
 *   3. Intercept feedback/overview + feedback/reviews
 *   4. Group reviews by merchantID, save + POST server
 *
 * Usage:
 *   node auto-sync-reviews.js                   # capture for currently logged-in account
 *
 * Schedule via multi-account orchestrator (เหมือน menu sync)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const WAIT_MAX = Number(process.env.WAIT_MAX_REVIEWS || 30);

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `auto-sync-reviews-${new Date().toISOString().slice(0, 10)}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeReview(r) {
  return {
    reviewId: r.reviewID,
    createdAt: r.createdAt,
    rating: r.rating,
    text: r.description || "",
    orderId: r.orderID || null,
    customerName: r.eaterName || null,
    status: r.status,
    orderedItems: r.orderedItems || [],
    recommendedItems: r.recommendedItems || [],
    merchantId: r.merchantID,
    merchantName: r.merchantName,
    serviceType: r.serviceType,
    aspects: (r.reviewAspects || []).map((a) => ({
      id: a.aspectId,
      name: a.aspectName,
      reason: a.reason,
    })),
    replies: (r.reviewReplies || [])
      .filter((rp) => rp)
      .map((rp) => ({
        replyId: rp.replyID,
        createdAt: rp.createdAt,
        text: rp.description || "",
        author: rp.repliedBy || null,
      })),
    images: r.paxReviewImageUrls || [],
    isNew: r.isNew === true,
    lastModifiedAt: r.contentLastModifiedAt,
  };
}

function normalizeOverview(o) {
  if (!o) return null;
  const dist = {};
  for (const d of o.ratingDistribution || []) dist[d.score] = d.countPercentage;
  return {
    avgRating: o.aggregatedRatingScore,
    ratingCount: o.ratingCount,
    distribution: dist,
  };
}

async function captureFeedback(page) {
  let overviewJson = null;
  let reviewsJson = null;
  let queriedMerchantIDs = [];

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!url.includes("api.grab.com/food/merchant/v1/feedback")) return;
      if (response.status() !== 200) return;
      const j = JSON.parse(await response.text());
      if (url.includes("/feedback/overview") && j.feedbackOverview) {
        overviewJson = j.feedbackOverview;
      }
      if (url.includes("/feedback/reviews") && response.request().method() === "POST" && j.reviews) {
        reviewsJson = j.reviews;
        try {
          const body = JSON.parse(response.request().postData() || "{}");
          if (body.merchantIDs) queriedMerchantIDs = body.merchantIDs;
        } catch {}
      }
    } catch {}
  };
  page.on("response", onResponse);

  // Navigate to /feedback. Prefer sidebar click (SPA route) — page.goto direct can lose session.
  log(`  Navigating to /feedback…`);
  const currentUrl = page.url();
  let clicked = false;

  // If already on a merchant.grab.com SPA page, try sidebar click
  if (currentUrl.includes("merchant.grab.com") && !currentUrl.includes("login")) {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
    try {
      clicked = await page.evaluate(() => {
        const fb = [...document.querySelectorAll("li")].find((l) => l.innerText.trim() === "ฟีดแบก");
        if (!fb) return false;
        (fb.querySelector('a, [role="button"]') || fb).click();
        return true;
      });
    } catch {}
  }

  if (!clicked) {
    // Fallback: hard navigate
    try {
      await page.goto("https://merchant.grab.com/feedback", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      page.off("response", onResponse);
      return { ok: false, error: `nav: ${err.message}` };
    }
  }

  // Wait for both feedback responses
  const start = Date.now();
  while ((!reviewsJson || !overviewJson) && Date.now() - start < WAIT_MAX * 1000) {
    await sleep(500);
  }
  page.off("response", onResponse);

  if (!reviewsJson && !overviewJson) {
    return { ok: false, error: "no feedback response within timeout (not logged in? or no branches?)" };
  }

  // Group reviews by merchantID
  const byMerchant = {};
  for (const r of reviewsJson || []) {
    const mid = r.merchantID || "unknown";
    if (!byMerchant[mid]) {
      byMerchant[mid] = {
        merchantId: mid,
        merchantName: r.merchantName,
        reviews: [],
      };
    }
    byMerchant[mid].reviews.push(normalizeReview(r));
  }
  // Ensure all queried merchants appear, even if 0 reviews
  for (const mid of queriedMerchantIDs) {
    if (!byMerchant[mid]) byMerchant[mid] = { merchantId: mid, merchantName: null, reviews: [] };
  }

  return {
    ok: true,
    overview: normalizeOverview(overviewJson),
    queriedMerchantIDs,
    branches: byMerchant,
    capturedAt: Date.now(),
  };
}

async function postToServer(payload) {
  const headers = { "Content-Type": "application/json" };
  if (SYNC_TOKEN) headers["X-Sync-Token"] = SYNC_TOKEN;
  try {
    const r = await fetch(`${SYNC_SERVER}/api/sync-reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    return j.ok ? { ok: true } : { ok: false, error: j.error || `status ${r.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function saveLocalSnapshot(data) {
  const file = path.resolve(__dirname, "..", "server-reviews.json");
  let store = { branches: {}, syncedAt: null };
  try { store = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  for (const [mid, branchData] of Object.entries(data.branches)) {
    store.branches[mid] = {
      ...branchData,
      overview: data.overview, // overview is for whole group; could split per-branch later
      capturedAt: data.capturedAt,
    };
  }
  store.syncedAt = Date.now();
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

async function main() {
  log(`╔══ Auto-sync reviews ══╗`);
  log(`CDP: ${CDP_URL}  │  Server: ${SYNC_SERVER}`);

  log(`Connecting to Chrome…`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { log("✗ No browser context"); process.exit(1); }
  const page =
    ctx.pages().find((p) => p.url().includes("merchant.grab.com")) ||
    ctx.pages()[0] ||
    (await ctx.newPage());

  log(`Current page: ${page.url()}`);
  const r = await captureFeedback(page).catch((e) => ({ ok: false, error: e.message }));

  if (r.ok) {
    const branchCount = Object.keys(r.branches).length;
    const totalReviews = Object.values(r.branches).reduce((s, b) => s + b.reviews.length, 0);
    log(`✓ captured ${totalReviews} reviews across ${branchCount} branches`);
    log(`  overview: avg ${r.overview?.avgRating?.toFixed(2)} (${r.overview?.ratingCount} ratings total)`);
    for (const [mid, b] of Object.entries(r.branches)) {
      log(`    ${mid} (${b.merchantName?.slice(0, 50) || "?"}): ${b.reviews.length} reviews`);
    }

    // Try server, fallback local
    const pushed = await postToServer(r);
    if (pushed.ok) {
      log(`✓ pushed to server`);
    } else {
      log(`⚠ server: ${pushed.error} — saving locally (server-reviews.json)`);
      saveLocalSnapshot(r);
    }
  } else {
    log(`✗ ${r.error}`);
  }

  await browser.close();
}

main().catch((err) => { log(`Fatal: ${err.message}`); process.exit(1); });
