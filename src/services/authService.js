'use strict';

const bcrypt = require('bcrypt');
const config = require('../config/env');
const { withTransaction } = require('../config/db');
const userRepository = require('../repositories/userRepository');
const pendingUserRepository = require('../repositories/pendingUserRepository');
// Called as emailService.sendVerificationEmail(...) so tests can replace it.
const emailService = require('./emailService');
const { AppError } = require('../utils/errors');
const { generateVerificationCode, hashVerificationCode, safeEqualHex } = require('../utils/crypto');
const { signAuthToken } = require('../utils/tokens');

const PG_UNIQUE_VIOLATION = '23505';

// Compared against when the email is unknown so login takes the same time either way.
const dummyHashPromise = bcrypt.hash('timing-equalizer-not-a-real-password', config.bcryptRounds);

function basicUser(user) {
  return { id: user.id, username: user.username, email: user.email };
}

async function register({ username, email, password }) {
  if (await userRepository.findByEmail(email)) {
    throw new AppError(409, 'Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const code = generateVerificationCode();

  const pending = await pendingUserRepository.upsert({
    username,
    email,
    passwordHash,
    codeHash: hashVerificationCode(email, code),
    expirySeconds: config.verification.expirySeconds,
    cooldownSeconds: config.verification.resendCooldownSeconds,
  });

  if (!pending) {
    throw new AppError(
      429,
      'A verification code was sent recently. Please wait a moment before requesting another.'
    );
  }

  try {
    await emailService.sendVerificationEmail(email, code);
  } catch (err) {
    console.error('Verification email failed:', err.message);
    await pendingUserRepository.deleteById(pending.id).catch(() => {});
    throw new AppError(502, 'Could not send the verification email. Please try again.');
  }

  return { email, expiresInSeconds: config.verification.expirySeconds };
}

async function verifyEmail({ email, code }) {
  const { maxAttempts } = config.verification;

  let outcome;
  try {
    // The transaction always COMMITs for expected failures (wrong code etc.) so the attempt
    // counter increment and row deletions persist; errors are thrown after it finishes.
    outcome = await withTransaction(async (client) => {
      const pending = await pendingUserRepository.findByEmailForUpdate(client, email);
      if (!pending) return { status: 'not_found' };

      if (pending.isExpired) {
        await pendingUserRepository.deleteById(pending.id, client);
        return { status: 'expired' };
      }
      if (pending.attemptCount >= maxAttempts) {
        await pendingUserRepository.deleteById(pending.id, client);
        return { status: 'too_many_attempts' };
      }

      const matches = safeEqualHex(hashVerificationCode(email, code), pending.codeHash);
      if (!matches) {
        const attempts = await pendingUserRepository.incrementAttempts(client, pending.id);
        if (attempts >= maxAttempts) {
          await pendingUserRepository.deleteById(pending.id, client);
          return { status: 'too_many_attempts' };
        }
        return { status: 'invalid', attemptsRemaining: maxAttempts - attempts };
      }

      const user = await userRepository.create(
        { username: pending.username, email: pending.email, passwordHash: pending.passwordHash },
        client
      );
      await pendingUserRepository.deleteById(pending.id, client);
      return { status: 'verified', user };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      // Someone else completed registration for this email in the meantime.
      await pendingUserRepository.deleteByEmail(email).catch(() => {});
      throw new AppError(409, 'Email already registered');
    }
    throw err;
  }

  switch (outcome.status) {
    case 'verified':
      return { user: basicUser(outcome.user), token: signAuthToken(outcome.user) };
    case 'not_found':
      throw new AppError(404, 'No pending registration found. Please register again.', {
        reason: 'not_found',
      });
    case 'expired':
      throw new AppError(400, 'Verification code has expired. Please register again.', {
        reason: 'expired',
      });
    case 'too_many_attempts':
      throw new AppError(429, 'Too many incorrect attempts. Please register again.', {
        reason: 'too_many_attempts',
      });
    default:
      throw new AppError(400, 'Incorrect verification code.', {
        reason: 'invalid',
        attemptsRemaining: outcome.attemptsRemaining,
      });
  }
}

async function login({ email, password }) {
  const user = await userRepository.findByEmail(email);
  const hash = user ? user.passwordHash : await dummyHashPromise;
  const passwordMatches = await bcrypt.compare(password, hash);

  if (!user || !passwordMatches) {
    throw new AppError(401, 'Invalid email or password');
  }
  return { user: basicUser(user), token: signAuthToken(user) };
}

async function getCurrentUser(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(401, 'Account no longer exists');
  return { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt };
}

module.exports = { register, verifyEmail, login, getCurrentUser };
