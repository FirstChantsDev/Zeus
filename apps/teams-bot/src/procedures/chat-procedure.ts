import { Page } from 'playwright';
import { Logger } from '../lib/Logger';

/**
 * ChatProcedure opens the in-meeting chat panel and posts messages.
 * Selectors have fallbacks because Teams' internal element names differ
 * between versions (corporate vs personal, and over time).
 */
export class ChatProcedure {
    private readonly page: Page;
    private readonly logger: Logger;

    constructor(args: { botId: string, page: Page }) {
        this.page = args.page;
        this.logger = new Logger({ source: 'chat-procedure', botId: args.botId });
    }

    private _composeBox() {
        return this.page.locator('div[role="textbox"][contenteditable="true"]').first();
    }

    /** Opens the chat panel if it is not already open */
    public async openChatPanel() {
        if (await this._composeBox().isVisible().catch(() => false)) {
            this.logger.info({ message: 'Chat panel already open.' });
            return;
        }

        const candidates = [
            'button[id="chat-button"]',
            'button[data-tid="chat-button"]',
            'button[data-tid="call-chat-button"]',
            'button[aria-label*="chat" i]',
            'button[title*="chat" i]',
            '[role="toolbar"] button:has-text("Chat")',
        ];
        let clicked = false;
        for (const selector of candidates) {
            const button = this.page.locator(selector).first();
            if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
                await button.click();
                this.logger.info({ message: `Clicked chat button (${selector}).` });
                clicked = true;
                break;
            }
        }

        // Fallback 1: Teams sometimes puts Chat inside the calling "More" menu.
        if (!clicked) {
            const moreButton = this.page.locator('button[id="callingButtons-showMoreBtn"]').first();
            if (await moreButton.count() > 0 && await moreButton.isVisible().catch(() => false)) {
                await moreButton.click();
                const chatMenuItem = this.page.locator('[role="menuitem"]').filter({ hasText: /chat/i }).first();
                if (await chatMenuItem.isVisible().catch(() => false)) {
                    await chatMenuItem.click();
                    this.logger.info({ message: 'Opened chat via the More menu.' });
                    clicked = true;
                } else {
                    await this.page.keyboard.press('Escape'); // close the menu again
                }
            }
        }

        // Fallback 2: a stray side panel may be displacing the toolbar — close it and retry once.
        if (!clicked) {
            const closePane = this.page.locator('[data-tid="rail-header-close-button"]').first();
            if (await closePane.count() > 0 && await closePane.isVisible().catch(() => false)) {
                await closePane.click();
                this.logger.info({ message: 'Closed a side panel; retrying chat button.' });
                for (const selector of candidates) {
                    const button = this.page.locator(selector).first();
                    if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
                        await button.click();
                        this.logger.info({ message: `Clicked chat button after closing panel (${selector}).` });
                        clicked = true;
                        break;
                    }
                }
            }
        }

        if (!clicked) {
            // Self-diagnosis: list every visible button so the log tells us
            // what this Teams version actually calls the chat button.
            const buttons = await this.page.locator('button').evaluateAll((els) =>
                els
                    .filter((el) => (el as HTMLElement).offsetParent !== null)
                    .map((el) => ({
                        id: el.id || undefined,
                        ariaLabel: el.getAttribute('aria-label') || undefined,
                        dataTid: el.getAttribute('data-tid') || undefined,
                        title: el.getAttribute('title') || undefined,
                        text: (el.textContent || '').trim().slice(0, 40) || undefined,
                    }))
            );
            this.logger.warn({ message: 'Chat button not found. Visible buttons on the page:', data: buttons });
        }

        await this._composeBox().waitFor({ state: 'visible', timeout: 15000 });
        this.logger.info({ message: 'Chat compose box is visible.' });
    }

    /** Opens the chat panel if needed, then types and sends one message */
    public async sendMessage(text: string) {
        await this.openChatPanel();
        const composeBox = this._composeBox();
        await composeBox.click();
        await composeBox.fill(text);
        await this.page.keyboard.press('Enter');
        this.logger.info({ message: `Sent chat message: ${text}` });
    }

    /**
     * Phase 5: sends one message and CONFIRMS it went — used for the greeting,
     * which must be dependable (it becomes customisable later).
     * On a successful send Teams clears the compose box, so leftover text
     * means the Enter didn't take. Retries the whole flow (panel open
     * included) a few times before giving up, logging clearly either way.
     * Returns true once confirmed posted.
     */
    public async sendMessageReliably(text: string, attempts = 3): Promise<boolean> {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                await this.openChatPanel();
                const composeBox = this._composeBox();
                await composeBox.click();
                await composeBox.fill(text);
                await this.page.keyboard.press('Enter');

                // Confirm: give Teams a moment, then check the box emptied.
                await this.page.waitForTimeout(1200);
                const leftover = (await composeBox.innerText().catch(() => '')).trim();
                if (!leftover) {
                    this.logger.info({ message: `Confirmed chat message posted (attempt ${attempt}): ${text}` });
                    return true;
                }
                this.logger.warn({ message: `Message still sitting in the compose box after attempt ${attempt} — retrying.` });
            } catch (error) {
                this.logger.warn({ message: `Send attempt ${attempt} failed — retrying.`, data: error });
            }
            await this.page.waitForTimeout(1500); // let the meeting UI settle before the next try
        }
        this.logger.error({ message: `Could NOT post chat message after ${attempts} attempts: ${text}` });
        return false;
    }
}
