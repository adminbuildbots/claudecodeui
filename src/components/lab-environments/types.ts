export type EnvironmentSlot = 'production' | 'development';

export type DropletEntry = {
  kind: 'do_droplet';
  id: number | null;
  name: string | null;
  region?: string | null;
  ip?: string | null;
};

export type Kitvm3Entry = {
  kind: 'kitvm3_vm';
  name: string;
  state?: number | null;
};

export type EnvironmentEntry = DropletEntry | Kitvm3Entry | null;

export type ProjectEnvironments = {
  production: EnvironmentEntry;
  development: EnvironmentEntry;
};

export type DropletSummary = {
  id: number;
  name: string;
  status: string;
  region: string | null;
  size: string | null;
  ip: string | null;
  tags: string[];
};

export type Kitvm3VmSummary = {
  name: string;
  state: number | null;
  memory_bytes: number | null;
  vcpus: number | null;
};

export type EnvironmentsApiResponse = {
  projectPath: string;
  environments: ProjectEnvironments;
};

export type DropletsApiResponse = {
  droplets: DropletSummary[];
  cached: boolean;
  fetchedAt: number;
};

export type VmsApiResponse = {
  vms: Kitvm3VmSummary[];
  cached: boolean;
  fetchedAt: number;
};
