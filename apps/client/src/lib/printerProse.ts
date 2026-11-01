// The printer as one enormous paragraph: everything it reports, plus everything that can be worked out from it, in
// words, like a word clock that won't stop talking. Grouped into zones so the screen can give each its own fixed
// place: a changing word only ever moves text inside its own zone. Numbers are deliberately rounded and held steady.

import type { FrameState, PrinterState } from '@ff/shared';
import type { AcState } from './store';
import type { NowPlaying } from '../providers/spotify';
import { currentPrint, printHistory } from './printLog';
import { historyTotals } from './printHistory';
import { printerFact } from './printerFacts';
import { prepBill } from './printPrep';

export interface Seg { t: string; c?: string }
export type Sentence = Seg[];
export type ZoneId = 'now' | 'progress' | 'pace' | 'heat' | 'air' | 'filament' | 'checks' | 'net' | 'past' | 'world' | 'end';
export type Zones = Record<ZoneId, Sentence[]>;

const HOT = '#ff9f0a', COOL = '#64d2ff', GOOD = '#30d158', TIME = '#ffd60a', NAME = '#ff6b9d', INFO = '#bf9dff', BAD = '#ff453a';

const ONES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
const ORD: Record<string, string> = { ONE: 'FIRST', TWO: 'SECOND', THREE: 'THIRD', FIVE: 'FIFTH', EIGHT: 'EIGHTH', NINE: 'NINTH', TWELVE: 'TWELFTH', TWENTY: 'TWENTIETH', THIRTY: 'THIRTIETH' };

/** 68 → "SIXTY-EIGHT". Up to the thousands; a phrase is the whole point here. */
export function words(n: number): string {
  n = Math.round(n);
  if (n < 0) return 'MINUS ' + words(-n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? '-' + ONES[n % 10]! : '');
  if (n < 1000) return ONES[Math.floor(n / 100)]! + ' HUNDRED' + (n % 100 ? ' AND ' + words(n % 100) : '');
  if (n < 1000000) return words(Math.floor(n / 1000)) + ' THOUSAND' + (n % 1000 ? (n % 1000 < 100 ? ' AND ' : ' ') + words(n % 1000) : '');
  return String(n);
}

function ordinal(n: number): string {
  const w = words(n);
  const i = w.lastIndexOf('-');
  const tail = i >= 0 ? w.slice(i + 1) : w;
  const o = ORD[tail] || tail + 'TH';
  return i >= 0 ? w.slice(0, i + 1) + o : o;
}

/** "TWENTY-THREE MINUTES PAST THREE", "QUARTER TO FOUR", "THREE O'CLOCK". */
export function clockWords(d: Date): string {
  const m = d.getMinutes();
  const h = d.getHours();
  const name = (x: number) => { const v = x % 12; return v === 0 ? (x % 24 === 0 ? 'MIDNIGHT' : 'TWELVE') : ONES[v]!; };
  if (m === 0) return name(h) === 'MIDNIGHT' ? 'MIDNIGHT' : name(h) + " O'CLOCK";
  if (m === 15) return 'QUARTER PAST ' + name(h);
  if (m === 30) return 'HALF PAST ' + name(h);
  if (m === 45) return 'QUARTER TO ' + name(h + 1);
  const mins = (x: number) => words(x) + (x === 1 ? ' MINUTE' : ' MINUTES');
  return m < 30 ? mins(m) + ' PAST ' + name(h) : mins(60 - m) + ' TO ' + name(h + 1);
}

/** 83 → "ONE HOUR AND TWENTY-THREE MINUTES". */
function duration(mins: number): string {
  mins = Math.max(0, Math.round(mins));
  if (mins < 1) return 'LESS THAN A MINUTE';
  const h = Math.floor(mins / 60), m = mins % 60;
  const hs = h ? words(h) + (h === 1 ? ' HOUR' : ' HOURS') : '';
  const ms = m ? words(m) + (m === 1 ? ' MINUTE' : ' MINUTES') : '';
  return hs && ms ? hs + ' AND ' + ms : hs || ms;
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const COLOURS: [string, number, number, number][] = [
  ['BLACK', 25, 25, 25], ['WHITE', 240, 240, 240], ['GREY', 130, 130, 130], ['RED', 210, 40, 40], ['ORANGE', 240, 130, 30], ['YELLOW', 240, 210, 50],
  ['GREEN', 50, 170, 80], ['TEAL', 40, 160, 160], ['BLUE', 40, 90, 210], ['SKY BLUE', 110, 180, 230], ['PURPLE', 130, 60, 190], ['PINK', 240, 130, 180], ['BROWN', 130, 80, 40], ['BEIGE', 220, 195, 160],
];
function rgb(hex: string): number[] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function colourName(hex: string | null): string {
  if (!hex) return 'MYSTERY-COLOURED';
  const c = rgb(hex);
  let best = 'MYSTERY-COLOURED', dist = Infinity;
  COLOURS.forEach(([n, r, g, b]) => {
    const d = (c[0]! - r) ** 2 + (c[1]! - g) ** 2 + (c[2]! - b) ** 2;
    if (d < dist) { dist = d; best = n; }
  });
  return best;
}
/** Filament colour you can read on black: dark ones are lifted just enough. */
function readable(hex: string | null): string {
  if (!hex) return '#ffffff';
  const c = rgb(hex);
  const lum = (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) / 255;
  if (lum >= 0.4) return hex;
  const t = (0.4 - lum) / (1 - lum);
  return 'rgb(' + c.map((v) => Math.round(v + (255 - v) * t)).join(',') + ')';
}

const fanWord = (v: number | null) => (v === null ? 'NOT SAYING' : v === 0 ? 'RESTING' : 'AT ' + words(v) + ' PERCENT');
const yesNo = (v: unknown) => (v ? 'ON' : 'OFF');
const clean = (s: string) => s.replace(/_/g, ' ').toUpperCase();
const STATUS: Record<string, string> = { printing: 'PRINTING', paused: 'PAUSED', idle: 'IDLE AND WAITING', finished: 'FINISHED', error: 'ASKING FOR HELP', offline: 'SWITCHED OFF' };

export interface ProseInput { p: PrinterState; state: FrameState; ac: AcState; music: NowPlaying | null; now: Date }

export function buildProse({ p, state, ac, music, now }: ProseInput): Zones {
  const zones: Zones = { now: [], progress: [], pace: [], heat: [], air: [], filament: [], checks: [], net: [], past: [], world: [], end: [] };
  let out = zones.now;
  const zone = (z: ZoneId) => { out = zones[z]; };
  const say = (...parts: (string | Seg | null | false | undefined)[]) => {
    const s: Sentence = [];
    parts.forEach((x) => { if (x) s.push(typeof x === 'string' ? { t: x } : x); });
    out.push(s);
  };
  const hot = (t: string): Seg => ({ t, c: HOT });
  const cool = (t: string): Seg => ({ t, c: COOL });
  const good = (t: string): Seg => ({ t, c: GOOD });
  const time = (t: string): Seg => ({ t, c: TIME });
  const name = (t: string): Seg => ({ t, c: NAME });
  const info = (t: string): Seg => ({ t, c: INFO });
  const raw: Record<string, any> = p.raw || {};
  const busy = p.status === 'printing' || p.status === 'paused';
  const place = state.settings.location ? state.settings.location.label.toUpperCase() : 'THIS HOUSE';

  say('IT IS ', time(clockWords(now)), ' ON ', time(DAYS[now.getDay()]! + ' THE ' + ordinal(now.getDate()) + ' OF ' + MONTHS[now.getMonth()]!), ' IN ', info(place), ' AND THE BAMBU LAB A1 IS ', good(STATUS[p.status] || p.status.toUpperCase()), '.');

  const bill = prepBill(p, now.getTime());
  if (bill) {
    const step = bill.items[bill.stepNo - 1];
    say('IT HAS NOT PUT DOWN ANY PLASTIC YET. IT IS ON STEP ', good(words(bill.stepNo)), ' OF ', good(words(bill.items.length)), ' OF ITS WARM-UP, ', hot(step ? step.label.toUpperCase() : 'GETTING READY'), ', WITH ROUGHLY ', time(duration(bill.leftMs / 60000)), ' TO GO BEFORE THE PRINT BEGINS.');
    say('THE ROUTINE IS: ', ...bill.items.map((i, k) => ({ t: i.label.toUpperCase() + (i.state === 'done' ? ' (DONE)' : i.state === 'now' ? ' (HAPPENING NOW)' : ' (STILL TO COME)') + (k < bill.items.length - 1 ? ', ' : '.'), c: i.state === 'now' ? HOT : i.state === 'done' ? GOOD : undefined })));
  }

  if (busy || p.jobName) {
    say(busy ? 'THE JOB IS CALLED ' : 'THE LAST JOB WAS CALLED ', name(clean(p.jobName || (p.lastPhoto && p.lastPhoto.job) || 'NOTHING AT ALL')),
      raw.plate_idx ? ', PLATE ' : '', raw.plate_idx ? info(words(Number(raw.plate_idx))) : '',
      p.telemetry.source ? ', SENT FROM ' : '', p.telemetry.source ? info(p.telemetry.source.toUpperCase()) : '',
      raw.design_id ? ', DESIGN NUMBER ' : '', raw.design_id ? info(String(raw.design_id)) : '', '.');
  }

  zone('progress');
  if (busy && p.progressPct !== null) {
    const pct = p.progressPct;
    say('IT IS ', good(words(pct) + ' PERCENT'), ' OF THE WAY THROUGH WITH ', good(words(100 - pct) + ' PERCENT'), ' TO GO',
      p.layer !== null && p.totalLayers ? ', ON LAYER ' : '', p.layer !== null && p.totalLayers ? good(words(p.layer)) : '', p.layer !== null && p.totalLayers ? ' OF ' : '', p.layer !== null && p.totalLayers ? good(words(p.totalLayers)) : '',
      p.layer !== null && p.totalLayers ? ', LEAVING ' : '', p.layer !== null && p.totalLayers ? good(words(Math.max(0, p.totalLayers - p.layer))) : '', p.layer !== null && p.totalLayers ? ' MORE TO LAY DOWN' : '', '.');
  }

  const cur = currentPrint();
  if (busy && p.remainingMin !== null) {
    const ends = new Date(now.getTime() + p.remainingMin * 60000);
    say(time(duration(p.remainingMin)), p.remainingMin === 1 ? ' REMAINS' : ' REMAIN', ', SO IT SHOULD BE DONE AT ', time(clockWords(ends)), '.');
    zone('pace');
    if (p.remainingMin >= 4) say('THAT IS TIME FOR ', info(words(p.remainingMin / 3.5) + (p.remainingMin < 6 ? ' POP SONG' : ' POP SONGS')), ', OR ', info(words(p.remainingMin / 3) + (p.remainingMin < 5 ? ' KETTLE' : ' KETTLES')), ' BOILED ONE AFTER ANOTHER, OR ', info(words(Math.round((p.remainingMin * 72) / 100) * 100) + ' HEARTBEATS'), '.');
    if (cur && cur.start) {
      const ran = (now.getTime() - cur.start) / 60000;
      say('IT STARTED AT ', time(clockWords(new Date(cur.start))), ' AND HAS BEEN GOING FOR ', time(duration(ran)), '.');
      if (p.layer && p.layer > 1) {
        const sec = (ran * 60) / p.layer;
        say('THAT IS ONE LAYER EVERY ', hot(words(Math.round(sec / 5) * 5) + ' SECONDS'), ', OR ROUGHLY ', hot(words(Math.round((p.layer / ran) * 60 / 10) * 10) + ' LAYERS AN HOUR'), '.');
      }
      if (p.progressPct) say('EACH PERCENT IS TAKING ABOUT ', hot(words(Math.round((ran * 60) / p.progressPct / 5) * 5) + ' SECONDS'), '.');
    }
  }

  zone('pace');
  const lh = /([\d.]+)\s*mm layer/i.exec(p.jobName || '');
  if (busy && lh && p.layer) {
    const h = Number(lh[1]);
    const mm = p.layer * h;
    say('EACH LAYER IS ', info(h + ' MM'), ' THICK, SO THE MODEL IS NOW ABOUT ', good(mm.toFixed(1) + ' MM'), ' TALL, ',
      p.totalLayers ? 'HEADING FOR ' : '', p.totalLayers ? good((p.totalLayers * h).toFixed(1) + ' MM') : '', p.totalLayers ? ', ' : '', 'THE HEIGHT OF ', info(words(Math.max(1, Math.round(mm / 3.15))) + ' POUND COINS'), ' IN A STACK.');
  }

  // At temperature the reading wobbles a degree or two: say the target, so the words stay put.
  const steady = (v: number, target: number | null) => (target && Math.abs(v - target) <= 2 ? target : v);
  zone('heat');
  if (p.nozzleTemp !== null) {
    const held = p.nozzleTarget && Math.abs(p.nozzleTemp - p.nozzleTarget) <= 2;
    const nozzleT = steady(p.nozzleTemp, p.nozzleTarget);
    say('THE NOZZLE IS AT ', hot(words(nozzleT) + ' DEGREES'), p.nozzleTarget ? ', AIMING FOR ' : ' WITH NOTHING TO AIM FOR', p.nozzleTarget ? hot(words(p.nozzleTarget)) : '', held ? ' AND HOLDING' : '',
      nozzleT > 100 ? ', THAT IS ' : '', nozzleT > 100 ? hot(words(nozzleT - 100) + ' DEGREES') : '', nozzleT > 100 ? ' HOTTER THAN BOILING WATER' : '', '.');
  }
  if (p.bedTemp !== null) {
    const bedT = steady(p.bedTemp, p.bedTarget);
    say('THE BED IS AT ', hot(words(bedT) + ' DEGREES'), p.bedTarget ? ', AIMING FOR ' : '', p.bedTarget ? hot(words(p.bedTarget)) : '', state.weather ? ', ' : '', state.weather ? hot(words(Math.abs(bedT - Math.round(state.weather.tempC))) + ' DEGREES ' + (bedT >= state.weather.tempC ? 'WARMER' : 'COLDER')) : '', state.weather ? ' THAN OUTSIDE' : '', '.');
  }

  zone('air');
  const t = p.telemetry;
  say('THE PART FAN IS ', cool(fanWord(t.partFanPct)), ', THE AUXILIARY FAN IS ', cool(fanWord(t.auxFanPct)), ' AND THE HEATBREAK FAN IS ', cool(fanWord(t.heatbreakFanPct)), '.');
  if (p.speed) say('SPEED IS SET TO ', good(p.speed.toUpperCase()), t.speedPct !== null ? ', ' : '', t.speedPct !== null ? good(words(t.speedPct) + ' PERCENT') : '', t.speedPct !== null ? ' OF NORMAL' : '', '.');
  if (t.nozzle || t.flowK !== null) say(t.nozzle ? 'THE NOZZLE IS ' : '', t.nozzle ? info(t.nozzle.toUpperCase()) : '', t.nozzle && t.flowK !== null ? ' AND ' : '', t.flowK !== null ? 'THE PRESSURE ADVANCE FACTOR IS ' : '', t.flowK !== null ? info(String(t.flowK)) : '', '.');

  zone('filament');
  const inUse = p.ams.filter((s) => s.material);
  inUse.forEach((s) => {
    const col = readable(s.color);
    say('SLOT ', info(words(s.slot)), ' HOLDS ', { t: colourName(s.color) + ' ' + (s.name || s.material || '').toUpperCase(), c: col },
      s.remainingPct !== null && s.remainingPct >= 0 ? ' WITH ' : '', s.remainingPct !== null && s.remainingPct >= 0 ? { t: words(s.remainingPct) + ' PERCENT', c: col } : '', s.remainingPct !== null && s.remainingPct >= 0 ? ' LEFT' : '',
      s.tempRange ? ', HAPPY AT ' : '', s.tempRange ? { t: s.tempRange.replace('–', ' TO ').replace('°', ' DEGREES'), c: col } : '',
      s.active ? ', AND ' : s.inJob ? ', AND IS PART OF THIS PRINT' : busy ? ', AND IS SITTING THIS ONE OUT' : '', s.active ? good('IS FEEDING RIGHT NOW') : '', '.');
  });
  const box = raw.ams && raw.ams.ams && raw.ams.ams[0];
  if (box && box.humidity) say('THE AMS REPORTS HUMIDITY LEVEL ', cool(words(Number(box.humidity))), ' OF FIVE, WHERE ONE IS DAMP AND FIVE IS DRY.');

  if (busy && inUse.filter((s) => s.inJob).length > 1) say('THIS PRINT USES ', good(words(inUse.filter((s) => s.inJob).length) + ' COLOURS'), ' AND SWAPS BETWEEN THEM THROUGH THE AMS.');

  zone('checks');
  say('BED LEVELLING IS ', info(yesNo(raw.bed_leveling)), ', FLOW CALIBRATION ', info(yesNo(raw.flow_cali)), ', VIBRATION CALIBRATION ', info(yesNo(raw.vibration_cali)), ', FIRST-LAYER INSPECTION ', info(yesNo(raw.layer_inspect)), ', TIMELAPSE ', info(yesNo(t.timelapse)), ', THE CAMERA RECORDING ', info(yesNo(t.recording)), raw.ipcam && raw.ipcam.resolution ? ' AT ' : '', raw.ipcam && raw.ipcam.resolution ? info(String(raw.ipcam.resolution).toUpperCase()) : '', ' AND THE CHAMBER LIGHT ', info(yesNo(t.light)), '.');

  say('THE MEMORY CARD IS ', info(raw.sdcard ? 'IN' : 'OUT'), ' AND THE QUEUE ', raw.queue_total ? 'HOLDS ' : 'IS ', info(raw.queue_total ? words(Number(raw.queue_total)) + ' JOBS' : 'EMPTY'), '.');

  zone('net');
  if (t.wifiDbm !== null) {
    const dbm = Math.round(t.wifiDbm / 5) * 5;
    say('ITS WI-FI SIGNAL IS ABOUT ', cool(words(dbm) + ' DECIBEL-MILLIWATTS'), ', WHICH IS ', cool(dbm >= -60 ? 'STRONG' : dbm >= -70 ? 'PERFECTLY GOOD' : 'A BIT WEAK'), '.');
  }

  if (p.alerts.length) say('IT HAS ', { t: words(p.alerts.length) + (p.alerts.length === 1 ? ' HEALTH WARNING: ' : ' HEALTH WARNINGS: ') + p.alerts.join('; ').toUpperCase(), c: BAD }, '.');
  else say('IT HAS ', good('NO HEALTH WARNINGS'), ' AND ', good('NO ERRORS'), ' TO REPORT.');

  zone('past');
  const totals = historyTotals();
  if (totals) say('SINCE ', time(new Date(totals.since).getDate() + ' ' + MONTHS[new Date(totals.since).getMonth()]! + ' ' + new Date(totals.since).getFullYear()), ' IT HAS MADE ', good(words(totals.n) + ' DIFFERENT THINGS'), ' IN ', good(words(totals.hours) + ' HOURS'), ' OF PRINTING.');

  const log = printHistory();
  if (log.length) {
    const last = log[log.length - 1]!;
    say('THE FRAME HAS WATCHED ', good(words(log.length) + (log.length === 1 ? ' PRINT' : ' PRINTS')), ' FINISH, MOST RECENTLY ', name(clean(last.job)), last.end && last.start ? ', WHICH TOOK ' : '', last.end && last.start ? time(duration((last.end - last.start) / 60000)) : '', '.');
  }
  const fact = printerFact(p, now);
  if (fact) say(info(fact.toUpperCase()), /[.!?]$/.test(fact) ? '' : '.');

  zone('world');
  const w = state.weather;
  const room = ac.units.length ? ac.units[0]!.roomTemp : null;
  if (w) say('OUTSIDE IN ', info(place), ' IT IS ', cool(words(Math.round(w.tempC)) + ' DEGREES'), ' AND ', cool(w.label.toUpperCase()), room !== null ? ', AND INSIDE IT IS ' : '', room !== null ? cool(words(Math.round(room)) + ' DEGREES') : '', '.');
  if (music && music.playing && music.track) say('MEANWHILE ', name(music.track.title.toUpperCase()), ' BY ', name(music.track.artist.toUpperCase()), ' IS PLAYING', music.device ? ' ON ' : '', music.device ? info(music.device.name.toUpperCase()) : '', '.');
  else say('NOTHING IS PLAYING ON SPOTIFY RIGHT NOW.');
  if (state.prayer) say('THE NEXT PRAYER IS ', info(state.prayer.next.label.toUpperCase()), ' AT ', time(clockWords(new Date(state.prayer.next.time))), '.');

  zone('end');
  say('THAT IS EVERYTHING IT KNOWS. IT WILL HAVE MORE TO SAY IN ', good('THIRTY SECONDS'), '.');
  return zones;
}
