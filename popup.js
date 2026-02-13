document.addEventListener('DOMContentLoaded', async () => {
  // ====== Sections ======
  const loginSection = document.getElementById('login-section');
  const registerSection = document.getElementById('register-section');
  const verifyEmailSection = document.getElementById('verify-email-section');
  const dashboardSection = document.getElementById('dashboard-section');
  const settingsSection = document.getElementById('settings-section');

  // ====== Forms ======
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const verifyEmailForm = document.getElementById('verify-email-form');

  // ====== Message boxes ======
  const loginMessage = document.getElementById('login-message');
  const registerMessage = document.getElementById('register-message');
  const verifyEmailMessage = document.getElementById('verify-email-message');

  // ====== Dashboard elements ======
  const dashboardUsername = document.getElementById('dashboard-username');
  const successfulSentCountEl = document.getElementById('successful-sent-count');
  const queueCountDisplay = document.getElementById('queue-count');

  // ====== Controls ======
  const logoutButton = document.getElementById('logout-button');
  const consentPuDebug = document.getElementById('consent-pu-debug');
  const queueRemoveButton = document.getElementById('queue-remove-button');
  const saveSettingsButton = document.getElementById('save-settings-button');

  // ====== Navigation links ======
  const showRegisterLink = document.getElementById('show-register');
  const showLoginLink = document.getElementById('show-login');
  const showVerifyEmailFromLoginLink = document.getElementById('show-verify-email-from-login');
  const backToLoginFromVerifyLink = document.getElementById('back-to-login-from-verify');
  const showSettingsFromDashboardLink = document.getElementById('show-settings-from-dashboard');
  const showSettingsFromLoginLink = document.getElementById('show-settings-from-login');
  const backToDashboardFromSettingsLink = document.getElementById('back-to-dashboard-from-settings');

  // ====== Server status displays ======
  const serverStatusIndicators = {
    login: document.getElementById('server-status-indicator-login'),
    dashboard: document.getElementById('server-status-indicator'),
    settings: document.getElementById('server-status-indicator-settings'),
    register: document.getElementById('server-status-indicator-register'),
    verify: document.getElementById('server-status-indicator-verify'),
  };
  const serverStatusTexts = {
    login: document.getElementById('server-status-text-login'),
    dashboard: document.getElementById('server-status-text'),
    settings: document.getElementById('server-status-text-settings'),
    register: document.getElementById('server-status-text-register'),
    verify: document.getElementById('server-status-text-verify'),
  };

  let onMessageListener;

  // ====== Utilities ======
  function showSection(sectionId) {
    [loginSection, registerSection, verifyEmailSection, dashboardSection, settingsSection].forEach(sec => {
      if (sec) sec.classList.add('hidden');
    });
    const sectionToShow = document.getElementById(sectionId);
    if (sectionToShow) sectionToShow.classList.remove('hidden');
  }

  function showMessage(element, message, type) {
    if (!element) return;
    element.textContent = message;
    element.className = `message-box mt-4 visible ${type || ''}`;
    element.classList.remove('hidden');
}


  function updateAllStatusDisplays(isReachable, text) {
    Object.keys(serverStatusIndicators).forEach(key => {
      if (serverStatusIndicators[key]) {
        serverStatusIndicators[key].classList.toggle('bg-green-500', isReachable);
        serverStatusIndicators[key].classList.toggle('bg-red-500', !isReachable);
      }
    });
    Object.keys(serverStatusTexts).forEach(key => {
      if (serverStatusTexts[key]) serverStatusTexts[key].textContent = text;
    });
  }

  // ====== Auth + Stats ======
  async function safeSendMessage(type, payload) {
    try {
      return await browser.runtime.sendMessage({ type, payload });
    } catch (err) {
      console.warn(`[Popup] Failed to send message ${type}:`, err);
      return undefined;
    }
  }

  async function getAuthStatus() {
    // Check localStorage first
    const storedUser = localStorage.getItem('pu_username');
    const localAuth = storedUser ? { isLoggedIn: true, username: storedUser } : { isLoggedIn: false };

    // Then check background (fail-safe)
    const bgResponse = await safeSendMessage('GET_AUTH_STATUS');
    if (bgResponse && typeof bgResponse.isLoggedIn !== 'undefined') {
      if (bgResponse.isLoggedIn && bgResponse.username) {
        localStorage.setItem('pu_username', bgResponse.username);
      }
      return bgResponse;
    }

    return localAuth;
  }

  async function checkLoginStatus() {
    const response = await getAuthStatus();
    if (response.isLoggedIn) {
      dashboardUsername.textContent = response.username || 'User';
      showSection('dashboard-section');
    } else {
      showSection('login-section');
    }
  }

  async function updateDashboardStats(queueCount) {
    const stats = await safeSendMessage('GET_STATS');
    if (!stats) return; // fail silently if background busy
    successfulSentCountEl.textContent = stats.successfulSentCount ?? 0;
    queueCountDisplay.textContent = queueCount ?? stats.queueCount ?? 0;
  }

  // ====== Settings ======
  async function renderMessageTypeSettings() {
    const container = document.getElementById('message-type-settings-container');
    if (!container) return;

    // Clear and show loading text safely
    container.textContent = 'Loading settings...';
    container.classList.add('text-gray-500');

    const settings = await safeSendMessage('GET_MESSAGE_TYPE_SETTINGS');
    if (!settings) return;

    // Clear container
    container.textContent = '';
    container.classList.remove('text-gray-500');

    Object.keys(settings).sort().forEach(type => {
        const isChecked = settings[type];

        // Label wrapper
        const label = document.createElement('label');
        label.className = 'flex items-center justify-between text-gray-300 cursor-pointer';

        // Span for type name
        const spanType = document.createElement('span');
        spanType.textContent = type;

        // Toggle wrapper
        const toggleWrapper = document.createElement('div');
        toggleWrapper.className = 'toggle-switch';

        // Checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.type = type;
        checkbox.checked = !!isChecked;
        checkbox.className = 'hidden';

        // Slider span
        const slider = document.createElement('span');
        slider.className = 'slider';

        toggleWrapper.appendChild(checkbox);
        toggleWrapper.appendChild(slider);

        label.appendChild(spanType);
        label.appendChild(toggleWrapper);

        container.appendChild(label);
    });
}


  async function saveMessageSettings() {
    const checkboxes = document.querySelectorAll('#message-type-settings-container input[type="checkbox"]');
    const settings = {};
    checkboxes.forEach(cb => settings[cb.dataset.type] = cb.checked);
    const response = await safeSendMessage('SAVE_MESSAGE_TYPE_SETTINGS', { settings });
    showMessage(document.getElementById('settings-message'), 
                response?.success ? 'Settings saved successfully!' : 'Failed to save settings.', 
                response?.success ? 'success' : 'error');
  }

  // ====== Event Listeners ======
  loginForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const username = e.target.username.value;
    const password = e.target.password.value;
    const response = await safeSendMessage('LOGIN', { username, password });
    if (response?.success) checkLoginStatus();
    else showMessage(loginMessage, response?.message || 'Login failed', 'error');
  });

  registerForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const username = e.target.username.value;
    const password = e.target.password.value;
    const email = e.target.email.value;
    const response = await safeSendMessage('REGISTER', { username, password, email });
    showMessage(registerMessage, response?.message || 'Error', response?.success ? 'success' : 'error');
    if (response?.success) showSection('verify-email-section');
  });

  verifyEmailForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = e.target.email.value;
    const code = e.target.code.value;
    const response = await safeSendMessage('VERIFY_EMAIL', { email, code });
    showMessage(verifyEmailMessage, response?.message || 'Error', response?.success ? 'success' : 'error');
    if (response?.success) await checkLoginStatus();
  });

  logoutButton?.addEventListener('click', async () => {
    await safeSendMessage('LOGOUT');
    localStorage.removeItem('pu_username');
    checkLoginStatus();
  });

  consentPuDebug?.addEventListener('change', async e => {
    await safeSendMessage('TOGGLE_DEBUG', { enabled: e.target.checked });
  });

  queueRemoveButton?.addEventListener('click', async () => {
    await safeSendMessage('REMOVE_ALL_QUEUE_ITEMS');
  });

  showRegisterLink?.addEventListener('click', e => { e.preventDefault(); showSection('register-section'); });
  showLoginLink?.addEventListener('click', e => { e.preventDefault(); showSection('login-section'); });
  showVerifyEmailFromLoginLink?.addEventListener('click', e => { e.preventDefault(); showSection('verify-email-section'); });
  backToLoginFromVerifyLink?.addEventListener('click', e => { e.preventDefault(); showSection('login-section'); });
  showSettingsFromDashboardLink?.addEventListener('click', e => { e.preventDefault(); showSection('settings-section'); renderMessageTypeSettings(); });
  showSettingsFromLoginLink?.addEventListener('click', e => { e.preventDefault(); showSection('settings-section'); renderMessageTypeSettings(); });
  backToDashboardFromSettingsLink?.addEventListener('click', e => { e.preventDefault(); showSection('dashboard-section'); });
  saveSettingsButton?.addEventListener('click', saveMessageSettings);

  // ====== Background push updates ======
  onMessageListener = msg => {
    if (!msg?.type) return;
    if (msg.type === 'SERVER_STATUS_UPDATED') {
      updateAllStatusDisplays(!!msg.serverReachable, msg.serverReachable ? 'Online' : 'Offline');
      updateDashboardStats(msg.queueCount);
    } else if (msg.type === 'AUTH_STATUS_UPDATED') {
      checkLoginStatus();
    } else if (msg.type === 'QUEUE_COUNT_UPDATED') {
      updateDashboardStats(msg.queueCount);
    }
  };
  browser.runtime.onMessage.addListener(onMessageListener);

  // ====== Initial load ======
  await checkLoginStatus();
  await updateDashboardStats();

  try {
    const forced = await safeSendMessage('FORCE_SERVER_CHECK');
    updateAllStatusDisplays(!!forced?.serverReachable, forced?.serverReachable ? 'Online' : 'Offline');
  } catch (e) {
    console.warn('Initial server check failed:', e);
  }

  window.addEventListener('unload', () => {
    if (onMessageListener) browser.runtime.onMessage.removeListener(onMessageListener);
  });
});
