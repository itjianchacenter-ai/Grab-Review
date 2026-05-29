#!/usr/bin/env node
"use strict";
/**
 * Capture menus from the currently logged-in Grab merchant session in Chrome CDP.
 *
 * Use case: when the automated login flow keeps tripping Grab's anti-bot, have
 * a human log in manually in the CDP-attached Chrome window, then invoke this
 * script to harvest menus for whichever user is currently authenticated.
 *
 * - Does NOT clear cookies (would log the user out)
 * - Does NOT run the login flow
 * - Reads localStorage / page to detect the active user
 * - Looks up that user's branches in vault (incl. PLACEHOLDER ids)
 * - For PLACEHOLDER ids, discovers the real id from page navigation + URL parse
 * - Captures the menu JSON via response interception and POSTs to /api/sync
 *
 * Usage:
 *   node capture-current-session.js                 # capture all branches for current user
 *   node capture-current-session.js --user <name>   # restrict to a username (must match vault)
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const { chromium } = require("playwright");
const { load: loadVault, save: saveVault } = require("./vault");

const SYNC_SERVER = process.env.SYNC_SERVER || "https://grab.jc-group-global.com";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const WAIT_MENU_SEC = 25;
const ID_REGEX = /\b(3-[A-Z0-9]{10,})\b/;

const args = process.argv.slice(2);
const RESTRICT_USER = (() => {
  const i = args.indexOf("--user");
  return i >= 0 ? args[i + 1] : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        id, name: it.itemName || it.name || id, category: catName,
        description: it.description || null, price,
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
    items, lastFetched: Date.now(), sourceUrl, sources: ["http-manual"],
  };
}

async function detectCurrentUser(page) {
  try {
    const info = await page.evaluate(() => {
      const profile = JSON.parse(localStorage.getItem("profileInfo") || "{}");
      return { profileName: profile.name, mobileNumber: profile.mobileNumber, username: profile.username };
    });
    return info.username || info.profileName || null;
  } catch { return null; }
}

async function listMerchants(page) {
  // Read the merchant selector from localStorage / page
  try {
    const arr = await page.evaluate(() => {
      const ms = localStorage.getItem("merchantSelector");
      if (!ms) return [];
      try { return JSON.parse(ms); } catch { return []; }
    });
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function listStores(page) {
  // Read the actual branch IDs ("3-XXXX" gfids) from _STORES_RESPONSE_
  try {
    const raw = await page.evaluate(() => localStorage.getItem("_STORES_RESPONSE_"));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (parsed.unified_store_profile || []).map((s) => ({
      gfid: s.gfid, name: s.name, address: s.address, status: s.status,
    })).filter((s) => s.gfid);
  } catch { return []; }
}

async function captureBranch(page, branchId) {
  const url = `https://merchant.grab.com/food/menu/${branchId}/menuOverview`;
  let menuJson = null, merchantInfo = null;
  let actualId = branchId;

  const onResponse = async (response) => {
    try {
      const u = response.url();
      if (u.includes("api.grab.com/food/merchant/v2/menu")) {
        const j = JSON.parse(await response.text());
        if (Array.isArray(j.categories)) menuJson = j;
      }
      if (u.includes("portal.grab.com/foodtroy/v2/TH/merchants/")) {
        const j = JSON.parse(await response.text());
        if (j.merchant) merchantInfo = j.merchant;
      }
    } catch {}
  };
  page.on("response", onResponse);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  } catch {}

  // After navigation, the URL may have been rewritten to the real branch ID
  const finalUrl = page.url();
  const m = finalUrl.match(ID_REGEX);
  if (m) actualId = m[1];

  const start = Date.now();
  while (!menuJson && Date.now() - start < WAIT_MENU_SEC * 1000) await sleep(500);
  page.off("response", onResponse);

  if (!menuJson) {
    const isEmpty = await page.evaluate(() => /เริ่มต้นโดยเพิ่มช่วงเวลา|Get started|Add menu/i.test(document.body?.innerText || "")).catch(() => false);
    return { ok: false, reason: isEmpty ? "empty-menu" : "no-menu-response", actualId };
  }

  const snapshot = normalizeMenu(menuJson, actualId, finalUrl, merchantInfo);
  return { ok: true, snapshot, actualId };
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
  return j;
}

async function main() {
  console.log(`Connecting CDP ${CDP_URL}…`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  // Find the Grab tab specifically — picking the last tab opened is wrong when
  // the user has other tabs (Claude docs, Facebook, etc.) in the same window.
  const allPages = ctx.pages();
  let page = allPages.find((p) => /grab\.com/.test(p.url()));
  if (!page) {
    console.log("No Grab tab found — opening a new one");
    page = await ctx.newPage();
    await page.goto("https://merchant.grab.com/portal", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  console.log(`Using Grab tab: ${page.url()}`);

  // Detect current user
  const detected = await detectCurrentUser(page);
  console.log(`Detected logged-in user: ${detected || "(unknown — proceed with --user)"}`);
  const username = RESTRICT_USER || detected;
  if (!username) {
    console.error("✗ Could not detect user. Pass --user <vault-username>.");
    process.exit(1);
  }

  // Find branches in vault for this user
  const vault = loadVault();
  const myBranches = vault.branches.filter((b) => b.username === username);
  if (myBranches.length === 0) {
    console.error(`✗ No vault entries with username "${username}".`);
    process.exit(1);
  }
  console.log(`Vault has ${myBranches.length} branch(es) for ${username}:`);
  for (const b of myBranches) console.log(`  • ${b.id}  ${b.name.slice(0, 60)}`);

  // Pull the actual branch list from Grab's _STORES_RESPONSE_ (real gfid branch IDs)
  const stores = await listStores(page);
  if (stores.length > 0) {
    console.log(`Grab's _STORES_RESPONSE_ reports ${stores.length} branch(es):`);
    for (const s of stores) console.log(`  ◇ ${s.gfid}  ${s.name?.slice(0, 60)}  [${s.status || "?"}]`);

    // Auto-update vault: if a PLACEHOLDER exists for this user and Grab reports
    // branches we don't yet have by real id, replace the placeholder with the
    // real one. If Grab reports MORE branches than vault has (multi-branch
    // account), add new entries cloning the credentials.
    const havePh = myBranches.filter((b) => b.id.startsWith("PLACEHOLDER"));
    const haveReal = new Set(myBranches.filter((b) => !b.id.startsWith("PLACEHOLDER")).map((b) => b.id));
    const placeholderCopy = havePh[0]; // reference for credentials
    const cred = placeholderCopy || myBranches[0]; // any entry for username/password
    let mutated = false;
    let phIdx = 0;
    for (const s of stores) {
      if (haveReal.has(s.gfid)) continue; // already in vault
      if (phIdx < havePh.length) {
        // Replace next placeholder
        const slot = havePh[phIdx++];
        slot.id = s.gfid;
        slot.name = s.name || slot.name;
        console.log(`   ↳ vault: placeholder → ${s.gfid}`);
        mutated = true;
      } else {
        // Add new entry for this branch under same credentials
        vault.branches.push({
          id: s.gfid, name: s.name || `Merchant ${s.gfid}`,
          username: cred.username, password: cred.password,
        });
        console.log(`   ↳ vault: added new branch ${s.gfid}`);
        mutated = true;
      }
    }
    if (mutated) {
      saveVault(vault);
      // Refresh myBranches for capture loop
      myBranches.length = 0;
      myBranches.push(...vault.branches.filter((b) => b.username === username));
    }
  }

  // Capture each vault branch
  console.log("");
  const results = [];
  for (let i = 0; i < myBranches.length; i++) {
    const b = myBranches[i];
    console.log(`[${i + 1}/${myBranches.length}] ${b.id}  ${b.name.slice(0, 50)}`);
    const r = await captureBranch(page, b.id);
    if (r.ok) {
      // If the branch id was a PLACEHOLDER, we now know the real one
      const wasPlaceholder = b.id.startsWith("PLACEHOLDER");
      if (wasPlaceholder && r.actualId !== b.id) {
        console.log(`   ↳ discovered real id: ${r.actualId}`);
        b.id = r.actualId;
        b.name = r.snapshot.name || b.name;
        saveVault(vault);
      }
      try {
        await postSync(r.snapshot);
        console.log(`   ✓ ${r.snapshot.items.length} items → posted to ${SYNC_SERVER}`);
        results.push({ id: r.actualId, ok: true, items: r.snapshot.items.length });
      } catch (e) {
        console.log(`   ✗ sync POST failed: ${e.message}`);
        results.push({ id: r.actualId, ok: false, error: e.message });
      }
    } else {
      console.log(`   ✗ ${r.reason}`);
      results.push({ id: r.actualId, ok: false, error: r.reason });
    }
    if (i < myBranches.length - 1) await sleep(3000);
  }

  console.log("\n═══ Summary ═══");
  const ok = results.filter((r) => r.ok).length;
  console.log(`✓ ${ok}/${results.length} captured`);
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.id}  ${r.ok ? r.items + " items" : r.error}`);
  }
  await browser.close().catch(() => {});
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
