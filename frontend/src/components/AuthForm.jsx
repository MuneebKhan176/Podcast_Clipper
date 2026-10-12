import { useId, useState } from 'react';
import { ApiError } from '../api/httpClient.js';
import { APP_NAME } from '../config.js';

/**
 * Shared card + form for register / verify / login.
 *
 * fields:       [{ name, label, type?, autoComplete?, inputMode?, maxLength?, hint?, transform? }]
 * validate:     (values) => { fieldName: message }   client-side checks, runs before any request
 * onSubmit:     async (values) => void               throw ApiError to show server messages
 * Server-side `data.errors` ([{ field, message }]) are shown under the matching field; any other
 * failure is shown as one alert above the form.
 */
export default function AuthForm({
  title,
  subtitle,
  fields,
  initialValues,
  validate,
  onSubmit,
  submitLabel,
  submittingLabel = 'Please wait…',
  footer,
}) {
  const formId = useId();
  const [values, setValues] = useState(initialValues);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState({});

  function handleChange(field, raw) {
    const value = field.transform ? field.transform(raw) : raw;
    setValues((prev) => ({ ...prev, [field.name]: value }));
    if (fieldErrors[field.name]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[field.name];
        return next;
      });
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setFormError('');

    const clientErrors = validate ? validate(values) : {};
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiError) {
        const serverFieldErrors = {};
        for (const item of err.data?.errors ?? []) {
          if (fields.some((f) => f.name === item.field) && !serverFieldErrors[item.field]) {
            serverFieldErrors[item.field] = item.message;
          }
        }
        setFieldErrors(serverFieldErrors);
        if (Object.keys(serverFieldErrors).length === 0) setFormError(err.message);
      } else {
        console.error(err);
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="center-screen">
      <div className="auth-card">
        <div className="brand">{APP_NAME}</div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}

        {formError && (
          <div className="alert" role="alert">
            {formError}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          {fields.map((field) => {
            const id = `${formId}-${field.name}`;
            const error = fieldErrors[field.name];
            const isPassword = field.type === 'password';
            const type = isPassword && revealed[field.name] ? 'text' : field.type || 'text';
            const describedBy = [error && `${id}-error`, field.hint && `${id}-hint`].filter(Boolean).join(' ');
            return (
              <div className="field" key={field.name}>
                <label htmlFor={id}>{field.label}</label>
                <div className="input-row">
                  <input
                    id={id}
                    name={field.name}
                    type={type}
                    value={values[field.name]}
                    onChange={(e) => handleChange(field, e.target.value)}
                    autoComplete={field.autoComplete}
                    inputMode={field.inputMode}
                    maxLength={field.maxLength}
                    aria-invalid={error ? 'true' : undefined}
                    aria-describedby={describedBy || undefined}
                    disabled={submitting}
                  />
                  {isPassword && (
                    <button
                      type="button"
                      className="btn-link toggle"
                      aria-label={`${revealed[field.name] ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`}
                      onClick={() => setRevealed((prev) => ({ ...prev, [field.name]: !prev[field.name] }))}
                    >
                      {revealed[field.name] ? 'Hide' : 'Show'}
                    </button>
                  )}
                </div>
                {field.hint && !error && (
                  <p className="hint" id={`${id}-hint`}>
                    {field.hint}
                  </p>
                )}
                {error && (
                  <p className="field-error" id={`${id}-error`} role="alert">
                    {error}
                  </p>
                )}
              </div>
            );
          })}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? submittingLabel : submitLabel}
          </button>
        </form>

        {footer && <div className="auth-footer">{footer}</div>}
      </div>
    </main>
  );
}
