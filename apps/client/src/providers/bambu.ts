// Bambu Lab A1 status, read from the frame's own read-only MQTT bridge (android/BambuBridge.java).
// Field names follow the printer's report format (OpenBambuAPI / ha-bambulab). Nothing here controls the printer.

import type { AmsSlot, PrinterState, PrinterStatus } from '@ff/shared';
import { request } from '../lib/api';

interface BridgeStatus {
  configured: boolean;
  connected: boolean;
  updatedAt: number;
  error: string | null;
  print: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  lastPhoto: { job: string | null; at: number } | null;
  preview: { task: string; job: string | null } | null;
}

const STATE: Record<string, PrinterStatus> = {
  IDLE: 'idle', RUNNING: 'printing', PREPARE: 'printing', SLICING: 'printing',
  PAUSE: 'paused', FINISH: 'finished', FAILED: 'error',
};

/** stg / stg_cur codes → words (from ha-bambulab's CURRENT_STAGE list). */
const STAGES: Record<number, string> = {
  0: 'Printing', 1: 'Auto bed levelling', 2: 'Heating the bed', 3: 'Sweeping motors', 4: 'Changing filament',
  5: 'Paused', 6: 'Paused: filament ran out', 7: 'Heating the nozzle', 8: 'Calibrating extrusion',
  9: 'Scanning the bed', 10: 'Inspecting first layer', 11: 'Identifying build plate', 12: 'Calibrating lidar',
  13: 'Homing the toolhead', 14: 'Cleaning the nozzle', 15: 'Checking nozzle temperature', 16: 'Paused',
  17: 'Paused: front cover fell', 18: 'Calibrating lidar', 19: 'Calibrating flow', 20: 'Paused: nozzle temperature fault',
  21: 'Paused: bed temperature fault', 22: 'Unloading filament', 23: 'Paused: skipped step', 24: 'Loading filament',
  25: 'Calibrating motor noise', 26: 'Paused: AMS lost', 27: 'Paused: heatbreak fan too slow', 29: 'Cooling down',
  30: 'Paused by G-code', 31: 'Motor noise check', 32: 'Paused: nozzle covered', 33: 'Paused: cutter error',
  34: 'Paused: first layer problem', 35: 'Paused: nozzle clog',
};
const SPEED: Record<number, string> = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };

const hex = (rrggbbaa: string | undefined) => (rrggbbaa && rrggbbaa.length >= 6 ? '#' + rrggbbaa.slice(0, 6) : null);
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : null);

function remainingLabel(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

/** HMS "health" entries → a readable line with Bambu's code (look-ups at wiki.bambulab.com, HMS codes). */
function hmsLine(h: { attr: number; code: number }): string {
  const pad = (n: number) => ('00000000' + (n >>> 0).toString(16).toUpperCase()).slice(-8);
  const full = pad(h.attr) + pad(h.code);
  return 'Printer message ' + full.slice(0, 4) + '-' + full.slice(4, 8) + '-' + full.slice(8, 12) + '-' + full.slice(12, 16);
}

/** The only two controls the frame may send (whitelisted again on the frame): light on/off, speed 1–4. */
export function controlPrinter(action: 'light' | 'speed', value: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('POST', '/api/printer/control', { action, value });
}

export async function fetchPrinter(): Promise<PrinterState | null> {
  const s = await request<BridgeStatus>('GET', '/api/printer');
  if (!s.configured) return null;
  const p = s.print || {};
  const status: PrinterStatus = !s.connected ? 'offline' : STATE[String(p.gcode_state)] || 'idle';
  const busy = status === 'printing' || status === 'paused';
  const ams0 = p.ams && p.ams.ams && p.ams.ams[0] ? p.ams.ams[0] : null;
  const trayNow = String(p.ams && p.ams.tray_now !== undefined ? p.ams.tray_now : '');
  // ams_mapping: per filament in the job → tray index (ams_id*4 + slot), 254 = external, -1 = unused.
  const mapping: number[] = Array.isArray(p.ams_mapping) ? p.ams_mapping : [];
  const trays: Array<Record<string, any>> = ams0 ? ams0.tray || [] : []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const range = (t: Record<string, any>) => (t.nozzle_temp_min && t.nozzle_temp_max ? `${t.nozzle_temp_min}–${t.nozzle_temp_max}°` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const ams: AmsSlot[] = [0, 1, 2, 3].map((i) => {
    const t = trays.filter((x) => String(x.id) === String(i))[0];
    const loaded = !!(t && t.tray_type);
    return {
      slot: i + 1,
      material: loaded ? t!.tray_type : null,
      color: loaded ? hex(t!.tray_color) : null,
      name: loaded ? t!.tray_sub_brands || t!.tray_type : null,
      remainingPct: null, // not shown: only meaningful for tracked Bambu RFID spools
      active: trayNow === String(i),
      inJob: busy && mapping.indexOf(i) >= 0,
      tempRange: loaded ? range(t!) : null,
    };
  });
  const vt = p.vt_tray;
  const external: AmsSlot | null = vt && vt.tray_type ? {
    slot: 0, material: vt.tray_type, color: hex(vt.tray_color), name: vt.tray_sub_brands || vt.tray_type,
    remainingPct: null, active: trayNow === '254', inJob: busy && mapping.indexOf(254) >= 0, tempRange: range(vt),
  } : null;

  // Stage + preparation checklist (stg = planned prep steps, stg_cur = current step).
  const cur = num(p.stg_cur);
  const plan: number[] = Array.isArray(p.stg) ? p.stg : [];
  const curIdx = cur !== null ? plan.indexOf(cur) : -1;
  const preparing = busy && cur !== null && cur !== 0 && cur !== 255 && cur !== -1 && plan.length > 0;
  const stagePlan = preparing
    ? plan.map((code, i) => ({ code, label: STAGES[code] || 'Step ' + code, state: (curIdx < 0 ? 'todo' : i < curIdx ? 'done' : i === curIdx ? 'now' : 'todo') as 'done' | 'now' | 'todo' }))
    : null;
  const stage = !busy ? null : preparing ? STAGES[cur!] || 'Getting ready' : status === 'paused' ? 'Paused' : 'Printing';

  const alerts: string[] = [];
  if (Array.isArray(p.hms)) p.hms.forEach((h: { attr: number; code: number }) => alerts.push(hmsLine(h)));
  const err = num(p.print_error);
  if (err && err !== 0) alerts.push('Print error ' + (err >>> 0).toString(16).toUpperCase());

  const details: { label: string; value: string }[] = [];
  if (p.nozzle_diameter) details.push({ label: 'Nozzle', value: `${p.nozzle_diameter} mm${p.nozzle_type === 'stainless_steel' ? ' steel' : p.nozzle_type ? ' ' + String(p.nozzle_type).replace(/_/g, ' ') : ''}` });
  if (p.wifi_signal) {
    const dbm = parseInt(String(p.wifi_signal), 10);
    details.push({ label: 'Wi‑Fi', value: dbm >= -60 ? 'Strong' : dbm >= -70 ? 'Good' : 'Weak' });
  }
  const light = Array.isArray(p.lights_report) ? p.lights_report.filter((l: { node: string }) => l.node === 'chamber_light')[0] : null;
  if (p.ipcam) details.push({ label: 'Timelapse', value: p.ipcam.timelapse === 'enable' ? 'On' : 'Off' });
  if (p.layer_inspect !== undefined) details.push({ label: 'First-layer check', value: p.layer_inspect ? 'On' : 'Off' });
  if (p.print_type && p.print_type !== 'idle') details.push({ label: 'Sent from', value: p.print_type === 'cloud' ? 'Bambu cloud' : p.print_type === 'local' ? 'Home network' : String(p.print_type) });

  // Fans report a 0–15 "gear"; show it as a rounded percentage like Bambu Handy does.
  const fan = (v: unknown) => (num(v) !== null ? Math.round((num(v)! / 15) * 10) * 10 : null);
  const nozzle = details.filter((d) => d.label === 'Nozzle')[0];
  const source = details.filter((d) => d.label === 'Sent from')[0];
  const telemetry = {
    partFanPct: fan(p.cooling_fan_speed),
    auxFanPct: fan(p.big_fan1_speed),
    heatbreakFanPct: fan(p.heatbreak_fan_speed),
    speedPct: num(p.spd_mag),
    wifiDbm: p.wifi_signal ? parseInt(String(p.wifi_signal), 10) : null,
    light: light ? light.mode === 'on' : null,
    recording: p.ipcam ? p.ipcam.ipcam_record === 'enable' : null,
    timelapse: p.ipcam ? p.ipcam.timelapse === 'enable' : null,
    flowK: num(p.k),
    nozzle: nozzle ? nozzle.value : null,
    source: source ? source.value : null,
  };

  const rem = num(p.mc_remaining_time);
  const round = (v: unknown) => (num(v) !== null ? Math.round(num(v)!) : null);
  return {
    provider: 'Bambu Lab (LAN)',
    model: 'A1',
    status,
    jobName: p.subtask_name || null,
    progressPct: num(p.mc_percent),
    remainingMin: rem,
    remainingLabel: rem !== null ? remainingLabel(rem) : null,
    layer: num(p.layer_num),
    totalLayers: num(p.total_layer_num),
    nozzleTemp: round(p.nozzle_temper),
    nozzleTarget: round(p.nozzle_target_temper),
    bedTemp: round(p.bed_temper),
    bedTarget: round(p.bed_target_temper),
    errorMessage: alerts.length ? alerts[0]! : !s.connected && s.error ? `Not connected (${s.error})` : null,
    ams,
    external,
    stage,
    stagePlan,
    speed: num(p.spd_lvl) !== null ? SPEED[num(p.spd_lvl)!] || null : null,
    speedLevel: num(p.spd_lvl),
    alerts,
    details,
    preview: s.preview || null,
    lastPhoto: s.lastPhoto || null,
    telemetry,
    raw: p,
    updatedAt: new Date(s.updatedAt || Date.now()).toISOString(),
  };
}
