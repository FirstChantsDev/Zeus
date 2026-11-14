/**
 * The hub's decision ledger (Phase 18 M3).
 *
 * Deliberately NOT a second copy: the ledger has ONE implementation,
 * apps/teams-bot/src/lib/ledger-core.js, written as dependency-free
 * CommonJS so this hub can load it directly (the hub already serves the
 * shared cockpit page from that same folder). The local bot reaches the
 * same file through lib/Ledger.ts. One file, no drift.
 */
module.exports = require('../../apps/teams-bot/src/lib/ledger-core.js');
