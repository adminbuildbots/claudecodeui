export type WizardStep = 1 | 2 | 3 | 4 | 5;

export type WorkspaceType = 'existing' | 'new' | 'from-prd';

export type ConsoleProject = {
  id: string;
  board_id: string;
  name: string;
  description: string;
  type: 'dev' | 'client' | 'infra' | string;
  status: 'active' | 'archived' | string;
  prd_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConsoleProjectListResponse = {
  projects?: ConsoleProject[];
  next_cursor?: string | null;
  error?: string;
};

export type ConsoleProjectSelection = {
  id: string;
  name: string;
  isNew: boolean;
};

export type TokenMode = 'stored' | 'new' | 'none';

export type GitRemoteMode = 'create' | 'pick' | 'external' | 'none';

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

export type CredentialsResponse = {
  credentials?: GithubTokenCredential[];
  error?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

export type CreateWorkspacePayload = {
  workspaceType: WorkspaceType;
  path: string;
};

export type CreateWorkspaceResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string;
  details?: string;
};

export type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

export type GiteaRepoSummary = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  private: boolean;
  description: string;
  default_branch: string;
  empty: boolean;
};

export type GiteaRepoSearchResponse = {
  repos?: GiteaRepoSummary[];
  defaultOrg?: string;
  baseUrl?: string;
  error?: string;
  details?: string;
};

export type GiteaRepoCreateResponse = {
  repo?: GiteaRepoSummary;
  created?: boolean;
  error?: string;
  details?: string;
  status?: number;
};

export type WizardFormState = {
  workspaceType: WorkspaceType;
  workspacePath: string;
  prdProjectName: string;

  // Universal git-remote step state.
  gitRemoteMode: GitRemoteMode;
  gitCreateName: string;
  gitCreateOrg: string;
  gitCreatePrivate: boolean;
  gitPickedRepo: GiteaRepoSummary | null;

  // External-URL clone path (the legacy "new + githubUrl" flow).
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;

  // Console board linkage (from-prd flow only — see StepConsoleProject).
  consoleProject: ConsoleProjectSelection | null;
};
