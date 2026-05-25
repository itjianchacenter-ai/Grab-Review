#!/usr/bin/env node
"use strict";
/**
 * Multi-account orchestrator
 *
 * Logic:
 *   1. CDP attach Chrome 9222
 *   2. Group vault entries by username
 *   3. For each account:
 *      a. Clear grab.com cookies
 *      b. Login via login.js
 *      c. captureBranch() for each branch under this account
 *      d. Continue to next
 *   4. Skip accounts already fully captured (recent lastFetched)
 *
 * Usage:
 *   node multi-account-sync.js                       # all pending
 *   node multi-account-sync.js --account mkt.fc08    # one account
 *   node multi-account-sync.js --skip-fresh-hours 6  # skip recently captured
 *   node multi-account-sync.js --manual              # manual login mode
 */
require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");
const { isLoggedIn, login } = require("./login");

// ════════════════════════════════════════════════════════════
// Lock file — prevent concurrent orchestrator runs
// ════════════════════════════════════════════════════════════
const LOCK_FILE = path.resolve(__dirname, "logs/.sync.lock");
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min — lock expires if process died

// ════════════════════════════════════════════════════════════
// Account fail tracking — auto-pause accounts that fail repeatedly
// (Protects against Grab account ban from too many failed logins)
// ════════════════════════════════════════════════════════════
const FAIL_FILE = path.resolve(__dirname, "logs/.account-fails.json");
const FAIL_PAUSE_HOURS = 24;
const FAIL_PAUSE_THRESHOLD = 3; // pause account after N consecutive login fails

function loadFailState() {
  try { return JSON.parse(fs.readFileSync(FAIL_FILE, "utf8")); }
  catch { return {}; }
}
function saveFailState(state) {
  try { fs.writeFileSync(FAIL_FILE, JSON.stringify(state, null, 2)); } catch {}
}
function isAccountPaused(state, username) {
  const e = state[username];
  if (!e) return false;
  if (e.pausedUntil && Date.now() < e.pausedUntil) return true;
  return false;
}
function recordAccountResult(state, username, ok) {
  const e = state[username] || { fails: 0, pausedUntil: 0 };
  if (ok) {
    e.fails = 0;
    e.pausedUntil = 0;
    e.lastSuccessAt = Date.now();
  } else {
    e.fails = (e.fails || 0) + 1;
    e.lastFailAt = Date.now();
    if (e.fails >= FAIL_PAUSE_THRESHOLD) {
      e.pausedUntil = Date.now() + FAIL_PAUSE_HOURS * 3600 * 1000;
    }
  }
  state[username] = e;
}

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
        console.error(`⚠ FORCE_LOCK=1 — overriding existing lock (pid ${data.pid}, age ${Math.round(age/1000)}s)`);
      } else if (alive && age < LOCK_STALE_MS) {
        console.error(`✗ Lock held by pid ${data.pid} (started ${Math.round(age / 1000)}s ago)`);
        console.error(`  Wait, run with FORCE_LOCK=1, or remove ${LOCK_FILE}`);
        process.exit(2);
      } else if (!alive) {
        console.error(`⚠ Stale lock (pid ${data.pid} dead, age ${Math.round(age / 1000)}s) — overriding`);
      } else {
        console.error(`⚠ Old lock (pid ${data.pid}, age ${Math.round(age / 1000)}s > ${LOCK_STALE_MS / 1000}s) — overriding`);
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

const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const SYNC_SERVER = process.env.SYNC_SERVER || "http://localhost:8765";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const WAIT_MAX = Number(process.env.WAIT_MAX || 25);
const DELAY_BRANCH = Number(process.env.DELAY_BRANCH || 8);
const DELAY_ACCOUNT = Number(process.env.DELAY_ACCOUNT || 30);
// Jitter: random extra delay between accounts (anti-bot)
const JITTER_MIN = Number(process.env.JITTER_MIN || 0);
const JITTER_MAX = Number(process.env.JITTER_MAX || 0);
// Circuit breaker: stop if N consecutive accounts fail to login
const CIRCUIT_BREAKER = Number(process.env.CIRCUIT_BREAKER || 3);

// CLI args
const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
}
const ONE_ACCOUNT = flag("--account");
const MANUAL = flag("--manual") === true;
const SKIP_FRESH_HOURS = Number(flag("--skip-fresh-hours") || 0);
const SHUFFLE = flag("--shuffle") === true;
const JITTER = flag("--jitter") === true;

const LOGS_DIR = path.resolve(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `multi-account-${new Date().toISOString().slice(0, 10)}.log`);
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ask(q) {
  return new Promise((r) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); r(a.trim()); });
  });
}

function normalizeMenu(json, branchId, sourceUrl, merchantInfo) {
  const items = [], seen = new Set();
  for (const cat of json.categories || []) {
    if (!Array.isArray(cat.items)) continue;
    const catName = cat.categoryName || cat.name || null;
    const catAvailable = cat.availableStatus === undefined ? true : cat.availableStatus === 1;
    for (const it of cat.items) {
      const id = it.itemID || it.itemId || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let price = 0;
      if (typeof it.priceDisplay === "string") {
        const m = it.priceDisplay.match(/[\d,]+(?:\.\d+)?/);
        if (m) price = parseFloat(m[0].replace(/,/g, "")) || 0;
      } else if (it.price != null) price = Number(it.price);
      const isAvailable = catAvailable && (it.availableStatus === undefined ? true : it.availableStatus === 1);
      items.push({
        id,
        name: it.itemName || it.name || id,
        category: catName,
        description: it.description || null,
        price,
        imageUrl: it.imageURL || it.imageUrl || null,
        isAvailable,
      });
    }
  }
  return {
    id: branchId,
    name: merchantInfo?.name || `Merchant ${branchId}`,
    address: merchantInfo?.address?.address || merchantInfo?.address || null,
    isOpen: true,
    openHours: merchantInfo?.openingHours ? JSON.stringify(merchantInfo.openingHours) : null,
    items,
    lastFetched: Date.now(),
    sourceUrl,
    sources: ["http"],
  };
}

async function captureBranch(page, branchId) {
  const url = `https://merchant.grab.com/food/menu/${branchId}/menuOverview`;
  let menuJson = null, merchantInfo = null;
  const onResponse = async (response) => {
    try {
      const u = response.url();
      if (u.includes("api.grab.com/food/merchant/v2/menu")) {
        const text = await response.text();
        const j = JSON.parse(text);
        if (Array.isArray(j.categories)) menuJson = j;
      }
      if (u.includes("portal.grab.com/foodtroy/v2/TH/merchants/")) {
        const text = await response.text();
        const j = JSON.parse(text);
        if (j.merchant) merchantInfo = j.merchant;
      }
    } catch {}
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err) {
    page.off("response", onResponse);
    return { ok: false, error: `nav: ${err.message}`, kind: "error" };
  }
  const start = Date.now();
  while (!menuJson && Date.now() - start < WAIT_MAX * 1000) await sleep(500);
  page.off("response", onResponse);

  if (!menuJson) {
    // Check if page is actually showing empty-menu state (vs network error / not-logged-in)
    const isEmptyState = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return /เริ่มต้นโดยเพิ่มช่วงเวลา|Get started|Add menu/i.test(text);
    }).catch(() => false);
    if (isEmptyState) return { ok: false, error: "empty-menu", kind: "empty" };
    return { ok: false, error: "no-menu-response", kind: "error" };
  }
  const finalUrl = page.url();
  if (!finalUrl.includes(branchId)) return { ok: false, error: `redirect: ${finalUrl}`, kind: "error" };

  const snapshot = normalizeMenu(menuJson, branchId, finalUrl, merchantInfo);
  try {
    const headers = { "Content-Type": "application/json" };
    if (SYNC_TOKEN) headers["X-Sync-Token"] = SYNC_TOKEN;
    const r = await fetch(`${SYNC_SERVER}/api/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ merchants: { [branchId]: snapshot }, events: [] }),
    });
    const j = await r.json();
    if (!j.ok) return { ok: false, error: `server: ${j.error}` };
  } catch (err) {
    return { ok: false, error: `server: ${err.message}` };
  }
  return { ok: true, items: snapshot.items.length, name: snapshot.name };
}

async function clearCookies(ctx) {
  const all = await ctx.cookies();
  const grab = all.filter((c) => /grab\.com|grabtaxi\.com/.test(c.domain));
  if (grab.length === 0) return 0;
  await ctx.clearCookies({ domain: "grab.com" });
  await ctx.clearCookies({ domain: ".grab.com" });
  await ctx.clearCookies({ domain: "merchant.grab.com" });
  await ctx.clearCookies({ domain: "portal.grab.com" });
  await ctx.clearCookies({ domain: "api.grab.com" });
  await ctx.clearCookies({ domain: "grabtaxi.com" });
  await ctx.clearCookies({ domain: "weblogin.grab.com" });
  return grab.length;
}

async function clearStorage(page) {
  // Clear localStorage/sessionStorage on all grab subdomains the page visits
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  } catch {}
}

async function gotoLoginForm(page, username, password) {
  // Step 0: explicit logout — without this Grab keeps the previous user "remembered"
  // and serves a saved-accounts page where the username field is disabled and
  // pre-filled with the last user. /logout is a Grab endpoint that clears its
  // server-side session before redirecting to saved-accounts.
  try {
    await page.goto("https://merchant.grab.com/logout", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    });
  } catch {}

  // Step 1: navigate; expect redirect to weblogin.grab.com/merchant/...
  await page.goto("https://merchant.grab.com/portal", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Step 2: handle saved-accounts page — click "Log in with another account"
  // Grab uses both <div role="button"> and plain <button> across page versions
  if (page.url().includes("/saved-accounts")) {
    const otherBtn = page.locator(
      'button:has-text("ลงชื่อเข้าใช้ด้วยบัญชีอื่น"), [role="button"]:has-text("ลงชื่อเข้าใช้ด้วยบัญชีอื่น"), button:has-text("Log in with another account"), [role="button"]:has-text("Log in with another account"), button:has-text("Use another account"), [role="button"]:has-text("Use another account")',
    );
    const cnt = await otherBtn.count();
    if (cnt > 0) {
      await otherBtn.first().click();
      // Wait for navigation away from /saved-accounts
      await page.waitForURL((u) => !u.toString().includes("/saved-accounts"), { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      throw new Error(`/saved-accounts: cannot find "another account" button`);
    }
  }

  // Step 3: now on login form
  await login(page, { username, password, name: username });
}

async function loadCurrentMerchants() {
  try {
    const r = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    const d = await r.json();
    return d.merchants || {};
  } catch { return {}; }
}

async function main() {
  acquireLock();
  log(`╔══ Multi-account orchestrator ══╗`);
  log(`Mode: ${MANUAL ? "MANUAL" : "AUTO"}  │  Server: ${SYNC_SERVER}  │  Skip fresh < ${SKIP_FRESH_HOURS}h`);

  const v = loadVault();
  const allBranches = (v.branches || []).filter((b) => !/\[CLOSE\s*(UP|DOWN)\]/i.test(b.name || ""));

  // Group by username
  const accounts = new Map();
  for (const b of allBranches) {
    if (!b.username || !b.password) continue;
    if (!accounts.has(b.username)) accounts.set(b.username, { username: b.username, password: b.password, branches: [] });
    accounts.get(b.username).branches.push(b);
  }

  let accountList = [...accounts.values()].sort((a, b) => a.username.localeCompare(b.username));
  if (ONE_ACCOUNT && ONE_ACCOUNT !== true) {
    accountList = accountList.filter((a) => a.username === ONE_ACCOUNT);
    if (accountList.length === 0) {
      log(`✗ No account "${ONE_ACCOUNT}" found in vault`);
      process.exit(1);
    }
  }

  // Shuffle account order (anti-bot: don't always login in same sequence)
  if (SHUFFLE) {
    for (let i = accountList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accountList[i], accountList[j]] = [accountList[j], accountList[i]];
    }
    log(`🔀 Shuffled account order`);
  }

  // Skip accounts whose branches are all fresh
  if (SKIP_FRESH_HOURS > 0) {
    const merchants = await loadCurrentMerchants();
    const cutoff = Date.now() - SKIP_FRESH_HOURS * 3600 * 1000;
    accountList = accountList.filter((a) => {
      const allFresh = a.branches.every((b) => (merchants[b.id]?.lastFetched || 0) > cutoff);
      if (allFresh) log(`  skip ${a.username} (fresh)`);
      return !allFresh;
    });
  }

  // Filter out paused accounts
  const failState = loadFailState();
  const pausedNow = accountList.filter((a) => isAccountPaused(failState, a.username));
  if (pausedNow.length > 0) {
    log(`⏸  Skipping ${pausedNow.length} paused accounts (failed ${FAIL_PAUSE_THRESHOLD}+ times):`);
    for (const a of pausedNow) {
      const until = new Date(failState[a.username].pausedUntil).toLocaleString("th-TH");
      log(`   ${a.username} — paused until ${until}`);
    }
    accountList = accountList.filter((a) => !isAccountPaused(failState, a.username));
  }

  log(`Accounts to process: ${accountList.length}`);
  log(`Branches total: ${accountList.reduce((s, a) => s + a.branches.length, 0)}`);

  log(`Connecting Chrome ${CDP_URL}…`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) { log("✗ No context"); process.exit(1); }
  const page = ctx.pages().find((p) => p.url().includes("grab.com")) || ctx.pages()[0] || (await ctx.newPage());

  const results = { success: [], fail: [], empty: [] };
  let consecutiveLoginFails = 0;

  for (let i = 0; i < accountList.length; i++) {
    const acc = accountList[i];
    log(`\n━━━ [${i + 1}/${accountList.length}] ${acc.username} (${acc.branches.length} สาขา) ━━━`);

    // Circuit breaker
    if (consecutiveLoginFails >= CIRCUIT_BREAKER) {
      log(`🛑 Circuit breaker triggered after ${consecutiveLoginFails} consecutive login failures`);
      log(`   Stopping to avoid Grab anti-bot detection. Resume later.`);
      break;
    }

    // Step 1: Clear cookies
    try {
      const cleared = await clearCookies(ctx);
      log(`  🍪 cleared ${cleared} cookies`);
    } catch (err) {
      log(`  ⚠ clear cookies failed: ${err.message}`);
    }

    // Step 2: Login
    try {
      if (MANUAL) {
        await page.goto("https://merchant.grab.com/portal", { waitUntil: "domcontentloaded", timeout: 30_000 });
        console.log(`\n👉 ใน Chrome:`);
        console.log(`   1. Login user: ${acc.username}  pass: ${acc.password}`);
        console.log(`   2. รอจน dashboard โหลด`);
        await ask(`   พร้อม? Enter: `);
      } else {
        await gotoLoginForm(page, acc.username, acc.password);
      }
      // Verify
      await page.waitForTimeout(2000);
      if (!(await isLoggedIn(page))) throw new Error(`not logged in after attempt — URL: ${page.url()}`);
      log(`  ✓ logged in — ${page.url().slice(0, 80)}`);
      consecutiveLoginFails = 0;
      recordAccountResult(failState, acc.username, true);
      saveFailState(failState);
    } catch (err) {
      log(`  ✗ login failed: ${err.message}`);
      results.fail.push({ account: acc.username, reason: `login: ${err.message}` });
      consecutiveLoginFails++;
      recordAccountResult(failState, acc.username, false);
      saveFailState(failState);
      const e = failState[acc.username];
      if (e?.pausedUntil > Date.now()) {
        log(`  ⏸  Account paused until ${new Date(e.pausedUntil).toLocaleString("th-TH")} (${e.fails} fails)`);
      }
      continue;
    }

    // Step 3: Capture each branch
    for (let j = 0; j < acc.branches.length; j++) {
      const b = acc.branches[j];
      log(`  [${j + 1}/${acc.branches.length}] ${b.id} ${(b.name || "").slice(0, 40)}`);
      const r = await captureBranch(page, b.id).catch((e) => ({ ok: false, error: e.message, kind: "error" }));
      if (r.ok) {
        log(`     ✓ ${r.items} items — ${r.name?.slice(0, 40)}`);
        results.success.push({ account: acc.username, id: b.id, items: r.items });
      } else if (r.kind === "empty") {
        log(`     ⊘ empty menu (ยังไม่ตั้งเมนูใน Grab)`);
        results.empty.push({ account: acc.username, id: b.id });
      } else {
        log(`     ✗ ${r.error}`);
        results.fail.push({ account: acc.username, id: b.id, reason: r.error });
      }
      if (j < acc.branches.length - 1) await sleep(DELAY_BRANCH * 1000);
    }

    if (i < accountList.length - 1) {
      const jitter = JITTER && JITTER_MAX > 0
        ? Math.floor((JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN)) * 1000)
        : 0;
      const total = DELAY_ACCOUNT * 1000 + jitter;
      log(`  💤 sleep ${(total / 1000).toFixed(0)}s${jitter ? ` (jitter +${(jitter / 1000).toFixed(0)}s)` : ""} before next account`);
      await sleep(total);
    }
  }

  log(`\n╔══ Done ══╗`);
  log(`✓ ${results.success.length} captured`);
  log(`⊘ ${results.empty.length} empty (ยังไม่ตั้งเมนูใน Grab)`);
  log(`✗ ${results.fail.length} failed`);
  if (results.fail.length > 0) {
    log(`\nFailures:`);
    for (const f of results.fail) log(`  ${f.account} ${f.id || ""} — ${f.reason}`);
  }
  if (results.empty.length > 0) {
    log(`\nEmpty menus:`);
    for (const f of results.empty) log(`  ${f.account} ${f.id}`);
  }
  await browser.close();
}

main().catch((e) => { log(`Fatal: ${e.message}`); process.exit(1); });
