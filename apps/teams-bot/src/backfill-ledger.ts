import path from 'path';
import fs from 'fs';
import { Ledger } from './lib/Ledger';
import { recordsDir } from './lib/MeetingRecord';

/**
 * One-off: fill the decision ledger from the meeting records already on
 * disk, so it is not empty on day one. Safe to run again - entries are
 * matched by id, so nothing is duplicated.
 *
 *   npx tsx apps/teams-bot/src/backfill-ledger.ts            (plain wording, free)
 *   npx tsx apps/teams-bot/src/backfill-ledger.ts --polish   (one paid API call per record, crisper wording)
 */
const readKey = (): string => {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    try {
        const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').replace(/^﻿/, '');
        const match = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
        return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch {
        return '';
    }
};

void (async () => {
    const polish = process.argv.includes('--polish');
    const apiKey = polish ? readKey() : '';
    if (polish && !apiKey) console.log('NOTE: --polish needs ANTHROPIC_API_KEY in .env - writing plain wording instead.');
    console.log(`Backfilling the ledger from ${recordsDir()} ...`);
    const totals = await Ledger.backfill(recordsDir(), { apiKey });
    console.log(`Done: ${totals.records} meeting record(s) read, ${totals.entries} decision(s) in the ledger (${totals.added} new, ${totals.updated} updated).`);
    console.log(`Ledger file: ${Ledger.ledgerFile()}`);
})();
