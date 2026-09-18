import { Input } from "@/components/ui/input";
import { useEffect, useId, useRef } from "react";
import "./verification-code.css";

/** Six visible fields, one controlled code. Spaces preserve empty positions. */
export function VerificationCode({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const label = useId();
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const pendingSubmission = useRef<string | null>(null);
  useEffect(() => {
    const completed = pendingSubmission.current;
    pendingSubmission.current = null;
    if (disabled || completed !== value || !/^[0-9]{6}$/.test(value)) return;
    const form = inputs.current[0]?.form;
    const submit = form?.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    if (form && submit && !submit.disabled) form.requestSubmit(submit);
  }, [value, disabled]);
  const digits = Array.from({ length: 6 }, (_, i) =>
    /^[0-9]$/.test(value[i] || "") ? value[i] : "",
  );
  const focus = (index: number) =>
    inputs.current[Math.max(0, Math.min(5, index))]?.focus();
  function change(index: number, text: string) {
    const numbers = text.replace(/\D/g, "");
    if (text && !numbers) return;
    const next = [...digits];
    if (!numbers) {
      next[index] = "";
    } else {
      const start = numbers.length >= 6 ? 0 : index;
      for (let i = 0; i < Math.min(numbers.length, 6 - start); i++)
        next[start + i] = numbers[i];
      focus(Math.min(start + numbers.length, 5));
    }
    const updated = next
      .map((d) => d || " ")
      .join("")
      .trimEnd();
    pendingSubmission.current = /^[0-9]{6}$/.test(updated) ? updated : null;
    onChange(updated);
  }
  return (
    <div className="verification-code" role="group" aria-labelledby={label}>
      <span id={label} className="verification-code-label">
        Verification code
      </span>
      <div className="verification-code-digits">
        {digits.map((digit, index) => (
          <Input
            key={index}
            ref={(element) => {
              inputs.current[index] = element;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            autoFocus={autoFocus && index === 0}
            aria-label={`Digit ${index + 1} of 6`}
            pattern="[0-9]"
            maxLength={6}
            required
            disabled={disabled}
            value={digit}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const native = e.nativeEvent as InputEvent;
              change(
                index,
                native.inputType === "insertText" && native.data
                  ? native.data
                  : e.currentTarget.value,
              );
            }}
            onPaste={(e) => {
              e.preventDefault();
              change(index, e.clipboardData.getData("text"));
            }}
            onKeyDown={(e) => {
              if (e.key === "Backspace") {
                e.preventDefault();
                const target = digits[index] ? index : Math.max(0, index - 1);
                const next = [...digits];
                next[target] = "";
                onChange(
                  next
                    .map((d) => d || " ")
                    .join("")
                    .trimEnd(),
                );
                focus(target);
              } else if (e.key === "Delete") {
                e.preventDefault();
                change(index, "");
              } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                focus(index + (e.key === "ArrowLeft" ? -1 : 1));
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                focus(e.key === "Home" ? 0 : 5);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
