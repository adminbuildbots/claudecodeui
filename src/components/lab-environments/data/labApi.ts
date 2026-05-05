import { api } from '../../../utils/api';
import type {
  DropletsApiResponse,
  EnvironmentEntry,
  EnvironmentsApiResponse,
  VmsApiResponse,
} from '../types';

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

export async function fetchProjectEnvironments(projectName: string): Promise<EnvironmentsApiResponse> {
  const response = await api.get(`/lab/projects/${encodeURIComponent(projectName)}/environments`);
  const data = await parseJson<EnvironmentsApiResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to load environments');
  return data;
}

export async function saveProjectEnvironments(
  projectName: string,
  patch: { production?: EnvironmentEntry; development?: EnvironmentEntry },
): Promise<EnvironmentsApiResponse> {
  const response = await api.put(
    `/lab/projects/${encodeURIComponent(projectName)}/environments`,
    patch,
  );
  const data = await parseJson<EnvironmentsApiResponse & { error?: string }>(response);
  if (!response.ok) throw new Error(data.error || 'Failed to save environments');
  return data;
}

export async function fetchDroplets(forceRefresh = false): Promise<DropletsApiResponse> {
  const url = forceRefresh ? '/lab/droplets?refresh=1' : '/lab/droplets';
  const response = await api.get(url);
  const data = await parseJson<DropletsApiResponse & { error?: string; details?: string }>(response);
  if (!response.ok) throw new Error(data.error || data.details || 'Failed to list droplets');
  return data;
}

export async function fetchVms(forceRefresh = false): Promise<VmsApiResponse> {
  const url = forceRefresh ? '/lab/vms?refresh=1' : '/lab/vms';
  const response = await api.get(url);
  const data = await parseJson<VmsApiResponse & { error?: string; details?: string }>(response);
  if (!response.ok) throw new Error(data.error || data.details || 'Failed to list VMs');
  return data;
}
