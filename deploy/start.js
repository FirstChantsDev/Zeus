/**
 * One start file for both Railway services (run as: node deploy/start.js).
 * Railway executes Dockerfile start commands WITHOUT a shell, so shell
 * branching (if/else) is not available — this plain-Node launcher branches
 * instead. The bot service has HUB_URL set; the cockpit does not.
 */
const { spawn } = require('child_process');

// Three modes, one launcher:
//   HUB_URL set     → the cloud bot (polls the hosted cockpit for briefs)
//   MEETING_URL set → a containerised local-mode bot joining that one meeting
//   neither         → the hosted cockpit server
const [command, args] = process.env.HUB_URL
    ? ['xvfb-run', ['--auto-servernum', '--', 'npx', 'tsx', 'deploy/bot/src/cloud-gate.ts']]
    : process.env.MEETING_URL
        ? ['xvfb-run', ['--auto-servernum', '--', 'npx', 'tsx', 'apps/teams-bot/src/gate.ts', process.env.MEETING_URL]]
        : ['node', ['deploy/cockpit-server/server.js']];

console.log(`start.js → ${command} ${args.join(' ')}`);
const child = spawn(command, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
    console.error('start.js could not launch:', error);
    process.exit(1);
});
