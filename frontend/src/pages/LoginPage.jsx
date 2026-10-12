import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthForm from '../components/AuthForm.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { normalizeEmail, validateLogin } from '../utils/validation.js';

const FIELDS = [
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  async function handleSubmit(values) {
    await login({ email: normalizeEmail(values.email), password: values.password });
    navigate(location.state?.from?.pathname || '/dashboard', { replace: true });
  }

  return (
    <AuthForm
      title="Welcome back"
      subtitle="Log in to continue."
      fields={FIELDS}
      initialValues={{ email: '', password: '' }}
      validate={validateLogin}
      onSubmit={handleSubmit}
      submitLabel="Log in"
      submittingLabel="Logging in…"
      footer={
        <>
          New here? <Link to="/register">Create an account</Link>
        </>
      }
    />
  );
}
