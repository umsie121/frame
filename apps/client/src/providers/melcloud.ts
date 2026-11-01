// Mitsubishi Electric MELCloud (air-to-air units). MELCloud has no public developer docs; this follows the
// same endpoints the official app and Home Assistant's integration use. Runs on the frame: Android 6
// trusts MELCloud's certificate (USERTrust root) and the API allows cross-origin calls.
//
// Only the session key ("ContextKey") is stored on the frame (kv "melcloud"); the password is typed on
// the frame once and never saved.

import { request } from '../lib/api';

const BASE = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';

export type AcMode = 'heat' | 'dry' | 'cool' | 'fan' | 'auto';
const MODE_CODE: Record<AcMode, number> = { heat: 1, dry: 2, cool: 3, fan: 7, auto: 8 };
const CODE_MODE: Record<number, AcMode> = { 1: 'heat', 2: 'dry', 3: 'cool', 7: 'fan', 8: 'auto' };

// EffectiveFlags tell MELCloud which fields a SetAta call changes.
const FLAG = { power: 0x01, mode: 0x02, temp: 0x04, fan: 0x08, vaneV: 0x10, vaneH: 0x100 };

export interface AcUnit {
  id: number;
  buildingId: number;
  name: string;
  power: boolean;
  mode: AcMode;
  setTemp: number;
  roomTemp: number | null;
  fan: number; // 0 = auto, 1..fanSteps
  fanSteps: number;
  /** Up/down louvre: 0 auto, 1 (level, throws far) … 5 (pointing down), 7 swing. */
  vaneV: number;
  /** Left/right: 0 auto, 1 (far left) … 5 (far right), 8 split, 12 swing. */
  vaneH: number;
  minTemp: number;
  maxTemp: number;
  offline: boolean;
}

interface RawState {
  Power: boolean;
  OperationMode: number;
  SetTemperature: number;
  RoomTemperature: number;
  SetFanSpeed: number;
  NumberOfFanSpeeds: number;
  VaneVertical: number;
  VaneHorizontal: number;
  Offline: boolean;
  EffectiveFlags: number;
  HasPendingCommand: boolean;
  [k: string]: unknown;
}

function call<T>(method: string, path: string, key: string | null, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, BASE + path);
    xhr.timeout = 20000;
    xhr.setRequestHeader('Accept', 'application/json');
    if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    if (key) xhr.setRequestHeader('X-MitsContextKey', key);
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new Error('signed-out'));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('MELCloud HTTP ' + xhr.status));
      try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send(body === undefined ? null : JSON.stringify(body));
  });
}

export async function login(email: string, password: string): Promise<string> {
  const r = await call<{ ErrorId: number | null; LoginData: { ContextKey: string } | null }>('POST', '/Login/ClientLogin', null, {
    Email: email, Password: password, Language: 0, AppVersion: '1.34.12.0', Persist: true, CaptchaResponse: null,
  });
  if (r.ErrorId !== null || !r.LoginData) throw new Error(r.ErrorId === 1 ? 'Wrong email or password' : 'Sign-in failed');
  return r.LoginData.ContextKey;
}

interface RawDevice { DeviceID: number; DeviceName: string; BuildingID: number; Device: { DeviceType: number } }
interface RawBuilding { ID: number; Structure: { Devices: RawDevice[]; Floors: { Devices: RawDevice[]; Areas: { Devices: RawDevice[] }[] }[]; Areas: { Devices: RawDevice[] }[] } }

function toUnit(d: { id: number; buildingId: number; name: string }, s: RawState): AcUnit {
  return {
    id: d.id,
    buildingId: d.buildingId,
    name: d.name,
    power: s.Power,
    mode: CODE_MODE[s.OperationMode] || 'auto',
    setTemp: s.SetTemperature,
    roomTemp: typeof s.RoomTemperature === 'number' ? s.RoomTemperature : null,
    fan: s.SetFanSpeed || 0,
    fanSteps: s.NumberOfFanSpeeds || 5,
    vaneV: typeof s.VaneVertical === 'number' ? s.VaneVertical : 0,
    vaneH: typeof s.VaneHorizontal === 'number' ? s.VaneHorizontal : 0,
    minTemp: 16,
    maxTemp: 31,
    offline: !!s.Offline,
  };
}

/** All air-to-air units across buildings, floors and areas, with fresh state. */
export async function listUnits(key: string): Promise<AcUnit[]> {
  const buildings = await call<RawBuilding[]>('GET', '/User/ListDevices', key);
  const found: { id: number; buildingId: number; name: string }[] = [];
  const add = (list: RawDevice[] | undefined) =>
    (list || []).forEach((d) => { if (d.Device && d.Device.DeviceType === 0) found.push({ id: d.DeviceID, buildingId: d.BuildingID, name: d.DeviceName }); });
  buildings.forEach((b) => {
    add(b.Structure.Devices);
    (b.Structure.Areas || []).forEach((a) => add(a.Devices));
    (b.Structure.Floors || []).forEach((f) => { add(f.Devices); (f.Areas || []).forEach((a) => add(a.Devices)); });
  });
  const states = await Promise.all(found.map((d) => call<RawState>('GET', `/Device/Get?id=${d.id}&buildingID=${d.buildingId}`, key)));
  return found.map((d, i) => toUnit(d, states[i]!));
}

export interface AcChange { power?: boolean; mode?: AcMode; setTemp?: number; fan?: number; vaneV?: number; vaneH?: number }

export async function setUnit(key: string, unit: AcUnit, change: AcChange): Promise<AcUnit> {
  const s = await call<RawState>('GET', `/Device/Get?id=${unit.id}&buildingID=${unit.buildingId}`, key);
  let flags = 0;
  if (change.power !== undefined) { s.Power = change.power; flags |= FLAG.power; }
  if (change.mode !== undefined) { s.OperationMode = MODE_CODE[change.mode]; flags |= FLAG.mode; }
  if (change.setTemp !== undefined) { s.SetTemperature = change.setTemp; flags |= FLAG.temp; }
  if (change.fan !== undefined) { s.SetFanSpeed = change.fan; flags |= FLAG.fan; }
  if (change.vaneV !== undefined) { s.VaneVertical = change.vaneV; flags |= FLAG.vaneV; }
  if (change.vaneH !== undefined) { s.VaneHorizontal = change.vaneH; flags |= FLAG.vaneH; }
  s.EffectiveFlags = flags;
  s.HasPendingCommand = true;
  const r = await call<RawState>('POST', '/Device/SetAta', key, s);
  return toUnit({ id: unit.id, buildingId: unit.buildingId, name: unit.name }, r);
}

export const loadKey = () => request<{ contextKey: string }>('GET', '/api/kv/melcloud').then((v) => v.contextKey).catch(() => null);
export const saveKey = (contextKey: string | null) => request('PUT', '/api/kv/melcloud', { contextKey: contextKey || '' });
