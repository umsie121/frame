// Photo library: paged grid of every photo/video (paged, not scrolled: smoother on this WebView),
// order choice (shuffle vs chronological), slide timing, approvals, and a viewer to show/favourite/hide.
import { useEffect, useState } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import type { FrameSettings, FrameState, PhotoSummary } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Segmented, Sheet } from '../components/Sheet';
import { api } from '../lib/api';
import { getStore, markFavourite } from '../lib/store';

const PER_PAGE = 21; // 7 × 3

function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (p: PhotoSummary) => { const d = new Date(p.takenAt || p.uploadedAt); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const fromOf = (p: PhotoSummary) => (p.sender ? 'From ' + p.sender : p.source === 'frameo' ? 'From Frameo' : (p.source as string) === 'google' ? 'From Google Photos' : 'Shared photo');

type Tab = 'all' | 'favourites' | 'pending' | 'hidden';

export function PhotosScreen({ state, onClose, onSave, onShowNow }: {
  state: FrameState;
  onClose: () => void;
  onSave: (patch: Partial<FrameSettings>) => void;
  onShowNow: (id: string) => void;
}) {
  const s = state.settings;
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(0);
  const [extra, setExtra] = useState<PhotoSummary[]>([]); // pending/hidden come from the frame on demand
  const [open, setOpen] = useState<PhotoSummary | null>(null);
  const [qr, setQr] = useState(false);
  const [, bump] = useState(0);

  useEffect(() => {
    setPage(0);
    if (tab === 'pending' || tab === 'hidden') {
      api.get<PhotoSummary[]>('/api/photos?status=' + (tab === 'pending' ? 'pending' : 'archived')).then(setExtra).catch(() => setExtra([]));
    }
  }, [tab]);

  const active = getStore().photos; // newest first
  const list = tab === 'all' ? active : tab === 'favourites' ? active.filter((p) => p.favourite) : extra;
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const shown = list.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  const setStatus = (p: PhotoSummary, status: 'active' | 'archived') =>
    api.post(`/api/photos/${p.id}`, { status }).then(() => {
      setOpen(null);
      if (tab === 'pending' || tab === 'hidden') setExtra(extra.filter((x) => x.id !== p.id));
    });

  return (
    <Sheet
      title="Photos"
      subtitle={`${active.length} photos and videos`}
      onClose={onClose}
      accessory={<button class="pill-btn" onClick={() => setQr(true)}><Icon name="qr" size={22} stroke={1.8} /><span>Add Photos</span></button>}
    >
      <div class="lib-bar">
        <Segmented
          value={tab}
          options={[{ value: 'all', label: 'All' }, { value: 'favourites', label: 'Favourites' }, { value: 'pending', label: 'Waiting' }, { value: 'hidden', label: 'Hidden' }]}
          onChange={setTab}
        />
        <div class="lib-bar-right">
          <span class="lib-bar-label">Order</span>
          <Segmented
            value={s.order === 'smart' ? 'shuffle' : s.order}
            options={[{ value: 'shuffle', label: 'Shuffle' }, { value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }]}
            onChange={(v) => onSave({ order: v })}
          />
          <span class="lib-bar-label">Each</span>
          <Segmented
            value={s.slideSeconds}
            options={[{ value: 10, label: '10s' }, { value: 30, label: '30s' }, { value: 60, label: '1m' }, { value: 300, label: '5m' }]}
            onChange={(v) => onSave({ slideSeconds: v })}
          />
        </div>
      </div>

      <div class="lib-grid">
        {shown.map((p) => (
          <button class="lib-thumb" key={p.id} onClick={() => setOpen(p)}>
            <img src={p.thumbUrl} alt="" />
            {p.kind === 'video' && <span class="thumb-badge">▶ {p.durationSec ? Math.round(p.durationSec) + 's' : ''}</span>}
            {p.favourite && <span class="thumb-fav"><Icon name="heart" size={16} fill stroke={1.5} /></span>}
          </button>
        ))}
        {shown.length === 0 && <div class="lib-empty">{tab === 'pending' ? 'Nothing waiting for approval.' : tab === 'hidden' ? 'No hidden photos.' : tab === 'favourites' ? 'Tap a photo, then Add to Favourites.' : 'No photos yet.'}</div>}
      </div>

      <div class="lib-pager">
        <button class="chev small" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevLeft" size={30} stroke={2.2} /></button>
        <span>Page {page + 1} of {pages}</span>
        <button class="chev small" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><Icon name="chevRight" size={30} stroke={2.2} /></button>
      </div>

      {open && (
        <div class="viewer" onClick={() => setOpen(null)}>
          <div class="viewer-card card" onClick={(e) => e.stopPropagation()}>
            <img class="viewer-img" src={open.url} alt="" />
            <div class="viewer-side">
              <div class="viewer-from">{fromOf(open)}</div>
              <div class="viewer-date">{dateOf(open)}{open.kind === 'video' ? ' · Video' : ''}</div>
              {open.status === 'active' && <button class="primary-btn" onClick={() => onShowNow(open.id)}>Show Now</button>}
              {open.status === 'active' && (
                <button class="row-btn" onClick={() => { markFavourite(open, !open.favourite); open.favourite = !open.favourite; bump((n) => n + 1); }}>
                  <Icon name="heart" size={22} fill={open.favourite} stroke={1.8} />{open.favourite ? 'Favourite' : 'Add to Favourites'}
                </button>
              )}
              {open.status !== 'active' && <button class="primary-btn" onClick={() => setStatus(open, 'active')}>{open.status === 'pending' ? 'Approve' : 'Show in Slideshow'}</button>}
              {open.status !== 'archived' && <button class="row-btn danger" onClick={() => setStatus(open, 'archived')}><Icon name="archive" size={22} />Hide from Slideshow</button>}
              <button class="link-btn" onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {qr && (
        <div class="viewer" onClick={() => setQr(false)}>
          <div class="card qr-card qr-pop" onClick={(e) => e.stopPropagation()}>
            {state.uploadUrl ? <div class="qr" dangerouslySetInnerHTML={{ __html: qrSvg(state.uploadUrl) }} /> : <div class="qr" />}
            <div class="qr-title">Add Photos</div>
            <div class="qr-sub">Scan with your phone’s camera while on the home Wi‑Fi.</div>
            <button class="link-btn" onClick={() => setQr(false)}>Done</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
