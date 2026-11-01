import type { FrameState, PhotoSummary } from '@ff/shared';
import { useEffect, useState } from 'preact/hooks';
import { Glass, type Backdrop } from '../components/Glass';
import { Icon } from '../components/Icon';
import { PrayerBar } from '../components/PrayerBar';
import { printerFact } from '../lib/printerFacts';
import { PhaseBar, prepHeadline } from '../components/PrepBill';
import { prepBill } from '../lib/printPrep';
import { DailyFact } from '../components/DailyFact';
import { FunFact } from '../components/FunFact';
import type { AcState, Connection } from '../lib/store';
import { MODE_COLOR, MODE_ICON, MODE_LABEL } from './Climate';
import { clock, hhmm, longDate, until } from '../lib/time';
import { urgency } from '../components/PrayerBar';
import { clockIsSane } from '../lib/hooks';
import type { ScreenId } from '../App';
import type { NowPlaying } from '../providers/spotify';

export const WEATHER_ICON: Record<string, string> = {
  clear: 'sun', partly: 'partly', cloudy: 'cloud', rain: 'rain', snow: 'snowCloud', storm: 'storm', fog: 'fog',
};

const DOCK: { id: ScreenId; label: string; icon: string }[] = [
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'prayer', label: 'Prayer', icon: 'moon' },
  { id: 'weather', label: 'Weather', icon: 'partly' },
  { id: 'climate', label: 'Climate', icon: 'fan' },
  { id: 'photos', label: 'Photos', icon: 'photo' },
  { id: 'printer', label: 'Printer', icon: 'cube' },
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function friendlyDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function Ambient({ state, ac, t, controls, night, connection, photo, backdrop, onOpen, onFavourite, playingVideo, facts, idle, music }: {
  state: FrameState;
  ac: AcState;
  t: Date;
  controls: boolean;
  night: boolean;
  connection: Connection;
  photo: PhotoSummary | null;
  backdrop: Backdrop | null;
  onOpen: (s: ScreenId) => void;
  onFavourite: () => void;
  /** A video is on screen: the extra glass overlays step aside so the GPU only composites the video + widgets. */
  playingVideo: boolean;
  /** Within 5 minutes of a tap or wake: show the fact captions in the top corners. */
  facts: boolean;
  /** A minute without a touch: the compact, half-height widget row (see IdleRow). */
  idle: boolean;
  /** Spotify, live: a Now Playing pill at the top centre whenever something is playing, on any device. */
  music: NowPlaying | null;
}) {
  const s = state.settings;
  const o = s.overlays;
  const c = clock(t, s.clock24h);
  const prayer = state.prayer;
  const event = state.events[0];
  const printer = state.printer;
  const weather = state.weather;
  // All modules are always on, except at night (dimmed clock only) and before the clock has synced after boot.
  const sane = clockIsSane(t);
  const quiet = night || !sane;
  const prep = printer ? prepBill(printer) : null;

  // Facts fade out rather than vanish: keep them mounted for the fade, then drop the layers.
  const showFacts = facts && !quiet && !playingVideo;
  const [factsMounted, setFactsMounted] = useState(showFacts);
  useEffect(() => {
    if (showFacts) { setFactsMounted(true); return; }
    const id = setTimeout(() => setFactsMounted(false), 900);
    return () => clearTimeout(id);
  }, [showFacts]);

  const open = (id: ScreenId) => (e: Event) => {
    e.stopPropagation();
    onOpen(id);
  };

  return (
    <div class={'ambient' + (night ? ' night' : '')}>

      {/* Top corners: "On this day" (left) and the fun fact of the day (right); the offline badge leads the left side. */}
      {(
        <div class={'top-facts' + (showFacts ? '' : ' out') + (idle ? ' idle' : '')}>
          <div class="top-left">
            {connection === 'offline' && !night && (
              <Glass backdrop={backdrop} class="round offline-badge"><Icon name="wifiOff" size={24} /></Glass>
            )}
            {factsMounted && <DailyFact t={t} backdrop={backdrop} />}
          </div>
          {factsMounted && <FunFact t={t} backdrop={backdrop} />}
        </div>
      )}

      {!quiet && music && music.playing && music.track && (
        <Glass backdrop={backdrop} class={'np-pill' + (idle ? ' idle' : '')} onClick={open('nowPlaying')}>
          {music.track.thumb ? <img class="np-art" src={music.track.art || music.track.thumb} /> : <span class="np-art blank"><Icon name="music" size={24} /></span>}
          <div class="np-text">
            <div class="np-title">{music.track.title}</div>
            <div class="np-sub">{music.track.artist}{music.device ? ' · ' + music.device.name : ''}</div>
            <div class="np-bar"><i style={{ width: (music.track.ms ? Math.min(100, ((music.progressMs + Date.now() - music.at) / music.track.ms) * 100) : 0) + '%' }} /></div>
          </div>
        </Glass>
      )}

      {/* Nothing playing: a quiet Spotify button in the same spot, straight into Music. */}
      {!quiet && !(music && music.playing && music.track) && (
        <Glass backdrop={backdrop} class={'round np-quick' + (idle ? ' idle' : '')} onClick={open('music')}>
          <Icon name="spotify" size={30} stroke={1.9} />
        </Glass>
      )}

      {/* While the printer warms up, it gets the middle of the screen. */}
      {!quiet && !controls && prep && (
        <Glass backdrop={backdrop} class={'prep-card' + (idle ? ' idle' : '')} onClick={open('printer')}>
          <div class="prep-card-line"><b>{prepHeadline(prep).big}</b> {prepHeadline(prep).rest}</div>
          <PhaseBar segments={prep.segments} slim />
          <div class="prep-card-sub">{prep.items[prep.stepNo - 1] ? prep.items[prep.stepNo - 1]!.label : 'Getting ready'} · step {prep.stepNo} of {prep.items.length}</div>
        </Glass>
      )}

      {idle && !quiet && <IdleRow state={state} ac={ac} t={t} backdrop={backdrop} />}

      {/* Bottom stack: widget row, with the prayer strip as its base, all one width. */}
      {!(idle && !quiet) && <div class="bottom-stack"><div class="stack">
      <div class="modules">
        {o.clock && (
          <div class="clock-col">
            <Glass backdrop={backdrop} class="module module-clock" onClick={open('briefing')}>
              <div class="clock-date">{sane ? longDate(t) : 'Setting time…'}</div>
              <div class="clock-time">
                {sane ? c.hm : '–:––'}
                {sane && c.suffix && <span class="clock-ampm">{c.suffix}</span>}
              </div>
            </Glass>
          </div>
        )}

        {!quiet && o.weather && !weather && (
          <Glass backdrop={backdrop} class="module module-sq" onClick={open('weather')}>
            <div class="w-head"><div class="w-place">{s.location ? s.location.label : 'Weather'}</div></div>
            <div class="w-temp">–°</div>
            <div class="sq-foot"><div class="sq-dim">Updating…</div></div>
          </Glass>
        )}

        {!quiet && o.weather && weather && (
          <Glass backdrop={backdrop} class="module module-sq" onClick={open('weather')}>
            <div class="w-head"><div class="w-place">{s.location ? s.location.label : 'Weather'}</div></div>
            <div class="w-head">
              <div class="w-temp">{Math.round(weather.tempC)}°</div>
              <Icon name={weather.hourly[0] && weather.hourly[0].night && weather.condition === 'clear' ? 'moon' : weather.hourly[0] && weather.hourly[0].night && weather.condition === 'partly' ? 'partlyNight' : WEATHER_ICON[weather.condition] || 'cloud'} size={30} stroke={1.7} />
            </div>
            <div class="sq-foot">
              <div class="w-cond">{weather.label}</div>
              <div class="sq-dim">H:{Math.round(weather.highC)}°  L:{Math.round(weather.lowC)}°</div>
            </div>
          </Glass>
        )}

        {!quiet && o.printer && printer && (() => {
          const busy = printer.status === 'printing' || printer.status === 'paused';
          const label = printer.status === 'printing' ? 'Printing' : printer.status === 'paused' ? 'Paused' : printer.status === 'error' ? 'Needs attention'
            : printer.status === 'offline' ? '3D Printer · Offline' : '3D Printer';
          // "26 Oct · 2:08 PM": when the last print finished (from the frame's own photo of it).
          const lastAt = printer.lastPhoto ? (() => {
            const d = new Date(printer.lastPhoto!.at);
            return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${hhmm(d)}`;
          })() : null;
          const job = (printer.jobName || (printer.lastPhoto && printer.lastPhoto.job) || 'Bambu Lab A1').replace(/_/g, ' ');
          return (
            <Glass backdrop={backdrop} class={'module module-sq pr-module status-' + printer.status} onClick={open('printer')}>
              <div class="sq-eyebrow"><Icon name="cube" size={18} stroke={1.9} />{label}</div>
              {busy ? (
                <div>
                  <div class="w-temp">{printer.progressPct ?? 0}<span class="pr-pct">%</span></div>
                  <div class="pr-job">{job}</div>
                </div>
              ) : (
                <div>
                  <div class="pr-job big">{job}</div>
                  {lastAt && <div class="pr-when">{lastAt}</div>}
                </div>
              )}
              <div class="sq-foot">
                {busy ? (
                  <div>
                    <div class="meter"><i style={{ width: (printer.progressPct || 0) + '%' }} /></div>
                    <div class="sq-dim">{printer.remainingLabel ? printer.remainingLabel + ' left' : printer.stage || ''}</div>
                  </div>
                ) : (
                  <div class="pr-fact">{printerFact(printer, t)}</div>
                )}
              </div>
            </Glass>
          );
        })()}

        <div class="right-col">
          <div class="right-row">
        {!quiet && ac.units.length > 0 && (() => {
          const u = ac.units.filter((x) => x.power)[0] || ac.units[0]!;
          return (
            <Glass backdrop={backdrop} class={'module module-sq ac-module' + (u.power ? ' on' : '')} onClick={open('climate')}>
              <div class="w-head">
                <div class="w-place">{u.name}</div>
                <span class="ac-fan" style={{ color: u.power ? MODE_COLOR[u.mode] : 'rgba(255,255,255,.5)' }}><Icon name="fan" size={24} stroke={1.8} /></span>
              </div>
              <div class="w-temp">{u.power ? Math.round(u.setTemp * 2) / 2 + '°' : 'Off'}</div>
              <div class="sq-foot">
                <div class="w-cond" style={{ color: u.power ? MODE_COLOR[u.mode] : undefined }}>
                  {u.power ? <span class="ac-mode"><Icon name={MODE_ICON[u.mode]} size={16} stroke={2} />{MODE_LABEL[u.mode]}</span> : 'Air Con'}
                </div>
                <div class="sq-dim">{u.roomTemp !== null ? 'Inside ' + Math.round(u.roomTemp) + '°' : u.offline ? 'Offline' : ''}</div>
              </div>
            </Glass>
          );
        })()}

        {!quiet && o.calendar && (
          <Glass backdrop={backdrop} class="module module-sq" onClick={open('calendar')}>
            <div class="c-day">{DAYS[t.getDay()]}</div>
            <div class="c-date">{t.getDate()}</div>
            {event ? (
              <div class="sq-foot c-event">
                <span class="c-bar" style={{ backgroundColor: event.color }} />
                <div class="c-text">
                  <div class="c-title">{event.title}</div>
                  <div class="sq-dim c-when">{event.dayLabel === 'Today' ? event.timeLabel : event.dayLabel + ' ' + event.timeLabel.replace(':00', '')}</div>
                </div>
              </div>
            ) : (
              <div class="sq-foot sq-dim">No more events</div>
            )}
          </Glass>
        )}
          </div>
        </div>
      </div>
      {!quiet && !playingVideo && o.prayer && prayer && <PrayerBar prayer={prayer} t={t} backdrop={backdrop} onOpen={open('prayer')} />}
      </div></div>}

      {controls && (
        <div class="controls" onClick={(e) => e.stopPropagation()}>
          {photo && (
            <Glass backdrop={backdrop} class="chip photo-meta">
              <div class="meta-main">{photo.sender ? 'From ' + photo.sender : photo.source === 'frameo' ? 'From Frameo' : 'Shared photo'}</div>
              <div class="meta-sub">{friendlyDate(photo.takenAt || photo.uploadedAt)}</div>
            </Glass>
          )}
          <Glass backdrop={backdrop} class="dock">
            {DOCK.map((d) => (
              <button class="dock-item" key={d.id} onClick={open(d.id)}>
                <Icon name={d.icon} size={30} stroke={1.6} />
                <span class="dock-label">{d.label}</span>
              </button>
            ))}
          </Glass>
          {photo && (
            <Glass backdrop={backdrop} class={'round fav' + (photo.favourite ? ' on' : '')} onClick={(e) => { e.stopPropagation(); onFavourite(); }}>
              <Icon name="heart" size={28} fill={photo.favourite} stroke={1.8} />
            </Glass>
          )}
        </div>
      )}
    </div>
  );
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Idle view: every widget at half height in one quiet row, just the glanceable bit of each. Tapping anywhere
 *  (handled in App) brings the full view back, so these pills have no actions of their own. */
function IdleRow({ state, ac, t, backdrop }: { state: FrameState; ac: AcState; t: Date; backdrop: Backdrop | null }) {
  const s = state.settings;
  const o = s.overlays;
  const c = clock(t, s.clock24h);
  const { weather, printer, prayer } = state;
  const event = state.events[0];
  const unit = ac.units.filter((x) => x.power)[0] || ac.units[0];
  const pill = 'idle-pill';
  return (
    <div class="idle-row">
      {/* Bottom left: a bigger clock, with the date and the weather right now on one small line beneath. */}
      {(o.clock || (o.weather && weather)) && (
        <Glass backdrop={backdrop} class="idle-clock">
          {o.clock && <div class="ic-time">{c.hm}{c.suffix && <span class="ic-ampm">{c.suffix}</span>}</div>}
          <div class="ic-line">
            {o.clock && <span>{SHORT_DAYS[t.getDay()]} {t.getDate()} {MONTHS[t.getMonth()]}</span>}
            {o.clock && o.weather && <span class="ic-dot">•</span>}
            {o.weather && weather && (
              <span class="ic-weather">
                <Icon name={weather.hourly[0] && weather.hourly[0].night && weather.condition === 'clear' ? 'moon' : weather.hourly[0] && weather.hourly[0].night && weather.condition === 'partly' ? 'partlyNight' : WEATHER_ICON[weather.condition] || 'cloud'} size={18} stroke={2} />
                {Math.round(weather.tempC)}°
              </span>
            )}
            {o.weather && !weather && <span class="ic-weather">–°</span>}
          </div>
        </Glass>
      )}
      <div class="idle-pills">
      {/* Every pill has the same three lines (label · main · detail) and width, whatever the time or state. */}
      {o.printer && printer && (() => {
        const busy = printer.status === 'printing' || printer.status === 'paused';
        const job = (printer.jobName || (printer.lastPhoto && printer.lastPhoto.job) || 'Bambu Lab A1').replace(/_/g, ' ');
        const head = printer.status === 'printing' ? 'Printing · ' + (printer.progressPct ?? 0) + '%' : printer.status === 'paused' ? 'Paused'
          : printer.status === 'error' ? 'Needs attention' : '3D Printer';
        let sub = printer.status === 'offline' ? 'Offline' : '';
        if (busy) sub = printer.remainingLabel ? printer.remainingLabel + ' left' : printer.stage || '';
        else if (printer.lastPhoto) {
          const d = new Date(printer.lastPhoto.at);
          sub = 'Last used ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
        }
        return (
          <Glass backdrop={backdrop} class={pill + ' ip-printer status-' + printer.status}>
            <div class="ip-head">{head}</div>
            <div class="ip-main">{job}</div>
            <div class="ip-sub">{sub}</div>
          </Glass>
        );
      })()}
      {unit && (
        <Glass backdrop={backdrop} class={pill}>
          <div class="ip-head" style={{ color: unit.power ? MODE_COLOR[unit.mode] : undefined }}>{unit.power ? MODE_LABEL[unit.mode] : unit.name}</div>
          <div class="ip-main">{unit.power ? 'Set to ' + Math.round(unit.setTemp * 2) / 2 + '°' : unit.roomTemp !== null ? Math.round(unit.roomTemp) + '° inside' : 'Air con'}</div>
          <div class="ip-sub">{unit.power ? (unit.roomTemp !== null ? 'Inside ' + Math.round(unit.roomTemp) + '°' : unit.name) : unit.offline ? 'Offline' : 'Air con off'}</div>
        </Glass>
      )}
      {o.calendar && (
        <Glass backdrop={backdrop} class={pill + ' ip-event'}>
          <div class="ip-head">{event ? (event.dayLabel === 'Today' ? 'Today' : event.dayLabel) : 'Calendar'}</div>
          <div class="ip-main">{event ? event.title : 'Nothing coming up'}</div>
          <div class="ip-sub">{event ? <span><span class="ip-dot" style={{ backgroundColor: event.color }} />{event.timeLabel}</span> : SHORT_DAYS[t.getDay()] + ' ' + t.getDate() + ' ' + MONTHS[t.getMonth()]}</div>
        </Glass>
      )}
      {o.prayer && prayer && (() => {
        const n = prayer.next;
        const mins = Math.max(0, Math.ceil((Date.parse(n.time) - t.getTime()) / 60000));
        return (
          <Glass backdrop={backdrop} class={pill}>
            <div class="ip-head">Next prayer</div>
            <div class="ip-main">{n.name === 'dhuhr' && prayer.isJumuah ? 'Jumu’ah' : n.label} {n.timeLabel}</div>
            <div class="ip-sub" style={{ color: urgency(mins) }}>{until(n.time, t)}</div>
          </Glass>
        );
      })()}
      </div>
    </div>
  );
}
