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
    /** Phase 5: the newest line named the owner in a way that needs them */
    mention: { speaker: string, quote: string } | null;
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
    /** Phase 5: the owner's name from the briefing — lets the agent spot when the room needs them */
    private ownerName = '';
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

    /** Phase 5: who the owner is, so mentions of them in the room can be flagged */
    public setOwner(name: string) {
        this.ownerName = name.trim();
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
        const quiet: LineDecision = { nudge: null, resolvedIds: [], mention: null };
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
                // Phase 5: keep the verbatim receipt behind the current judgement.
                // Overwritten as the judgement evolves; freezes once closed
                // (closed conditions are never re-judged).
                if (judged.evidence.length > 0) {
                    condition.evidence = judged.evidence;
                }
                if (judged.status === 'closed') {
                    condition.status = 'closed';
                    resolvedIds.push(condition.id);
                    console.log(`CONDITION CLOSED >>> ${condition.label} — ${condition.note ?? 'settled in the room'}`);
                    for (const line of condition.evidence ?? []) {
                        console.log(`  ⤷ ${line.speaker}: "${line.quote}"`);
                    }
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

            // 3. Phase 5: pass along an owner mention, but only when a name was briefed.
            const mention = this.ownerName ? decision.mention : null;
            return { nudge, resolvedIds, mention };
        } catch (error) {
            this.logger.error({ message: 'Nudge decision failed', data: error });
            return quiet;
        }
    }

    /** The instructions sent with every call, rebuilt so they always show live condition and time state */
    private _buildSystemPrompt(time: TimeState): string {
        // Phase 5: only ask about owner mentions when a name was briefed. Scoped
        // to the LAST line so one remark is flagged once, not on every turn the
        // rolling window still contains it.
        const mentionTask = this.ownerName ? [
            '',
            `3. MENTION: look ONLY at the LAST line — the one that just arrived. Does it name or clearly`,
            `   refer to your owner, ${this.ownerName}, in a way that needs their input, decision, or`,
            `   presence — e.g. "we can't confirm until ${this.ownerName} gets back to us" or "let's check`,
            `   with ${this.ownerName}"? If yes, report the speaker and their exact verbatim words.`,
            `   A mention that needs nothing from ${this.ownerName} (e.g. "${this.ownerName} already`,
            `   approved this") is NOT an alert — use null.`,
        ] : [];
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
            `Do ${this.ownerName ? 'THREE' : 'TWO'} things, judging from the WHOLE conversation, not just the newest line. A resolution often`,
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
            '   - evidence: the transcript line(s) that DIRECTLY drive your judgement, copied VERBATIM from',
            '     the conversation — the speaker and their exact words, character for character. Never',
            '     paraphrase, shorten, or invent a quote. At most 3 lines; use [] when no specific line',
            '     applies (e.g. the condition simply has not been raised yet).',
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
            ...mentionTask,
            '',
            'Reply with ONLY strict JSON on one line, no other text, exactly this shape:',
            '{"conditions": [{"id": "<id>", "status": "open", "reason": "...", "why": "...",',
            '   "evidence": [{"speaker": "<name>", "quote": "<their exact words>"}]}, ...],',
            ' "nudge": {"conditionId": "<id>", "message": "[ZEUS] ..."}' + (this.ownerName ? ',' : '}'),
            ...(this.ownerName ? [' "mention": {"speaker": "<name>", "quote": "<their exact words>"}}'] : []),
            'Include EVERY open condition in "conditions" (status "open" or "closed").',
            'Use "nudge": null when you should stay quiet' + (this.ownerName ? ', and "mention": null unless the newest line genuinely needs your owner.' : '.'),
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

    /**
     * Phase 10 Milestone 3 — chat-mode briefing. One API call per owner
     * message: the model collects the brief conversationally and, when the
     * calendar is connected, matches what the owner says against their
     * upcoming meetings. It NEVER sees join links — meetings are passed by
     * index (subject, time, duration, hasTeamsLink) and the server maps a
     * chosen index back to the real URL.
     *
     * Returns null on any failure so the UI can say "try again".
     */
    public async briefChat(args: {
        history: Array<{ from: 'owner' | 'agent', text: string }>,
        meetings: Array<{ index: number, subject: string, start: string, durationMinutes: number, hasTeamsLink: boolean }>,
    }): Promise<{
        reply: string,
        proposeMeeting: number | null,
        showList: boolean,
        brief: {
            meetingIndex: number | null,
            meetingUrl: string | null,
            meetingName: string,
            lengthMinutes: number,
            ownerName: string,
            conditions: string[],
            context: string,
        } | null,
    } | null> {
        const calendarLines = args.meetings.length
            ? [
                'The owner\'s upcoming meetings (their calendar is connected):',
                ...args.meetings.map((m) => `  ${m.index}: "${m.subject}" — ${m.start} (${m.durationMinutes} min)${m.hasTeamsLink ? '' : ' [NO Teams link — cannot be chosen]'}`),
            ]
            : ['The owner\'s calendar is NOT connected — they must paste a Teams meeting link in the chat.'];

        const system = [
            'You are Zeus bot. Your owner is briefing you, by chat, for a meeting you will attend and drive',
            'for them. Collect the brief briskly and warmly — 1-2 short sentences per turn, one question at',
            'a time. You need:',
            '1. WHICH MEETING. If their words clearly match exactly ONE meeting in the calendar list, propose',
            '   it by setting proposeMeeting to its index and asking for confirmation in your reply, naming',
            '   it with its day and time (e.g. "I\'ll assume you mean \'Marketing Launch Sync\', Thu 15:00 —',
            '   right?"). NEVER guess between several plausible matches and never invent meetings — if',
            '   nothing matches confidently, set showList true and ask them to tap one. A pasted Teams link',
            '   also works. Meetings marked [NO Teams link] cannot be chosen — say why if they ask for one.',
            '   When the owner confirms your proposal (yes / that one / correct), the meeting is resolved.',
            '2. THE CONDITIONS this meeting must settle — 1 to 5, in the owner\'s own words.',
            '3. Optionally: their name (so you can flag when the room needs them) and any extra context.',
            '   The scheduled length comes from the calendar automatically; for a pasted link ask once or',
            '   default to 30.',
            '',
            ...calendarLines,
            '',
            `Today is ${new Date().toISOString().slice(0, 10)} (times are UTC).`,
            '',
            'Reply with ONLY strict JSON on one line, exactly this shape:',
            '{"reply": "...", "proposeMeeting": <calendar index>|null, "showList": true|false,',
            ' "brief": null | {"meetingIndex": <index>|null, "meetingUrl": "<pasted link>"|null,',
            '   "meetingName": "...", "lengthMinutes": <n>, "ownerName": "...", "conditions": ["..."],',
            '   "context": "..."}}',
            'Set "brief" ONLY once the meeting is resolved (confirmed index, or pasted link) AND you have at',
            'least one condition and have given the owner a chance to add their name/context. Its reply is',
            'still shown — make it the send-off ("Locked in — heading into <meeting> with those 3 conditions.").',
        ].join('\n');

        const conversation = args.history.map((m) => `${m.from === 'owner' ? 'Owner' : 'You'}: ${m.text}`).join('\n');

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
                    max_tokens: 600,
                    system,
                    messages: [{ role: 'user', content: `Conversation so far:\n${conversation}` }],
                }),
            });
            if (!response.ok) {
                const errorBody = await response.text().catch(() => '(no body)');
                this.logger.error({ message: `Anthropic API error ${response.status} (brief chat)`, data: errorBody });
                return null;
            }
            const data = await response.json() as { content?: Array<{ type: string, text?: string }> };
            const text = (data.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
                .trim();
            const cleaned = Nudger._extractJson(text);
            if (!cleaned) {
                this.logger.warn({ message: 'Could not parse brief-chat JSON', data: text });
                return null;
            }
            const parsed = JSON.parse(cleaned) as {
                reply?: unknown, proposeMeeting?: unknown, showList?: unknown,
                brief?: {
                    meetingIndex?: unknown, meetingUrl?: unknown, meetingName?: unknown,
                    lengthMinutes?: unknown, ownerName?: unknown, conditions?: unknown, context?: unknown,
                } | null,
            };
            if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;
            const brief = (parsed.brief && typeof parsed.brief === 'object')
                ? {
                    meetingIndex: typeof parsed.brief.meetingIndex === 'number' ? parsed.brief.meetingIndex : null,
                    meetingUrl: typeof parsed.brief.meetingUrl === 'string' && parsed.brief.meetingUrl.trim() ? parsed.brief.meetingUrl.trim() : null,
                    meetingName: typeof parsed.brief.meetingName === 'string' ? parsed.brief.meetingName.trim() : '',
                    lengthMinutes: typeof parsed.brief.lengthMinutes === 'number' ? parsed.brief.lengthMinutes : 30,
                    ownerName: typeof parsed.brief.ownerName === 'string' ? parsed.brief.ownerName.trim() : '',
                    conditions: Array.isArray(parsed.brief.conditions)
                        ? parsed.brief.conditions.filter((c): c is string => typeof c === 'string' && Boolean(c.trim())).map((c) => c.trim())
                        : [],
                    context: typeof parsed.brief.context === 'string' ? parsed.brief.context.trim() : '',
                }
                : null;
            return {
                reply: parsed.reply.trim(),
                proposeMeeting: typeof parsed.proposeMeeting === 'number' ? parsed.proposeMeeting : null,
                showList: parsed.showList === true,
                brief,
            };
        } catch (error) {
            this.logger.error({ message: 'Brief-chat call failed', data: error });
            return null;
        }
    }

    /**
     * ONE API call at meeting end: a short, factual plain-English summary
     * for the meeting's persisted record — what was decided, what stayed
     * open, who was involved. Never throws; null means "no summary" and
     * the record is saved without one.
     */
    public async summarise(args: {
        meetingName: string,
        ownerName: string,
        participants: string[],
        durationMinutes: number | null,
        events: Array<{ at: string, type: string, detail: string }>,
    }): Promise<string | null> {
        const boardLines = this.conditions.map((c) => {
            const evidence = (c.evidence ?? []).map((e) => `${e.speaker}: "${e.quote}"`).join(' / ');
            return `- ${c.label} — ${c.status.toUpperCase()}${c.note ? ` (${c.note})` : ''}${evidence ? ` [evidence: ${evidence}]` : ''}`;
        }).join('\n');
        const eventLines = args.events
            .filter((e) => e.type !== 'speaker-seen') // participants are passed separately
            .map((e) => `- ${e.at.slice(11, 19)} ${e.detail}`)
            .join('\n');

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
                    max_tokens: 500,
                    system: [
                        'You are Zeus bot. A meeting you attended for your owner has just ended. Write the short,',
                        'factual summary that goes into its permanent record — the thing your owner actually reads',
                        'afterwards.',
                        '',
                        'Cover, in plain English prose (a short paragraph or two, no headings, no bullet lists):',
                        'what was decided (with the deciding words where you have them), which conditions closed and',
                        'which stayed open (and why, if known), anything that needed the owner, and who was involved.',
                        'Only state what the record shows — do not embellish or guess. Keep it under 150 words.',
                    ].join('\n'),
                    messages: [{
                        role: 'user',
                        content: [
                            `Meeting: "${args.meetingName}"${args.ownerName ? ` (owner: ${args.ownerName})` : ''}`,
                            args.durationMinutes !== null ? `Duration: about ${args.durationMinutes} minutes.` : 'The agent never made it into the room.',
                            `Participants heard: ${args.participants.length ? args.participants.join(', ') : 'none'}`,
                            '',
                            'Final condition board:',
                            boardLines || '(no conditions)',
                            '',
                            'What happened, in order:',
                            eventLines || '(no events)',
                        ].join('\n'),
                    }],
                }),
            });
            if (!response.ok) {
                const errorBody = await response.text().catch(() => '(no body)');
                this.logger.error({ message: `Anthropic API error ${response.status} (summary)`, data: errorBody });
                return null;
            }
            const data = await response.json() as { content?: Array<{ type: string, text?: string }> };
            const text = (data.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
                .trim();
            return text || null;
        } catch (error) {
            this.logger.error({ message: 'Summary generation failed', data: error });
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
        conditions: Array<{ id: string, status: 'open' | 'closed', reason: string, why: string, evidence: Array<{ speaker: string, quote: string }> }>,
        nudge: { conditionId: string, message: string } | null,
        mention: { speaker: string, quote: string } | null,
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
                mention?: { speaker?: unknown, quote?: unknown } | null,
            };
            const conditions = (Array.isArray(parsed.conditions) ? parsed.conditions : [])
                .filter((item): item is { id: string, status?: unknown, reason?: unknown, why?: unknown, evidence?: unknown } =>
                    Boolean(item) && typeof (item as { id?: unknown }).id === 'string')
                .map((item) => ({
                    id: item.id,
                    status: (item.status === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
                    reason: typeof item.reason === 'string' ? item.reason.trim() : '',
                    why: typeof item.why === 'string' ? item.why.trim() : '',
                    evidence: (Array.isArray(item.evidence) ? item.evidence : [])
                        .filter((line): line is { speaker: string, quote: string } =>
                            Boolean(line)
                            && typeof (line as { speaker?: unknown }).speaker === 'string'
                            && typeof (line as { quote?: unknown }).quote === 'string'
                            && Boolean((line as { quote: string }).quote.trim()))
                        .slice(0, 3),
                }));
            const nudge = (parsed.nudge && typeof parsed.nudge.conditionId === 'string' && typeof parsed.nudge.message === 'string')
                ? { conditionId: parsed.nudge.conditionId, message: parsed.nudge.message }
                : null;
            const mention = (parsed.mention && typeof parsed.mention.speaker === 'string'
                && typeof parsed.mention.quote === 'string' && parsed.mention.quote.trim())
                ? { speaker: parsed.mention.speaker, quote: parsed.mention.quote }
                : null;
            return { conditions, nudge, mention };
        } catch {
            this.logger.warn({ message: 'Could not parse decision JSON', data: cleaned });
            return null;
        }
    }
}
