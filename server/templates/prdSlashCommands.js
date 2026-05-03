// Project-scoped slash commands scaffolded into "From PRD" projects. Lands at
// `.claude/commands/*.md` so Claude Code picks them up automatically. Each
// file's content is the prompt that gets sent to Claude when the user types
// the matching slash command in chat.
//
// Naming convention: file basename → command name (e.g. save-prd.md → /save-prd).

export const PRD_SLASH_COMMANDS = {
  'save-prd.md': `Save the current PRD draft to \`.taskmaster/docs/prd.md\` so it can be picked up by task-master and downstream Forge tooling.

1. Assemble the complete PRD markdown from our conversation so far, using the 19-section format from your system prompt (CLAUDE.md). Include all sections that have content; for sections that haven't been discussed, write \`_(not yet discussed)_\` rather than padding with filler.
2. Write the markdown to \`.taskmaster/docs/prd.md\`. Overwrite if it already exists — this command is the "commit current state" gesture.
3. After saving, briefly summarize what's in the file (which sections are filled, which are still open) so the user knows what they have.
`,

  'generate-tasks.md': `Generate a task breakdown from the saved PRD using the task-master MCP tools.

1. Read \`.taskmaster/docs/prd.md\`. If the file doesn't exist, tell the user to run \`/save-prd\` first.
2. Call the task-master \`parse_prd\` MCP tool with the PRD content. The tool will produce a structured task list.
3. Save the result to \`.taskmaster/tasks/tasks.json\` in task-master's expected format (\`{ master: { tasks: [...] } }\`).
4. Show the user the generated tasks: count, top-level structure, any tasks marked high-priority. Ask if they want to refine before pushing to Console.

If task-master's \`parse_prd\` tool isn't available in this session, fall back to generating the task structure yourself by reading the PRD and producing a JSON file with this shape:

\`\`\`json
{
  "master": {
    "tasks": [
      { "id": 1, "title": "...", "description": "...", "status": "pending", "priority": "high", "dependencies": [] }
    ]
  }
}
\`\`\`

Use sequential IDs starting at 1, derive titles from PRD sections (one task per major requirement), set \`status\` to \`pending\` and \`priority\` based on the PRD's P0/P1/P2 markings (P0 → high, P1 → medium, P2 → low).
`,

  'submit-to-forge.md': `Submit the saved PRD to the Forge pipeline by pushing it to the \`keylink-studio/forge-prds\` Gitea repo.

1. Read \`.taskmaster/docs/prd.md\`. If it doesn't exist, tell the user to run \`/save-prd\` first.
2. Determine a sensible filename slug from the project context (use the workspace directory name).
3. POST the PRD to the local Forge endpoint:

   \`\`\`bash
   curl -sS -X POST http://localhost:3001/api/forge/submit \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer $CLOUDCLI_AUTH_TOKEN" \\
     -d "$(jq -n --arg name "<slug>" --arg content "$(cat .taskmaster/docs/prd.md)" '{fileName: $name, content: $content}')"
   \`\`\`

   The auth token is the same one the browser session is using. If \`CLOUDCLI_AUTH_TOKEN\` isn't set in the environment, ask the user to set it (it's in their browser's localStorage as \`auth-token\`) — or run the curl from inside the cloudcli container where the request can come from \`localhost\` without auth.
4. The response includes \`repoUrl\` and \`fileUrl\`. Show those to the user so they can click through.
`,

  'push-to-console.md': `Push the generated tasks to the Console Projects API so they land in the team's project tracker.

**Status:** the Console API contract isn't finalized yet (PLAN.md Open Decision #12). For now, this command is a dry run — gather everything that *would* be sent and present it to the user.

1. Read \`.taskmaster/tasks/tasks.json\`. If missing, tell the user to run \`/generate-tasks\` first.
2. Read \`.taskmaster/docs/prd.md\` to capture the project name + executive summary.
3. Print the JSON payload that will be POSTed to Console once the API lands:

   \`\`\`json
   {
     "name": "<project name>",
     "description": "<one-line from executive summary>",
     "prd_url": "<gitea URL if /submit-to-forge has been run, else null>",
     "tasks": [ ... ]
   }
   \`\`\`

4. Tell the user: "When the Console API ships, this payload will POST to \`$CONSOLE_API_URL/projects\` with a service token. Track progress at PLAN.md Open Decision #12."
`,
};
