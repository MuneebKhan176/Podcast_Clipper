import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { APP_NAME } from '../config.js';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

        <section className="panel placeholder" aria-label="Podcast clipping workflow">
          <h2>Podcast clipping</h2>
          <p>
            Upload a podcast episode and get AI-selected clips. This workflow is coming in a later phase — nothing to
            do here yet.
          </p>
          <button type="button" className="btn-primary" disabled>
            Upload podcast (coming soon)
          </button>
        </section>
      </main>
    </div>
  );
}
