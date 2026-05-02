import { useState, useEffect } from 'react';
import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';

export type InstallMode = 'git' | 'npm';

// Fork-side override: the upstream version-check hits GitHub releases for
// siteboon/claudecodeui and prompts the user to upgrade. We're a long-lived
// fork with our own version cadence, so the prompt is noise. Short-circuit
// to "no update available" and skip the network round-trip entirely.
export const useVersionCheck = (_owner: string, _repo: string) => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');

  useEffect(() => {
    const fetchInstallMode = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
      } catch {
        // Default to git on error
      }
    };
    fetchInstallMode();
  }, []);

  return {
    updateAvailable: false,
    latestVersion: null as string | null,
    currentVersion: version,
    releaseInfo: null as ReleaseInfo | null,
    installMode,
  };
};
