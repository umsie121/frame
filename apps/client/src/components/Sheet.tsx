import type { ComponentChildren } from 'preact';
import { Icon } from './Icon';

/** Full-screen page with an iOS-style large title and a single, obvious way back to photos. */
export function Sheet({ title, subtitle, onClose, children, accessory }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ComponentChildren;
  accessory?: ComponentChildren;
}) {
  return (
    <div class="sheet">
      <header class="sheet-header">
        <div class="sheet-titles">
          <h1 class="sheet-title">{title}</h1>
          {subtitle && <div class="sheet-subtitle">{subtitle}</div>}
        </div>
        {accessory}
        <button class="close-btn" onClick={onClose} aria-label="Back to photos">
          <Icon name="close" size={28} stroke={2} />
        </button>
      </header>
      <div class="sheet-body">{children}</div>
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button class={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <i />
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="segmented">
      {options.map((o) => (
        <button key={String(o.value)} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
