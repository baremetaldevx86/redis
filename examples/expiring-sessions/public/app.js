(() => {
  'use strict';

  // The API uses an HTTP-only cookie. No token is read from, stored in, or
  // rendered by this client.
  // These are the canonical routes exposed by the service. The browser only
  // sends the cookie automatically; it never needs to know its bearer token.
  const API = Object.freeze({
    login: '/auth/demo-login',
    session: '/session',
    renew: '/session/renew',
    protectedAction: '/protected',
    logout: '/session',
    health: '/health/ready'
  });

  const RESYNC_INTERVAL_MS = 10000;
  const EXPIRING_THRESHOLD_MS = 30000;
  const REQUEST_TIMEOUT_MS = 10000;

  const elements = {
    loginCard: document.getElementById('login-card'),
    loginForm: document.getElementById('login-form'),
    userId: document.getElementById('user-id'),
    deviceLabel: document.getElementById('device-label'),
    loginButton: document.getElementById('login-button'),
    loginError: document.getElementById('login-error'),
    sessionCard: document.getElementById('session-card'),
    sessionStatusBadge: document.getElementById('session-status-badge'),
    sessionStatusMessage: document.getElementById('session-status-message'),
    sessionUser: document.getElementById('session-user'),
    sessionDevice: document.getElementById('session-device'),
    sessionCreated: document.getElementById('session-created'),
    sessionAbsoluteExpiry: document.getElementById('session-absolute-expiry'),
    countdown: document.getElementById('countdown'),
    progress: document.getElementById('expiry-progress'),
    protectedButton: document.getElementById('protected-button'),
    renewButton: document.getElementById('renew-button'),
    logoutButton: document.getElementById('logout-button'),
    actionResult: document.getElementById('action-result'),
    serviceStatusBadge: document.getElementById('service-status-badge'),
    serviceStatusMessage: document.getElementById('service-status-message')
  };

  const state = {
    session: null,
    observedAt: 0,
    ttlMs: 0,
    progressTotalMs: 0,
    status: 'signed-out',
    busy: false,
    syncInFlight: false,
    serviceAvailable: null,
    timer: null
  };

  function setText(element, value) {
    // Keeping all API-derived values on textContent prevents markup injection.
    element.textContent = value == null || value === '' ? '—' : String(value);
  }

  function setHidden(element, hidden) {
    element.hidden = hidden;
  }

  function setMessage(element, message, kind) {
    // Messages intentionally allow an empty value so stale errors disappear.
    element.textContent = message == null ? '' : String(message);
    element.classList.toggle('message-error', kind === 'error');
    element.classList.toggle('message-success', kind === 'success');
    element.classList.toggle('message-warning', kind === 'warning');
  }

  function setBusy(button, busy, busyLabel) {
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent;
    }
    button.disabled = busy;
    setText(button, busy ? busyLabel : button.dataset.defaultLabel);
  }

  function getErrorMessage(error, fallback) {
    if (error && error.status === 503) {
      return 'The session service is unavailable (Redis may be unavailable). Try again shortly.';
    }
    if (error && error.status === 401) {
      return 'This session is no longer authenticated. Sign in again.';
    }
    if (error && error.status === 403) {
      return 'The service denied this action for the current session.';
    }
    if (error && error.userMessage && !/^(service_unavailable|unauthorized|forbidden)$/i.test(error.userMessage)) {
      return error.userMessage;
    }
    if (error && error.name === 'AbortError') {
      return 'The session service did not respond in time. Check that Redis and the API are running.';
    }
    if (error && error instanceof TypeError) {
      return 'The session service could not be reached. Check that the API and Redis are running.';
    }
    return fallback || 'The session service returned an unexpected error.';
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = new Headers(options.headers || {});
    let body = options.body;

    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, {
        ...options,
        body,
        headers,
        credentials: 'same-origin',
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      let payload = null;
      if (response.status !== 204) {
        if (contentType.includes('application/json')) {
          payload = await response.json();
        } else {
          const text = await response.text();
          payload = text ? { message: text } : null;
        }
      }
      if (!response.ok) {
        const error = new Error('API request failed');
        error.status = response.status;
        error.payload = payload;
        const message = payload && (payload.message || payload.error);
        if (message && typeof message === 'string') {
          error.userMessage = message;
        }
        throw error;
      }
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dateValue(value) {
    if (value == null || value === '') {
      return null;
    }
    const number = numberOrNull(value);
    if (number !== null) {
      // API timestamps are normally milliseconds; accept seconds as well.
      return number < 100000000000 ? number * 1000 : number;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sessionFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const value = payload.session && typeof payload.session === 'object'
      ? payload.session
      : payload;
    if (value.authenticated === false || value.loggedIn === false) {
      return null;
    }
    // The API contract returns ttlMs next to session. These aliases also make
    // the dashboard useful with a session payload carrying its own TTL.
    const ttlMs = numberOrNull(payload.ttlMs) ?? numberOrNull(value.ttlMs);
    const idleTimeoutMs = numberOrNull(payload.idleTimeoutMs)
      ?? numberOrNull(value.idleTimeoutMs)
      ?? numberOrNull(payload.sessionIdleTimeoutMs)
      ?? numberOrNull(value.sessionIdleTimeoutMs);
    const maxTtlMs = numberOrNull(payload.maxTtlMs) ?? numberOrNull(value.maxTtlMs);
    const createdAt = dateValue(value.createdAt ?? value.createdAtMs);
    const absoluteExpiresAt = dateValue(
      value.absoluteExpiresAt ?? value.absoluteExpiry ?? value.expiresAt
    );

    return {
      userId: value.userId ?? value.user ?? value.id,
      deviceLabel: value.deviceLabel ?? value.device ?? value.deviceName,
      createdAt,
      absoluteExpiresAt,
      ttlMs,
      idleTimeoutMs,
      maxTtlMs
    };
  }

  function payloadTtl(payload, session) {
    return numberOrNull(payload && payload.ttlMs)
      ?? numberOrNull(session && session.ttlMs)
      ?? numberOrNull(payload && payload.remainingTtlMs)
      ?? numberOrNull(session && session.remainingTtlMs);
  }

  function sessionRemainingMs(now = Date.now()) {
    if (!state.session || !state.observedAt) {
      return 0;
    }
    return Math.max(0, state.ttlMs - (now - state.observedAt));
  }

  function statusForRemaining(remaining) {
    if (!state.session) {
      return 'signed-out';
    }
    if (remaining <= 0) {
      return 'expired';
    }
    return remaining <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'active';
  }

  function statusLabel(status) {
    return {
      'signed-out': 'Signed out',
      active: 'Active',
      expiring: 'Expiring soon',
      expired: 'Expired'
    }[status] || 'Unknown';
  }

  function formatDuration(milliseconds) {
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
    }
    return `${remainder}s`;
  }

  function formatDate(milliseconds) {
    if (!milliseconds) {
      return '—';
    }
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium'
      }).format(new Date(milliseconds));
    } catch (_error) {
      return new Date(milliseconds).toLocaleString();
    }
  }

  function updateSessionDetails() {
    const session = state.session;
    setText(elements.sessionUser, session && session.userId);
    setText(elements.sessionDevice, session && session.deviceLabel);
    setText(elements.sessionCreated, session && formatDate(session.createdAt));
    setText(elements.sessionAbsoluteExpiry, session && formatDate(session.absoluteExpiresAt));
  }

  function updateServiceStatus(available, message) {
    state.serviceAvailable = available;
    const label = available === true ? 'Available' : available === false ? 'Unavailable' : 'Unknown';
    elements.serviceStatusBadge.dataset.state = available === true ? 'available' : available === false ? 'unavailable' : 'unknown';
    setText(elements.serviceStatusBadge, label);
    setText(elements.serviceStatusMessage, message);
  }

  function renderClock() {
    const remaining = sessionRemainingMs();
    state.status = statusForRemaining(remaining);
    const hasSession = Boolean(state.session);
    const total = state.progressTotalMs > 0 ? state.progressTotalMs : 1;
    const percentage = hasSession ? Math.min(100, Math.max(0, remaining / total * 100)) : 0;

    elements.sessionStatusBadge.dataset.state = state.status;
    elements.sessionCard.dataset.state = state.status;
    setText(elements.sessionStatusBadge, statusLabel(state.status));
    elements.progress.value = percentage;
    elements.progress.setAttribute('aria-valuetext', hasSession ? `${formatDuration(remaining)} remaining` : 'No active session');
    setText(elements.countdown, hasSession ? formatDuration(remaining) : '—');

    if (!hasSession) {
      setText(elements.sessionStatusMessage, 'Sign in to begin.');
    } else if (state.status === 'active') {
      setText(elements.sessionStatusMessage, 'Your session is active.');
    } else if (state.status === 'expiring') {
      setText(elements.sessionStatusMessage, 'Your session is expiring soon. Renew it before it expires.');
    } else {
      setText(elements.sessionStatusMessage, 'Your session has expired. Renewal cannot recreate a deleted session; sign in again.');
    }

    elements.protectedButton.disabled = state.busy || state.status === 'signed-out' || state.status === 'expired';
    elements.renewButton.disabled = state.busy || state.status === 'signed-out';
    elements.logoutButton.disabled = state.busy || state.status === 'signed-out';
  }

  function applySession(payload, options = {}) {
    const session = sessionFromPayload(payload);
    const ttlMs = session && payloadTtl(payload, session);
    if (!session || ttlMs === null || ttlMs <= 0) {
      state.session = null;
      state.ttlMs = 0;
      state.progressTotalMs = 0;
      state.observedAt = 0;
      updateSessionDetails();
      renderClock();
      return false;
    }

    const knownTotal = session.idleTimeoutMs ?? session.maxTtlMs;
    const nextTotal = numberOrNull(knownTotal);
    // Keep the original scale when a periodic lookup reports a smaller TTL.
    // A renewal gets a fresh scale because it intentionally starts a new idle
    // timeout window.
    if (options.resetProgress || state.progressTotalMs <= 0) {
      state.progressTotalMs = nextTotal && nextTotal > 0 ? Math.max(nextTotal, ttlMs) : ttlMs;
    } else if (nextTotal && nextTotal > state.progressTotalMs) {
      state.progressTotalMs = nextTotal;
    }
    state.session = session;
    state.ttlMs = ttlMs;
    state.observedAt = Date.now();
    updateSessionDetails();
    renderClock();
    return true;
  }

  function clearLocalSession() {
    state.session = null;
    state.ttlMs = 0;
    state.progressTotalMs = 0;
    state.observedAt = 0;
    state.status = 'signed-out';
    updateSessionDetails();
    renderClock();
  }

  function markExpired() {
    if (!state.session) {
      return;
    }
    state.ttlMs = 0;
    state.observedAt = Date.now();
    state.status = 'expired';
    renderClock();
  }

  function showSessionCard(show) {
    setHidden(elements.sessionCard, !show);
    setHidden(elements.loginCard, show);
  }

  async function syncSession(options = {}) {
    if (state.syncInFlight) {
      return;
    }
    state.syncInFlight = true;
    try {
      const payload = await request(API.session, { method: 'GET' });
      if (applySession(payload)) {
        showSessionCard(true);
        updateServiceStatus(true, 'The API and session store are responding.');
      } else {
        clearLocalSession();
        showSessionCard(false);
        updateServiceStatus(true, 'The API is available. No active session is signed in.');
      }
      if (!options.silent) {
        setMessage(elements.actionResult, '', null);
      }
    } catch (error) {
      if (error.status === 401) {
        updateServiceStatus(true, 'The API is available. No active session is signed in.');
        if (state.session) {
          markExpired();
        } else {
          clearLocalSession();
          showSessionCard(false);
        }
      } else {
        updateServiceStatus(false, getErrorMessage(error, 'The session service is unavailable.'));
        if (error.status === 404 && state.session) {
          markExpired();
        }
      }
      if (!options.silent && error.status !== 401) {
        setMessage(elements.actionResult, getErrorMessage(error, 'Could not load the current session.'), 'error');
      }
    } finally {
      state.syncInFlight = false;
    }
  }

  async function syncHealth(options = {}) {
    try {
      await request(API.health, { method: 'GET' });
      updateServiceStatus(true, 'The API and Redis session store are ready.');
    } catch (error) {
      updateServiceStatus(false, getErrorMessage(error, 'The session service or Redis is unavailable.'));
      if (!options.silent) {
        setMessage(elements.actionResult, getErrorMessage(error, 'The session service is not ready.'), 'error');
      }
    }
  }

  async function resync(options = {}) {
    await syncSession(options);
    await syncHealth(options);
  }

  async function login(event) {
    event.preventDefault();
    setMessage(elements.loginError, '', null);
    const userId = elements.userId.value.trim();
    const deviceLabel = elements.deviceLabel.value.trim() || 'Browser demo';
    if (!userId) {
      setMessage(elements.loginError, 'Enter a user ID to sign in.', 'error');
      elements.userId.focus();
      return;
    }

    setBusy(elements.loginButton, true, 'Signing in…');
    try {
      const payload = await request(API.login, {
        method: 'POST',
        body: { userId, deviceLabel }
      });
      if (!applySession(payload, { resetProgress: true })) {
        // Some APIs set the cookie and return no session body. Load it through
        // the normal lookup without ever exposing cookie contents.
        await syncSession();
      } else {
        showSessionCard(true);
        updateServiceStatus(true, 'The API and session store are responding.');
        setMessage(elements.actionResult, 'Signed in successfully.', 'success');
      }
    } catch (error) {
      updateServiceStatus(false, getErrorMessage(error, 'The session service is unavailable.'));
      setMessage(elements.loginError, getErrorMessage(error, 'Sign-in failed.'), 'error');
    } finally {
      setBusy(elements.loginButton, false, 'Signing in…');
      renderClock();
    }
  }

  async function renew() {
    setMessage(elements.actionResult, '', null);
    setBusy(elements.renewButton, true, 'Renewing…');
    state.busy = true;
    renderClock();
    try {
      const payload = await request(API.renew, { method: 'POST' });
      if (!applySession(payload, { resetProgress: true })) {
        throw new Error('The service did not return a renewed session.');
      }
      updateServiceStatus(true, 'The session was renewed by the service.');
      setMessage(elements.actionResult, 'Session renewed. The countdown has restarted.', 'success');
    } catch (error) {
      updateServiceStatus(false, getErrorMessage(error, 'The session could not be renewed.'));
      if (error.status === 401 || error.status === 404) {
        markExpired();
      }
      setMessage(elements.actionResult, getErrorMessage(error, 'Renewal failed; sign in again if the session expired.'), 'error');
    } finally {
      state.busy = false;
      setBusy(elements.renewButton, false, 'Renewing…');
      renderClock();
    }
  }

  async function protectedAction() {
    setMessage(elements.actionResult, '', null);
    setBusy(elements.protectedButton, true, 'Calling…');
    state.busy = true;
    renderClock();
    try {
      const payload = await request(API.protectedAction, { method: 'GET' });
      updateServiceStatus(true, 'The API and session store are responding.');
      const message = payload && (payload.message || payload.result || payload.data);
      setMessage(elements.actionResult, typeof message === 'string' ? message : 'Protected action succeeded.', 'success');
    } catch (error) {
      updateServiceStatus(false, getErrorMessage(error, 'The protected action failed.'));
      if (error.status === 401 || error.status === 404) {
        markExpired();
      }
      setMessage(elements.actionResult, getErrorMessage(error, 'The protected action failed.'), 'error');
    } finally {
      state.busy = false;
      setBusy(elements.protectedButton, false, 'Calling…');
      renderClock();
    }
  }

  async function logout() {
    setMessage(elements.actionResult, '', null);
    setBusy(elements.logoutButton, true, 'Logging out…');
    state.busy = true;
    renderClock();
    try {
      await request(API.logout, { method: 'DELETE' });
      updateServiceStatus(true, 'The session was logged out.');
      clearLocalSession();
      showSessionCard(false);
      setMessage(elements.loginError, 'You are signed out.', 'success');
      elements.userId.focus();
    } catch (error) {
      updateServiceStatus(false, getErrorMessage(error, 'The session service is unavailable.'));
      setMessage(elements.actionResult, getErrorMessage(error, 'Log out failed.'), 'error');
    } finally {
      state.busy = false;
      setBusy(elements.logoutButton, false, 'Logging out…');
      renderClock();
    }
  }

  function startClock() {
    const tick = () => {
      renderClock();
      state.timer = window.setTimeout(tick, 250);
    };
    tick();
  }

  elements.loginForm.addEventListener('submit', login);
  elements.renewButton.addEventListener('click', renew);
  elements.protectedButton.addEventListener('click', protectedAction);
  elements.logoutButton.addEventListener('click', logout);
  window.setInterval(() => resync({ silent: true }), RESYNC_INTERVAL_MS);
  startClock();
  resync();
})();
