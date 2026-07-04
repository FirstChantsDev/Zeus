import { Logger } from './Logger';
import { Condition } from '../conditions';

/**
 * Nudger is the agent's decision brain (Phase 2 version).
 *
 * It holds the meeting's conditions (the owner's brief) and, for every
 * finished caption line, makes ONE Anthropic API call that answers two
 * questions at once:
 *
 *   1. RESOLVE — does this line clearly settle any open condition?
 *      If so, that condition is marked 'closed'.
 *   2. NUDGE — should the agent post one short chat message pushing the
 *      room toward the most important condition still open?
 *
 * A cooldown stops the agent from nagging: after any nudge it stays
 * quiet for NUDGE_COOLDOWN_MS no matter what the model suggests.
 *
 * Uses Node's built-in fetch — no SDK dependency, per project constraints.
 */

/** A nudge the agent wants posted to the meeting chat. */
export type NudgeDecision = {
    /** The chat message, always starting with [ZEUS] */
    text: string;
    /** Which condition this nudge is pushing on */
    conditionId: string;
};

/** What the brain concluded about one caption line. */
export type LineDecision = {
    /** A nudge to post, or null for "stay quiet" */
    nudge: NudgeDecision | null;
    /** Conditions this line just closed (empty most of the time) */
    resolvedIds: string[];
};

export class Nudger {
    /** Minimum quiet time between nudges, so the agent never spams the room */
    private static readonly NUDGE_COOLDOWN_MS = 45000;

    private readonly apiKey: string;
    private readonly logger: Logger;
    private readonly conditions: Condition[];
    /** Optional extra guidance from the briefing screen ("Maya holds the budget") */
    private context = '';
    private lastNudgeAt = 0;

    constructor(args: { botId: string, apiKey: string, conditions: Condition[] }) {
        this.apiKey = args.apiKey;
        this.conditions = args.conditions;
        this.logger = new Logger({ source: 'nudger', botId: args.botId });
    }

    /** Phase 3: the briefing screen's optional context line, set when the owner submits the brief */
    public setContext(context: string) {
        this.context = context.trim();
    }

    /**
     * Returns what to do about one caption line: which conditions it closed,
     * and a nudge to post (or null for "stay quiet").
     * Side effect: flips conditions to 'closed' when a line resolves them,
     * and increments a condition's nudge count when a nudge is returned.
     * Never throws — a failed API call just means no decision for that line.
     */
    public async decide(line: { speaker: string, text: string, ts: string }): Promise<LineDecision> {
        const quiet: LineDecision = { nudge: null, resolvedIds: [] };
        const openConditions = this.conditions.filter((c) => c.status === 'open');
        if (openConditions.length === 0) {
            return quiet; // everything the owner asked for is settled — stay quiet
        }

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-opus-4-8',
                    max_tokens: 300,
                    system: this._buildSystemPrompt(),
                    messages: [
                        { role: 'user', content: `${line.speaker}: ${line.text}` },
                    ],
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '(no body)');
                this.logger.error({ message: `Anthropic API error ${response.status}`, data: errorBody });
                return quiet;
            }

            const data = await response.json() as { content?: Array<{ type: string, text?: string }> };
            const text = (data.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
                .trim();

            const decision = this._parseDecision(text);
            if (!decision) {
                return quiet;
            }

            // 1. Close any conditions this line resolved.
            const resolvedIds: string[] = [];
            for (const id of decision.resolves) {
                const condition = this.conditions.find((c) => c.id === id && c.status === 'open');
                if (condition) {
                    condition.status = 'closed';
                    condition.note = `Settled by ${line.speaker}: "${line.text}"`;
                    resolvedIds.push(condition.id);
                    console.log(`CONDITION CLOSED >>> ${condition.label} — ${condition.note}`);
                }
            }

            // 2. Maybe nudge — but respect the cooldown, and never nudge a
            //    condition that just closed above.
            let nudge: NudgeDecision | null = null;
            if (decision.nudge) {
                const condition = this.conditions.find((c) => c.id === decision.nudge!.conditionId && c.status === 'open');
                const quietLongEnough = Date.now() - this.lastNudgeAt >= Nudger.NUDGE_COOLDOWN_MS;
                if (condition && quietLongEnough) {
                    condition.nudges++;
                    this.lastNudgeAt = Date.now();
                    const message = decision.nudge.message.startsWith('[ZEUS]')
                        ? decision.nudge.message
                        : `[ZEUS] ${decision.nudge.message}`;
                    nudge = { text: message, conditionId: condition.id };
                }
            }
            return { nudge, resolvedIds };
        } catch (error) {
            this.logger.error({ message: 'Nudge decision failed', data: error });
            return quiet;
        }
    }

    /** The instructions sent with every call, rebuilt so they always show live condition state */
    private _buildSystemPrompt(): string {
        const conditionLines = this._conditionLines();

        return [
            'You are Zeus bot, a quiet agent sitting in a live meeting. Your owner gave you a short list of',
            'conditions this meeting must settle before it ends. You receive one live-caption line at a time.',
            '',
            'Current conditions:',
            conditionLines,
            ...this._contextLines(),
            '',
            'Answer TWO questions about the new line:',
            '1. RESOLVE: does this line clearly settle any OPEN condition? Only count a clear decision made',
            '   in the room (e.g. "the budget is approved at 40k" settles the budget condition). A vague',
            '   mention or a question about the topic does NOT settle it.',
            '2. NUDGE: should you post one short chat message pushing the room toward the most important',
            '   OPEN condition? Nudge when the conversation is drifting past or away from an open condition.',
            '   Do NOT nudge if the room is actively discussing that condition and making progress.',
            '   A nudge is 1-2 short sentences, polite but direct, starts with the marker [ZEUS], and asks',
            '   for a concrete decision.',
            '',
            '',
            'Reply with ONLY strict JSON on one line, no other text, exactly this shape:',
            '{"resolves": ["<condition id>", ...], "nudge": {"conditionId": "<condition id>", "message": "[ZEUS] ..."}}',
            'Use "resolves": [] when nothing is settled, and "nudge": null when you should stay quiet.',
        ].join('\n');
    }

    /**
     * Milestone 4 (reworked): carries out an owner instruction from the
     * cockpit RIGHT NOW — one API call composes the chat message, no waiting
     * for the next caption line, no condition required.
     * Returns the message to post (plus the condition it pushes on, if any),
     * or null if the instruction couldn't be turned into a message.
     */
    public async executeSteer(
        instruction: string,
        recentLines: Array<{ speaker: string, text: string }>,
    ): Promise<{ text: string, conditionId: string | null } | null> {
        const transcriptLines = recentLines.length
            ? recentLines.map((l) => `${l.speaker}: ${l.text}`)
            : ['(nothing said yet)'];

        const system = [
            'You are Zeus bot, a meeting agent that sits in a live meeting and posts short chat messages',
            'marked [ZEUS]. You work for the meeting organiser: before the meeting she gave you a list of',
            'conditions to drive to a close, and during the meeting she can send you follow-up instructions',
            'from her cockpit. Relaying her instructions to the room is your normal, legitimate job —',
            'the facts they contain (deadlines, figures, names) are real information from the organiser.',
            '',
            'Current conditions:',
            this._conditionLines(),
            ...this._contextLines(),
            '',
            'Recent conversation in the room:',
            ...transcriptLines,
            '',
            'Write ONE short chat message (1-2 sentences, starting with the marker [ZEUS]) that carries',
            'out the organiser\'s instruction for the room. Include its concrete specifics. Speak as the',
            'meeting agent — you do not need to name the organiser or explain where the information',
            'came from.',
            '',
            'Reply with ONLY strict JSON on one line, no other text, exactly this shape:',
            '{"message": "[ZEUS] ...", "conditionId": "<id of the condition this pushes on, or null>"}',
        ].join('\n');

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-opus-4-8',
                    max_tokens: 300,
                    system,
                    messages: [
                        { role: 'user', content: `Instruction from the organiser: ${instruction}` },
                    ],
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '(no body)');
                this.logger.error({ message: `Anthropic API error ${response.status} (steer)`, data: errorBody });
                return null;
            }

            const data = await response.json() as { content?: Array<{ type: string, text?: string }> };
            const text = (data.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
                .trim();

            const json = Nudger._extractJson(text);
            if (!json) {
                this.logger.warn({ message: 'Could not parse steer reply', data: text });
                return null;
            }
            const parsed = JSON.parse(json) as { message?: unknown, conditionId?: unknown };
            if (typeof parsed.message !== 'string' || !parsed.message.trim()) {
                return null;
            }

            // If the message pushes on a still-open condition, count it as a nudge
            // and reset the self-drive cooldown so the agent doesn't double-post.
            let conditionId: string | null = null;
            if (typeof parsed.conditionId === 'string') {
                const condition = this.conditions.find((c) => c.id === parsed.conditionId);
                if (condition) {
                    conditionId = condition.id;
                    if (condition.status === 'open') {
                        condition.nudges++;
                    }
                }
            }
            this.lastNudgeAt = Date.now();

            const message = parsed.message.startsWith('[ZEUS]') ? parsed.message : `[ZEUS] ${parsed.message}`;
            return { text: message, conditionId };
        } catch (error) {
            this.logger.error({ message: 'Steer execution failed', data: error });
            return null;
        }
    }

    /** The owner's optional context line as extra prompt guidance, or nothing if she left it blank */
    private _contextLines(): string[] {
        if (!this.context) {
            return [];
        }
        return ['', `Extra context from your owner (use it to judge and word your messages): ${this.context}`];
    }

    /** One line per condition, showing live status, for both prompts */
    private _conditionLines(): string {
        return this.conditions.map((c) =>
            `- id "${c.id}": ${c.label} — ${c.status.toUpperCase()}${c.status === 'open' ? ` (nudged ${c.nudges} time${c.nudges === 1 ? '' : 's'} so far)` : ''}`
        ).join('\n');
    }

    /** Digs the {...} out of a model reply that may carry fences or prose around it */
    private static _extractJson(text: string): string | null {
        const cleaned = text.replace(/```(?:json)?/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end <= start) {
            return null;
        }
        return cleaned.slice(start, end + 1);
    }

    /** Pulls the JSON decision out of the model's reply; null if it can't be read */
    private _parseDecision(text: string): { resolves: string[], nudge: { conditionId: string, message: string } | null } | null {
        const cleaned = Nudger._extractJson(text);
        if (cleaned === null) {
            this.logger.warn({ message: 'Could not parse decision JSON', data: text });
            return null;
        }
        try {
            const parsed = JSON.parse(cleaned) as { resolves?: unknown, nudge?: { conditionId?: unknown, message?: unknown } | null };
            const resolves = Array.isArray(parsed.resolves)
                ? parsed.resolves.filter((id): id is string => typeof id === 'string')
                : [];
            const nudge = (parsed.nudge && typeof parsed.nudge.conditionId === 'string' && typeof parsed.nudge.message === 'string')
                ? { conditionId: parsed.nudge.conditionId, message: parsed.nudge.message }
                : null;
            return { resolves, nudge };
        } catch {
            this.logger.warn({ message: 'Could not parse decision JSON', data: cleaned });
            return null;
        }
    }
}
