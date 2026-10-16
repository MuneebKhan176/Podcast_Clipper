import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/httpClient.js';
import VideoUploader from '../components/VideoUploader.jsx';
import App from '../App.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';

// ---- tiny fake of backend + storage (size 45, 10-byte parts => 5 parts) ----
function createWorld({ stored = [] } = {}) {
  const world = {
    stored: new Set(stored), puts: [], aborts: 0, failPart: null, gate: null,
    api: null, putPart: null,
  };
  world.api = {
    initiate: async () => ({
      upload: { id: 'up-1', status: 'uploading', sizeBytes: 45, partSizeBytes: 10, totalParts: 5, completedParts: [...world.stored] },
    }),
    signParts: async (id, parts) => ({
      parts: parts.map((n) => ({ partNumber: n, url: `https://s.test/${n}` })),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
    complete: async () => {
      const missing = [1, 2, 3, 4, 5].filter((n) => !world.stored.has(n));
      if (missing.length) throw new ApiError(409, 'incomplete', { reason: 'incomplete', missingParts: missing });
      return { id: 'up-1', status: 'completed', publicUrl: 'https://pub.test/talk.mp4' };
    },
    abort: async () => { world.aborts++; },
  };
  world.putPart = async (url, blob, { signal, onProgress }) => {
    const n = Number(url.split('/').pop());
    if (world.gate) await world.gate(n, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (world.failPart === n) throw Object.assign(new Error('Network error'), { name: 'PartUploadError' });
    onProgress?.(blob.size);
    world.puts.push(n);
    world.stored.add(n);
  };
  return world;
}

const opts = (world, extra = {}) => ({
  api: world.api, putPart: world.putPart, sleep: async () => {}, waitForOnline: async () => {},
  random: () => 1, baseDelayMs: 1, maxAttempts: 2, concurrency: 1, ...extra,
});
const video = (name = 'talk.mp4') => new File([new Uint8Array(45)], name, { type: 'video/mp4', lastModified: 1 });
const pick = (file) => userEvent.upload(screen.getByLabelText('Video file'), file);

afterEach(() => vi.unstubAllGlobals());

describe('VideoUploader', () => {
  it('uploads a chosen video, shows completion with a link, and notifies the parent', async () => {
    const world = createWorld();
    const onCompleted = vi.fn();
    render(<VideoUploader uploaderOptions={opts(world)} onCompleted={onCompleted} />);
    await pick(video());

    expect(await screen.findByText(/Upload complete/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('link', { name: 'open file' })).toHaveAttribute('href', 'https://pub.test/talk.mp4');
    expect(world.puts.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(screen.getByRole('button', { name: 'Upload another video' })).toBeInTheDocument();
  });

  it('rejects non-video files before any network call', async () => {
    const world = createWorld();
    const initiate = vi.spyOn(world.api, 'initiate');
    render(<VideoUploader uploaderOptions={opts(world)} />);
    // applyAccept:false so the browser-level accept filter does not hide our own validation
    await userEvent.setup({ applyAccept: false }).upload(screen.getByLabelText('Video file'), new File(['x'], 'malware.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please choose a video file');
    expect(initiate).not.toHaveBeenCalled();
  });

  it('shows a clear error when the connection keeps failing, and Resume upload continues from the checkpoint', async () => {
    const world = createWorld();
    world.failPart = 3;
    render(<VideoUploader uploaderOptions={opts(world)} />);
    await pick(video());

    expect(await screen.findByText('Upload stopped')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Part 3 could not be uploaded/);
    expect(world.puts).toEqual([1, 2]);

    world.failPart = null; // network is back
    await userEvent.click(screen.getByRole('button', { name: 'Resume upload' }));
    expect(await screen.findByText(/Upload complete/)).toBeInTheDocument();
    expect(world.puts).toEqual([1, 2, 3, 4, 5]); // parts 1 and 2 were NOT sent a second time
  });

  it('tells the user how much was already uploaded when an earlier attempt is resumed', async () => {
    const world = createWorld({ stored: [1, 2] });
    world.gate = () => new Promise(() => {}); // keep it uploading so the note stays visible
    render(<VideoUploader uploaderOptions={opts(world)} />);
    await pick(video());
    expect(await screen.findByText(/Resuming: 20 B were already uploaded/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '44');
  });

  it('pause and resume buttons control the upload', async () => {
    const world = createWorld();
    let release;
    const hold = new Promise((r) => { release = r; });
    world.gate = async (n, signal) => {
      if (n === 2) await new Promise((resolve) => { signal?.addEventListener('abort', resolve, { once: true }); hold.then(resolve); });
    };
    render(<VideoUploader uploaderOptions={opts(world)} />);
    await pick(video());

    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused')).toBeInTheDocument();

    world.gate = null;
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/Upload complete/)).toBeInTheDocument();
    expect(world.puts.filter((n) => n === 1)).toHaveLength(1);
    release();
  });

  it('cancel discards the upload on the server and offers to start over', async () => {
    const world = createWorld();
    world.gate = (n, signal) => new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
    render(<VideoUploader uploaderOptions={opts(world)} />);
    await pick(video());
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Upload cancelled')).toBeInTheDocument();
    await waitFor(() => expect(world.aborts).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'Upload another video' }));
    expect(screen.getByLabelText('Video file')).toBeInTheDocument();
  });

  it('warns before the tab is closed while an upload is running, and stops warning afterwards', async () => {
    const world = createWorld();
    let release;
    world.gate = () => new Promise((r) => { release = r; });
    const add = vi.spyOn(window, 'addEventListener');
    render(<VideoUploader uploaderOptions={opts(world)} />);
    await pick(video());
    await screen.findByText(/Uploading/);
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    world.gate = null;
    release();
    await screen.findByText(/Upload complete/);
    add.mockRestore();
  });
});

describe('dashboard upload list', () => {
  const ok = (data) => ({ status: 200, body: { success: true, message: 'ok', data } });
  function renderDashboard(uploadsResponse) {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
      const res =
        key === 'GET /api/auth/me' ? ok({ user: { id: 'u1', username: 'Muneeb', email: 'm@example.com', createdAt: '2026-01-01T00:00:00Z' } })
        : key === 'GET /api/uploads' ? uploadsResponse
        : { status: 404, body: { success: false, message: 'nope', data: null } };
      if (res instanceof Error) throw res;
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }));
    return render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it('lists finished and unfinished uploads', async () => {
    renderDashboard(ok({ uploads: [
      { id: 'a', filename: 'ep1.mp4', sizeBytes: 5 * 1024 ** 3, status: 'completed' },
      { id: 'b', filename: 'ep2.mp4', sizeBytes: 3 * 1024 ** 3, status: 'uploading' },
    ] }));
    expect(await screen.findByText('ep1.mp4')).toBeInTheDocument();
    expect(screen.getByText('5.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText(/choose the same file again to resume/)).toBeInTheDocument();
  });

  it('shows an empty state, and a soft message (not a crash) if the list cannot be loaded', async () => {
    const { unmount } = renderDashboard(ok({ uploads: [] }));
    expect(await screen.findByText('No uploads yet.')).toBeInTheDocument();
    unmount();
    renderDashboard(new TypeError('Failed to fetch'));
    expect(await screen.findByText(/Couldn't load your uploads/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
  });
});
