// Throwaway STEP 0 check: opens a visible browser window for 15 seconds, then closes.
const { chromium } = require('playwright');

(async () => {
    // Use the real Chrome installed on this PC — Playwright's bundled Chromium
    // fails to start on this machine (Windows side-by-side error).
    const browser = await chromium.launch({ headless: false, channel: 'chrome' });
    const page = await browser.newPage();
    await page.setContent(
        '<div style="font-family:sans-serif;font-size:48px;text-align:center;margin-top:20%">' +
        'GATE — browser test OK ✔<br><span style="font-size:20px">This window closes itself in 15 seconds.</span></div>'
    );
    await page.waitForTimeout(15000);
    await browser.close();
    console.log('Headed browser launched and closed cleanly.');
})();
