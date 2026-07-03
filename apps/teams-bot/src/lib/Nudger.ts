import { Logger } from './Logger';

/**
 * Nudger sends one finished caption line to the Anthropic API and asks a
 * simple question: does this line deserve a short nudge in the meeting chat?
 *
 * Trivial starter rule (Milestone 5): if the line contains an action item,
 * reply with a one-line summary; otherwise reply SKIP.
 *
 * Uses Node's built-in fetch — no SDK dependency, per project constraints.
 */

const SYSTEM_PROMPT = [
    'You are GATE bot, a quiet meeting assistant. You receive one live-caption line from a meeting.',
    'Rule: if the line mentions an action item (for example it contains the phrase "action item",',
    'or clearly assigns a task to someone), reply with exactly one short chat message summarizing',
    'the action item, starting with the marker [GATE]. Otherwise reply with exactly: SKIP',
    'Reply with only the chat message or SKIP. No explanations, no reasoning, no preamble.',
].join(' ');

export class Nudger {
    private readonly apiKey: string;
    private readonly logger: Logger;

    constructor(args: { botId: string, apiKey: string }) {
        this.apiKey = args.apiKey;
        this.logger = new Logger({ source: 'nudger', botId: args.botId });
    }

    /**
     * Returns the nudge text to post to chat, or null for "stay quiet".
     * Never throws — a failed API call just means no nudge for that line.
     */
    public async decide(line: { speaker: string, text: string, ts: string }): Promise<string | null> {
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
                    max_tokens: 256,
                    system: SYSTEM_PROMPT,
                    messages: [
                        { role: 'user', content: `${line.speaker}: ${line.text}` },
                    ],
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '(no body)');
                this.logger.error({ message: `Anthropic API error ${response.status}`, data: errorBody });
                return null;
            }

            const data = await response.json() as { content?: Array<{ type: string, text?: string }> };
            const text = (data.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
                .trim();

            if (!text || text === 'SKIP') {
                return null;
            }
            return text;
        } catch (error) {
            this.logger.error({ message: 'Nudge decision failed', data: error });
            return null;
        }
    }
}
