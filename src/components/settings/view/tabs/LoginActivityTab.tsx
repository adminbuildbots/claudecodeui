import { useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';

type LoginEvent = {
  id: number;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  username: string | null;
};

// Compress a UA string into something readable in a table cell. We don't need
// fingerprint-grade detail here — "Chrome on macOS" is enough to tell two
// team members apart at a glance.
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return '—';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    'Browser';
  const os =
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Linux/.test(ua) ? 'Linux' :
    'Unknown';
  return `${browser} on ${os}`;
}

function formatTimestamp(iso: string): string {
  // Stored as UTC SQLite CURRENT_TIMESTAMP — append Z so JS parses correctly.
  const d = new Date(iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function LoginActivityTab() {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.auth.loginEvents(50);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load login events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Activity className="h-5 w-5" />
            Team activity
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recent logins to this lab instance. The lab is a single shared account, so the IP and browser are
            what differentiate team members.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Event</th>
              <th className="px-3 py-2 text-left font-medium">IP</th>
              <th className="px-3 py-2 text-left font-medium">Browser</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && events.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && events.length === 0 && !error && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No login events yet.</td></tr>
            )}
            {events.map((ev) => (
              <tr key={ev.id} className="hover:bg-accent/30">
                <td className="px-3 py-2 whitespace-nowrap text-foreground">{formatTimestamp(ev.created_at)}</td>
                <td className="px-3 py-2 capitalize text-muted-foreground">{ev.event_type}</td>
                <td className="px-3 py-2 font-mono text-xs text-foreground">{ev.ip_address || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{summarizeUserAgent(ev.user_agent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
