// Project-scoped slash commands scaffolded into "From PRD" projects. Lands at
// `<project>/.claude/commands/*.md` so Claude Code picks them up automatically.
// Each file's content is the prompt that gets sent to Claude when the user
// types the matching slash command in chat.
//
// Source of truth lives at /app/scripts/claude-defaults/commands/*.md (also
// read by /usr/local/bin/claude-init.sh at container start to populate
// user-scope ~/.claude/commands/). Single source means the wizard scaffolder
// and the rehydrate-on-boot path can never drift.

import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// __dirname → /app/server/templates/
// commands  → /app/scripts/claude-defaults/commands/
const COMMANDS_DIR = join(__dirname, '..', '..', 'scripts', 'claude-defaults', 'commands');

export const PRD_SLASH_COMMANDS = Object.fromEntries(
  readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => [name, readFileSync(join(COMMANDS_DIR, name), 'utf-8')]),
);
