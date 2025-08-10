// popup.js
document.addEventListener('DOMContentLoaded', async () => {
    const loginSection = document.getElementById('login-section');
    const registerSection = document.getElementById('register-section');
    const verifyEmailSection = document.getElementById('verify-email-section');
    const dashboardSection = document.getElementById('dashboard-section');

    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const verifyEmailForm = document.getElementById('verify-email-form');

    const loginMessage = document.getElementById('login-message');
    const registerMessage = document.getElementById('register-message');
    const verifyEmailMessage = document.getElementById('verify-email-message');

    const dashboardUsername = document.getElementById('dashboard-username');
    const serverStatusIndicator = document.getElementById('server-status-indicator');
    const serverStatusText = document.getElementById('server-status-text');
    const successfulSentCount = document.getElementById('successful-sent-count');
    const queueCountDisplay = document.getElementById('queue-count');

    const logoutButton = document.getElementById('logout-button');
    const consentPuDebug = document.getElementById('consent-pu-debug');

    const queueRemoveButton = document.getElementById('queue-remove-button')

    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const resendCodeLink = document.getElementById('resend-code');
    const backToLoginFromVerifyLink = document.getElementById('back-to-login-from-verify');
    const showVerifyEmailFromLoginLink = document.getElementById('show-verify-email-from-login');

    function showMessage(element, message, type = 'info') {
        element.textContent = message;
        element.className = `message-box ${type}`;
        element.classList.remove('hidden');
    }

    function showSection(sectionId) {
        loginSection.classList.add('hidden');
        registerSection.classList.add('hidden');
        verifyEmailSection.classList.add('hidden');
        dashboardSection.classList.add('hidden');
        document.getElementById(sectionId).classList.remove('hidden');
    }

    async function updateDashboardStats() {
        const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
        if (response) {
            successfulSentCount.textContent = response.successfulSentCount;
            queueCountDisplay.textContent = response.queueCount;

            // Update server status indicator
            if (response.serverReachable) {
                serverStatusIndicator.classList.remove('status-offline');
                serverStatusIndicator.classList.add('status-online');
                serverStatusText.textContent = 'Online';
                serverStatusText.classList.remove('text-red-400');
                serverStatusText.classList.add('text-green-400');
            } else {
                serverStatusIndicator.classList.remove('status-online');
                serverStatusIndicator.classList.add('status-offline');
                serverStatusText.textContent = 'Offline';
                serverStatusText.classList.remove('text-green-400');
                serverStatusText.classList.add('text-red-400');
            }
        }
    }

    async function checkLoginStatus() {
        const response = await chrome.runtime.sendMessage({ type: 'CHECK_AUTH_STATUS' });
        if (response && response.loggedIn) {
            showSection('dashboard-section');
            dashboardUsername.textContent = response.username;
            consentPuDebug.checked = response.puDebugEnabled;
            updateDashboardStats();
            setInterval(updateDashboardStats, 2000); // Update stats every 2 seconds / rework this to work with each batch send to return server status
        } else {
            showSection('login-section');
        }
    }

    // Handle login form submission
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = loginForm.username.value;
        const password = loginForm.password.value;

        showMessage(loginMessage, 'Logging in...', 'info');

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'LOGIN',
                payload: { username, password }
            });

            if (response.success) {
                showMessage(loginMessage, 'Login successful!', 'success');
                await checkLoginStatus(); // Update UI
            } else {
                // Handle unverified email response
                if (response.needs_email_verification && response.email) {
                    showMessage(loginMessage, response.message, 'warning');
                    document.getElementById('verify-email-input').value = response.email; // Pre-fill email
                    showSection('verify-email-section');
                } else {
                    showMessage(loginMessage, response.message || 'Login failed.', 'error');
                }
            }
        } catch (error) {
            console.error('Login request failed:', error);
            showMessage(loginMessage, 'An error occurred during login. Please check server connection.', 'error');
        }
    });

    // Handle registration form submission
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = registerForm.username.value;
        const email = registerForm['register-email'].value;
        const password = registerForm.password.value;

        showMessage(registerMessage, 'Registering...', 'info');

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'REGISTER',
                payload: { username, email, password }
            });

            if (response.success) {
                showMessage(registerMessage, response.message, 'success');
                registerForm.reset();
                document.getElementById('verify-email-input').value = email; // Pre-fill email for verification
                showSection('verify-email-section');
            } else {
                showMessage(registerMessage, response.message || 'Registration failed.', 'error');
            }
        } catch (error) {
            console.error('Registration request failed:', error);
            showMessage(registerMessage, 'An error occurred during registration. Please check server connection.', 'error');
        }
    });

    // Handle email verification form submission
    verifyEmailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = verifyEmailForm['verify-email-input'].value;
        const code = verifyEmailForm['verification-code'].value;

        showMessage(verifyEmailMessage, 'Verifying email...', 'info');

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'VERIFY_EMAIL',
                payload: { email, code }
            });

            if (response.success) {
                showMessage(verifyEmailMessage, response.message, 'success');
                verifyEmailForm.reset();
                showSection('login-section');
            } else {
                showMessage(verifyEmailMessage, response.message || 'Verification failed.', 'error');
            }
        } catch (error) {
            console.error('Email verification request failed:', error);
            showMessage(verifyEmailMessage, 'An error occurred during verification. Please check server connection.', 'error');
        }
    });

    // Handle logout button click
    logoutButton.addEventListener('click', async () => {
        try {
            await chrome.runtime.sendMessage({ type: 'LOGOUT' });
            showMessage(loginMessage, 'Logged out successfully.', 'info');
            await checkLoginStatus();
        } catch (error) {
            console.error('Logout request failed:', error);
            showMessage(loginMessage, 'An error occurred during logout.', 'error');
        }
    });

    queueRemoveButton.addEventListener('click', async () => {
        try {
            await chrome.runtime.sendMessage({ type: 'QUEUEREMOVE'});
            console.log('Removed messages queue!');
        } catch (error) {
            console.error('Remove message queue failed', error);
        }
    })



    // Handle pu-debug consent checkbox change
    consentPuDebug.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'SET_PU_DEBUG_CONSENT',
                payload: { enabled }
            });
            if (response.success) {
                console.log(`PrUn Debugging ${enabled ? 'enabled' : 'disabled'}.`);
            } else {
                console.error('Failed to set pu-debug consent:', response.message);
            }
        } catch (error) {
            console.error('Error setting pu-debug consent:', error);
        }
    });

    // Event listeners for switching forms
    showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        showSection('register-section');
        loginMessage.classList.add('hidden');
    });

    showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        showSection('login-section');
        registerMessage.classList.add('hidden');
        verifyEmailMessage.classList.add('hidden');
    });

    resendCodeLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const email = document.getElementById('verify-email-input').value;
        if (!email) {
            showMessage(verifyEmailMessage, 'Please enter your email to resend the code.', 'warning');
            return;
        }
        showMessage(verifyEmailMessage, 'Resending code...', 'info');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'RESEND_VERIFICATION_CODE',
                payload: { email }
            });
            if (response.success) {
                showMessage(verifyEmailMessage, response.message, 'success');
            } else {
                showMessage(verifyEmailMessage, response.message || 'Failed to resend code.', 'error');
            }
        } catch (error) {
            console.error('Resend code request failed:', error);
            showMessage(verifyEmailMessage, 'An error occurred while resending code. Please check server connection.', 'error');
        }
    });

    backToLoginFromVerifyLink.addEventListener('click', (e) => {
        e.preventDefault();
        showSection('login-section');
        verifyEmailMessage.classList.add('hidden');
    });

    showVerifyEmailFromLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        showSection('verify-email-section');
        loginMessage.classList.add('hidden');
    });

    // Initial check
    checkLoginStatus();
});
