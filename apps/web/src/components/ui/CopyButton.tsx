import { useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { IconCheck, IconCopy } from "./icons";

/** Copies text and confirms inline (no toast needed: the change is visible where the user clicked). */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "ghost",
  size = "sm",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(handle);
  }, [copied]);
  return (
    <Button
      variant={variant}
      size={size}
      icon={copied ? <IconCheck size={14} aria-hidden="true" /> : <IconCopy size={14} aria-hidden="true" />}
      onClick={() => {
        void copyText(text).then((ok) => setCopied(ok));
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </Button>
  );
}
