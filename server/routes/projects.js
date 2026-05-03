import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import { addProjectManually } from '../projects.js';
import { DEFAULT_GITEA_ORG, GITEA_URL, getGiteaToken, giteaFetch } from './giteaClient.js';
import { PRD_CLAUDE_MD } from '../templates/prdClaudeMd.js';
import { PRD_SLASH_COMMANDS } from '../templates/prdSlashCommands.js';

const router = express.Router();

function sanitizeGitError(message, token) {
  if (!message || !token) return message;
  return message.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
}

// Configure allowed workspace root (defaults to user's home directory)
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

// System-critical paths that should never be used as workspace directories
export const FORBIDDEN_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin'
];

/**
 * Validates that a path is safe for workspace operations
 * @param {string} requestedPath - The path to validate
 * @returns {Promise<{valid: boolean, resolvedPath?: string, error?: string}>}
 */
export async function validateWorkspacePath(requestedPath) {
  try {
    // Resolve to absolute path
    let absolutePath = path.resolve(requestedPath);

    // Check if path is a forbidden system directory
    const normalizedPath = path.normalize(absolutePath);
    if (FORBIDDEN_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations'
      };
    }

    // Additional check for paths starting with forbidden directories
    for (const forbidden of FORBIDDEN_PATHS) {
      if (normalizedPath === forbidden ||
          normalizedPath.startsWith(forbidden + path.sep)) {
        // Exception: /var/tmp and similar user-accessible paths might be allowed
        // but /var itself and most /var subdirectories should be blocked
        if (forbidden === '/var' &&
            (normalizedPath.startsWith('/var/tmp') ||
             normalizedPath.startsWith('/var/folders'))) {
          continue; // Allow these specific cases
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbidden}`
        };
      }
    }

    // Try to resolve the real path (following symlinks)
    let realPath;
    try {
      // Check if path exists to resolve real path
      await fs.access(absolutePath);
      realPath = await fs.realpath(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist yet - check parent directory
        let parentPath = path.dirname(absolutePath);
        try {
          const parentRealPath = await fs.realpath(parentPath);

          // Reconstruct the full path with real parent
          realPath = path.join(parentRealPath, path.basename(absolutePath));
        } catch (parentError) {
          if (parentError.code === 'ENOENT') {
            // Parent doesn't exist either - use the absolute path as-is
            // We'll validate it's within allowed root
            realPath = absolutePath;
          } else {
            throw parentError;
          }
        }
      } else {
        throw error;
      }
    }

    // Resolve the workspace root to its real path
    const resolvedWorkspaceRoot = await fs.realpath(WORKSPACES_ROOT);

    // Ensure the resolved path is contained within the allowed workspace root
    if (!realPath.startsWith(resolvedWorkspaceRoot + path.sep) &&
        realPath !== resolvedWorkspaceRoot) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`
      };
    }

    // Additional symlink check for existing paths
    try {
      await fs.access(absolutePath);
      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        // Verify symlink target is also within allowed root
        const linkTarget = await fs.readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), linkTarget);
        const realTarget = await fs.realpath(resolvedTarget);

        if (!realTarget.startsWith(resolvedWorkspaceRoot + path.sep) &&
            realTarget !== resolvedWorkspaceRoot) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root'
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Path doesn't exist - that's fine for new workspace creation
    }

    return {
      valid: true,
      resolvedPath: realPath
    };

  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${error.message}`
    };
  }
}

/**
 * Create a new workspace
 * POST /api/projects/create-workspace
 *
 * Body:
 * - workspaceType: 'existing' | 'new'
 * - path: string (workspace path)
 * - githubUrl?: string (optional, for new workspaces)
 * - githubTokenId?: number (optional, ID of stored token)
 * - newGithubToken?: string (optional, one-time token)
 */
router.post('/create-workspace', async (req, res) => {
  try {
    const { workspaceType, path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body;

    // Validate required fields
    if (!workspaceType || !workspacePath) {
      return res.status(400).json({ error: 'workspaceType and path are required' });
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      return res.status(400).json({ error: 'workspaceType must be "existing" or "new"' });
    }

    // Validate path safety before any operations
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid workspace path',
        details: validation.error
      });
    }

    const absolutePath = validation.resolvedPath;

    // Handle existing workspace
    if (workspaceType === 'existing') {
      // Check if the path exists
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path exists but is not a directory' });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Workspace path does not exist' });
        }
        throw error;
      }

      // Add the existing workspace to the project list
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'Existing workspace added successfully'
      });
    }

    // Handle new workspace creation
    if (workspaceType === 'new') {
      // Create the directory if it doesn't exist
      await fs.mkdir(absolutePath, { recursive: true });

      // If GitHub URL is provided, clone the repository
      if (githubUrl) {
        let githubToken = null;

        // Get GitHub token if needed
        if (githubTokenId) {
          // Fetch token from database
          const token = await getGithubTokenById(githubTokenId, req.user.id);
          if (!token) {
            // Clean up created directory
            await fs.rm(absolutePath, { recursive: true, force: true });
            return res.status(404).json({ error: 'GitHub token not found' });
          }
          githubToken = token.github_token;
        } else if (newGithubToken) {
          githubToken = newGithubToken;
        }

        // Extract repo name from URL for the clone destination
        const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
        const repoName = normalizedUrl.split('/').pop() || 'repository';
        const clonePath = path.join(absolutePath, repoName);

        // Check if clone destination already exists to prevent data loss
        try {
          await fs.access(clonePath);
          return res.status(409).json({
            error: 'Directory already exists',
            details: `The destination path "${clonePath}" already exists. Please choose a different location or remove the existing directory.`
          });
        } catch (err) {
          // Directory doesn't exist, which is what we want
        }

        // Clone the repository into a subfolder
        try {
          await cloneGitHubRepository(githubUrl, clonePath, githubToken);
        } catch (error) {
          // Only clean up if clone created partial data (check if dir exists and is empty or partial)
          try {
            const stats = await fs.stat(clonePath);
            if (stats.isDirectory()) {
              await fs.rm(clonePath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Directory doesn't exist or cleanup failed - ignore
          }
          throw new Error(`Failed to clone repository: ${error.message}`);
        }

        // Add the cloned repo path to the project list
        const project = await addProjectManually(clonePath);

        return res.json({
          success: true,
          project,
          message: 'New workspace created and repository cloned successfully'
        });
      }

      // Add the new workspace to the project list (no clone)
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'New workspace created successfully'
      });
    }

  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({
      error: error.message || 'Failed to create workspace',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Helper function to get GitHub token from database
 */
async function getGithubTokenById(tokenId, userId) {
  const { db } = await import('../database/db.js');

  const credential = db.prepare(
    'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1'
  ).get(tokenId, userId, 'github_token');

  // Return in the expected format (github_token field for compatibility)
  if (credential) {
    return {
      ...credential,
      github_token: credential.credential_value
    };
  }

  return null;
}

/**
 * Clone repository with progress streaming (SSE)
 * GET /api/projects/clone-progress
 */
router.get('/clone-progress', async (req, res) => {
  const { path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (!workspacePath || !githubUrl) {
      sendEvent('error', { message: 'workspacePath and githubUrl are required' });
      res.end();
      return;
    }

    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      sendEvent('error', { message: validation.error });
      res.end();
      return;
    }

    const absolutePath = validation.resolvedPath;

    await fs.mkdir(absolutePath, { recursive: true });

    let githubToken = null;
    if (githubTokenId) {
      const token = await getGithubTokenById(parseInt(githubTokenId), req.user.id);
      if (!token) {
        await fs.rm(absolutePath, { recursive: true, force: true });
        sendEvent('error', { message: 'GitHub token not found' });
        res.end();
        return;
      }
      githubToken = token.github_token;
    } else if (newGithubToken) {
      githubToken = newGithubToken;
    }

    const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
    const repoName = normalizedUrl.split('/').pop() || 'repository';
    const clonePath = path.join(absolutePath, repoName);

    // Check if clone destination already exists to prevent data loss
    try {
      await fs.access(clonePath);
      sendEvent('error', { message: `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.` });
      res.end();
      return;
    } catch (err) {
      // Directory doesn't exist, which is what we want
    }

    let cloneUrl = githubUrl;
    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL or invalid - use as-is
      }
    }

    sendEvent('progress', { message: `Cloning into '${repoName}'...` });

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let lastError = '';

    gitProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      lastError = message;
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const project = await addProjectManually(clonePath);
          sendEvent('complete', { project, message: 'Repository cloned successfully' });
        } catch (error) {
          sendEvent('error', { message: `Clone succeeded but failed to add project: ${error.message}` });
        }
      } else {
        const sanitizedError = sanitizeGitError(lastError, githubToken);
        let errorMessage = 'Git clone failed';
        if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your credentials.';
        } else if (lastError.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (lastError.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (sanitizedError) {
          errorMessage = sanitizedError;
        }
        try {
          await fs.rm(clonePath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error('Failed to clean up after clone failure:', sanitizeGitError(cleanupError.message, githubToken));
        }
        sendEvent('error', { message: errorMessage });
      }
      res.end();
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        sendEvent('error', { message: 'Git is not installed or not in PATH' });
      } else {
        sendEvent('error', { message: error.message });
      }
      res.end();
    });

    req.on('close', () => {
      gitProcess.kill();
    });

  } catch (error) {
    sendEvent('error', { message: error.message });
    res.end();
  }
});

/**
 * Helper function to clone a GitHub repository
 */
function cloneGitHubRepository(githubUrl, destinationPath, githubToken = null) {
  return new Promise((resolve, reject) => {
    let cloneUrl = githubUrl;

    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL - use as-is
      }
    }

    const gitProcess = spawn('git', ['clone', '--progress', cloneUrl, destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        let errorMessage = 'Git clone failed';

        if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your GitHub token.';
        } else if (stderr.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (stderr.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (stderr) {
          errorMessage = stderr;
        }

        reject(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Git is not installed or not in PATH'));
      } else {
        reject(error);
      }
    });
  });
}

/**
 * Streaming endpoint for the Pivot 3 wizard's universal "create-with-git" flow.
 *
 * Handles three workspace types crossed with three remote modes (create / pick / none).
 * The "external" remote mode keeps using the existing /clone-progress endpoint, so we
 * don't replicate its logic here.
 *
 * GET /api/projects/create-with-git
 * Query: workspaceType, workspacePath?, prdProjectName?, gitRemoteMode,
 *        gitCreateName?, gitCreateOrg?, gitCreatePrivate?, gitPickedRepoFullName?, token
 */
router.get('/create-with-git', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data = {}) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const fail = (message) => {
    sendEvent('error', { message });
    res.end();
  };

  try {
    const {
      workspaceType,
      workspacePath: rawPath,
      prdProjectName,
      gitRemoteMode,
      gitCreateName,
      gitCreateOrg,
      gitCreatePrivate,
      gitPickedRepoFullName,
    } = req.query;

    if (!['existing', 'new', 'from-prd'].includes(workspaceType)) {
      return fail('workspaceType must be existing, new, or from-prd');
    }
    if (!['create', 'pick', 'none'].includes(gitRemoteMode)) {
      return fail('gitRemoteMode must be create, pick, or none');
    }

    // Resolve target workspace path.
    let targetPath;
    if (workspaceType === 'from-prd') {
      const slug = slugifyProjectName(prdProjectName || '');
      if (!slug) return fail('Project name is required for from-prd');
      const root = process.env.WORKSPACES_ROOT || path.join(os.homedir(), 'workspace');
      targetPath = path.join(root, slug);
    } else {
      if (!rawPath || !rawPath.trim()) return fail('workspacePath is required');
      targetPath = rawPath.trim();
    }

    const validation = await validateWorkspacePath(targetPath);
    if (!validation.valid) return fail(validation.error);
    const absolutePath = validation.resolvedPath;

    // Pre-resolve the Gitea remote (create or pick) before touching disk so we can
    // surface remote-side errors without leaving partial workspace state behind.
    let remote = null;
    const giteaToken = getGiteaToken();

    if (gitRemoteMode === 'create') {
      const safeName = (gitCreateName || '').trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(safeName)) {
        return fail('Repo name must contain only letters, digits, _, ., or -');
      }
      const owner = (gitCreateOrg || DEFAULT_GITEA_ORG).trim() || DEFAULT_GITEA_ORG;
      sendEvent('progress', { message: `Creating ${owner}/${safeName} on Gitea…` });

      const created = await giteaCreateOrReuseRepo({
        owner,
        name: safeName,
        isPrivate: gitCreatePrivate === 'true' || gitCreatePrivate === true,
      });
      if (!created.ok) return fail(created.error);
      remote = created.repo;
    } else if (gitRemoteMode === 'pick') {
      const fullName = (gitPickedRepoFullName || '').trim();
      if (!fullName.includes('/')) return fail('gitPickedRepoFullName must be "owner/name"');
      const lookup = await giteaFetch(`/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`);
      if (!lookup.ok) return fail(`Picked repo not found: ${fullName}`);
      remote = await lookup.json();
    }

    // Build the authenticated clone/push URL once. Gitea over HTTPS uses the embedded
    // token via the `token` username convention used by the existing kitadmin helper.
    const remoteUrlWithAuth = remote && giteaToken
      ? authenticateGiteaUrl(remote.clone_url, giteaToken)
      : null;

    // Create / verify the workspace dir.
    if (workspaceType === 'existing') {
      try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isDirectory()) return fail('Path exists but is not a directory');
      } catch (error) {
        if (error.code === 'ENOENT') return fail('Workspace path does not exist');
        throw error;
      }
    } else {
      // new + from-prd: ensure parent exists, create dir if missing.
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          const entries = await fs.readdir(absolutePath);
          if (entries.length > 0 && gitRemoteMode === 'pick') {
            return fail(`Target directory ${absolutePath} is not empty; pick requires an empty target`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(absolutePath, { recursive: true });
      }
    }

    const isFromPrd = workspaceType === 'from-prd';

    // Run the git plumbing for the chosen mode.
    if (gitRemoteMode === 'pick' && (workspaceType === 'new' || workspaceType === 'from-prd')) {
      sendEvent('progress', { message: `Cloning ${remote.full_name}…` });
      // Clone INTO the workspace dir (it must be empty).
      const cloneResult = await runGit(['clone', '--progress', remoteUrlWithAuth, absolutePath], {
        sendEvent,
        token: giteaToken,
      });
      if (!cloneResult.ok) return fail(cloneResult.error);

      // Add PRD scaffolding on top of the cloned content as a separate commit.
      if (isFromPrd) {
        sendEvent('progress', { message: 'Scaffolding PRD project…' });
        await scaffoldFromPrdProject(absolutePath);
        const scaffoldCommit = await commitScaffoldingChanges(absolutePath, sendEvent);
        if (!scaffoldCommit.ok) return fail(scaffoldCommit.error);
        sendEvent('progress', { message: 'Pushing PRD scaffolding…' });
        const push = await runGit(['push', '-u', 'origin', 'HEAD'], {
          cwd: absolutePath,
          sendEvent,
          token: giteaToken,
        });
        if (!push.ok) return fail(push.error);
      }
    } else if (gitRemoteMode === 'create' || gitRemoteMode === 'pick' || gitRemoteMode === 'none') {
      // existing-* and new/from-prd-create/none all need a local repo first.
      const gitDir = path.join(absolutePath, '.git');
      const hasGitDir = await fs
        .access(gitDir)
        .then(() => true)
        .catch(() => false);

      if (!hasGitDir) {
        sendEvent('progress', { message: 'Initializing git repo…' });
        const initResult = await runGit(['init', '-b', 'main'], { cwd: absolutePath, sendEvent });
        if (!initResult.ok) return fail(initResult.error);
      }

      // PRD scaffolding for from-prd lands BEFORE remote add so the initial
      // commit (create mode) naturally picks it up.
      if (isFromPrd) {
        sendEvent('progress', { message: 'Scaffolding PRD project…' });
        await scaffoldFromPrdProject(absolutePath);
      }

      if (remote) {
        // Replace any existing 'origin' so re-runs don't fail.
        await runGit(['remote', 'remove', 'origin'], { cwd: absolutePath, ignoreError: true });
        const addRemote = await runGit(['remote', 'add', 'origin', remoteUrlWithAuth], {
          cwd: absolutePath,
          sendEvent,
          token: giteaToken,
        });
        if (!addRemote.ok) return fail(addRemote.error);

        // Seed initial commit only for create-mode + workspace was empty.
        if (gitRemoteMode === 'create' && (workspaceType === 'new' || workspaceType === 'from-prd')) {
          const readmePath = path.join(absolutePath, 'README.md');
          await fs.writeFile(readmePath, `# ${remote.name}\n\n${remote.description || ''}\n`, 'utf-8');

          await runGit(['add', '.'], { cwd: absolutePath, sendEvent });
          // Use a deterministic identity so commits work even if global git config is missing.
          const commitEnv = {
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'cloudcli',
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'cloudcli@local',
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'cloudcli',
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'cloudcli@local',
          };
          const commit = await runGit(['commit', '-m', 'Initial commit'], {
            cwd: absolutePath,
            sendEvent,
            extraEnv: commitEnv,
          });
          if (!commit.ok) return fail(commit.error);

          sendEvent('progress', { message: 'Pushing to origin…' });
          const push = await runGit(['push', '-u', 'origin', 'main'], {
            cwd: absolutePath,
            sendEvent,
            token: giteaToken,
          });
          if (!push.ok) return fail(push.error);
        }
      }
    }

    const project = await addProjectManually(absolutePath);
    sendEvent('complete', {
      project,
      workspaceType,
      remote: remote
        ? {
            full_name: remote.full_name,
            html_url: remote.html_url || `${GITEA_URL}/${remote.full_name}`,
          }
        : null,
      message: 'Project created',
    });
    res.end();
  } catch (error) {
    console.error('create-with-git error:', error);
    return fail(error.message || 'Failed to create project');
  }
});

// PRD-project scaffolding: drop a CLAUDE.md (PRD-authoring system prompt), a
// minimal .taskmaster/ skeleton (so the Tasks tab detects the project), and a
// .claude/commands/ directory of project-scoped slash commands (/save-prd,
// /generate-tasks, /submit-to-forge, /push-to-console) the user can invoke
// from chat.
async function scaffoldFromPrdProject(workspacePath) {
  // CLAUDE.md — only write if the workspace doesn't already have one.
  const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
  const claudeMdExists = await fs.access(claudeMdPath).then(() => true).catch(() => false);
  if (!claudeMdExists) {
    await fs.writeFile(claudeMdPath, PRD_CLAUDE_MD, 'utf-8');
  }

  // .taskmaster/ skeleton.
  const taskmasterDir = path.join(workspacePath, '.taskmaster');
  await fs.mkdir(path.join(taskmasterDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(taskmasterDir, 'tasks'), { recursive: true });

  const tasksJsonPath = path.join(taskmasterDir, 'tasks', 'tasks.json');
  const tasksJsonExists = await fs.access(tasksJsonPath).then(() => true).catch(() => false);
  if (!tasksJsonExists) {
    await fs.writeFile(
      tasksJsonPath,
      JSON.stringify({ master: { tasks: [] } }, null, 2) + '\n',
      'utf-8',
    );
  }

  // .claude/commands/ — project-scoped slash commands. Each .md file is sent to
  // Claude as the prompt when the matching /command is invoked. Idempotent —
  // existing files are left alone so user customizations survive re-runs.
  const commandsDir = path.join(workspacePath, '.claude', 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  for (const [filename, content] of Object.entries(PRD_SLASH_COMMANDS)) {
    const cmdPath = path.join(commandsDir, filename);
    const cmdExists = await fs.access(cmdPath).then(() => true).catch(() => false);
    if (!cmdExists) {
      await fs.writeFile(cmdPath, content, 'utf-8');
    }
  }
}

// Stage + commit any scaffolding diffs (called after a clone for the pick path).
async function commitScaffoldingChanges(workspacePath, sendEvent) {
  const add = await runGit(['add', 'CLAUDE.md', '.taskmaster', '.claude'], { cwd: workspacePath, sendEvent });
  if (!add.ok) return add;

  // Bail cleanly if there's nothing to commit (e.g. cloned repo already had it).
  const diff = await runGit(['diff', '--cached', '--quiet'], { cwd: workspacePath, ignoreError: true });
  if (diff.ok) return { ok: true };

  const commitEnv = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'cloudcli',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'cloudcli@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'cloudcli',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'cloudcli@local',
  };
  return runGit(['commit', '-m', 'Add PRD authoring scaffolding'], {
    cwd: workspacePath,
    sendEvent,
    extraEnv: commitEnv,
  });
}

function slugifyProjectName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function giteaCreateOrReuseRepo({ owner, name, isPrivate }) {
  try {
    const create = await giteaFetch(`/orgs/${encodeURIComponent(owner)}/repos`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: '',
        private: isPrivate,
        auto_init: false,
        default_branch: 'main',
      }),
    });

    if (create.ok) return { ok: true, repo: await create.json() };

    if (create.status === 409) {
      const lookup = await giteaFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      if (lookup.ok) return { ok: true, repo: await lookup.json() };
    }

    if (create.status === 404) {
      // Org doesn't exist; fall back to the authenticated user's namespace.
      const userCreate = await giteaFetch('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: '',
          private: isPrivate,
          auto_init: false,
          default_branch: 'main',
        }),
      });
      if (userCreate.ok) return { ok: true, repo: await userCreate.json() };
    }

    const text = await create.text();
    return { ok: false, error: `Gitea create-repo failed (${create.status}): ${text}` };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function authenticateGiteaUrl(cloneUrl, token) {
  try {
    const url = new URL(cloneUrl);
    url.username = encodeURIComponent('kitadmin');
    url.password = token;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

function runGit(args, { cwd, sendEvent, token, ignoreError = false, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    let stderr = '';

    const sanitize = (text) => (token ? sanitizeGitError(text, token) : text);

    proc.stdout.on('data', (data) => {
      const message = sanitize(data.toString().trim());
      if (message && sendEvent) sendEvent('progress', { message });
    });

    proc.stderr.on('data', (data) => {
      const raw = data.toString();
      stderr += raw;
      const message = sanitize(raw.trim());
      if (message && sendEvent) sendEvent('progress', { message });
    });

    proc.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      if (ignoreError) return resolve({ ok: true });
      const sanitized = sanitize(stderr).trim() || `git ${args[0]} exited with code ${code}`;
      resolve({ ok: false, error: sanitized });
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') return resolve({ ok: false, error: 'git is not installed or not in PATH' });
      resolve({ ok: false, error: err.message });
    });
  });
}

export default router;
