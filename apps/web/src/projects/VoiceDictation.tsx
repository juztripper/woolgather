import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { IconButton } from "../ui/Button";
import { useToast } from "../ui/Toast";

type SpeechAlternativeLike = { transcript: string };

type SpeechResultLike = {
  isFinal: boolean;
  0?: SpeechAlternativeLike;
};

type SpeechResultListLike = {
  length: number;
  [index: number]: SpeechResultLike | undefined;
};

type SpeechEventLike = {
  resultIndex: number;
  results: SpeechResultListLike;
};

type SpeechErrorEventLike = { error?: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onresult: ((event: SpeechEventLike) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

const MAX_DICTATION_CHARACTERS = 12_000;

export type BrowserDictationStatus =
  "idle" | "listening" | "unsupported" | "error";

export type UseBrowserDictationOptions = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  language?: string;
  onActiveChange?: (active: boolean) => void;
  onInterimChange?: (text: string) => void;
};

export type UseBrowserDictationResult = {
  supported: boolean;
  status: BrowserDictationStatus;
  error?: string;
  interimTranscript: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
};

function recognitionConstructor() {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
}

export function isBrowserDictationSupported() {
  return !!recognitionConstructor();
}

function clearRecognitionHandlers(recognition: SpeechRecognitionLike | null) {
  if (!recognition) return;
  recognition.onstart = null;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
}

function appendTranscript(current: string, transcript: string) {
  const clean = transcript.replace(/\s+/g, " ").trim();
  const boundedCurrent = current.slice(0, MAX_DICTATION_CHARACTERS);
  if (!clean || boundedCurrent.length >= MAX_DICTATION_CHARACTERS) {
    return boundedCurrent;
  }
  if (!boundedCurrent) return clean.slice(0, MAX_DICTATION_CHARACTERS);
  const separator = /[\s\n]$/.test(boundedCurrent) ? "" : " ";
  return `${boundedCurrent}${separator}${clean}`.slice(
    0,
    MAX_DICTATION_CHARACTERS,
  );
}

function errorMessage(code: string | undefined) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Dictation needs microphone permission in this browser.";
    case "network":
      return "This browser’s dictation service is unavailable right now.";
    case "language-not-supported":
      return "This language is not available for browser dictation.";
    default:
      return "Browser dictation could not start. Your draft is unchanged.";
  }
}

/**
 * Browser-only dictation. It appends final Web Speech results to the caller's
 * controlled draft; interim hypotheses stay inside this hook. It has no
 * planner, network, or Live-session path, so the caller can edit the text
 * before deciding whether to send it.
 */
export function useBrowserDictation({
  value,
  onChange,
  disabled = false,
  language,
  onActiveChange,
  onInterimChange,
}: UseBrowserDictationOptions): UseBrowserDictationResult {
  const supported = isBrowserDictationSupported();
  const [status, setStatus] = useState<BrowserDictationStatus>(
    supported ? "idle" : "unsupported",
  );
  const [error, setError] = useState<string>();
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onActiveChangeRef = useRef(onActiveChange);
  const onInterimChangeRef = useRef(onInterimChange);
  const stopRequestedRef = useRef(false);
  const errorRef = useRef(false);
  const finalizedCountRef = useRef(0);
  const mountedRef = useRef(true);

  valueRef.current = value;
  onChangeRef.current = onChange;
  onActiveChangeRef.current = onActiveChange;
  onInterimChangeRef.current = onInterimChange;

  const setInactive = useCallback(
    (
      nextStatus: BrowserDictationStatus,
      expectedRecognition?: SpeechRecognitionLike,
    ) => {
      if (
        expectedRecognition &&
        recognitionRef.current !== expectedRecognition
      ) {
        clearRecognitionHandlers(expectedRecognition);
        return;
      }
      const recognition = expectedRecognition || recognitionRef.current;
      recognitionRef.current = null;
      clearRecognitionHandlers(recognition);
      if (!mountedRef.current) return;
      setInterimTranscript("");
      onInterimChangeRef.current?.("");
      setStatus(nextStatus);
      onActiveChangeRef.current?.(false);
    },
    [],
  );

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    const recognition = recognitionRef.current;
    if (!recognition) {
      setInactive(supported ? "idle" : "unsupported");
      return;
    }
    clearRecognitionHandlers(recognition);
    try {
      recognition.stop();
    } catch {
      // The browser may already have ended the recognition service.
    }
    setInactive(supported ? "idle" : "unsupported", recognition);
  }, [setInactive, supported]);

  const start = useCallback(() => {
    if (disabled || !supported || recognitionRef.current) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setStatus("unsupported");
      return;
    }
    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Constructor();
    } catch {
      setStatus("error");
      setError(errorMessage(undefined));
      return;
    }
    stopRequestedRef.current = false;
    finalizedCountRef.current = 0;
    setError(undefined);
    errorRef.current = false;
    setInterimTranscript("");
    onInterimChangeRef.current?.("");
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang =
      language || document.documentElement.lang || navigator.language;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (
        !mountedRef.current ||
        stopRequestedRef.current ||
        recognitionRef.current !== recognition
      ) {
        clearRecognitionHandlers(recognition);
        try {
          recognition.stop();
        } catch {
          // The permission prompt may have already closed the service.
        }
        return;
      }
      setStatus("listening");
      onActiveChangeRef.current?.(true);
    };
    recognition.onresult = (event) => {
      if (
        !mountedRef.current ||
        stopRequestedRef.current ||
        recognitionRef.current !== recognition
      ) {
        clearRecognitionHandlers(recognition);
        return;
      }
      let finalText = "";
      let nextFinalizedCount = finalizedCountRef.current;
      while (
        nextFinalizedCount < event.results.length &&
        event.results[nextFinalizedCount]?.isFinal
      ) {
        finalText += event.results[nextFinalizedCount]?.[0]?.transcript || "";
        nextFinalizedCount += 1;
      }
      finalizedCountRef.current = nextFinalizedCount;
      let interim = "";
      for (
        let index = nextFinalizedCount;
        index < event.results.length;
        index += 1
      )
        interim += event.results[index]?.[0]?.transcript || "";
      if (finalText) {
        const nextValue = appendTranscript(valueRef.current, finalText);
        valueRef.current = nextValue;
        onChangeRef.current(nextValue);
      }
      const nextInterim = interim.trim().slice(0, MAX_DICTATION_CHARACTERS);
      if (
        !mountedRef.current ||
        stopRequestedRef.current ||
        recognitionRef.current !== recognition
      ) {
        clearRecognitionHandlers(recognition);
        return;
      }
      setInterimTranscript(nextInterim);
      onInterimChangeRef.current?.(nextInterim);
    };
    recognition.onerror = (event) => {
      if (!mountedRef.current || recognitionRef.current !== recognition) {
        clearRecognitionHandlers(recognition);
        return;
      }
      if (event.error === "aborted" || stopRequestedRef.current) return;
      errorRef.current = true;
      setError(errorMessage(event.error));
      setStatus("error");
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) {
        clearRecognitionHandlers(recognition);
        return;
      }
      setInactive(errorRef.current ? "error" : "idle", recognition);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      clearRecognitionHandlers(recognition);
      recognitionRef.current = null;
      setStatus("error");
      setError(errorMessage(undefined));
      onActiveChangeRef.current?.(false);
    }
  }, [disabled, language, setInactive, supported]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) stop();
    else start();
  }, [start, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRequestedRef.current = true;
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      clearRecognitionHandlers(recognition);
      try {
        recognition?.stop();
      } catch {
        // The browser may already have ended the recognition service.
      }
      onActiveChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (disabled && recognitionRef.current) stop();
  }, [disabled, stop]);

  return {
    supported,
    status,
    error,
    interimTranscript,
    start,
    stop,
    toggle,
  };
}

export type VoiceDictationProps = UseBrowserDictationOptions & {
  className?: string;
};

/** Compact composer control for browser dictation. It never sends the draft. */
export function VoiceDictation({
  className = "",
  ...options
}: VoiceDictationProps) {
  const { notify } = useToast();
  const dictation = useBrowserDictation(options);
  const listening = dictation.status === "listening";
  const notifiedErrorRef = useRef("");
  useEffect(() => {
    if (dictation.status !== "error" || !dictation.error) {
      notifiedErrorRef.current = "";
      return;
    }
    if (notifiedErrorRef.current === dictation.error) return;
    notifiedErrorRef.current = dictation.error;
    notify(dictation.error, { tone: "error", duration: 8_000 });
  }, [dictation.error, dictation.status, notify]);
  const label =
    dictation.status === "unsupported"
      ? "Dictation unavailable in this browser"
      : dictation.status === "error"
        ? dictation.error || "Dictation unavailable"
        : listening
          ? "Stop dictation"
          : "Dictate into draft";

  return (
    <span className={`voice-dictation ${className}`.trim()}>
      <IconButton
        size="icon-sm"
        className="voice-dictation-button"
        aria-label={label}
        aria-description="Uses browser dictation. Words stay in your editable draft until you send it."
        aria-pressed={listening}
        disabled={options.disabled || !dictation.supported}
        onClick={dictation.toggle}
      >
        {listening ? (
          <span className="voice-dictation-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : dictation.status === "error" ? (
          <MicOff aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
      </IconButton>
      {(listening || dictation.status === "error") && (
        <span className="sr-only" role="status">
          {listening
            ? dictation.interimTranscript || "Listening"
            : dictation.error}
        </span>
      )}
    </span>
  );
}
