/**
 * GATE prototype launcher.
 *
 * Usage:  npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
 *
 * Opens a VISIBLE Chrome window, joins the meeting as "GATE bot" with camera
 * and mic off, and then sits there printing a plain-English status line
 * whenever its situation changes (lobby / in meeting / neither).
 * The window stays open until you press Ctrl+C in the terminal.
 */
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { JoinProcedure } from './procedures/join-procedure';
import { ChatProcedure } from './procedures/chat-procedure';
import { CaptionsProcedure } from './procedures/captions-procedure';

const meetingUrl = process.argv[2];
if (!meetingUrl) {
    console.error('Usage: npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>');
    process.exit(1);
}

const main = async () => {
    const botId = randomUUID();

    const browser = await chromium.launch({
        headless: false,   // hard requirement: always visible
        channel: 'chrome', // Playwright's bundled Chromium won't start on this PC; use installed Chrome
        args: [
            '--use-fake-ui-for-media-stream',     // auto-accept any mic/camera permission popup
            '--use-fake-device-for-media-stream', // hand Teams a fake mic/camera instead of real hardware
        ],
    });
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 }, // wide enough that Teams doesn't hide toolbar buttons in the More menu
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const join = new JoinProcedure({ botId, page });

    console.log('\n=== GATE bot: opening the meeting link... ===\n');
    await join.startMeetingLauncherFlow({ meetingUrl });
    await join.joinMeetingLobbyFlow();

    console.log('\n=== GATE bot: join clicked. Watching status (Ctrl+C here to quit)... ===\n');

    let lastState = '';
    let inMeetingSince: number | null = null;
    let chatMessagePosted = false;
    let captionsStarted = false;
    while (true) {
        let state = 'unknown';
        if (await join.isInMeeting({})) {
            state = 'in-meeting';
        } else if (await join.isInMeetingLobby({})) {
            state = 'lobby';
        }

        if (state !== lastState) {
            if (state === 'lobby') {
                console.log('\n>>> STATUS: In the waiting room (lobby). Waiting to be admitted. <<<\n');
            } else if (state === 'in-meeting') {
                inMeetingSince = Date.now();
                console.log('\n>>> STATUS: Admitted! GATE bot is now IN the meeting. <<<\n');
            } else {
                console.log('\n>>> STATUS: Not in lobby or meeting (page may still be loading, or the call ended). <<<\n');
            }
            lastState = state;
        }

        // Milestone 3: once admitted, post one hard-coded test message to chat.
        if (state === 'in-meeting' && !chatMessagePosted) {
            chatMessagePosted = true; // only try once, even if it fails
            await page.waitForTimeout(3000); // let the meeting UI settle first
            try {
                const chat = new ChatProcedure({ botId, page });
                await chat.sendMessage('hello from GATE bot');
                console.log('\n>>> STATUS: Posted test message to the meeting chat. <<<\n');
            } catch (error) {
                console.error('\n>>> PROBLEM: Could not post to the meeting chat. <<<\n', error);
            }
        }

        // Milestone 4: turn on live captions and print finished lines.
        if (state === 'in-meeting' && chatMessagePosted && !captionsStarted) {
            captionsStarted = true; // only try once, even if it fails
            try {
                const captions = new CaptionsProcedure({ botId, page });
                await captions.enableCaptionsFlow();
                await captions.subscribeToCaptions();
                console.log('\n>>> STATUS: Live captions are ON. Speak — finished lines print below as CAPTION >>> lines. <<<\n');
            } catch (error) {
                console.error('\n>>> PROBLEM: Could not turn on / read live captions. <<<\n', error);
            }
        }

        // Milestone 2 evidence: report a stable minute in the meeting.
        if (state === 'in-meeting' && inMeetingSince && Date.now() - inMeetingSince >= 60000) {
            console.log('>>> STATUS: Stable in meeting for 60+ seconds. <<<');
            inMeetingSince = null; // print this only once
        }

        await page.waitForTimeout(5000);
    }
};

main().catch((error) => {
    console.error('\n=== GATE bot hit a fatal error ===\n', error);
    process.exit(1);
});
