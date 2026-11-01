// Printer screen: A1 + AMS illustration / camera / model preview, live status with the preparation
// checklist, heating progress, speed, health warnings and details — plus a full-screen camera view
// with everything overlaid and an optional plain-words summary. The only controls are the chamber light and
// the speed mode (owner-approved); nothing else is ever sent to the printer.
import { PhaseBar, PhaseLegend, PrepBillCard, prepHeadline } from '../components/PrepBill';
import { prepBill, printBar } from '../lib/printPrep';
import { useEffect, useState } from 'preact/hooks';
import type { FrameState, PrinterState } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Segmented, Sheet } from '../components/Sheet';
import { PrinterArt } from '../components/PrinterArt';
import { controlPrinter } from '../providers/bambu';
import { refreshPrinter } from '../lib/store';
import { request } from '../lib/api';
import { clockIn, hqStoryFor, storyFor } from '../lib/printerStory';
import { Boot, Countdown, HqOverlay, Static, warmedCamera, type HqPhase } from '../components/HqMode';
import { sfxBoost, sfxStart, sfxStatic, sfxStop, sfxVoice } from '../lib/sfx';
import { hhmm } from '../lib/time';

const SPEEDS = [{ v: 1, label: 'Silent' }, { v: 2, label: 'Standard' }, { v: 3, label: 'Sport' }, { v: 4, label: 'Ludicrous' }];

/**
 * Light + speed controls. Shows the requested value straight away and holds it until the printer's
 * report catches up (or 8 s pass), so taps feel instant even though reports arrive every few seconds.
 */
function useControls(p: PrinterState) {
  const [want, setWant] = useState<{ light?: boolean; speed?: number; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fresh = want && Date.now() - want.at < 8000;
  const light = fresh && want!.light !== undefined ? want!.light! : p.telemetry.light;
  const speed = fresh && want!.speed !== undefined ? want!.speed! : p.speedLevel;
  const send = (action: 'light' | 'speed', value: string, local: { light?: boolean; speed?: number }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setWant({ ...local, at: Date.now() });
    controlPrinter(action, value)
      .then(() => { window.setTimeout(refreshPrinter, 1500); window.setTimeout(refreshPrinter, 4000); })
      .catch((e: Error) => { setWant(null); setError(e && e.message ? e.message : 'Printer didn’t respond'); })
      .then(() => setBusy(false));
  };
  const active = p.status === 'printing' || p.status === 'paused';
  return {
    light, speed, busy, error, canSpeed: active && p.status !== 'offline', online: p.status !== 'offline',
    toggleLight: () => send('light', light ? 'off' : 'on', { light: !light }),
    setSpeed: (v: number) => send('speed', String(v), { speed: v }),
  };
}

const STATUS: Record<string, string> = {
  offline: 'Offline', idle: 'Idle', printing: 'Printing', paused: 'Paused', finished: 'Finished', error: 'Needs attention',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hhmm(d)}`;
}

const dotColor = (p: PrinterState) =>
  p.status === 'printing' ? '#30d158' : p.status === 'paused' ? '#ff9f0a' : p.status === 'error' ? '#ff453a' : p.status === 'offline' ? '#8e8e93' : '#64d2ff';

/** "173° → 220°" while heating, "220°" once there. */
function temp(now: number | null, target: number | null): { main: string; sub: string } {
  if (now === null) return { main: '–', sub: '' };
  if (target && Math.abs(target - now) > 3) return { main: now + '°', sub: '→ ' + target + '°' };
  return { main: now + '°', sub: '' };
}

/** Live camera (or a stored photo); loads each frame off-screen and swaps when ready, so it never flashes. */
function PrintPhoto({ live, src, refreshMs, cls, first, onFirst }: {
  live: boolean; src: string; refreshMs: number; cls?: string; first?: string | null; onFirst?: () => void;
}) {
  const [shown, setShown] = useState<string | null>(first || null);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = () => {
      const url = live ? src + (src.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() : src;
      const img = new Image();
      img.onload = () => {
        if (alive) setShown(url);
        // Report after the swap has painted (next frame), so "ready" means visible.
        if (alive && onFirst) requestAnimationFrame(() => requestAnimationFrame(onFirst));
        if (alive && live) timer = window.setTimeout(load, refreshMs);
      };
      img.onerror = () => { if (alive && live) timer = window.setTimeout(load, refreshMs * 2); };
      img.src = url;
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [src, live]);
  return shown ? <img class={cls || 'print-photo-img'} src={shown} alt="" /> : <div class="print-photo-empty">Connecting to camera…</div>;
}

function Checklist({ p }: { p: PrinterState }) {
  if (!p.stagePlan) return null;
  const bill = prepBill(p);
  if (bill) return <PrepBillCard bill={bill} />;
  return (
    <div class="checklist">
      {p.stagePlan.map((s, i) => (
        <div key={i} class={'check ' + s.state}>
          <span class="check-mark">{s.state === 'done' ? '✓' : ''}</span>
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

const pct = (v: number | null) => (v === null ? '–' : v + '%');
const onOff = (v: boolean | null) => (v === null ? '–' : v ? 'On' : 'Off');

function Gauge({ label, value, sub, fill }: { label: string; value: string; sub?: string; fill?: number | null }) {
  return (
    <div class="fc-gauge">
      <div class="fc-dim">{label}</div>
      <div class="fc-gauge-v">{value}{sub ? <small> {sub}</small> : null}</div>
      {fill !== undefined && <div class="fc-meter"><i style={{ width: Math.max(0, Math.min(100, fill || 0)) + '%' }} /></div>}
    </div>
  );
}

/** Full-screen camera, cropped to fill the display, with the live info floating over it. */
const SUMMARY_KEY = 'ff_fc_summary';
function loadSummaryPref(): boolean {
  try { return localStorage.getItem(SUMMARY_KEY) === '1'; } catch (e) { return false; }
}

/** iOS-style switch inside a glass pill: the whole pill is the tap target. */
function SwitchPill({ label, icon, on, disabled, onToggle }: { label: string; icon: string; on: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button class={'fc-btn fc-switch' + (on ? ' on' : '')} onClick={onToggle} disabled={disabled} role="switch" aria-checked={on}>
      <Icon name={icon} size={22} stroke={2} /><span>{label}</span>
      <i class="sw"><b /></i>
    </button>
  );
}

function FullCamera({ p, name, room, home, onClose }: {
  p: PrinterState; name: string | null; room: number | null;
  home: { lat: number; lng: number; label: string } | null; onClose: () => void;
}) {
  const [hq, setHq] = useState<HqPhase>('off');
  // HQ target: kv "hqTarget" on the frame (exact spot for the easter egg), else the home location.
  const [target, setTarget] = useState<{ lat: number; lng: number; label: string } | null>(null);
  useEffect(() => {
    request<{ lat: number; lng: number; label?: string }>('GET', '/api/kv/hqTarget')
      .then((t) => { if (t && typeof t.lat === 'number') setTarget({ lat: t.lat, lng: t.lng, label: t.label || 'Bedroom HQ' }); })
      .catch(() => {});
  }, []);
  const [liveGlitch, setLiveGlitch] = useState('');
  // Leaving the full-screen view always ends the sound, whatever phase HQ mode was in.
  useEffect(() => () => sfxStop(), []);
  useEffect(() => { if (hq === 'static-out') sfxStatic(650); }, [hq]);
  const ops = hq === 'preload' || hq === 'live' || hq === 'countdown';
  const [liveReady, setLiveReady] = useState(false);
  const c = useControls(p);
  const [picker, setPicker] = useState(false);
  const [story, setStory] = useState(loadSummaryPref);
  const toggleStory = () => {
    const next = !story;
    setStory(next);
    try { localStorage.setItem(SUMMARY_KEY, next ? '1' : '0'); } catch (e) { /* not remembered, that's fine */ }
  };
  // Don't let the 45 s "back to photos" timer close it while someone is watching.
  useEffect(() => {
    (window as unknown as { ffStayOpen?: boolean }).ffStayOpen = true;
    return () => { (window as unknown as { ffStayOpen?: boolean }).ffStayOpen = false; };
  }, []);
  const dot = dotColor(p);
  const t = p.telemetry;
  const active = p.status === 'printing' || p.status === 'paused';
  const heatPct = (now: number | null, target: number | null) => (now !== null && target ? (now / target) * 100 : now !== null ? 0 : null);
  const nSub = p.nozzleTarget && p.nozzleTemp !== null && Math.abs(p.nozzleTarget - p.nozzleTemp) > 3 ? '→ ' + p.nozzleTarget + '°' : p.nozzleTarget ? 'target ' + p.nozzleTarget + '°' : 'off';
  const bSub = p.bedTarget && p.bedTemp !== null && Math.abs(p.bedTarget - p.bedTemp) > 3 ? '→ ' + p.bedTarget + '°' : p.bedTarget ? 'target ' + p.bedTarget + '°' : 'off';
  const spools = p.ams.concat(p.external ? [p.external] : []);
  const wifi = t.wifiDbm === null ? '–' : t.wifiDbm >= -60 ? 'Strong' : t.wifiDbm >= -70 ? 'Good' : 'Weak';
  // Labels: normal, or the Bedroom HQ easter egg's in-world names.
  const L = ops
    ? { job: '> ' + (p.jobName || 'idle').replace(/_/g, ' '), fil: 'Spools', nozzle: 'HOTEND', bed: 'PLATE', speed: 'FEED', part: 'FAN_01', aux: 'FAN_02', core: 'FAN_03', done: 'ETA', layer: 'LAYER' }
    : { job: p.jobName || 'Bambu Lab A1', fil: 'Filament', nozzle: 'Nozzle', bed: 'Bed', speed: 'Speed', part: 'Part fan', aux: 'Aux fan', core: 'Hotend fan', done: 'Done at', layer: 'Layer' };
  return (
    <div class={'fullcam' + (ops ? ' hq' : '') + (liveGlitch ? ' g-' + liveGlitch : '')} onClick={(e) => e.stopPropagation()}>
      {/* The camera pauses under the full-screen effects: redrawing it through the HQ filter would stall them. */}
      {hq !== 'countdown' && hq !== 'static-out' && hq !== 'boot' && <PrintPhoto live src="/api/printer/camera.jpg" refreshMs={1000} cls="fullcam-img" first={warmedCamera()} onFirst={() => setLiveReady(true)} />}
      {(hq === 'preload' || hq === 'live') && <HqOverlay p={p} name={name} room={room} onGlitch={setLiveGlitch} />}

      <div class="fc-left">
        <div class="fc-panel fc-top">
          <div class="fc-top-row">
            <span class="fc-dot" style={{ backgroundColor: dot }} />
            <div class="fc-top-text">
              <div class="fc-job">{L.job}</div>
              <div class="fc-sub">{p.stage || STATUS[p.status]}{p.speed && active ? ' · ' + p.speed + ' speed' : ''}{t.source ? ' · ' + t.source : ''}</div>
            </div>
          </div>
          {story && <p class="fc-story-text">{ops ? hqStoryFor(p, name) : storyFor(p, name)}</p>}
        </div>
        {(p.alerts.length > 0 || p.stagePlan) && (
          <div class="fc-panel fc-side">
            {p.alerts.map((a, i) => <div key={i} class="fc-alert-line">{a}</div>)}
            {p.stagePlan && <Checklist p={p} />}
          </div>
        )}
      </div>

      <div class="fc-actions">
        {ops
          ? <button class="fc-btn fc-danger" onClick={() => { sfxBoost(); sfxVoice('destruct'); setHq('countdown'); }} disabled={hq === 'countdown'}><span>Self destruct</span></button>
          : <button class="fc-btn fc-danger" onClick={() => { sfxStart(); sfxStatic(1100); setHq('static-in'); }}><span>Do not click</span></button>}
        <SwitchPill label="Light" icon="bulb" on={!!c.light} disabled={!c.online || c.busy} onToggle={c.toggleLight} />
        <SwitchPill label="Summary" icon="text" on={story} onToggle={toggleStory} />
      </div>
      <button class="fc-close" onClick={onClose} aria-label="Exit full screen"><Icon name="close" size={28} stroke={2} /></button>

      {c.error && <div class="fc-panel fc-error">{c.error}</div>}

      <div class="fc-panel fc-spools-panel">
        <div class="fc-dim fc-head">{L.fil}</div>
        {spools.map((s) => (
          <div key={s.slot} class={'fc-spool-row' + (s.active ? ' on' : s.inJob ? ' job' : '') + (s.material ? '' : ' empty')}>
            <span class="fc-spool" style={{ backgroundColor: s.color || 'transparent' }} />
            <div class="fc-spool-text">
              <div>{s.material ? s.name || s.material : 'Empty'}</div>
              <div class="fc-dim">{s.slot === 0 ? 'External' : 'Slot ' + s.slot}{s.tempRange ? ' · ' + s.tempRange : ''}</div>
            </div>
            {s.active && <span class="fc-tag">In use</span>}
          </div>
        ))}
      </div>

      <div class="fc-panel fc-bottom">
        <div class="fc-prog">
          <div class="fc-pct">{p.progressPct ?? 0}<span>%</span></div>
          <div class="fc-meta">
            <div>{active && p.remainingLabel ? p.remainingLabel + ' left' : STATUS[p.status]}</div>
            {active && p.remainingMin !== null && <div class="fc-dim">{L.done} {clockIn(p.remainingMin)}</div>}
            <div class="fc-dim">{L.layer} {p.layer ?? '–'} of {p.totalLayers ?? '–'}</div>
          </div>
        </div>
        <div class="fc-gauges">
          <Gauge label={L.nozzle} value={p.nozzleTemp !== null ? p.nozzleTemp + '°' : '–'} sub={nSub} fill={heatPct(p.nozzleTemp, p.nozzleTarget)} />
          <Gauge label={L.bed} value={p.bedTemp !== null ? p.bedTemp + '°' : '–'} sub={bSub} fill={heatPct(p.bedTemp, p.bedTarget)} />
          <button class={'fc-gauge-btn' + (c.canSpeed ? '' : ' off')} onClick={() => c.canSpeed && setPicker(!picker)}>
            <Gauge label={c.canSpeed ? L.speed + ' · tap to change' : L.speed} value={pct(t.speedPct)} sub={(c.speed && SPEEDS[c.speed - 1] ? SPEEDS[c.speed - 1]!.label : p.speed) || ''} fill={t.speedPct !== null ? t.speedPct / 1.66 : null} />
          </button>
          <Gauge label={L.part} value={pct(t.partFanPct)} fill={t.partFanPct} />
          <Gauge label={L.aux} value={pct(t.auxFanPct)} fill={t.auxFanPct} />
          <Gauge label={L.core} value={pct(t.heatbreakFanPct)} fill={t.heatbreakFanPct} />
        </div>
        <div class="fc-facts">
          <div><span class="fc-dim">Nozzle</span> {t.nozzle || '–'}</div>
          <div><span class="fc-dim">Flow K</span> {t.flowK !== null ? t.flowK.toFixed(3) : '–'}</div>
          <div><span class="fc-dim">Wi‑Fi</span> {wifi}{t.wifiDbm !== null ? <small> {t.wifiDbm} dBm</small> : null}</div>
          {ops
            ? <div><span class="fc-dim">Node</span> bedroom-hq{room !== null ? <small> {room}°C</small> : null}</div>
            : <div><span class="fc-dim">Timelapse</span> {onOff(t.timelapse)}</div>}
        </div>
        <i class="fc-bar" style={{ width: (p.progressPct || 0) + '%', backgroundColor: dot }} />
      </div>

      {hq === 'static-in' && <Static ms={1100} label="SIGNAL INTERRUPTED" onDone={() => setHq('boot')} />}
      {(hq === 'boot' || hq === 'preload') && (
        <Boot p={p} name={name} room={room} home={target || home} liveReady={liveReady}
          onPreload={() => { setLiveReady(false); setHq('preload'); }} onDone={() => setHq('live')} />
      )}
      {hq === 'countdown' && <Countdown onDone={() => setHq('static-out')} />}
      {hq === 'static-out' && <Static ms={650} onDone={() => { sfxStop(); setHq('off'); }} />}

      {picker && c.canSpeed && (
        <div class="fc-panel fc-speeds">
          {SPEEDS.map((s) => (
            <button key={s.v} class={c.speed === s.v ? 'on' : ''} disabled={c.busy} onClick={() => { c.setSpeed(s.v); setPicker(false); }}>{s.label}</button>
          ))}
        </div>
      )}

    </div>
  );
}

/** Light + speed row on the main printer screen. */
function ControlRow({ p }: { p: PrinterState }) {
  const c = useControls(p);
  return (
    <div class="printer-controls">
      {/* Light sits top-right of the panel (absolute), beside the status pill; speed flows below the stats. */}
      <button class={'ctl-light' + (c.light ? ' on' : '')} onClick={c.toggleLight} disabled={!c.online || c.busy} role="switch" aria-checked={!!c.light}>
        <Icon name="bulb" size={22} stroke={2} /> Light <i class="sw"><b /></i>
      </button>
      {c.canSpeed && (
        <div class="segmented ctl-speed">
          {SPEEDS.map((s) => (
            <button key={s.v} class={c.speed === s.v ? 'on' : ''} disabled={c.busy} onClick={() => c.setSpeed(s.v)}>{s.label}</button>
          ))}
        </div>
      )}
      {c.error && <div class="ctl-error">{c.error}</div>}
    </div>
  );
}

export function PrinterScreen({ state, room, onClose, onHistory, onProse }: { state: FrameState; room: number | null; onClose: () => void; onHistory: () => void; onProse: () => void }) {
  const p = state.printer;
  const [view, setView] = useState<'printer' | 'camera' | 'model'>('printer');
  const [full, setFull] = useState(false);
  const historyBtn = <button class="pill-btn" onClick={onHistory}><Icon name="archive" size={22} stroke={1.9} />History</button>;
  const proseBtn = <button class="pill-btn" onClick={onProse}><Icon name="text" size={22} stroke={1.9} />Words</button>;
  if (!p) return <Sheet title="Printer" onClose={onClose} accessory={historyBtn}><p class="muted big">Printer not connected.</p></Sheet>;
  const active = p.status === 'printing' || p.status === 'paused';
  const lp = p.lastPhoto;
  const live = active || p.status === 'error' || !lp;
  const camSrc = live ? '/api/printer/camera.jpg' : '/api/printer/last.jpg?at=' + lp!.at;
  const dot = dotColor(p);
  const bill = prepBill(p);
  const bar = bill ? null : printBar(p);
  const n = temp(p.nozzleTemp, p.nozzleTarget);
  const b = temp(p.bedTemp, p.bedTarget);
  const views: { value: 'printer' | 'camera' | 'model'; label: string }[] = [{ value: 'printer', label: 'Printer' }, { value: 'camera', label: live ? 'Camera' : 'Latest Print' }];
  if (p.preview) views.push({ value: 'model', label: 'Model' });

  return (
    <Sheet title="Bambu Lab A1" onClose={onClose} accessory={<div class="printer-acc"><Segmented value={view} options={views} onChange={setView} />{proseBtn}{historyBtn}</div>}>
      <div class="printer-layout">
        <div class="card printer-stage">
          {view === 'printer' && <PrinterArt p={p} />}
          {view === 'camera' && (
            <div class="stage-photo">
              <PrintPhoto live={live} src={camSrc} refreshMs={active ? 1500 : 20000} />
              <div class="print-photo-cap">{live ? 'Live' : `Latest print · ${when(lp!.at)}`}</div>
              <button class="maximise" onClick={() => setFull(true)} aria-label="Full screen"><Icon name="expand" size={24} stroke={2} /></button>
            </div>
          )}
          {view === 'model' && p.preview && (
            <div class="stage-photo stage-model">
              <img class="model-img" src={'/api/printer/preview.png?task=' + p.preview.task} alt="" />
              <div class="print-photo-cap">Model preview</div>
            </div>
          )}
        </div>

        <div class="printer-side">
          <div class="status-pill"><i style={{ backgroundColor: dot }} />{p.stage || STATUS[p.status]}</div>
          <div class="printer-job">{p.jobName || 'No recent job'}</div>
          {bill ? (
            <div class="prep-head">
              <div class="prep-big">{prepHeadline(bill).big}</div>
              <div class="prep-rest">{prepHeadline(bill).rest}</div>
              <PhaseBar segments={bill.segments} />
              <PhaseLegend legend={bill.legend} />
            </div>
          ) : (
            <div>
              <div class="big-progress">{p.progressPct ?? 0}<span>%</span></div>
              {bar ? <div><PhaseBar segments={bar.segments} /><PhaseLegend legend={bar.legend} /></div> : <div class="progress-track"><i style={{ width: (p.progressPct || 0) + '%', backgroundColor: dot }} /></div>}
              <div class="progress-sub">
                {active && p.remainingLabel ? `${p.remainingLabel} remaining` : p.status === 'finished' ? 'Print complete' : p.status === 'idle' ? 'Ready' : STATUS[p.status]}
                {active && p.speed ? ` · ${p.speed} speed` : ''}
              </div>
            </div>
          )}
          {p.alerts.map((a, i) => <div key={i} class="printer-alert">{a}</div>)}
          {p.stagePlan ? (
            <Checklist p={p} />
          ) : (
            <div class="stat-row">
              <div class="stat"><div class="stat-label">Layer</div><div class="stat-value">{p.layer ?? '–'}<span> / {p.totalLayers ?? '–'}</span></div></div>
              <div class="stat"><div class="stat-label">Nozzle</div><div class="stat-value">{n.main}<span> {n.sub}</span></div></div>
              <div class="stat"><div class="stat-label">Bed</div><div class="stat-value">{b.main}<span> {b.sub}</span></div></div>
            </div>
          )}
          {p.stagePlan && (
            <div class="heat-row">
              <span>Nozzle <b>{n.main}</b> {n.sub}</span>
              <span>Bed <b>{b.main}</b> {b.sub}</span>
            </div>
          )}
          <ControlRow p={p} />
          {!bill && <div class="details">
            {p.details.map((d) => <span key={d.label} class="detail"><span class="detail-k">{d.label}</span> {d.value}</span>)}
          </div>}
        </div>
      </div>
      {full && <FullCamera p={p} name={state.settings.ownerName} room={room} home={state.settings.location} onClose={() => setFull(false)} />}
    </Sheet>
  );
}
