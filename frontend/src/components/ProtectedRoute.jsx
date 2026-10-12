import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

function SessionLoading() {
  return (
    <main className="center-screen" aria-busy="true">
      <div className="spinner" role="status" aria-label="Loading" />
    </main>
  );
}

function SessionError({ onRetry }) {
  return (
    <main className="center-screen">
      <div className="auth-card" role="alert">
        <h1>Can&apos;t reach the server</h1>
        <p className="subtitle">We couldn&apos;t check your session. Make sure the API is running, then try again.</p>
        <button type="button" className="btn-primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </main>
  );
}

/** Wrap private routes: waits for the /me check, then either renders them or sends the user to /login. */
export function ProtectedRoute() {
  const { status, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <SessionLoading />;
  if (status === 'error') return <SessionError onRetry={retry} />;
  if (status === 'unauthenticated') return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

/** Wrap login/register/verify: signed-in users are sent on to the dashboard (or where they were headed). */
export function PublicOnlyRoute() {
  const { status, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <SessionLoading />;
  if (status === 'error') return <SessionError onRetry={retry} />;
  if (status === 'authenticated') {
    return <Navigate to={location.state?.from?.pathname || '/dashboard'} replace />;
  }
  return <Outlet />;
}

export default ProtectedRoute;
