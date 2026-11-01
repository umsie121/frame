// Weather from Open-Meteo: free, no key, no account, CORS-enabled.
// Plain HTTP on purpose: its HTTPS certificate chains to a 2024 Let's Encrypt root that
// Android 6 doesn't trust. Only rough coordinates are sent; nothing private.

import type { WeatherNow } from '@ff/shared';
import { request } from '../lib/api';

/** WMO weather codes → our condition + Apple-style label. */
function describe(code: number, isDay: boolean): { condition: WeatherNow['condition']; label: string } {
  if (code === 0) return { condition: 'clear', label: isDay ? 'Sunny' : 'Clear' };
  if (code === 1) return { condition: 'partly', label: 'Mostly Clear' };
  if (code === 2) return { condition: 'partly', label: 'Partly Cloudy' };
  if (code === 3) return { condition: 'cloudy', label: 'Cloudy' };
  if (code === 45 || code === 48) return { condition: 'fog', label: 'Fog' };
  if (code >= 51 && code <= 57) return { condition: 'rain', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { condition: 'rain', label: code >= 65 ? 'Heavy Rain' : 'Rain' };
  if (code >= 71 && code <= 77) return { condition: 'snow', label: 'Snow' };
  if (code >= 80 && code <= 82) return { condition: 'rain', label: 'Showers' };
  if (code >= 85 && code <= 86) return { condition: 'snow', label: 'Snow Showers' };
  if (code >= 95) return { condition: 'storm', label: 'Thunderstorms' };
  return { condition: 'cloudy', label: 'Cloudy' };
}

interface OpenMeteo {
  current: { temperature_2m: number; weather_code: number; is_day: number };
  hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: number[]; is_day: number[] };
  daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; sunrise: string[]; sunset: string[] };
}

export async function fetchWeather(lat: number, lng: number): Promise<WeatherNow> {
  const url =
    `http://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    '&current=temperature_2m,weather_code,is_day' +
    '&hourly=temperature_2m,weather_code,precipitation_probability,is_day&forecast_hours=24' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&forecast_days=6&timezone=auto';
  const j = await request<OpenMeteo>('GET', url, undefined, 20000, false);
  const now = describe(j.current.weather_code, j.current.is_day === 1);
  return {
    tempC: j.current.temperature_2m,
    condition: now.condition,
    label: now.label,
    highC: j.daily.temperature_2m_max[0]!,
    lowC: j.daily.temperature_2m_min[0]!,
    hourly: j.hourly.time.slice(0, 12).map((t, i) => ({
      hour: Number(t.slice(11, 13)),
      tempC: j.hourly.temperature_2m[i]!,
      condition: describe(j.hourly.weather_code[i]!, true).condition,
      night: j.hourly.is_day[i] === 0,
      rainPct: j.hourly.precipitation_probability[i] ?? 0,
    })),
    daily: j.daily.time.map((d, i) => ({
      date: d,
      condition: describe(j.daily.weather_code[i]!, true).condition,
      label: describe(j.daily.weather_code[i]!, true).label,
      highC: j.daily.temperature_2m_max[i]!,
      lowC: j.daily.temperature_2m_min[i]!,
    })),
    updatedAt: new Date().toISOString(),
  };
}
