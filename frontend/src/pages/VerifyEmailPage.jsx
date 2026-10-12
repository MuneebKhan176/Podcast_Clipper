import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/httpClient.js';
import AuthForm from '../components/AuthForm.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { normalizeEmail, validateVerify } from '../utils/validation.js';

const EMAIL_FIELD = { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' };
const CODE_FIELD = {
  name: 'code',
  label: 'Verification code',
  autoComplete: 'one-time-code',
  inputMode: 'numeric',
  maxLength: 6,
  transform: (value) => value.replace(/\D/g, '').slice(0, 6),
};

export default function VerifyEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { verifyEmail } = useAuth();

  // The email comes from the register step. After a page refresh it is gone, so we ask for it again.
  const knownEmail = location.state?.email || '';

  async function handleSubmit(values) {
    try {
      await verifyEmail({ email: normalizeEmail(values.email), code: values.code });
    } catch (err) {
      if (err instanceof ApiError && err.data?.reason === 'invalid' && err.data.attemptsRemaining != null) {
        const n = err.data.attemptsRemaining;
        throw new ApiError(err.status, `${err.message} ${n} attempt${n === 1 ? '' : 's'} remaining.`, err.data);
      }
      throw err;
    }
    // The backend set the HttpOnly cookie and AuthContext now holds the user.
    navigate('/dashboard', { replace: true });
  }

  return (
    <AuthForm
      title="Check your email"
      subtitle={
        knownEmail ? (
          <>
            We sent a 6-digit code to <strong>{knownEmail}</strong>. It expires in 10 minutes.
          </>
        ) : (
          'Enter your email and the 6-digit code we sent you.'
        )
      }
      fields={knownEmail ? [CODE_FIELD] : [EMAIL_FIELD, CODE_FIELD]}
      initialValues={{ email: knownEmail, code: '' }}
      validate={validateVerify}
      onSubmit={handleSubmit}
      submitLabel="Verify email"
      submittingLabel="Verifying…"
      footer={
        <>
          Code expired or didn&apos;t arrive? <Link to="/register">Register again</Link> to get a new one.
        </>
      }
    />
  );
}
