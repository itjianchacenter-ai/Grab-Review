#!/usr/bin/env node
"use strict";
/**
 * Multi-account orchestrator — REVIEWS
 *
 * Same pattern as multi-account-sync.js (for menu) — adapted for reviews.
 * One feedback call per account captures ALL branches under that account.
 *
 * Logic:
 *   1. CDP attach Chrome 9222
 *   2. Group vault entries by username
 *   3. For each account:
 *      a. Clear grab.com cookies
 *      b. Login via login.js
 *      c. Navigate /feedback → capture overview + reviews
 *      d. POST /api/sync-reviews
 *      e. Sleep before next
 *   4. Circuit breaker on consecutive login fails
 *
 * Usage:
 *   node multi-account-sync-reviews.js                       # all accounts
 *   node multi-account-sync-reviews.js --account mkt.fc08    # one account
 *   node multi-account-sync-reviews.js --skip-fresh-hours 6  # skip recently captured
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");
const { isLoggedIn } = require("./login");

// ════════════════════════════════════════════════════════════
// Lock file
// ════════════════════════════════════════════════════════════
const LOCK_FILE = path.resolve(__dirname, "logs/.sync-reviews.lock");
const LOCK_STALE_MS = 60 * 60 * 1000;

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const FORCE = process.env.FORCE_LOCK === "1";
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      const age = Date.now() - data.ts;
      let alive = false;
      try { process.kill(data.pid, 0); alive = true; } catch {}
      if (FORCE) {
        console.error(`⚠ FORCE_LOCK=1 — overriding existing lock`);
      } else if (alive && age < LOCK_STALE_MS) {
        console.error(`✗ Lock held by pid ${data.pid} (age ${Math.round(age/1000)}s)`);
        process.exit(2);
      }
    } catch {}
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
  process.on("uncaughtException", (e) => { console.error("Fatal:", e); release(); process.exit(1); });
}

// ════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const WAIT_MAX = Number(process.env.WAIT_MAX_REVIEWS || 45);
const DELAY_ACCOUNT = Number(process.env.DELAY_ACCOUNT || 15);
const JITTER_MIN = Number(process.env.JITTER_MIN || 3);
const JITTER_MAX = Number(process.env.JITTER_MAX || 8);
const CIRCUIT_BREAKER = Number(process.env.CIRCUIT_BREAKER || 3);
const MAX_PAGES = Number(process.env.MAX_PAGES || 50); // pagination cap per account (~1000 reviews)
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || 300); // pacing between paginated requests

// CLI args
const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
}
const ONE_ACCOUNT = flag("--account");
const SKIP_FRESH_HOURS = Number(flag("--skip-fresh-hours") || 0);
const SHUFFLE = flag("--shuffle") === true;

// ════════════════════════════════════════════════════════════
// Logging
// ════════════════════════════════════════════════════════════
const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `multi-account-reviews-${new Date().toISOString().slice(0, 10)}.log`);
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// Capture (per-account)
// ════════════════════════════════════════════════════════════
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
      id: a.aspectId, name: a.aspectName, reason: a.reason,
    })),
    replies: (r.reviewReplies || []).filter((rp) => rp).map((rp) => ({
      replyId: rp.replyID, createdAt: rp.createdAt,
      text: rp.description || "", author: rp.repliedBy || null,
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
  return { avgRating: o.aggregatedRatingScore, ratingCount: o.ratingCount, distribution: dist };
}

// Explicit per-merchant query — bypass SPA's cityID filter to also reach branches outside Bangkok
async function queryMerchantReviews(page, merchantId, reqHeaders, dateRange) {
  const all = [];
  let nextToken = null;
  let pages = 0;
  while (pages < MAX_PAGES) {
    const body = {
      serviceType: "DELIVERY",
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      merchantIDs: [merchantId],
      businessTypeFilter: 0,
      include_empty_reviews: false,
    };
    if (nextToken) body.nextToken = nextToken;
    try {
      const resp = await page.request.fetch(
        "https://api.grab.com/food/merchant/v1/feedback/reviews",
        { method: "POST", headers: reqHeaders, data: body }
      );
      if (resp.status() !== 200) return { ok: false, status: resp.status(), reviews: all };
      const j = await resp.json();
      const r = j.reviews || [];
      if (r.length === 0) break;
      all.push(...r);
      nextToken = j.nextToken || null;
      pages++;
      if (!nextToken) break;
      await sleep(PAGE_DELAY_MS);
    } catch (e) {
      return { ok: false, error: e.message, reviews: all };
    }
  }
  return { ok: true, reviews: all, pages };
}

async function captureFeedback(page, accountBranchIds = []) {
  let overviewJson = null;
  let firstReviewsJson = null;
  let firstNextToken = null;
  let initialReqBody = null;
  let initialReqHeaders = null;
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
        firstReviewsJson = j.reviews;
        firstNextToken = j.nextToken || null;
        try {
          const req = response.request();
          initialReqBody = JSON.parse(req.postData() || "{}");
          initialReqHeaders = req.headers();
          if (initialReqBody.merchantIDs) queriedMerchantIDs = initialReqBody.merchantIDs;
        } catch {}
      }
    } catch {}
  };
  page.on("response", onResponse);

  // Navigate to /feedback via SPA sidebar click
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);

  let clicked = false;
  try {
    clicked = await page.evaluate(() => {
      const fb = [...document.querySelectorAll("li")].find((l) => l.innerText.trim() === "ฟีดแบก");
      if (!fb) return false;
      (fb.querySelector('a, [role="button"]') || fb).click();
      return true;
    });
  } catch {}

  if (!clicked) {
    try {
      await page.goto("https://merchant.grab.com/feedback", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      page.off("response", onResponse);
      return { ok: false, error: `nav: ${err.message}` };
    }
  }

  const start = Date.now();
  while ((!firstReviewsJson || !overviewJson) && Date.now() - start < WAIT_MAX * 1000) {
    await sleep(500);
  }
  page.off("response", onResponse);

  if (!firstReviewsJson && !overviewJson) {
    return { ok: false, error: "no feedback response within timeout" };
  }

  const allReviews = [...(firstReviewsJson || [])];

  // ─── Pagination via page.request.fetch — uses Playwright's browser context (cookies + headers) ───
  let nextToken = firstNextToken;
  let pageCount = 1;
  let paginationStopped = null;
  while (nextToken && pageCount < MAX_PAGES) {
    try {
      const body = { ...(initialReqBody || {}), nextToken };
      // Replay headers captured from initial request (drop pseudo-headers + ones we set)
      const replayHeaders = {};
      for (const [k, v] of Object.entries(initialReqHeaders || {})) {
        const lk = k.toLowerCase();
        if (lk.startsWith(":")) continue;
        if (["content-length", "content-type", "host", "cookie", "accept-encoding"].includes(lk)) continue;
        replayHeaders[k] = v;
      }
      replayHeaders["Content-Type"] = "application/json";

      const resp = await page.request.fetch(
        "https://api.grab.com/food/merchant/v1/feedback/reviews",
        { method: "POST", headers: replayHeaders, data: body }
      );
      const status = resp.status();
      if (status !== 200) {
        paginationStopped = `status ${status} on page ${pageCount + 1}`;
        break;
      }
      const j = await resp.json();
      const pageReviews = j.reviews || [];
      if (pageReviews.length === 0) break;
      allReviews.push(...pageReviews);
      nextToken = j.nextToken || null;
      pageCount++;
      if (!nextToken) break;
      await sleep(PAGE_DELAY_MS);
    } catch (e) {
      paginationStopped = `error on page ${pageCount + 1}: ${e.message}`;
      break;
    }
  }

  // ─── Fallback: explicit per-merchant query for vault branches missed by SPA scope ───
  const dateRange = {
    startDate: initialReqBody?.startDate || "2025-05-26T17:00:00.000Z",
    endDate: initialReqBody?.endDate || new Date().toISOString(),
  };
  const replayHeaders = {};
  for (const [k, v] of Object.entries(initialReqHeaders || {})) {
    const lk = k.toLowerCase();
    if (lk.startsWith(":")) continue;
    if (["content-length", "content-type", "host", "cookie", "accept-encoding"].includes(lk)) continue;
    replayHeaders[k] = v;
  }
  replayHeaders["Content-Type"] = "application/json";

  const seenIds = new Set(allReviews.map((r) => r.merchantID).filter(Boolean));
  const extraQueried = [];
  const knownNames = {}; // merchantId → name from vault (for 0-review branches)
  for (const b of (accountBranchIds.__withNames || [])) {
    if (b && b.id && b.name) knownNames[b.id] = b.name;
  }
  for (const mid of accountBranchIds) {
    if (seenIds.has(mid) || mid.startsWith("PLACEHOLDER")) continue;
    const r = await queryMerchantReviews(page, mid, replayHeaders, dateRange);
    extraQueried.push({ mid, ok: r.ok, count: r.reviews.length, status: r.status });
    if (r.ok && r.reviews.length > 0) allReviews.push(...r.reviews);
  }

  // Group by merchantID
  const byMerchant = {};
  for (const r of allReviews) {
    const mid = r.merchantID || "unknown";
    if (!byMerchant[mid]) byMerchant[mid] = { merchantId: mid, merchantName: r.merchantName, reviews: [] };
    byMerchant[mid].reviews.push(normalizeReview(r));
  }
  for (const mid of queriedMerchantIDs) {
    if (!byMerchant[mid]) byMerchant[mid] = { merchantId: mid, merchantName: null, reviews: [] };
  }
  // Inject names from vault for known 0-review branches so they pass server brand filter
  for (const [mid, name] of Object.entries(knownNames)) {
    if (byMerchant[mid] && !byMerchant[mid].merchantName) byMerchant[mid].merchantName = name;
    else if (!byMerchant[mid]) byMerchant[mid] = { merchantId: mid, merchantName: name, reviews: [] };
  }

  return {
    ok: true,
    overview: normalizeOverview(overviewJson),
    queriedMerchantIDs,
    branches: byMerchant,
    capturedAt: Date.now(),
    pagesFetched: pageCount,
    totalReviews: allReviews.length,
    paginationStopped,
    extraQueried,
  };
}

async function postToServer(payload) {
  const headers = { "Content-Type": "application/json" };
  if (SYNC_TOKEN) headers["X-Sync-Token"] = SYNC_TOKEN;
  try {
    const r = await fetch(`${SYNC_SERVER}/api/sync-reviews`, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    const j = await r.json();
    return j.ok ? { ok: true, newReviews: j.new_reviews || 0 } : { ok: false, error: j.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════════════
// Login / cookies helpers
// ════════════════════════════════════════════════════════════
async function clearCookies(ctx) {
  await ctx.clearCookies({ domain: ".grab.com" }).catch(() => {});
  await ctx.clearCookies({ domain: "merchant.grab.com" }).catch(() => {});
  await ctx.clearCookies({ domain: "portal.grab.com" }).catch(() => {});
  await ctx.clearCookies({ domain: "api.grab.com" }).catch(() => {});
  await ctx.clearCookies({ domain: "weblogin.grab.com" }).catch(() => {});
}

// Custom login flow — Grab no longer uses <button> elements, so we use text= selectors
async function doLogin(page, username, password) {
  // Step 1: get to fresh login form
  await page.goto("https://merchant.grab.com/portal", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Handle saved-accounts: click "another account"
  if (page.url().includes("/saved-accounts")) {
    const otherBtn = page
      .locator("text=ลงชื่อเข้าใช้ด้วยบัญชีอื่น")
      .or(page.locator("text=Log in with another account"));
    if ((await otherBtn.count()) === 0) {
      throw new Error(`/saved-accounts: no "another account" link`);
    }
    await otherBtn.first().click();
    await page.waitForURL((u) => !u.toString().includes("/saved-accounts"), { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  // If Grab auto-jumped to password challenge for cached user, navigate to fresh login
  if (page.url().includes("/challenge/")) {
    await page.goto(
      "https://weblogin.grab.com/merchant/login?service_id=MEXUSERS&redirect=https%3A%2F%2Fmerchant.grab.com%2Fportal",
      { waitUntil: "domcontentloaded", timeout: 30_000 }
    );
    await page.waitForTimeout(2000);
  }

  // Step 2: fill username + click ต่อไป
  await page.waitForSelector('input[type="text"], input[type="email"], input[autocomplete="username"]', { timeout: 20_000 });
  const userInput = page.locator('input[type="text"], input[type="email"], input[autocomplete="username"]').first();
  await userInput.fill(username);
  await page.waitForTimeout(500);
  await page.locator("text=ต่อไป").first().click();

  // Step 3: wait for password field
  await page.waitForSelector('input[type="password"]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.locator('input[type="password"]').fill(password);

  // Step 4: click ต่อไป to submit password
  await page.waitForTimeout(500);
  await page.locator("text=ต่อไป").first().click();

  // Step 5: wait for redirect away from weblogin
  try {
    await page.waitForURL((u) => !u.toString().includes("weblogin.grab.com"), { timeout: 30_000 });
  } catch {
    throw new Error("login did not redirect — wrong password / CAPTCHA / 2FA?");
  }
  await page.waitForTimeout(2000);
  if (!(await isLoggedIn(page))) throw new Error("still detected as not logged in");
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════
async function main() {
  acquireLock();
  log(`╔══ Multi-account REVIEWS sync ══╗`);
  log(`Server: ${SYNC_SERVER}  │  Skip fresh < ${SKIP_FRESH_HOURS}h  │  Delay account ${DELAY_ACCOUNT}s + jitter ${JITTER_MIN}-${JITTER_MAX}s`);

  const v = loadVault();
  const allBranches = (v.branches || []).filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));

  // Group by username
  const accounts = new Map();
  for (const b of allBranches) {
    if (!b.username || !b.password) continue;
    if (!accounts.has(b.username)) {
      accounts.set(b.username, { username: b.username, password: b.password, branches: [] });
    }
    accounts.get(b.username).branches.push(b);
  }

  let accountList = [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username));
  if (ONE_ACCOUNT && ONE_ACCOUNT !== true) {
    accountList = accountList.filter((a) => a.username === ONE_ACCOUNT);
    if (accountList.length === 0) {
      log(`✗ No account "${ONE_ACCOUNT}" found`); process.exit(1);
    }
  }
  if (SHUFFLE) {
    for (let i = accountList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accountList[i], accountList[j]] = [accountList[j], accountList[i]];
    }
    log(`🔀 Shuffled account order`);
  }

  // Skip accounts with recent sync
  if (SKIP_FRESH_HOURS > 0) {
    try {
      const r = await fetch(`${SYNC_SERVER}/api/reviews`, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const branches = d.branches || {};
        const cutoff = Date.now() - SKIP_FRESH_HOURS * 3600_000;
        const freshIds = new Set(
          Object.values(branches).filter((b) => (b.lastSyncedAt || 0) > cutoff).map((b) => b.merchantId)
        );
        accountList = accountList.filter((a) => {
          const allFresh = a.branches.every((b) => freshIds.has(b.id));
          if (allFresh) log(`  skip ${a.username} (all branches fresh)`);
          return !allFresh;
        });
      }
    } catch {}
  }

  log(`Accounts to process: ${accountList.length}`);
  log(`Branches total (per vault): ${accountList.reduce((s, a) => s + a.branches.length, 0)}`);

  log(`Connecting Chrome ${CDP_URL}…`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { log("✗ No context"); process.exit(1); }
  const page = ctx.pages().find((p) => p.url().includes("grab.com")) || ctx.pages()[0] || (await ctx.newPage());

  const summary = { success: [], fail: [], totalNewReviews: 0, branchesSeen: new Set() };
  let consecutiveLoginFails = 0;

  for (let i = 0; i < accountList.length; i++) {
    const acc = accountList[i];
    log(`\n━━━ [${i + 1}/${accountList.length}] ${acc.username} (vault: ${acc.branches.length} branches) ━━━`);

    if (consecutiveLoginFails >= CIRCUIT_BREAKER) {
      log(`🛑 Circuit breaker — stopping after ${consecutiveLoginFails} consecutive login fails`);
      break;
    }

    // Clear cookies
    try { await clearCookies(ctx); } catch {}

    // Login
    try {
      await doLogin(page, acc.username, acc.password);
      log(`  ✓ login OK`);
      consecutiveLoginFails = 0;
    } catch (err) {
      log(`  ✗ login failed: ${err.message.slice(0, 100)}`);
      summary.fail.push({ account: acc.username, reason: `login: ${err.message}` });
      consecutiveLoginFails++;
      continue;
    }

    // Wait for SPA + sidebar
    await page.waitForTimeout(5000);

    // Capture feedback — pass account's known branches (from vault) for fallback explicit query + name injection
    const accountBranchIds = acc.branches.map((b) => b.id);
    accountBranchIds.__withNames = acc.branches.map((b) => ({ id: b.id, name: b.name }));
    const r = await captureFeedback(page, accountBranchIds).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      const branchCount = Object.keys(r.branches).length;
      const reviewCount = Object.values(r.branches).reduce((s, b) => s + b.reviews.length, 0);
      const avg = r.overview?.avgRating?.toFixed(2) || "n/a";
      const pagesNote = r.pagesFetched > 1 ? ` (${r.pagesFetched} pages)` : "";
      const stopNote = r.paginationStopped ? ` [stopped: ${r.paginationStopped}]` : "";
      const extraNote = r.extraQueried && r.extraQueried.length > 0
        ? ` +${r.extraQueried.filter(x => x.ok && x.count > 0).length}/${r.extraQueried.length} extra-queried`
        : "";
      log(`  ✓ ${branchCount} branches, ${reviewCount} reviews, avg ${avg}${pagesNote}${stopNote}${extraNote}`);
      for (const mid of Object.keys(r.branches)) summary.branchesSeen.add(mid);

      // Push to server
      const pushed = await postToServer(r);
      if (pushed.ok) {
        log(`  ✓ pushed (${pushed.newReviews} new)`);
        summary.totalNewReviews += pushed.newReviews;
        summary.success.push({ account: acc.username, branches: branchCount, reviews: reviewCount });
      } else {
        log(`  ⚠ server push failed: ${pushed.error}`);
        summary.fail.push({ account: acc.username, reason: `push: ${pushed.error}` });
      }
    } else {
      log(`  ✗ capture failed: ${r.error}`);
      summary.fail.push({ account: acc.username, reason: r.error });
    }

    // Sleep before next account
    if (i < accountList.length - 1) {
      const jitter = Math.floor((JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN)) * 1000);
      const total = DELAY_ACCOUNT * 1000 + jitter;
      log(`  💤 sleep ${(total / 1000).toFixed(0)}s before next`);
      await sleep(total);
    }
  }

  await browser.close();

  log(`\n╔══ Summary ══╗`);
  log(`✓ ${summary.success.length} accounts captured`);
  log(`✗ ${summary.fail.length} accounts failed`);
  log(`📊 ${summary.branchesSeen.size} unique branches seen`);
  log(`🆕 ${summary.totalNewReviews} new reviews added`);
  if (summary.fail.length > 0) {
    log(`\nFailures:`);
    for (const f of summary.fail) log(`  ${f.account} — ${f.reason.slice(0, 100)}`);
  }
}

main().catch((e) => { log(`Fatal: ${e.message}`); process.exit(1); });
