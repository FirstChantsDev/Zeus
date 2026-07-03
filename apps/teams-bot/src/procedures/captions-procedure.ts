import { Page } from 'playwright';
import { Logger } from '../lib/Logger';
import z from 'zod';
import { FileStreamer } from '../lib/FileStreamer';
import path from 'path';

/** A finished caption line, after dedup. This is all Milestone 5 consumes. */
export type FinishedCaptionLine = {
    speaker: string;
    text: string;
    ts: string;
};

const CaptionsProcedureStateSchema = z.object({
    /** The bot ID */
    botId: z.string().uuid(),

    /** The status changes of the procedure */
    statusChanges: z.array(
        z.object({
            status: z.enum([
                'unknown',
                'initializing',
                'enabled',
                'subscribed',
                'fatal'
            ]),
            subCode: z.string().nullable(),
            message: z.string().nullable(),
            createdAt: z.string().datetime(),
        })
    ),
})
type CaptionsProcedureStateType = z.infer<typeof CaptionsProcedureStateSchema>;

/**
 * CaptionsProcedure turns on Teams live captions and emits clean, finished
 * caption lines.
 *
 * Teams captions update in place: a line keeps changing while someone talks
 * (partial guesses), then settles when they pause. Dedup strategy:
 *  1. Each on-screen caption row gets a stable id (we stamp a data attribute on it).
 *  2. We keep a ledger of id -> { speaker, text, lastChanged, emitted }.
 *  3. Every change updates that row's entry.
 *  4. A row that hasn't changed for DEBOUNCE_MS is finished: emit once, mark emitted.
 *  5. A row is also finished the moment a newer row appears after it.
 */
export class CaptionsProcedure {
    private static readonly DEBOUNCE_MS = 1500;
    private static readonly SWEEP_INTERVAL_MS = 500;

    private readonly page: Page;
    private readonly logger: Logger;
    private readonly transcriptFileStreamer: FileStreamer;
    private readonly onFinishedLine?: (line: FinishedCaptionLine) => void;
    public state: CaptionsProcedureStateType;

    /** The dedup ledger: caption row id -> latest known state of that row */
    private lines = new Map<string, { speaker: string; text: string; lastChanged: number; emitted: boolean }>();
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(args: { botId: string, page: Page, onFinishedLine?: (line: FinishedCaptionLine) => void }) {
        this.page = args.page;
        this.onFinishedLine = args.onFinishedLine;
        this.state = CaptionsProcedureStateSchema.parse({
            botId: args.botId,
            statusChanges: [{
                status: 'initializing',
                subCode: null,
                message: null,
                createdAt: new Date().toISOString()
            }],
        });
        this.logger = new Logger({ source: 'captions-procedure', botId: args.botId });
        this.transcriptFileStreamer = new FileStreamer({
            streamId: `${args.botId}-transcript`,
            // Colons from toISOString() are illegal in Windows filenames
            filePath: path.join('output', 'transcripts', `${new Date().toISOString().replace(/:/g, '-')}-${args.botId}.jsonl`)
        });
    }

    /** Helper method to add a status change to the procedure state */
    private _addStatusChange(statusChange: Partial<Omit<CaptionsProcedureStateType['statusChanges'][number], 'createdAt'>>) {
        this.state = CaptionsProcedureStateSchema.parse({
            ...this.state,
            statusChanges: [
                ...this.state.statusChanges,
                {
                    // Prefill/override the status, subCode and message from the status change
                    status: 'unknown' as const,
                    subCode: null,
                    message: null,
                    ...statusChange,
                    // Don't override the createdAt
                    createdAt: new Date().toISOString()
                }
            ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        });
    }

    /** Log every visible menu item / button, so a failed hunt tells us what Teams calls things here */
    private async _dumpVisibleMenuItems(context: string) {
        const items = await this.page.locator('[role="menuitem"], [role="menuitemcheckbox"], button').evaluateAll((els) =>
            els
                .filter((el) => (el as HTMLElement).offsetParent !== null)
                .map((el) => ({
                    role: el.getAttribute('role') || el.tagName.toLowerCase(),
                    id: el.id || undefined,
                    ariaLabel: el.getAttribute('aria-label') || undefined,
                    dataTid: el.getAttribute('data-tid') || undefined,
                    text: (el.textContent || '').trim().slice(0, 50) || undefined,
                }))
        );
        this.logger.warn({ message: `${context} — visible menu items/buttons:`, data: items });
    }

    /**
     * ================================================
     * Public methods
     * ================================================
     */

    /** Enables the captions flow via the UI */
    public async enableCaptionsFlow() {
        try {
            this.logger.info({ message: 'Starting captions procedure.' });

            // Open the "More" menu
            const moreCandidates = [
                'button[id="callingButtons-showMoreBtn"]',
                'button[data-tid="more-button"]',
                'button[aria-label*="more" i]',
            ];
            let moreClicked = false;
            for (const selector of moreCandidates) {
                const button = this.page.locator(selector).first();
                if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
                    await button.click();
                    this.logger.info({ message: `Clicked "More" button (${selector}).` });
                    moreClicked = true;
                    break;
                }
            }
            if (!moreClicked) {
                await this._dumpVisibleMenuItems('"More" button not found');
                throw new Error('"More" button not found');
            }

            // Find the captions entry — sometimes directly in the menu,
            // sometimes nested under "Language and speech".
            const findCaptionsEntry = () =>
                this.page.locator('div[id="closed-captions-button"], [role="menuitem"], [role="menuitemcheckbox"]')
                    .filter({ hasText: /caption/i })
                    .first();

            let captionsEntry = findCaptionsEntry();
            if (!(await captionsEntry.isVisible().catch(() => false))) {
                const languageSubmenu = this.page.locator('[role="menuitem"]').filter({ hasText: /language and speech/i }).first();
                if (await languageSubmenu.isVisible().catch(() => false)) {
                    await languageSubmenu.click();
                    this.logger.info({ message: 'Opened "Language and speech" submenu.' });
                    captionsEntry = findCaptionsEntry();
                    await captionsEntry.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
                }
            }

            if (!(await captionsEntry.isVisible().catch(() => false))) {
                await this._dumpVisibleMenuItems('Captions menu entry not found');
                throw new Error('Captions menu entry not found');
            }
            await captionsEntry.click();
            this.logger.info({ message: 'Clicked captions menu entry.' });

            // Wait for the captions container to be visible
            const captionsContainerSelector = 'div[data-tid="closed-caption-renderer-wrapper"]';
            await this.page.waitForSelector(captionsContainerSelector, { timeout: 30000 });
            this.logger.info({ message: 'Found captions container.' });

            this._addStatusChange({ status: 'enabled', subCode: null, message: 'Live captions enabled' });
        } catch (error) {
            this._addStatusChange({ status: 'fatal', subCode: 'captions_error', message: 'Error enabling captions' });
            this.logger.error({ message: 'Error enabling captions', data: error });
            throw error;
        }
    }

    /** Subscribes to caption changes and starts the dedup sweep */
    public async subscribeToCaptions() {
        try {
            // The page calls this on every caption change (partial or not)
            await this.page.exposeFunction('gateOnCaptionUpdate', (update: { id: string, speaker: string, text: string }) => {
                this._handleUpdate(update);
            });

            const captionsContainerSelector = 'div[data-tid="closed-caption-renderer-wrapper"]';
            await this.page.waitForSelector(captionsContainerSelector, { timeout: 30000 });

            this.logger.info({ message: 'Subscribing to captions.' });

            // Inside the page: on any change in the caption area, rescan all caption
            // rows, stamp new rows with a stable incrementing id, and report each
            // row's current speaker + text up to Node.
            // NOTE: passed as a raw string, not a function — our TypeScript runner
            // (tsx/esbuild) rewrites functions with helpers like __name that do not
            // exist inside the browser page, which crashes page.evaluate.
            await this.page.evaluate(`(() => {
                const wrapper = document.querySelector('div[data-tid="closed-caption-renderer-wrapper"]');
                if (!wrapper) {
                    return;
                }

                let nextId = 1;
                const report = () => {
                    const rows = wrapper.querySelectorAll('.fui-ChatMessageCompact');
                    rows.forEach((row) => {
                        if (!row.hasAttribute('data-gate-id')) {
                            row.setAttribute('data-gate-id', String(nextId++));
                        }
                        const id = row.getAttribute('data-gate-id');
                        const authorEl = row.querySelector('span[data-tid="author"]');
                        const textEl = row.querySelector('span[data-tid="closed-caption-text"]');
                        const speaker = (authorEl && authorEl.textContent) ? authorEl.textContent.trim() : 'Unknown';
                        const text = (textEl && textEl.innerText) ? textEl.innerText.trim() : '';
                        if (text) {
                            window.gateOnCaptionUpdate({ id, speaker, text });
                        }
                    });
                };

                const observer = new MutationObserver(report);
                observer.observe(wrapper, { childList: true, subtree: true, characterData: true });
                report();
            })()`);

            // Sweep the ledger: finish lines that have gone quiet
            this.sweepTimer = setInterval(() => this._sweep(), CaptionsProcedure.SWEEP_INTERVAL_MS);

            this._addStatusChange({ status: 'subscribed', message: 'Subscribed to captions' });
        } catch (error) {
            this._addStatusChange({ status: 'fatal', subCode: 'captions_error', message: 'Error subscribing to captions' });
            this.logger.error({ message: 'Error subscribing to captions', data: error });
            throw error;
        }
    }

    public stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    /**
     * ================================================
     * Dedup internals
     * ================================================
     */

    private _handleUpdate(update: { id: string, speaker: string, text: string }) {
        const existing = this.lines.get(update.id);
        if (existing?.emitted) {
            return; // never touch a line that has already been printed
        }
        if (existing && existing.text === update.text) {
            return; // no actual change
        }

        this.lines.set(update.id, {
            speaker: update.speaker,
            text: update.text,
            lastChanged: Date.now(),
            emitted: false,
        });

        // A newer row means every older row is done talking — finish them now.
        for (const [id, line] of this.lines) {
            if (Number(id) < Number(update.id) && !line.emitted) {
                this._emit(id, line);
            }
        }
    }

    private _sweep() {
        const now = Date.now();
        for (const [id, line] of this.lines) {
            if (!line.emitted && now - line.lastChanged >= CaptionsProcedure.DEBOUNCE_MS) {
                this._emit(id, line);
            }
        }
    }

    private _emit(id: string, line: { speaker: string; text: string; lastChanged: number; emitted: boolean }) {
        line.emitted = true;
        const finished: FinishedCaptionLine = {
            speaker: line.speaker,
            text: line.text,
            ts: new Date().toISOString(),
        };

        // One clean line per finished sentence — this is the Milestone 4 deliverable
        console.log(`CAPTION >>> ${finished.speaker}: ${finished.text}`);

        this.transcriptFileStreamer.write(finished);
        this.onFinishedLine?.(finished);
    }
}
