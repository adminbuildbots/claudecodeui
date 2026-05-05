Help the user assign **production** and **development** environments to the current project, persisting the choice to `<project_path>/.lab/environments.json` so the cloudcli UI's header pills reflect it and future sessions know which infra to target.

## What an environment assignment is

- **Production** = a DigitalOcean droplet (use `do_list_droplets`)
- **Development** = a Hyper-V VM on KITVM3 (use `kitvm3_list_vms`)

The mapping lives in a per-project JSON file. The user generally doesn't need to see the file format — call the lab MCP tools instead of writing JSON yourself.

## Steps

1. **Resolve the project path.** If you don't already have it, run `pwd` via Bash to determine the user's current working directory. That's the `project_path` for every subsequent tool call.

2. **Read current state.** Call `lab_get_environments` with the project_path. If both production and development are already set, summarize the current assignments and ask the user if they want to change anything. If only one is set, focus on the missing one.

3. **List candidates** (only as needed):
   - For production: `do_list_droplets`. There may be many — narrow by:
     - Tags matching the project name
     - Hostnames containing the project slug
     - Asking the user "I see N droplets; want me to filter?" if the list is large (>15)
   - For development: `kitvm3_list_vms`. There are typically ≤10, so list all of them with their state (2 = Running, 3 = Off).

4. **Suggest a match if obvious.** If a droplet's name closely matches the project directory name (e.g., project `kit-3cx` and droplet `keylinkit.tn.3cx.us`), surface it as a default suggestion. Otherwise present the candidates and ask the user which one.

5. **Confirm before writing.** Echo what you're about to set: "I'll assign **prod = lab.keylinkit.net** (droplet 564052797) and **dev = KIT-Dev**. Confirm?" — wait for explicit approval.

6. **Write the assignment.** Use `lab_set_production` and/or `lab_set_development`. Pass the rich fields (region, ip for droplets; state for VMs) when available — they make the UI display nicer.

7. **Verify.** After writing, call `lab_get_environments` again to confirm the file matches what you intended, then tell the user the cloudcli header pills will reflect the change on next page load.

## When the user says "deploy to prod" or "ssh into dev" later

Read `lab_get_environments` first, then use the returned droplet ID with `do_ssh_command` (for prod) or the VM name with `kitvm3_run_powershell` / `kitvm3_run_in_vm` (for dev). The user shouldn't need to repeat the assignment every session — that's the whole point of persisting it.

## Edge cases

- **`.lab/environments.json` doesn't exist yet**: `lab_get_environments` returns `{production: null, development: null}` — that's fine, just a fresh project. Proceed with assignments.
- **User wants to clear an assignment**: use `lab_clear_environment` with `slot=production` or `slot=development`.
- **User wants to assign a droplet that doesn't exist yet**: tell them to create it first via `do_create_droplet`, then re-run `/assign-environments`.
- **User wants to assign a VM that doesn't exist yet**: same — `kitvm3_create_vm` first.
