import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Cloud, Loader2, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { Button, Input } from '../../shared/view/ui';
import { fetchDroplets, fetchVms, saveProjectEnvironments } from './data/labApi';
import type {
  DropletSummary,
  EnvironmentEntry,
  EnvironmentSlot,
  Kitvm3VmSummary,
  ProjectEnvironments,
} from './types';

type EnvironmentPickerModalProps = {
  projectName: string;
  slot: EnvironmentSlot;
  currentEntry: EnvironmentEntry;
  onClose: () => void;
  onSaved: (updated: ProjectEnvironments) => void;
};

const SLOT_TITLES: Record<EnvironmentSlot, { title: string; subtitle: string }> = {
  production: {
    title: 'Production environment',
    subtitle: 'Pick a DigitalOcean droplet to associate with this project as production.',
  },
  development: {
    title: 'Development environment',
    subtitle: 'Pick a Hyper-V VM on KITVM3 to associate with this project as dev.',
  },
};

export default function EnvironmentPickerModal({
  projectName,
  slot,
  currentEntry,
  onClose,
  onSaved,
}: EnvironmentPickerModalProps) {
  const isProduction = slot === 'production';
  const [search, setSearch] = useState('');
  const [droplets, setDroplets] = useState<DropletSummary[] | null>(null);
  const [vms, setVms] = useState<Kitvm3VmSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      if (isProduction) {
        const res = await fetchDroplets(forceRefresh);
        setDroplets(res.droplets);
      } else {
        const res = await fetchVms(forceRefresh);
        setVms(res.vms);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isProduction]);

  useEffect(() => {
    void loadList(false);
  }, [loadList]);

  const filteredDroplets = useMemo(() => {
    if (!droplets) return [];
    const q = search.trim().toLowerCase();
    if (!q) return droplets;
    return droplets.filter((d) => {
      const haystack = [d.name, d.region, d.size, d.ip, ...(d.tags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [droplets, search]);

  const filteredVms = useMemo(() => {
    if (!vms) return [];
    const q = search.trim().toLowerCase();
    if (!q) return vms;
    return vms.filter((v) => v.name.toLowerCase().includes(q));
  }, [vms, search]);

  const handleSelect = async (entry: EnvironmentEntry) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveProjectEnvironments(projectName, { [slot]: entry });
      onSaved(result.environments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
      setSaving(false);
    }
  };

  const isCurrent = (entry: EnvironmentEntry): boolean => {
    if (!currentEntry || !entry) return false;
    if (currentEntry.kind === 'do_droplet' && entry.kind === 'do_droplet') {
      return currentEntry.id === entry.id;
    }
    if (currentEntry.kind === 'kitvm3_vm' && entry.kind === 'kitvm3_vm') {
      return currentEntry.name === entry.name;
    }
    return false;
  };

  const meta = SLOT_TITLES[slot];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${isProduction ? 'bg-[#0541AD]' : 'bg-[#2660C9]'}`}>
              {isProduction ? <Cloud className="h-4 w-4 text-white" /> : <Server className="h-4 w-4 text-white" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{meta.title}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">{meta.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-gray-200 p-3 dark:border-gray-700">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isProduction ? 'Search droplets by name, region, IP, tag…' : 'Search VMs by name…'}
            className="flex-1"
            autoFocus
            disabled={loading}
          />
          <Button
            variant="outline"
            onClick={() => loadList(true)}
            disabled={refreshing || loading}
            title="Force re-fetch (skip 5-min cache)"
            className="px-2"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {isProduction ? 'Loading droplets…' : 'Loading VMs (first call may take 30-40s on cold tunnel)…'}
            </div>
          )}

          {!loading && error && (
            <div className="m-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && isProduction && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredDroplets.length === 0 && (
                <li className="p-4 text-center text-sm text-gray-500">No droplets match.</li>
              )}
              {filteredDroplets.map((d) => {
                const entry = {
                  kind: 'do_droplet' as const,
                  id: d.id,
                  name: d.name,
                  region: d.region,
                  ip: d.ip,
                };
                const selected = isCurrent(entry);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(entry)}
                      disabled={saving}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                        {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Cloud className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="flex-1 truncate">
                        <div className="font-medium text-gray-900 dark:text-white">{d.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {d.region || '?'} · {d.size || '?'} · {d.ip || 'no public IP'} · {d.status}
                          {d.tags?.length ? ` · ${d.tags.join(', ')}` : ''}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && !error && !isProduction && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredVms.length === 0 && (
                <li className="p-4 text-center text-sm text-gray-500">No VMs match.</li>
              )}
              {filteredVms.map((v) => {
                const entry = { kind: 'kitvm3_vm' as const, name: v.name, state: v.state };
                const selected = isCurrent(entry);
                const memGb = v.memory_bytes ? Math.round((v.memory_bytes / 1e9) * 10) / 10 : null;
                return (
                  <li key={v.name}>
                    <button
                      type="button"
                      onClick={() => handleSelect(entry)}
                      disabled={saving}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/40 ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : ''} ${saving ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                        {selected ? <Check className="h-4 w-4 text-blue-500" /> : <Server className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="flex-1 truncate">
                        <div className="font-medium text-gray-900 dark:text-white">{v.name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          state={v.state ?? '?'} · vCPU={v.vcpus ?? '?'} · {memGb != null ? `${memGb}GB` : '?'}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 p-3 dark:border-gray-700">
          <Button
            variant="outline"
            onClick={() => handleSelect(null)}
            disabled={saving || !currentEntry}
            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            title="Clear the assignment for this slot"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
