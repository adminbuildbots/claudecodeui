Push the generated tasks to the Console Projects API so they land in the team's project tracker.

**Status:** the Console API contract isn't finalized yet (PLAN.md Open Decision #12). For now, this command is a dry run — gather everything that *would* be sent and present it to the user.

1. Read `.taskmaster/tasks/tasks.json`. If missing, tell the user to run `/generate-tasks` first.
2. Read `.taskmaster/docs/prd.md` to capture the project name + executive summary.
3. Print the JSON payload that will be POSTed to Console once the API lands:

   ```json
   {
     "name": "<project name>",
     "description": "<one-line from executive summary>",
     "prd_url": "<gitea URL if /submit-to-forge has been run, else null>",
     "tasks": [ ... ]
   }
   ```

4. Tell the user: "When the Console API ships, this payload will POST to `$CONSOLE_API_URL/projects` with a service token. Track progress at PLAN.md Open Decision #12."
