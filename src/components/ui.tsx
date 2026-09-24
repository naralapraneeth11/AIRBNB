"use client";
import {
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { X, ArrowRight, Plus, Check, Info } from "lucide-react";
export function Button({
  children,
  primary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      className={`button ${primary ? "primary" : ""} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
export function Head({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Plus />
      </div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  sheet = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  sheet?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const focus = document.activeElement as HTMLElement | null;
    d?.showModal();
    return () => {
      d?.close();
      focus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={sheet ? "sheet" : ""}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button aria-label="Close" onClick={onClose} className="icon-button">
          <X />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={"toggle " + (checked ? "on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <Info />
      <div>
        <strong>Something needs attention</strong>
        <p>{message}</p>
        {retry && (
          <button onClick={retry}>
            Try again <ArrowRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
export function Skeleton() {
  return (
    <div
      className="skeleton-layout"
      role="status"
      aria-label="Loading workspace"
    >
      <div className="skeleton title" />
      <div className="skeleton hero" />
      <div className="skeleton-grid">
        {[1, 2, 3].map((i) => (
          <div key={i} className="skeleton card" />
        ))}
      </div>
    </div>
  );
}
export function Confirm({
  title,
  detail,
  onConfirm,
  onClose,
  busy = false,
  label = "Confirm",
}: {
  title: string;
  detail: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{detail}</p>
      <div className="form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button primary disabled={busy} onClick={onConfirm}>
          <Check size={16} />
          {busy ? "Saving…" : label}
        </Button>
      </div>
    </Modal>
  );
}
