import type { FrameSettings, FrameState } from '@ff/shared';
import { Segmented, Sheet, Toggle } from '../components/Sheet';
import { shell } from '../lib/api';
import type { Connection } from '../lib/store';

export function SettingsScreen({ state, connection, onClose, onSave }: {
  state: FrameState;
  connection: Connection;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const s: FrameSettings = state.settings;
  const overlay = (k: keyof FrameSettings['overlays'], label: string) => (
    <div class="row" key={k}>
      <span class="row-label">{label}</span>
      <Toggle on={s.overlays[k]} onChange={(v) => onSave({ overlays: { [k]: v } })} />
    </div>
  );
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div class="settings-cols">
        <div class="settings-col">
          <h2 class="section-title">Display</h2>
          <section class="card group">
            <div class="row">
              <span class="row-label">Clock</span>
              <Segmented value={s.clock24h ? '24' : '12'} options={[{ value: '12', label: '12‑hour' }, { value: '24', label: '24‑hour' }]} onChange={(v) => onSave({ clock24h: v === '24' })} />
            </div>
            <div class="row">
              <span class="row-label">Photo fit</span>
              <Segmented value={s.fit} options={[{ value: 'smart', label: 'Smart' }, { value: 'contain', label: 'Whole' }, { value: 'cover', label: 'Fill' }]} onChange={(v) => onSave({ fit: v })} />
            </div>
            <div class="row">
              <span class="row-label">Play videos</span>
              <Toggle on={s.video.enabled} onChange={(v) => onSave({ video: { enabled: v } })} />
            </div>
            <div class="row">
              <span class="row-label">Screen off {s.night.start}–{s.night.end}</span>
              <Toggle on={s.night.enabled} onChange={(v) => onSave({ night: { enabled: v } })} />
            </div>
          </section>
          <h2 class="section-title">On the photo</h2>
          <section class="card group">
            {overlay('clock', 'Time and date')}
            {overlay('prayer', 'Next prayer')}
            {overlay('calendar', 'Next event')}
            {overlay('printer', 'Active print')}
            {overlay('weather', 'Weather')}
          </section>
        </div>
        <div class="settings-col">
          <h2 class="section-title">Prayer</h2>
          <section class="card group">
            <div class="row"><span class="row-label">Location</span><span class="row-value">{s.location ? s.location.label : 'Not set'}</span></div>
            <div class="row">
              <span class="row-label">Asr</span>
              <Segmented value={s.prayer.madhab} options={[{ value: 'shafi', label: 'Earlier' }, { value: 'hanafi', label: 'Later' }]} onChange={(v) => onSave({ prayer: { madhab: v } })} />
            </div>
            <div class="row">
              <span class="row-label">Hijri date</span>
              <Segmented value={s.prayer.hijriAdjust} options={[{ value: -1, label: '−1' }, { value: 0, label: '0' }, { value: 1, label: '+1' }]} onChange={(v) => onSave({ prayer: { hijriAdjust: v } })} />
            </div>
          </section>
          <h2 class="section-title">Integrations</h2>
          <section class="card group">
            {Object.keys(state.providers).map((k) => {
              const p = state.providers[k]!;
              return (
                <div class="row" key={k}>
                  <span class="row-label">{p.name}<span class="row-sub">{p.message}</span></span>
                  <span class={'status-dot' + (p.ok ? ' ok' : '')} />
                </div>
              );
            })}
          </section>
          <h2 class="section-title">About</h2>
          <section class="card group">
            <div class="row"><span class="row-label">Internet</span><span class="row-value">{connection === 'online' ? 'Connected' : connection === 'offline' ? 'Offline' : 'Checking…'}</span></div>
            <div class="row"><span class="row-label">Upload link</span><span class="row-value">{state.uploadUrl.replace('http://', '').split('/u/')[0] || '—'}</span></div>
            <div class="row"><span class="row-label">App</span><span class="row-value">{shell && shell.version ? shell.version() : 'Browser'}</span></div>
            {shell && shell.openFrameo && (
              <button class="row row-button" onClick={() => shell!.openFrameo!()}>Open Frameo</button>
            )}
          </section>
        </div>
      </div>
    </Sheet>
  );
}
