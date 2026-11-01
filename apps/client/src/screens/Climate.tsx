// Tesla-style climate control for MELCloud units: a static tap-to-aim room map (AimMap),
// big chevron temperature, modes, fan steps and air-direction presets. No continuous animation.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AcPreset, FrameState } from '@ff/shared';
import { AimMap } from '../components/AimMap';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import type { AcMode, AcUnit } from '../providers/melcloud';
import { acCancelTimer, acRunPreset, acSet, acSignIn, acSignOut, acTimer, onAcTimer, saveSettings, type AcState } from '../lib/store';
import { hhmm } from '../lib/time';

export const MODE_COLOR: Record<AcMode, string> = { cool: '#5ac8fa', heat: '#ff9f0a', auto: '#30d158', dry: '#64e0d6', fan: '#e5e5ea' };
export const MODE_LABEL: Record<AcMode, string> = { cool: 'Cooling', heat: 'Heating', auto: 'Auto', dry: 'Dry', fan: 'Fan' };
export const MODE_ICON: Record<AcMode, string> = { cool: 'snow', heat: 'flame', auto: 'auto', dry: 'drop', fan: 'fan' };
const MODES: AcMode[] = ['cool', 'heat', 'auto', 'dry', 'fan'];
function SignIn({ error }: { error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error || '');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await acSignIn(email.trim(), password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed');
    }
    setPassword('');
    setBusy(false);
  };
  return (
    <div class="card signin">
      <div class="signin-title">Connect MELCloud</div>
      <div class="signin-sub">Sign in with your Mitsubishi Electric MELCloud account. Your password isn’t stored; only a sign-in key is kept on this frame.</div>
      <input class="field" type="email" placeholder="Email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autoComplete="off" />
      <input class="field" type="password" placeholder="Password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      {err && <div class="signin-err">{err}</div>}
      <button class="primary-btn" disabled={busy || !email || !password} onClick={submit}>{busy ? 'Signing In…' : 'Sign In'}</button>
    </div>
  );
}

const PRESET_ICON: Record<string, string> = { cool: 'snow', heat: 'flame', night: 'moon' };
const PRESET_COLOR: Record<string, string> = { cool: '#5ac8fa', heat: '#ff9f0a', night: '#bf5af2' };
const DURATIONS = [10, 20, 30, 60, 120, 0];
const short = (m: number) => (m === 0 ? 'Stay' : m < 60 ? m + 'm' : m / 60 + 'h');
const mins = (m: number) => (m === 0 ? 'Stay on' : m < 60 ? m + ' min' : m / 60 + ' h');
function presetDesc(p: AcPreset): string {
  // Short enough for the button: "18° · 20 min", "Quiet · off in 2 h".
  const bits: string[] = [];
  if (p.setTemp !== null) bits.push(p.setTemp + '°');
  else if (p.fan === 'min') bits.push('Quiet');
  if (p.minutes) bits.push((p.after === 'off' ? 'off in ' : '') + mins(p.minutes));
  return bits.join(' · ');
}
function clockAt(ms: number): string {
  return hhmm(new Date(ms));
}

/** One-tap shortcuts (Quick Cool, Quick Heat, Night), editable, with the pending undo/off shown. */
function Presets({ unit, presets }: { unit: AcUnit; presets: AcPreset[] }) {
  const [, bump] = useState(0);
  useEffect(() => onAcTimer(() => bump((x) => x + 1)), []);
  const [editing, setEditing] = useState(false);
  const save = (id: string, change: Partial<AcPreset>) =>
    saveSettings({ acPresets: presets.map((p) => (p.id === id ? { ...p, ...change } : p)) }).catch(() => {});
  const timer = acTimer && acTimer.unitId === unit.id ? acTimer : null;
  const running = timer ? presets.filter((p) => p.id === timer.presetId)[0] : null;
  return (
    <div class="presets-wrap">
      <div class="presets">
        {presets.map((p) => (
          <button key={p.id} class={'preset' + (running && running.id === p.id ? ' on' : '')}
            style={running && running.id === p.id ? { borderColor: PRESET_COLOR[p.id] } : undefined}
            onClick={() => !editing && acRunPreset(unit, p)}>
            <span class="preset-icon" style={{ color: PRESET_COLOR[p.id] }}><Icon name={PRESET_ICON[p.id] || 'fan'} size={24} stroke={1.9} /></span>
            <span class="preset-text"><b>{p.label}</b><small>{presetDesc(p)}</small></span>
          </button>
        ))}
        <button class={'preset-edit' + (editing ? ' on' : '')} onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>
      </div>
      {editing && <div class="preset-editor">{presets.map((p) => (
        <div class="preset-row" key={p.id}>
          <span class="preset-row-name">{p.label}</span>
          {p.setTemp !== null && (
            <span class="preset-temp">
              <button onClick={() => save(p.id, { setTemp: Math.max(16, p.setTemp! - 1) })}>−</button>
              <b>{p.setTemp}°</b>
              <button onClick={() => save(p.id, { setTemp: Math.min(31, p.setTemp! + 1) })}>+</button>
            </span>
          )}
          <span class="preset-durs">
            {DURATIONS.map((m) => (
              <button key={m} class={p.minutes === m ? 'on' : ''} onClick={() => save(p.id, { minutes: m })}>{short(m)}</button>
            ))}
          </span>
        </div>
      ))}</div>}
      {timer && running && !editing && (
        <div class="preset-timer">
          <span>{running.label} · {timer.after === 'off' ? 'turns off' : 'back to how it was'} at {clockAt(timer.at)}</span>
          <button onClick={() => acCancelTimer(false)}>Keep it</button>
          <button onClick={() => acCancelTimer(true)}>{timer.after === 'off' ? 'Turn off now' : 'Undo now'}</button>
        </div>
      )}
    </div>
  );
}

export function ClimateScreen({ state, ac, onClose }: { state: FrameState; ac: AcState; onClose: () => void }) {
  const [sel, setSel] = useState(0);
  const unit = ac.units[Math.min(sel, ac.units.length - 1)];
  // Temperature taps update instantly but are sent once you stop tapping.
  const [temp, setTemp] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => setTemp(null), [unit && unit.id]);
  const shownTemp = temp !== null ? temp : unit ? unit.setTemp : 0;
  const nudge = (d: number) => {
    if (!unit) return;
    const next = Math.max(unit.minTemp, Math.min(unit.maxTemp, Math.round((shownTemp + d) * 2) / 2));
    setTemp(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { acSet(unit, { setTemp: next }); setTemp(null); }, 900);
  };

  if (ac.status === 'signed-out') {
    return <Sheet title="Climate" onClose={onClose}><SignIn /></Sheet>;
  }
  if (!unit) {
    return <Sheet title="Climate" onClose={onClose}><p class="muted big">{ac.status === 'error' ? 'Can’t reach MELCloud right now.' : 'Loading your air conditioning…'}</p></Sheet>;
  }
  const color = MODE_COLOR[unit.mode];
  const outside = state.weather ? Math.round(state.weather.tempC) : null;
  return (
    <Sheet
      title="Climate"
      subtitle={unit.offline ? `${unit.name} · Unit offline` : unit.name}
      onClose={onClose}
      accessory={ac.units.length > 1 ? (
        <div class="segmented unit-pills">
          {ac.units.map((u, i) => <button key={u.id} class={i === sel ? 'on' : ''} onClick={() => setSel(i)}>{u.name}</button>)}
        </div>
      ) : undefined}
    >
      <div class="climate-layout">
        <div class="card climate-stage">
          <AimMap unit={unit} color={color} onAim={(vaneH, vaneV) => acSet(unit, { vaneH, vaneV })} />
          <div class="stage-foot">
            <span>Inside <b>{unit.roomTemp !== null ? Math.round(unit.roomTemp * 10) / 10 + '°' : '–'}</b></span>
            {outside !== null && <span>Outside <b>{outside}°</b></span>}
          </div>
        </div>
        <div class="climate-controls">
          <Presets unit={unit} presets={state.settings.acPresets || []} />
          <div class="temp-row">
            <button class="chev" onClick={() => nudge(-0.5)} disabled={!unit.power}><Icon name="chevLeft" size={40} stroke={2.2} /></button>
            <div class={'big-temp' + (unit.power ? '' : ' dim')}>
              {shownTemp.toFixed(1)}<span>°</span>
            </div>
            <button class="chev" onClick={() => nudge(0.5)} disabled={!unit.power}><Icon name="chevRight" size={40} stroke={2.2} /></button>
          </div>
          <div class="mode-row">
            {MODES.map((m) => {
              const on = unit.mode === m && unit.power;
              return (
                <button key={m} class={'mode-btn' + (on ? ' on' : '')} style={on ? { backgroundColor: MODE_COLOR[m] } : undefined}
                  onClick={() => acSet(unit, unit.power ? { mode: m } : { mode: m, power: true })}>
                  <Icon name={MODE_ICON[m]} size={30} stroke={1.8} />
                  <span>{m === 'cool' ? 'Cool' : m === 'heat' ? 'Heat' : m === 'auto' ? 'Auto' : m === 'dry' ? 'Dry' : 'Fan'}</span>
                </button>
              );
            })}
          </div>
          <div class="fan-row">
            <span class="fan-label">Fan</span>
            <div class="fan-steps">
              <button class={unit.fan === 0 ? 'on' : ''} onClick={() => acSet(unit, { fan: 0 })}>Auto</button>
              {Array.apply(null, Array(unit.fanSteps)).map((_, i) => (
                <button key={i} class={'bars' + (unit.fan === i + 1 ? ' on' : '')} onClick={() => acSet(unit, { fan: i + 1 })}>
                  <i style={{ height: 8 + (i + 1) * (22 / unit.fanSteps) + 'px' }} />
                </button>
              ))}
            </div>
          </div>
          <div class="fan-row">
            <span class="fan-label">Air</span>
            <div class="fan-steps dir-steps">
              <button class={unit.vaneV === 0 && unit.vaneH === 0 ? 'on' : ''} onClick={() => acSet(unit, { vaneV: 0, vaneH: 0 })}>Auto</button>
              <button class={unit.vaneV === 7 ? 'on' : ''} onClick={() => acSet(unit, { vaneV: 7 })}>Sweep ↕</button>
              <button class={unit.vaneH === 12 ? 'on' : ''} onClick={() => acSet(unit, { vaneH: 12 })}>Sweep ↔</button>
              <button class={unit.vaneV >= 1 && unit.vaneV <= 5 && unit.vaneH >= 1 && unit.vaneH <= 5 ? 'on' : ''}
                onClick={() => acSet(unit, { vaneV: 3, vaneH: 3 })}>Aim</button>
            </div>
          </div>
          <button class={'power-btn' + (unit.power ? ' on' : '')} style={unit.power ? { borderColor: color } : undefined}
            onClick={() => acSet(unit, { power: !unit.power })}>
            <Icon name="power" size={28} stroke={2} />
            <span>{unit.power ? `${MODE_LABEL[unit.mode]} · Turn Off` : 'Turn On'}</span>
          </button>
          <button class="link-btn" onClick={acSignOut}>Disconnect MELCloud</button>
        </div>
      </div>
    </Sheet>
  );
}
