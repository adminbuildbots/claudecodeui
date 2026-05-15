import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { authenticateToken } from '../middleware/auth.js';
import { extractProjectDirectory } from '../projects.js';

const router = express.Router();

// In-memory caches with TTL. Both list endpoints are slow:
//  - doctl list: ~1-2s, hits the DO API with auth
//  - Get-VM via SSH-over-cloudflared: 20-40s on cold tunnel, 1-2s warm
// The picker UI loads them on demand, so caching makes opening the modal
// snappy and avoids re-cold-starting the tunnel for every user click.
const CACHE_TTL_MS = 5 * 60 * 1000;
const dropletsCache = { data: null, fetchedAt: 0, error: null };
const vmsCache = { data: null, fetchedAt: 0, error: null };

const ENV_FILE_RELPATH = path.join('.lab', 'environments.json');

const ENV_DEFAULTS = Object.freeze({
  production: null,
  development: null,
});

// ---------- helpers --------------------------------------------------------

function execProcess(cmd, args, { timeoutSeconds = 60, env = process.env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = timeoutSeconds > 0
      ? setTimeout(() => {
        proc.kill('SIGKILL');
        stderr += `\n[killed by timeout after ${timeoutSeconds}s]`;
      }, timeoutSeconds * 1000)
      : null;
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}` });
    });
  });
}

async function resolveProjectPath(projectName) {
  const dir = await extractProjectDirectory(projectName);
  if (!dir) return null;
  // Sanity: the path resolution can return a synthesized directory name when
  // there are no .jsonl sessions yet. Verify the directory actually exists.
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

async function readEnvironmentsFile(projectPath) {
  const filePath = path.join(projectPath, ENV_FILE_RELPATH);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      production: parsed.production ?? null,
      development: parsed.development ?? null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...ENV_DEFAULTS };
    throw err;
  }
}

async function writeEnvironmentsFile(projectPath, envs) {
  const dir = path.join(projectPath, '.lab');
  await fs.mkdir(dir, { recursive: true });
  const content = JSON.stringify(envs, null, 2) + '\n';
  await fs.writeFile(path.join(dir, 'environments.json'), content, 'utf-8');
}

function normalizeExtras(entry) {
  // Pull through the optional rich-doc fields (services / urls / deploy_notes)
  // that any kind may carry. Validate shapes lightly; drop anything malformed.
  const out = {};
  if (Array.isArray(entry.services)) {
    out.services = entry.services
      .filter((s) => s && typeof s === 'object' && s.name)
      .map((s) => ({
        name: String(s.name),
        port: s.port != null ? Number(s.port) : undefined,
        restart: s.restart ? String(s.restart) : undefined,
      }));
  }
  if (entry.urls && typeof entry.urls === 'object' && !Array.isArray(entry.urls)) {
    out.urls = Object.fromEntries(
      Object.entries(entry.urls)
        .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
        .map(([k, v]) => [k, String(v)]),
    );
  }
  if (typeof entry.deploy_notes === 'string') {
    out.deploy_notes = entry.deploy_notes;
  }
  return out;
}

function normalizeEnvironmentEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== 'object') return null;

  const kind = entry.kind;
  const extras = normalizeExtras(entry);

  if (kind === 'do_droplet') {
    if (entry.id === undefined && !entry.name) return null;
    return {
      kind: 'do_droplet',
      id: entry.id != null ? Number(entry.id) : null,
      name: entry.name ? String(entry.name) : null,
      region: entry.region ? String(entry.region) : null,
      ip: entry.ip ? String(entry.ip) : null,
      ...extras,
    };
  }
  if (kind === 'kitvm3_vm') {
    if (!entry.name) return null;
    return {
      kind: 'kitvm3_vm',
      name: String(entry.name),
      state: entry.state != null ? entry.state : null,
      ...extras,
    };
  }
  if (kind === 'inmotion_cpanel') {
    if (!entry.server || !entry.account) return null;
    return {
      kind: 'inmotion_cpanel',
      server: String(entry.server),
      account: String(entry.account),
      domain: entry.domain ? String(entry.domain) : null,
      ip: entry.ip ? String(entry.ip) : null,
      home_path: entry.home_path ? String(entry.home_path) : `/home/${entry.account}`,
      ...extras,
    };
  }
  if (kind === 'ec2_instance') {
    if (!entry.instance_id || !entry.region || !entry.public_ip || !entry.ssh_user || !entry.ssh_key_path) {
      return null;
    }
    return {
      kind: 'ec2_instance',
      instance_id: String(entry.instance_id),
      region: String(entry.region),
      public_ip: String(entry.public_ip),
      ssh_user: String(entry.ssh_user),
      ssh_key_path: String(entry.ssh_key_path),
      code_path: entry.code_path ? String(entry.code_path) : null,
      ...extras,
    };
  }
  return null;
}

// ---------- routes ---------------------------------------------------------

router.use(authenticateToken);

// GET /api/lab/projects/:projectName/environments
router.get('/projects/:projectName/environments', async (req, res) => {
  try {
    const projectPath = await resolveProjectPath(req.params.projectName);
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const envs = await readEnvironmentsFile(projectPath);
    res.json({ projectPath, environments: envs });
  } catch (err) {
    console.error('GET /lab/projects/:name/environments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/lab/projects/:projectName/environments
// Body: { production?: <entry|null>, development?: <entry|null> }
router.put('/projects/:projectName/environments', async (req, res) => {
  try {
    const projectPath = await resolveProjectPath(req.params.projectName);
    if (!projectPath) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const incoming = req.body || {};
    const merged = await readEnvironmentsFile(projectPath);
    if ('production' in incoming) {
      merged.production = normalizeEnvironmentEntry(incoming.production);
    }
    if ('development' in incoming) {
      merged.development = normalizeEnvironmentEntry(incoming.development);
    }
    await writeEnvironmentsFile(projectPath, merged);
    res.json({ projectPath, environments: merged });
  } catch (err) {
    console.error('PUT /lab/projects/:name/environments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/lab/droplets — cached doctl list
router.get('/droplets', async (req, res) => {
  const now = Date.now();
  const force = req.query.refresh === '1';
  if (!force && dropletsCache.data && now - dropletsCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ droplets: dropletsCache.data, cached: true, fetchedAt: dropletsCache.fetchedAt });
  }
  if (!process.env.DIGITALOCEAN_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'DIGITALOCEAN_ACCESS_TOKEN not set in container env' });
  }
  const result = await execProcess('doctl', ['compute', 'droplet', 'list', '-o', 'json'], { timeoutSeconds: 30 });
  if (result.code !== 0) {
    dropletsCache.error = result.stderr;
    return res.status(502).json({ error: 'doctl failed', details: result.stderr });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return res.status(502).json({ error: 'doctl returned non-JSON', details: result.stdout.slice(0, 500) });
  }
  // Slim to fields the picker needs.
  const droplets = parsed.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    region: d.region?.slug,
    size: d.size?.slug,
    ip: (d.networks?.v4 || []).find((n) => n.type === 'public')?.ip_address || null,
    tags: d.tags || [],
  }));
  dropletsCache.data = droplets;
  dropletsCache.fetchedAt = now;
  dropletsCache.error = null;
  res.json({ droplets, cached: false, fetchedAt: now });
});

// GET /api/lab/vms — cached `ssh kitvm3 'Get-VM | ConvertTo-Json'` output
router.get('/vms', async (req, res) => {
  const now = Date.now();
  const force = req.query.refresh === '1';
  if (!force && vmsCache.data && now - vmsCache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ vms: vmsCache.data, cached: true, fetchedAt: vmsCache.fetchedAt });
  }
  // PowerShell 5.1 — no -EnumsAsStrings; State comes back as integer. The
  // picker UI doesn't really care about state for picker purposes (just
  // names + display), but expose it for richer UI later.
  const psCmd = 'Get-VM | Select-Object Name, State, MemoryAssigned, ProcessorCount | ConvertTo-Json -Depth 3 -Compress';
  // First call may cold-start cloudflared (20-40s); retry once on banner timeout.
  const tryCmd = async () => execProcess('ssh', ['kitvm3', psCmd], { timeoutSeconds: 60 });
  let result = await tryCmd();
  if (result.code !== 0 && result.stderr.includes('banner exchange')) {
    result = await tryCmd();
  }
  if (result.code !== 0) {
    vmsCache.error = result.stderr;
    return res.status(502).json({ error: 'ssh kitvm3 failed', details: result.stderr });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return res.status(502).json({ error: 'kitvm3 returned non-JSON', details: result.stdout.slice(0, 500) });
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const vms = list.map((v) => ({
    name: v.Name,
    state: v.State,
    memory_bytes: v.MemoryAssigned,
    vcpus: v.ProcessorCount,
  }));
  vmsCache.data = vms;
  vmsCache.fetchedAt = now;
  vmsCache.error = null;
  res.json({ vms, cached: false, fetchedAt: now });
});

export default router;
