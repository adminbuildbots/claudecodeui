import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Parse the Gitea personal access token from the git credentials file.
// Format: https://kitadmin:<token>@git.keylinkit.net
function getGiteaToken() {
  const credPaths = [
    path.join(os.homedir(), '.config', 'git', 'credentials'),
    path.join(os.homedir(), '.git-credentials'),
  ];
  for (const p of credPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      const match = content.match(/https?:\/\/[^:]+:([^@]+)@git\.keylinkit\.net/);
      if (match) return match[1];
    } catch {
      // try next path
    }
  }
  return null;
}

const GITEA_URL = 'https://git.keylinkit.net';
const GITEA_ORG = 'keylink-studio';
const PRD_REPO = 'forge-prds';

async function giteaFetch(endpoint, options = {}) {
  const token = getGiteaToken();
  if (!token) throw new Error('Gitea token not found in git credentials');

  const res = await fetch(`${GITEA_URL}/api/v1${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${token}`,
      ...options.headers,
    },
  });
  return res;
}

// Ensure the forge-prds repo exists under the org. Idempotent.
async function ensureRepo() {
  const check = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}`);
  if (check.ok) return;

  // Try to create it
  const create = await giteaFetch(`/orgs/${GITEA_ORG}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: PRD_REPO,
      description: 'PRDs submitted from the lab for the Forge pipeline',
      private: false,
      auto_init: true,
      default_branch: 'main',
    }),
  });

  if (!create.ok && create.status !== 409) {
    const err = await create.text();
    throw new Error(`Failed to create repo ${GITEA_ORG}/${PRD_REPO}: ${create.status} ${err}`);
  }
}

// Push or update a file in the repo via the Gitea Contents API.
async function pushFile(filePath, content, message) {
  // Check if file already exists (need its SHA to update)
  const existing = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}/contents/${encodeURIComponent(filePath)}?ref=main`);
  const body = {
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: 'main',
  };

  if (existing.ok) {
    const data = await existing.json();
    body.sha = data.sha;
  }

  const res = await giteaFetch(`/repos/${GITEA_ORG}/${PRD_REPO}/contents/${encodeURIComponent(filePath)}`, {
    method: existing.ok ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to push ${filePath}: ${res.status} ${err}`);
  }

  return res.json();
}

// POST /api/forge/submit
// Body: { fileName: string, content: string }
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { fileName, content } = req.body;

    if (!fileName || !content) {
      return res.status(400).json({ error: 'fileName and content are required' });
    }

    // Sanitize filename
    const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\.+/g, '.');
    const filePath = `prds/${safeName}.md`;
    const commitMessage = `Submit PRD: ${safeName}`;

    await ensureRepo();
    const result = await pushFile(filePath, content, commitMessage);

    const repoUrl = `${GITEA_URL}/${GITEA_ORG}/${PRD_REPO}`;
    const fileUrl = `${repoUrl}/src/branch/main/${filePath}`;

    res.json({
      success: true,
      repoUrl,
      fileUrl,
      filePath,
      message: `PRD submitted to ${GITEA_ORG}/${PRD_REPO}`,
    });
  } catch (error) {
    console.error('Forge submit error:', error);
    res.status(500).json({
      error: 'Failed to submit PRD to Forge',
      message: error.message,
    });
  }
});

export default router;
