#!/usr/bin/env node
"use strict";
/**
 * Slow human-like sync — works around Grab's anti-bot which detects fill()-based
 * automation. Uses page.keyboard.type() with realistic per-char delays.
 *
 * Flow per account:
 *   1. logout + navigate to /portal
 *   2. click "another account" if on /saved-accounts
 *   3. slow-type username, click ต่อไป
 *   4. slow-type password, click ต่อไป
 *   5. wait for redirect to /portal or /dashboard
 *   6. for each Jiancha branch in vault under this username:
 *        - navigate to /food/menu/<id>/menuOverview
 *        - capture menu response
 *        - POST to /api/sync
 *
 * Usage:
 *   node slow-sync-all.js              # all accounts in vault
 *   node slow-sync-all.js --only u1,u2 # specific usernames
 *   node slow-sync-all.js --skip-fresh-hours 5
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { load: loadVault } = require("./vault");

const SYNC_SERVER = process.env.SYNC_SERVER || "https://grab.jc-group-global.com";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const WAIT_MENU_SEC = 25;
const ID_REGEX = /\b(3-[A-Z0-9]{10,})\b/;

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const ONLY_USERS = flag("--only")?.split(",") || null;
const SKIP_FRESH_HOURS = Number(flag("--skip-fresh-hours") || 0);
const EXCLUDED = new Set([
  "3-C6WJCULBLU2AL6", // King Power Rangnam
  "3-C6VVMAKHLBNBET", // Head office
  "3-C62EJCKTLFXJTX", // G
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function slowType(page, text, perChar = [180, 380]) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(perChar[0], perChar[1]));
    if (Math.random() < 0.12) await sleep(rand(300, 600));
  }
}

async function moveAndClick(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) { await locator.click({ timeout: 10000 }).catch(() => {}); return; }
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await page.mouse.move(x - 80 + Math.random() * 160, y - 40 + Math.random() * 80, { steps: 6 });
  await sleep(rand(150, 350));
  await page.mouse.move(x, y, { steps: 10 });
  await sleep(rand(120, 280));
  await page.mouse.click(x, y);
}

async function slowLogin(page, ctx, username, password) {
  console.log(`  → slow-login ${username}`);
  // Force clean state — clear all Grab cookies + storage. Without this, /logout
  // sometimes preserves the session and /portal redirects to /dashboard, where
  // there is no username field for the next login.
  try {
    await ctx.clearCookies({ domain: ".grab.com" });
    await ctx.clearCookies({ domain: "grab.com" });
    await ctx.clearCookies({ domain: "merchant.grab.com" });
    await ctx.clearCookies({ domain: "weblogin.grab.com" });
    await ctx.clearCookies({ domain: "api.grab.com" });
  } catch {}
  await page.goto("https://merchant.grab.com/logout", { waitUntil: "load", timeout: 20000 }).catch(() => {});
  await sleep(rand(2500, 4000));
  try {
    await page.evaluate(() => { try { localStorage.clear(); } catch {} try { sessionStorage.clear(); } catch {} });
  } catch {}
  await page.goto("https://merchant.grab.com/portal", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await sleep(rand(3500, 5500));

  if (page.url().includes("saved-accounts")) {
    const otherBtn = page.locator('[role="button"]:has-text("ลงชื่อเข้าใช้ด้วยบัญชีอื่น"), button:has-text("ลงชื่อเข้าใช้ด้วยบัญชีอื่น")').first();
    await moveAndClick(page, otherBtn);
    await sleep(rand(2500, 4000));
  }

  const userField = page.locator('input[type="text"], input#Username').first();
  if (await userField.count() === 0) throw new Error(`username field not found at ${page.url()}`);
  await moveAndClick(page, userField);
  await sleep(rand(500, 900));
  await slowType(page, username);
  await sleep(rand(1500, 2800));

  await moveAndClick(page, page.locator('button:has-text("ต่อไป")').first());
  await sleep(rand(3500, 5500));

  const pwField = page.locator('input[type="password"]').first();
  if (await pwField.count() === 0) throw new Error(`password field not found at ${page.url()}`);
  await moveAndClick(page, pwField);
  await sleep(rand(500, 900));
  await slowType(page, password);
  await sleep(rand(1500, 2800));

  await moveAndClick(page, page.locator('button:has-text("ต่อไป")').first());

  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const u = page.url();
    if (u.includes("merchant.grab.com") && !u.includes("login") && !u.includes("challenge")) {
      console.log(`    ✓ logged in (${i + 1}s)`);
      return true;
    }
  }
  return false;
}

function normalizeMenu(json, branchId, sourceUrl, mi) {
  const items = [], seen = new Set();
  for (const c of json.categories || []) {
    if (!Array.isArray(c.items)) continue;
    const cn = c.categoryName || c.name || null;
    const ca = c.availableStatus === undefined ? true : c.availableStatus === 1;
    for (const it of c.items) {
      const id = it.itemID || it.itemId || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let pr = 0;
      if (typeof it.priceDisplay === "string") {
        const m = it.priceDisplay.match(/[\d,]+(?:\.\d+)?/);
        if (m) pr = parseFloat(m[0].replace(/,/g, "")) || 0;
      } else if (it.price != null) pr = Number(it.price);
      const av = ca && (it.availableStatus === undefined ? true : it.availableStatus === 1);
      items.push({
        id, name: it.itemName || it.name || id, category: cn,
        description: it.description || null, price: pr,
        imageUrl: it.imageURL || it.imageUrl || null, isAvailable: av,
      });
    }
  }
  return {
    id: branchId,
    name: mi?.name || `Merchant ${branchId}`,
    address: mi?.address?.address || mi?.address || null,
    isOpen: true,
    openHours: mi?.openingHours ? JSON.stringify(mi.openingHours) : null,
    items, lastFetched: Date.now(), sourceUrl, sources: ["http-slow"],
  };
}

async function captureBranch(page, branchId) {
  let menuJson = null, mi = null;
  const handler = async (r) => {
    try {
      const u = r.url();
      if (u.includes("api.grab.com/food/merchant/v2/menu")) {
        const j = JSON.parse(await r.text());
        if (Array.isArray(j.categories)) menuJson = j;
      }
      if (u.includes("portal.grab.com/foodtroy/v2/TH/merchants/")) {
        const j = JSON.parse(await r.text());
        if (j.merchant) mi = j.merchant;
      }
    } catch {}
  };
  page.on("response", handler);
  await page.goto(`https://merchant.grab.com/food/menu/${branchId}/menuOverview`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const finalUrl = page.url();
  const start = Date.now();
  while (!menuJson && Date.now() - start < WAIT_MENU_SEC * 1000) await sleep(500);
  page.off("response", handler);
  // Brand check — drop non-Jiancha branches
  if (menuJson && mi?.name && !/jiancha|jian\s*cha|见茶山|เจี้ยนชา/i.test(mi.name)) {
    return { ok: false, reason: `non-Jiancha brand: ${mi.name.slice(0, 30)}` };
  }
  if (!menuJson) {
    const empty = await page.evaluate(() => /เริ่มต้นโดยเพิ่มช่วงเวลา|Get started|Add menu/i.test(document.body?.innerText || "")).catch(() => false);
    return { ok: false, reason: empty ? "empty-menu" : "no-menu-response" };
  }
  return { ok: true, snapshot: normalizeMenu(menuJson, branchId, finalUrl, mi) };
}

async function postSync(snapshot) {
  const headers = { "Content-Type": "application/json" };
  if (SYNC_TOKEN) headers["X-Sync-Token"] = SYNC_TOKEN;
  const r = await fetch(`${SYNC_SERVER}/api/sync`, {
    method: "POST", headers,
    body: JSON.stringify({ merchants: { [snapshot.id]: snapshot }, events: [] }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "sync failed");
}

async function fetchCurrentMerchants() {
  try {
    const r = await fetch(`${SYNC_SERVER}/api/data`, { cache: "no-store" });
    const d = await r.json();
    return d.merchants || {};
  } catch { return {}; }
}

async function main() {
  const vault = loadVault();
  // Group branches by username, keeping only real IDs (not PLACEHOLDER)
  const accounts = new Map();
  for (const b of vault.branches) {
    if (b.id.startsWith("PLACEHOLDER")) continue;
    if (EXCLUDED.has(b.id)) continue;
    if (!b.username || !b.password) continue;
    if (!accounts.has(b.username)) accounts.set(b.username, { username: b.username, password: b.password, branches: [] });
    accounts.get(b.username).branches.push(b);
  }
  let list = [...accounts.values()];
  if (ONLY_USERS) list = list.filter((a) => ONLY_USERS.includes(a.username));

  // Skip accounts whose branches are all fresh
  if (SKIP_FRESH_HOURS > 0) {
    const current = await fetchCurrentMerchants();
    list = list.filter((a) =>
      a.branches.some((b) => {
        const m = current[b.id];
        if (!m) return true;
        const age_h = (Date.now() - m.lastFetched) / 3600000;
        return age_h >= SKIP_FRESH_HOURS;
      })
    );
  }

  // Shuffle for anti-pattern
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }

  console.log(`Accounts to sync: ${list.length}`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => /grab\.com/.test(p.url())) || await ctx.newPage();
  await page.bringToFront();

  let captured = 0, failed = 0, empty = 0;
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    console.log(`\n━━━ [${i + 1}/${list.length}] ${acc.username} (${acc.branches.length} branches) ━━━`);
    try {
      const ok = await slowLogin(page, ctx, acc.username, acc.password);
      if (!ok) { console.log("    ✗ login failed"); failed += acc.branches.length; continue; }
    } catch (e) {
      console.log(`    ✗ login error: ${e.message.slice(0, 80)}`);
      failed += acc.branches.length;
      continue;
    }

    for (const b of acc.branches) {
      const r = await captureBranch(page, b.id);
      if (r.ok) {
        try { await postSync(r.snapshot); console.log(`    ✓ ${b.id} ${r.snapshot.items.length} items`); captured++; }
        catch (e) { console.log(`    ✗ ${b.id} sync: ${e.message.slice(0, 60)}`); failed++; }
      } else if (r.reason === "empty-menu") {
        console.log(`    ⊘ ${b.id} empty`); empty++;
      } else {
        console.log(`    ✗ ${b.id} ${r.reason}`); failed++;
      }
      await sleep(rand(2000, 4000));
    }
    // Random jitter between accounts to avoid pattern
    if (i < list.length - 1) await sleep(rand(10000, 25000));
  }

  console.log(`\n╔══ Done ══╗`);
  console.log(`✓ ${captured} captured  ⊘ ${empty} empty  ✗ ${failed} failed`);
  await browser.close().catch(() => {});
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
