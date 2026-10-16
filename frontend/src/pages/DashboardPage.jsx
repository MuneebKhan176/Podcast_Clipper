import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as uploadApi from '../api/uploadApi.js';
import VideoUploader from '../components/VideoUploader.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { APP_NAME } from '../config.js';
import { formatBytes } from '../utils/format.js';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState(null); // null = loading
  const [listFailed, setListFailed] = useState(false);

  const loadUploads = useCallback(async (signal) => {
    try {
      setUploads(await uploadApi.list(signal));
      setListFailed(false);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setListFailed(true);
      setUploads((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadUploads(controller.signal);
    return () => controller.abort();
  }, [loadUploads]);

  async function handleLogout() {
    setBusy(true);
    setError('');
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not log out. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <header className="topbar">
        <span className="brand">{APP_NAME}</span>
        <button type="button" className="btn-secondary" onClick={handleLogout} disabled={busy}>
          {busy ? 'Logging out…' : 'Log out'}
        </button>
      </header>

      <main className="dashboard-main">
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        <section className="panel">
          <h1>Welcome, {user.username}</h1>
          <dl className="profile">
            <dt>Username</dt>
            <dd>{user.username}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Upload a podcast</h2>
          <VideoUploader onCompleted={() => loadUploads()} />
        </section>

        <section className="panel" aria-label="Your uploads">
          <h2>Your uploads</h2>
          {uploads === null && <p className="uploader-meta" role="status">Loading…</p>}
          {listFailed && <p className="uploader-meta" role="status">Couldn&apos;t load your uploads right now.</p>}
          {uploads?.length === 0 && !listFailed && <p className="uploader-meta">No uploads yet.</p>}
          {uploads?.length > 0 && (
            <ul className="upload-list">
              {uploads.map((u) => (
                <li key={u.id}>
                  <span>
                    <strong>{u.filename}</strong>
                    <br />
                    <span className="uploader-meta">{formatBytes(u.sizeBytes)}</span>
                  </span>
                  {u.status === 'completed' ? (
                    <span className="badge ok">Uploaded</span>
                  ) : (
                    <span className="uploader-meta">Unfinished — choose the same file again to resume</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
