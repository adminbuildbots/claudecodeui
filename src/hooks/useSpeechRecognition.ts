import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionHook = {
  isSupported: boolean;
  isListening: boolean;
  start: () => void;
  stop: () => void;
};

// Browser-prefixed types — not in lib.dom.d.ts for all builds.
type SpeechRecognitionInstance = InstanceType<typeof window.SpeechRecognition> & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
  interface SpeechRecognitionEvent {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }
}

function getSpeechRecognitionClass() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useSpeechRecognition(
  onFinalTranscript: (text: string) => void,
): SpeechRecognitionHook {
  const SRClass = getSpeechRecognitionClass();
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isListening, setIsListening] = useState(false);
  const callbackRef = useRef(onFinalTranscript);
  callbackRef.current = onFinalTranscript;

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const start = useCallback(() => {
    if (!SRClass || isListening) return;

    const recognition = new SRClass();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        callbackRef.current(transcript);
      }
    };

    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are normal — user paused or we called stop().
      const err = (event as Event & { error?: string }).error;
      if (err !== 'no-speech' && err !== 'aborted') {
        console.warn('SpeechRecognition error:', err);
      }
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [SRClass, isListening]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  return {
    isSupported: SRClass !== null,
    isListening,
    start,
    stop,
  };
}
