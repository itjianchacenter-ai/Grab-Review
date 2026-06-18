"use strict";
/**
 * Login flow for merchant.grab.com.
 * Selectors are intentionally generous — Grab redesigns the page periodically.
 * If a selector breaks, run with HEADLESS=false and watch what fails.
 */

// Type text char-by-char with random pauses to look human — fill() is detected
// by Grab's anti-bot as automation. Slow typing + occasional re-checks bypass it.
async function humanType(page, locator, text, perCharMs = [180, 380]) {
  await locator.click();
  await page.waitForTimeout(400 + Math.random() * 600);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(perCharMs[0] + Math.random() * (perCharMs[1] - perCharMs[0]));
    if (Math.random() < 0.12) await page.waitForTimeout(300 + Math.random() * 500);
  }
}

async function isLoggedIn(page) {
  // After login, Grab redirects via several URLs (login → portal → dashboard/feedback).
  // Poll up to 8s to ride out the redirect chain instead of catching a transient
  // /login state and falsely reporting "credentials may be wrong".
  for (let i = 0; i < 8; i++) {
    const url = page.url();
    const onLogin = url.includes("/login") || url.includes("/signin");
    if (!onLogin) {
      // Final sanity: a visible password input means we got bounced back to the form
      const pwField = await page.locator('input[type="password"]').count();
      if (pwField === 0) return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function login(page, branch) {
  console.log(`  → login flow for ${branch.name || branch.id} (user: ${branch.username})`);
  console.log(`    URL before login: ${page.url()}`);

  // Wait for the SPA to finish rendering. The page starts as <div id="root"></div>
  // so we need to wait for actual interactive content.
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="userName"]',
    'input[id*="email"]',
    'input[id*="user"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ];

  // Wait up to 30s for any of the email selectors to appear
  const combinedSelector = emailSelectors.join(", ");
  try {
    await page.waitForSelector(combinedSelector, { timeout: 30_000, state: "visible" });
  } catch (_) {
    // Maybe we need to click a "Sign In" / "Log In" button first to reveal the form
    const signInBtn = page.locator(
      'a:has-text("Login"), a:has-text("Sign in"), a:has-text("เข้าสู่ระบบ"), ' +
        'button:has-text("Login"), button:has-text("Sign in"), button:has-text("เข้าสู่ระบบ")',
    );
    if ((await signInBtn.count()) > 0) {
      console.log(`    clicking Sign In/Login button first…`);
      await signInBtn.first().click().catch(() => {});
      await page.waitForSelector(combinedSelector, { timeout: 30_000, state: "visible" });
    } else {
      throw new Error(`login form did not render within 30s — URL: ${page.url()}`);
    }
  }

  let emailLocator = null;
  for (const sel of emailSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      emailLocator = page.locator(sel).first();
      break;
    }
  }
  if (!emailLocator) throw new Error("login form: email field not found");

  await humanType(page, emailLocator, branch.username);
  await page.waitForTimeout(1200 + Math.random() * 1800);

  // Password field selectors (declared early to detect single-vs-two-step form)
  const pwSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ];

  // Grab has TWO login layouts:
  //   (a) Single-page form — username + password both VISIBLE, "ต่อไป" submits
  //   (b) Two-page form    — fill username, click "Continue/ต่อไป", then password page appears
  //                          (the password input may exist hidden in the DOM on page 1)
  // Only skip the Continue click when password is *actually visible* — count alone
  // also matches hidden inputs and wrongly suppresses the click.
  let pwAlreadyVisible = false;
  for (const sel of pwSelectors) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      if (await el.isVisible().catch(() => false)) { pwAlreadyVisible = true; break; }
    }
    if (pwAlreadyVisible) break;
  }
  if (!pwAlreadyVisible) {
    const continueBtn = page.locator(
      'button:has-text("Continue"), button:has-text("Next"), button:has-text("ดำเนินการต่อ"), button:has-text("ถัดไป"), button:has-text("ต่อไป")',
    );
    if ((await continueBtn.count()) > 0) {
      await continueBtn.first().click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  // Wait for password field to appear (might appear after email continue button)
  try {
    await page.waitForSelector(pwSelectors.join(", "), { timeout: 15_000, state: "visible" });
  } catch (_) {
    /* will fall through to error below */
  }
  let pwLocator = null;
  for (const sel of pwSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      pwLocator = page.locator(sel).first();
      break;
    }
  }
  if (!pwLocator) throw new Error("login form: password field not found");

  await humanType(page, pwLocator, branch.password);
  // Settle — React-based forms need a tick for the input value to register
  // before the submit handler reads it; without this the submit can fire with
  // empty password ("did not redirect"). Slow typing also adds human-like
  // pause that bypasses Grab's anti-bot pattern detection.
  await page.waitForTimeout(1200 + Math.random() * 1800);

  // Submit
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("เข้าสู่ระบบ")',
    'button:has-text("ล็อกอิน")',
    'button:has-text("ต่อไป")',
    'button:has-text("ถัดไป")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ];
  let submit = null;
  for (const sel of submitSelectors) {
    if ((await page.locator(sel).count()) > 0) {
      submit = page.locator(sel).first();
      break;
    }
  }
  if (submit) await submit.click();
  else await pwLocator.press("Enter");

  // Wait for redirect away from login. Note: "login" appears in the hostname
  // "weblogin.grab.com", so this filter ONLY matches when the URL has navigated
  // off the weblogin subdomain entirely (i.e., to merchant.grab.com/...).
  // Grab can take 30-60s under anti-bot scrutiny — give it generous time.
  try {
    await page.waitForURL((url) => !url.toString().includes("login"), { timeout: 60_000 });
  } catch (_) {
    // Could be a CAPTCHA or 2FA — let caller handle
    throw new Error("login did not redirect away from login URL — may need CAPTCHA / 2FA");
  }

  // Final sanity check
  await page.waitForTimeout(2000);
  if (!(await isLoggedIn(page))) {
    throw new Error("still on login form after submit — credentials may be wrong");
  }
  console.log(`  ✓ logged in — URL now: ${page.url()}`);
}

module.exports = { isLoggedIn, login };
