// Small shadcn-style primitives (neutral tokens, rounded cards).
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border bg-background hover:bg-accent',
  ghost: 'hover:bg-accent',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
};

export function Button({ variant = 'primary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'h-8 px-3 text-sm' : size === 'lg' ? 'h-12 px-6 text-base' : 'h-10 px-4 text-sm';
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        sz,
        className
      )}
      {...p}
    />
  );
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...p} />;
}

export function CardHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center justify-between gap-2 border-b px-4 py-3', className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/50', className)} {...p} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/50', className)} {...p} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cx('flex flex-col gap-1 text-xs font-medium text-muted-foreground', className)}>{children}</label>;
}

export function Badge({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium', className)} {...p} />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p data-testid="error" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

export { cx };
