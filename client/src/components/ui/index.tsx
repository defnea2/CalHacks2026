// Small primitives in the ui/final design language (see src/design/): same props as before.
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
// The tangerine clay button is reserved for the primary action; everything else is a quiet pill.
const VARIANTS: Record<Variant, string> = {
  primary: 'lesson-primary',
  secondary: 'voice-button',
  outline: 'voice-button',
  ghost: 'voice-button is-ghost',
  destructive: 'voice-button is-danger',
};

export function Button({ variant = 'primary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'is-small' : size === 'lg' ? 'is-large' : '';
  return <button className={cx(VARIANTS[variant], sz, className)} {...p} />;
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('voice-card', className)} {...p} />;
}

export function CardHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('voice-card-header', className)}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('voice-input', className)} {...p} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('voice-input', className)} {...p} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cx('voice-label', className)}>{children}</label>;
}

export function Badge({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx('voice-tab', className)} {...p} />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p data-testid="error" className="lesson-error" role="alert">
      {children}
    </p>
  );
}

export { cx };
