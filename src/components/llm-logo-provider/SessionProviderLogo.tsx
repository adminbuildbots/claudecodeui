import type { SessionProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GeminiLogo from './GeminiLogo';
import DeepSeekLogo from './DeepSeekLogo';
import OrchestrationLogo from './OrchestrationLogo';

type SessionProviderLogoProps = {
  provider?: SessionProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'gemini') {
    return <GeminiLogo className={className} />;
  }

  if (provider === 'deepseek') {
    return <DeepSeekLogo className={className} />;
  }

  if (provider === 'orchestration') {
    return <OrchestrationLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
