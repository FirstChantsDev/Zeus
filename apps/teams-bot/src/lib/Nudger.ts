import { Logger } from './Logger';
import { Condition } from '../conditions';

/**
 * Nudger is the agent's decision brain (Phase 4 version).
 *
 * It holds the meeting's conditions (the owner's brief) and, for every
 * finished caption line, makes ONE Anthropic API call that judges the
 * WHOLE conversation so far — not just the newest line — and answers:
 *
 *   1. JUDGE — for each open condition: is it now settled (a resolution
 *      may unfold across several lines and speakers), a one-line reason
 *      for the board, and a fuller "why" the owner can expand.
 *   2. NUDGE — should the agent post one short chat message pushing the
 *      room toward the most important condition still open? Remaining
 *      meeting time shapes how urgent that nudge is.
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

/** What the brain concluded after one caption line arrived. */
export type LineDecision = {
    /** A nudge to post, or null for "stay quiet" */
    nudge: NudgeDecision | null;
    /** Conditions the conversation just closed (empty most of the time) */
    resolvedIds: string[];
};

/** Where the meeting stands against its scheduled length (from the briefing) */
export type TimeState = {
    scheduledMinutes: number;
    /** Minutes left; negative when over time; null before the bot is in the meeting */
    remainingMinutes: number | null;
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
     * Phase 4: judges the whole conversation so far (the caller passes a
     * rolling window of transcript lines, newest last) against every open
     * condition, and decides whether to nudge — with urgency shaped by the
     * remaining meeting time.
     * Side effects: flips conditions to 'closed' when the room has settled
     * them, refreshes each open condition's one-line reason (note) and
     * fuller explanation (why), and increments nudge counts.
     * Never throws — a failed API call just means no decision this line.
     */
    public async decide(args: {
        transcript: Array<{ speaker: string, text: string }>,
        time: TimeState,
    }): Promise<LineDecision> {
        const quiet: LineDecision = { nudge: null, resolvedIds: [] };
        const openConditions = this.conditions.filter((c) => c.status === 'open');
        if (openConditions.length === 0) {
            return quiet; // everything the owner asked for is settled — stay quiet
        }

        const conversation = args.transcript.length
            ? args.transcript.map((l) => `${l.speaker}: ${l.text}`).join('\n')
            : '(nothing said yet)';

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
                    max_tokens: 700,
                    system: this._buildSystemPrompt(args.time),
                    messages: [
                        { role: 'user', content: `Conversation so far (oldest first; the LAST line just arrived):\n${conversation}` },
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

            // 1. Apply the per-condition judgements: close what the room has
            //    settled, and refresh every open condition's reason + why.
            const resolvedIds: string[] = [];
            for (const judged of decision.conditions) {
                const condition = this.conditions.find((c) => c.id === judged.id && c.status === 'open');
                if (!condition) {
                    continue; // unknown id, or already closed — never reopen
                }
                if (judged.reason) {
                    condition.note = judged.reason;
                }
                if (judged.why) {
                    condition.why = judged.why;
                }
                if (judged.status === 'closed') {
                    condition.status = 'closed';
                    resolvedIds.push(condition.id);
                    console.log(`CONDITION CLOSED >>> ${condition.label} — ${condition.note ?? 'settled in the room'}`);
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

    /** The instructions sent with every call, rebuilt so they always show live condition and time state */
    private _buildSystemPrompt(time: TimeState): string {
        return [
            'You are Zeus bot, a quiet agent sitting in a live meeting. Your owner gave you a short list of',
            'conditions this meeting must settle before it ends. On every turn you receive the conversation',
            'so far as live-caption lines, oldest first — the last line is the one that just arrived.',
            '',
            'Current conditions:',
            this._conditionLines(),
            ...this._contextLines(),
            ...Nudger._timeLines(time),
            '',
            'Do TWO things, judging from the WHOLE conversation, not just the newest line. A resolution often',
            'unfolds across several lines and speakers — e.g. "what\'s the budget?" / "50k" / "yes, approved"',
            'across three speakers clearly settles a budget condition even though no single line does.',
            '',
            '1. JUDGE every OPEN condition:',
            '   - status: "closed" ONLY if the room has clearly settled it — a definite decision stated or',
            '     agreed out loud, possibly across several lines. A vague mention or an unanswered question',
            '     does NOT settle it. Otherwise "open".',
            '   - reason: ONE short line for the owner\'s board. If closed: who/what settled it. If open:',
            '     where it stands in the room right now (e.g. "Not raised yet", "Waiting on finance").',
            '   - why: 1-2 plain-English sentences telling the fuller story — what is blocking it, who said',
            '     what, whether it depends on another condition; or, if closed, how it came together.',
            '',
            '2. NUDGE: should you post one short chat message pushing the room toward the most important',
            '   OPEN condition? Nudge when the conversation is drifting past or away from an open condition.',
            '   Do NOT nudge if the room is actively discussing that condition and making progress.',
            '   A nudge is 1-2 short sentences, polite but direct, starts with the marker [ZEUS], and asks',
            '   for a concrete decision.',
            '   URGENCY: let the remaining time shape your tone and eagerness. With plenty of time left,',
            '   nudge sparingly and gently. Once under a third of the meeting remains, be more direct and',
            '   mention the time. In the final minutes — or over time — push hard for immediate decisions',
            '   on whatever is still open (e.g. "Ten minutes left and the budget is still open — can we',
            '   lock it now?").',
            '',
            'Reply with ONLY strict JSON on one line, no other text, exactly this shape:',
            '{"conditions": [{"id": "<id>", "status": "open", "reason": "...", "why": "..."}, ...],',
            ' "nudge": {"conditionId": "<id>", "message": "[ZEUS] ..."}}',
            'Include EVERY open condition in "conditions" (status "open" or "closed").',
            'Use "nudge": null when you should stay quiet.',
        ].join('\n');
    }

    /** The scheduled-length / time-remaining lines for the prompts (empty before the meeting starts) */
    private static _timeLines(time: TimeState): string[] {
        if (time.remainingMinutes === null) {
            return ['', `Time: the meeting is scheduled for ${time.scheduledMinutes} minutes; it has not started yet.`];
        }
        const remaining = Math.round(time.remainingMinutes);
        if (remaining >= 0) {
            return ['', `Time: the meeting is scheduled for ${time.scheduledMinutes} minutes; about ${remaining} minute${remaining === 1 ? '' : 's'} remain.`];
        }
        const over = -remaining;
        return ['', `Time: the meeting was scheduled for ${time.scheduledMinutes} minutes and is now ${over} minute${over === 1 ? '' : 's'} OVER time.`];
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
        time: TimeState,
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
            ...Nudger._timeLines(time),
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
    private _parseDecision(text: string): {
        conditions: Array<{ id: string, status: 'open' | 'closed', reason: string, why: string }>,
        nudge: { conditionId: string, message: string } | null,
    } | null {
        const cleaned = Nudger._extractJson(text);
        if (cleaned === null) {
            this.logger.warn({ message: 'Could not parse decision JSON', data: text });
            return null;
        }
        try {
            const parsed = JSON.parse(cleaned) as {
                conditions?: unknown,
                nudge?: { conditionId?: unknown, message?: unknown } | null,
            };
            const conditions = (Array.isArray(parsed.conditions) ? parsed.conditions : [])
                .filter((item): item is { id: string, status?: unknown, reason?: unknown, why?: unknown } =>
                    Boolean(item) && typeof (item as { id?: unknown }).id === 'string')
                .map((item) => ({
                    id: item.id,
                    status: (item.status === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
                    reason: typeof item.reason === 'string' ? item.reason.trim() : '',
                    why: typeof item.why === 'string' ? item.why.trim() : '',
                }));
            const nudge = (parsed.nudge && typeof parsed.nudge.conditionId === 'string' && typeof parsed.nudge.message === 'string')
                ? { conditionId: parsed.nudge.conditionId, message: parsed.nudge.message }
                : null;
            return { conditions, nudge };
        } catch {
            this.logger.warn({ message: 'Could not parse decision JSON', data: cleaned });
            return null;
        }
    }
}
