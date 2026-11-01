// The one internal API contract between Frame Hub and Frame Client.
// The frame never talks to external services; it only understands these shapes.
// Keep everything JSON-serialisable and pre-formatted where the frame's old
// Chromium 44 would struggle (Intl, time zones, Hijri dates).

export type ISODateTime = string;

// ---------- Photos ----------

export type PhotoStatus = 'pending' | 'active' | 'archived';
export type PhotoOrientation = 'landscape' | 'portrait' | 'square';
export type PhotoSourceId = 'upload' | 'folder' | 'google' | 'frameo' | 'mock';

export type MediaKind = 'photo' | 'video';

export interface PhotoSummary {
  id: string;
  kind: MediaKind;
  /** Pre-sized image for the frame (max 1280x800, EXIF-rotated, JPEG). For videos: the poster frame. */
  url: string;
  /** Videos only: H.264 MP4 the frame's hardware decoder can play. */
  videoUrl: string | null;
  durationSec: number | null;
  thumbUrl: string;
  width: number; // of the display variant
  height: number;
  orientation: PhotoOrientation;
  /** Focal point 0..1 for object-position when cropping to fill. */
  focalX: number;
  focalY: number;
  /** Flat letterbox colour (hex) sampled from the image. No gradients. */
  bg: string;
  favourite: boolean;
  status: PhotoStatus;
  source: PhotoSourceId;
  sender: string | null;
  takenAt: ISODateTime | null;
  uploadedAt: ISODateTime;
}

export interface Playlist {
  generatedAt: ISODateTime;
  photos: PhotoSummary[];
}

// ---------- Calendar ----------

export interface CalendarEvent {
  id: string;
  title: string;
  start: ISODateTime;
  end: ISODateTime;
  allDay: boolean;
  calendar: string;
  /** Hex colour of the source calendar. */
  color: string;
  location?: string;
  /** Pre-formatted for display, e.g. "4:30 PM" or "All day". */
  timeLabel: string;
  /** "Today", "Tomorrow", "Sat 25 Oct". */
  dayLabel: string;
}

// ---------- Prayer ----------

export type PrayerName = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

export interface PrayerTime {
  name: PrayerName;
  label: string; // "Fajr"
  time: ISODateTime;
  timeLabel: string; // "5:42 AM"
  isSalah: boolean; // false for sunrise
}

export interface PrayerDay {
  date: string; // YYYY-MM-DD local
  hijri: string; // "1 Jumada al-Awwal 1448"
  method: string;
  location: string;
  times: PrayerTime[];
  current: PrayerName | null;
  next: PrayerTime; // may be tomorrow's Fajr
  isJumuah: boolean;
}

// ---------- Smart home ----------

export type DeviceKind =
  | 'light'
  | 'switch'
  | 'thermostat'
  | 'sensor'
  | 'contact'
  | 'lock'
  | 'camera'
  | 'cover';

export interface HomeDevice {
  id: string;
  name: string;
  room: string;
  kind: DeviceKind;
  on?: boolean;
  brightness?: number; // 0..100
  temperature?: number; // current °C
  targetTemperature?: number;
  humidity?: number;
  open?: boolean; // contact / cover
  locked?: boolean;
  /** Security-sensitive devices need a deliberate confirm step on the frame. */
  sensitive: boolean;
  available: boolean;
}

export interface HomeScene {
  id: string;
  name: string;
  icon: 'moon' | 'film' | 'power' | 'stairs' | 'flame' | 'sun';
}

export interface HomeState {
  provider: string;
  rooms: string[];
  devices: HomeDevice[];
  scenes: HomeScene[];
}

export type HomeAction =
  | { type: 'toggle'; deviceId: string }
  | { type: 'setBrightness'; deviceId: string; value: number }
  | { type: 'setTarget'; deviceId: string; value: number }
  | { type: 'scene'; sceneId: string }
  | { type: 'lock'; deviceId: string }
  | { type: 'unlock'; deviceId: string; confirmToken: string };

// ---------- Printer ----------

export type PrinterStatus = 'offline' | 'idle' | 'printing' | 'paused' | 'finished' | 'error';

export interface AmsSlot {
  slot: number; // 1..4
  material: string | null; // "PLA"
  color: string | null; // hex
  name: string | null; // "Bambu PLA Basic"
  remainingPct: number | null;
  active: boolean;
  /** Used by the current job. */
  inJob?: boolean;
  /** e.g. "190–230°" */
  tempRange?: string | null;
}

export interface PrinterState {
  provider: string;
  model: string; // "A1"
  status: PrinterStatus;
  jobName: string | null;
  progressPct: number | null;
  remainingMin: number | null;
  remainingLabel: string | null; // "1h 23m"
  layer: number | null;
  totalLayers: number | null;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  errorMessage: string | null;
  ams: AmsSlot[];
  /** Spool on the A1's external holder (used when no AMS slot is active). */
  external: AmsSlot | null;
  /** What the printer is doing right now, in words ("Heating the bed"). */
  stage: string | null;
  /** Preparation checklist with progress, while the printer gets ready. */
  stagePlan: { code: number; label: string; state: 'done' | 'now' | 'todo' }[] | null;
  speed: string | null; // Silent / Standard / Sport / Ludicrous
  speedLevel: number | null; // 1–4
  alerts: string[]; // human-readable health warnings
  details: { label: string; value: string }[];
  /** Bambu Studio's preview of the model being printed (from the job's 3MF), if fetched. */
  preview: { task: string; job: string | null } | null;
  /** Photo the frame took when the last print finished (job name + epoch ms), if any. */
  lastPhoto: { job: string | null; at: number } | null;
  /** The printer's whole report, for the words view (it reports far more than the fields here). */
  raw?: Record<string, any>;
  /** Extra live readings for the full-screen camera view. */
  telemetry: {
    partFanPct: number | null; // part-cooling fan
    auxFanPct: number | null;
    heatbreakFanPct: number | null;
    speedPct: number | null; // 100 = Standard
    wifiDbm: number | null;
    light: boolean | null;
    recording: boolean | null;
    timelapse: boolean | null;
    flowK: number | null; // pressure-advance factor
    nozzle: string | null; // "0.4 mm steel"
    source: string | null; // "Bambu cloud" / "Home network"
  };
  updatedAt: ISODateTime;
}

// ---------- Weather ----------

export type WeatherCondition = 'clear' | 'partly' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog';

export interface WeatherNow {
  tempC: number;
  condition: WeatherCondition;
  label: string; // "Partly Cloudy"
  highC: number;
  lowC: number;
  hourly: { hour: number; tempC: number; condition: WeatherCondition; rainPct: number; night: boolean }[];
  daily: { date: string; condition: WeatherCondition; label: string; highC: number; lowC: number }[];
  updatedAt: ISODateTime;
}

// ---------- Settings ----------

/** A one-tap climate shortcut. null fields are left as they are. */
export interface AcPreset {
  id: 'cool' | 'heat' | 'night';
  label: string;
  mode: 'heat' | 'dry' | 'cool' | 'fan' | 'auto' | null;
  setTemp: number | null;
  fan: 'max' | 'min' | 'auto' | null;
  /** Vanes to auto (up/down + left/right). */
  vaneAuto: boolean;
  /** After this many minutes (0 = never): 'revert' puts the previous settings back, 'off' turns the unit off. */
  minutes: number;
  after: 'revert' | 'off';
}

export interface FrameSettings {
  /** Home location for prayer times and weather. Set on the frame, never in source code. */
  location: { lat: number; lng: number; label: string } | null;
  prayer: {
    method: string; // adhan CalculationMethod name, e.g. "MoonsightingCommittee"
    madhab: 'shafi' | 'hanafi';
    offsets: Partial<Record<PrayerName, number>>; // minutes, to match a mosque timetable
    hijriAdjust: number; // days
  };
  /** Name used in the greeting ("Good morning, …"). */
  ownerName: string | null;
  /** MELCloud unit names to show (null = all). */
  acUnits: string[] | null;
  /** One-tap climate shortcuts (Climate screen). */
  acPresets: AcPreset[];
  slideSeconds: number;
  order: 'smart' | 'shuffle' | 'newest' | 'oldest';
  fit: 'smart' | 'contain' | 'cover';
  pairPortraits: boolean;
  clock24h: boolean;
  idleReturnSeconds: number;
  overlays: {
    clock: boolean;
    prayer: boolean;
    calendar: boolean;
    printer: boolean;
    weather: boolean;
  };
  night: {
    enabled: boolean;
    start: string; // "22:30"
    end: string; // "06:30"
    brightness: number; // 0..1 window brightness during night
  };
  uploads: {
    requireApproval: boolean;
  };
  video: {
    enabled: boolean;
    /** Never autoplay sound by default. */
    muted: boolean;
  };
}

// ---------- Aggregate ----------

/** Everything the Ambient screen needs, pushed over SSE as `state`. */
export interface FrameState {
  serverTime: ISODateTime;
  timeZone: string;
  settings: FrameSettings;
  prayer: PrayerDay | null;
  events: CalendarEvent[]; // upcoming, sorted
  printer: PrinterState | null;
  weather: WeatherNow | null;
  home: HomeState | null;
  playlistVersion: number;
  uploadUrl: string;
  providers: Record<string, { name: string; ok: boolean; message?: string }>;
}

export type StreamEvent =
  | { type: 'state'; state: FrameState }
  | { type: 'playlist'; version: number }
  | { type: 'printer'; printer: PrinterState }
  | { type: 'home'; home: HomeState };
