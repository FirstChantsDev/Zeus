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
}
