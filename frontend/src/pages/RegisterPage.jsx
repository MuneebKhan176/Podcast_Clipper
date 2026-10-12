import { Link, useNavigate } from 'react-router-dom';
import * as authApi from '../api/authApi.js';
import AuthForm from '../components/AuthForm.jsx';
import { normalizeEmail, validateRegister } from '../utils/validation.js';

const FIELDS = [
  { name: 'username', label: 'Username', autoComplete: 'username' },
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', hint: 'At least 8 characters.' },
  { name: 'confirmPassword', label: 'Confirm password', type: 'password', autoComplete: 'new-password' },
];

export default function RegisterPage() {
  const navigate = useNavigate();

  async function handleSubmit(values) {
    const email = normalizeEmail(values.email);
    await authApi.register({
      username: values.username.trim(),
      email,
      password: values.password,
      confirmPassword: values.confirmPassword,
    });
    // The account does not exist yet: the emailed code must be verified first.
    navigate('/verify-email', { state: { email } });
  }

  return (
    <AuthForm
      title="Create your account"
      subtitle="We'll email you a 6-digit code to verify your address."
      fields={FIELDS}
      initialValues={{ username: '', email: '', password: '', confirmPassword: '' }}
      validate={validateRegister}
      onSubmit={handleSubmit}
      submitLabel="Create account"
      submittingLabel="Creating account…"
      footer={
        <>
          Already have an account? <Link to="/login">Log in</Link>
        </>
      }
    />
  );
}
