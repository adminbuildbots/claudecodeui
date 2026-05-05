#!/usr/bin/env node
/**
 * lab-environments MCP server — read/write per-project production +
 * development environment assignments. The state file lives at
 * <project_path>/.lab/environments.json so assignments travel with the
 * project's git repo. The cloudcli UI's header pills read the same file
 * via the /api/lab/projects/:name/environments routes.
 *
 * Tools:
 *   lab_get_environments(project_path)
 *   lab_set_production(project_path, droplet_id, droplet_name, region?, ip?)
 *   lab_set_development(project_path, vm_name, state?)
 *   lab_clear_environment(project_path, slot)
 *
 * Discovery of available droplets / VMs is delegated to the lab-do and
 * lab-kitvm3 MCP servers (do_list_droplets, kitvm3_list_vms). This server
 * only handles persistence of the chosen assignments.
 *
 * Designed for the lab.keylinkit cloudcli container. Auto-registered by
 * /usr/local/bin/claude-init.sh on every container start.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENV_DIR = '.lab';
const ENV_FILE = 'environments.json';

const server = new Server(
  { name: 'lab-environments', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------- helpers --------------------------------------------------------

function envFilePath(projectPath) {
  return path.join(projectPath, ENV_DIR, ENV_FILE);
}

async function ensureProjectPath(projectPath) {
  const stat = await fs.stat(projectPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`project_path "${projectPath}" does not exist or is not a directory`);
  }
}

async function readEnvironments(projectPath) {
  const filePath = envFilePath(projectPath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      production: parsed.production ?? null,
      development: parsed.development ?? null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { production: null, development: null };
    throw err;
  }
}

async function writeEnvironments(projectPath, envs) {
  const dir = path.join(projectPath, ENV_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ENV_FILE),
    JSON.stringify(envs, null, 2) + '\n',
    'utf-8',
  );
}

function ok(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// ---------- tools ----------------------------------------------------------

const tools = [
  {
    name: 'lab_get_environments',
    description: 'Read the production + development environment assignments for a project. Returns { production: { kind, id, name, ... } | null, development: { kind, name, ... } | null }. Missing or unconfigured projects return both as null.',
    inputSchema: {
      type: 'object',
      required: ['project_path'],
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root (the directory that contains or will contain .lab/environments.json). Use the user\'s current working directory if they\'re asking about "this project".',
        },
      },
    },
  },
  {
    name: 'lab_set_production',
    description: 'Assign a DigitalOcean droplet as the project\'s production environment. The droplet must already exist in the DO account; use do_list_droplets first to discover valid IDs and names. Writes to <project_path>/.lab/environments.json.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'droplet_id', 'droplet_name'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        droplet_id: { type: 'integer', description: 'DigitalOcean droplet numeric ID (from do_list_droplets).' },
        droplet_name: { type: 'string', description: 'DigitalOcean droplet name (display label).' },
        region: { type: 'string', description: 'Optional: region slug like "nyc2" for richer UI display.' },
        ip: { type: 'string', description: 'Optional: public IPv4 for richer UI display.' },
      },
    },
  },
  {
    name: 'lab_set_development',
    description: 'Assign a KITVM3 Hyper-V VM as the project\'s development environment. The VM must already exist on KITVM3; use kitvm3_list_vms first to discover valid names. Writes to <project_path>/.lab/environments.json.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'vm_name'],
      properties: {
        project_path: { type: 'string', description: 'Absolute path to the project root.' },
        vm_name: { type: 'string', description: 'Hyper-V VM name on KITVM3 (from kitvm3_list_vms).' },
        state: { type: 'integer', description: 'Optional: VM state integer for richer UI display (2 = Running, 3 = Off).' },
      },
    },
  },
  {
    name: 'lab_clear_environment',
    description: 'Clear an assignment for a project (set production or development back to null). Used when retiring a droplet/VM without immediately replacing it.',
    inputSchema: {
      type: 'object',
      required: ['project_path', 'slot'],
      properties: {
        project_path: { type: 'string' },
        slot: {
          type: 'string',
          enum: ['production', 'development'],
        },
      },
    },
  },
];

// ---------- handlers -------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'lab_get_environments': {
        if (!args.project_path) return fail('project_path is required');
        await ensureProjectPath(args.project_path);
        const envs = await readEnvironments(args.project_path);
        return ok({ project_path: args.project_path, environments: envs });
      }

      case 'lab_set_production': {
        const { project_path, droplet_id, droplet_name, region, ip } = args;
        if (!project_path || droplet_id == null || !droplet_name) {
          return fail('project_path, droplet_id, and droplet_name are required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs.production = {
          kind: 'do_droplet',
          id: Number(droplet_id),
          name: String(droplet_name),
          region: region ?? null,
          ip: ip ?? null,
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_set_development': {
        const { project_path, vm_name, state } = args;
        if (!project_path || !vm_name) {
          return fail('project_path and vm_name are required');
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs.development = {
          kind: 'kitvm3_vm',
          name: String(vm_name),
          state: state ?? null,
        };
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      case 'lab_clear_environment': {
        const { project_path, slot } = args;
        if (!project_path || !slot) return fail('project_path and slot are required');
        if (slot !== 'production' && slot !== 'development') {
          return fail("slot must be 'production' or 'development'");
        }
        await ensureProjectPath(project_path);
        const envs = await readEnvironments(project_path);
        envs[slot] = null;
        await writeEnvironments(project_path, envs);
        return ok({ project_path, environments: envs });
      }

      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
});

// ---------- start ----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
