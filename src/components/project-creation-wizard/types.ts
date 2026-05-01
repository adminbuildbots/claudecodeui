export type WizardStep = 1 | 2 | 3 | 4;

export type WorkspaceType = 'existing' | 'new' | 'from-prd';

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
};
