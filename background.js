const SERVER_URL = '';
const DATA_SERVER_URL = '';

const BATCH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 10;
const QUEUE_DB_NAME = 'prunDataQueue';
const QUEUE_STORE_NAME = 'dataItems';
const SERVER_CHECK_INTERVAL_MS = 10000;

const TOKEN_LIFESPAN_SECONDS_CLIENT_SIDE_ESTIMATE = 31536000;

let isSending = false;
let auth_token = null;
let username = null;
let auth_token_expires_at = null;
let puDebugEnabled = false;

let successfulSentCount = 0;
let messagesInQueueCount = 0;
let serverReachable = false;

// --- IndexedDB Setup ---
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(QUEUE_DB_NAME, 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
                db.createObjectStore(QUEUE_STORE_NAME, { autoIncrement: true });
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error('IndexedDB error:', event.target.errorCode);
            reject(event.target.error);
        };
    });
}

async function addToIndexedDB(item) {
    const db = await openDb();
    const transaction = db.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.add(item);
        request.onsuccess = () => {
            console.log('[Background] Added item to IndexedDB.');
            messagesInQueueCount++;
            resolve();
        };
        request.onerror = () => {
            console.error('[Background] Failed to add item to IndexedDB:', request.error);
            reject(request.error);
        };
    });
}

async function getFromIndexedDB() {
    const db = await openDb();
    const transaction = db.transaction([QUEUE_STORE_NAME], 'readonly');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            console.log(`[Background] Retrieved ${request.result.length} items from IndexedDB.`);
            resolve(request.result);
        };
        request.onerror = () => {
            console.error('[Background] Failed to get items from IndexedDB:', request.error);
            reject(request.error);
        };
    });
}

async function clearIndexedDB(keys) {
    if (keys.length === 0) {
        console.log('[Background] No keys to clear from IndexedDB.');
        return;
    }
    const db = await openDb();
    const transaction = db.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    return new Promise((resolve, reject) => {
        const deletePromises = keys.map(key => {
            return new Promise((res, rej) => {
                const request = store.delete(key);
                request.onsuccess = () => res();
                request.onerror = () => rej(request.error);
            });
        });
        Promise.all(deletePromises)
            .then(() => {
                console.log(`[Background] Cleared ${keys.length} items from IndexedDB.`);
                updateQueueCountFromDb();
                resolve();
            })
            .catch(error => {
                console.error('[Background] Error clearing IndexedDB:', error);
                reject(error);
            });
    });
}

async function wipeIndexedDB() {
    const db = await openDb();
    const transaction = db.transaction([QUEUE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);

    return new Promise((resolve, reject) => {
        const request = store.clear();

        request.onsuccess = () => {
            console.log(`[Background] Cleared all items from IndexedDB.`);
            updateQueueCountFromDb();
            resolve();
        };

        request.onerror = () => {
            console.error('[Background] Error clearing IndexedDB: ', request.error);
            reject(request.error);
        };
    });
}

async function updateQueueCountFromDb() {
    const db = await openDb();
    const transaction = db.transaction([QUEUE_STORE_NAME], 'readonly');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    return new Promise((resolve) => {
        const request = store.count();
        request.onsuccess = () => {
            messagesInQueueCount = request.result;
            console.log(`[Background] Updated messagesInQueueCount: ${messagesInQueueCount}`);
            resolve();
        };
        request.onerror = () => {
            console.error('[Background] Failed to get IndexedDB count:', request.error);
            messagesInQueueCount = 0;
            resolve();
        };
    });
}


// --- Server Reachability Check ---
let serverCheckIntervalId = null;
async function checkServerStatus() {
    try {
        const response = await fetch(`${DATA_SERVER_URL}/status`, { method: 'GET', signal: AbortSignal.timeout(5000) });
        if (response.ok) {
            serverReachable = true;
            console.log('[Background] Server is reachable.');
        } else {
            serverReachable = false;
            console.warn(`[Background] Server responded with status ${response.status}. Considering it unreachable.`);
        }
    } catch (error) {
        serverReachable = false;
        console.error('[Background] Server is unreachable (network error or timeout):', error.message);
    }
}

function startServerChecker() {
    if (serverCheckIntervalId) {
        clearInterval(serverCheckIntervalId);
    }
    serverCheckIntervalId = setInterval(checkServerStatus, SERVER_CHECK_INTERVAL_MS);
    checkServerStatus();
    console.log('[Background] Server checker started.');
}

function stopServerChecker() {
    if (serverCheckIntervalId) {
        clearInterval(serverCheckIntervalId);
        serverCheckIntervalId = null;
        console.log('[Background] Server checker stopped.');
    }
}


// --- Authentication Functions ---
async function registerUser(username_input, email_input, password_input) {
    console.log('[Background] Attempting registration for:', username_input, email_input);
    try {
        const response = await fetch(`${SERVER_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username_input, email: email_input, password: password_input })
        });
        const data = await response.json();
        if (response.ok) {
            console.log('[Background] Registration response:', data);
            return { success: data.success, message: data.message };
        } else {
            console.error('[Background] Registration failed:', data.message);
            return { success: false, message: data.message || `Registration failed with status: ${response.status}` };
        }
    } catch (error) {
        console.error('[Background] Registration fetch error:', error);
        return { success: false, message: `Network error: ${error.message}. Server might be offline.` };
    }
}

async function verifyEmail(email_input, code_input) {
    console.log('[Background] Attempting email verification for:', email_input);
    try {
        const response = await fetch(`${SERVER_URL}/verify_email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email_input, code: code_input })
        });
        const data = await response.json();
        if (response.ok) {
            console.log('[Background] Email verification response:', data);
            return { success: data.success, message: data.message };
        } else {
            console.error('[Background] Email verification failed:', data.message);
            return { success: false, message: data.message || `Verification failed with status: ${response.status}` };
        }
    } catch (error) {
        console.error('[Background] Email verification fetch error:', error);
        return { success: false, message: `Network error: ${error.message}. Server might be offline.` };
    }
}

async function resendVerificationCode(email_input) {
    console.log('[Background] Attempting to resend verification code for:', email_input);
    try {
        const response = await fetch(`${SERVER_URL}/resend_verification_code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email_input })
        });
        const data = await response.json();
        if (response.ok) {
            console.log('[Background] Resend code response:', data);
            return { success: data.success, message: data.message };
        } else {
            console.error('[Background] Resend code failed:', data.message);
            return { success: false, message: data.message || `Resend failed with status: ${response.status}` };
        }
    } catch (error) {
        console.error('[Background] Resend code fetch error:', error);
        return { success: false, message: `Network error: ${error.message}. Server might be offline.` };
    }
}


async function loginUser(username_input, password_input) {
    console.log('[Background] Attempting login for:', username_input);
    try {
        const response = await fetch(`${SERVER_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username_input, password: password_input })
        });
        const data = await response.json();
        if (response.ok && data.success) {
            auth_token = data.token;
            username = data.username;
            auth_token_expires_at = data.expires_at;
            await chrome.storage.local.set({ auth_token, username, auth_token_expires_at });
            startBatchSender();
            console.log('[Background] Login successful. Token and expiration stored.');
            serverReachable = true;
            return { success: true, message: 'Logged in successfully!' };
        } else {
            console.error('[Background] Login failed:', data.message);
            serverReachable = false;
            return { success: false, message: data.message || `Login failed with status: ${response.status}` };
        }
    } catch (error) {
        console.error('[Background] Login fetch error:', error);
        serverReachable = false;
        return { success: false, message: `Network error: ${error.message}. Server might be offline.` };
    }
}

async function logoutUser() {
    console.log('[Background] Logging out user.');
    auth_token = null;
    username = null;
    auth_token_expires_at = null;
    await chrome.storage.local.remove(['auth_token', 'username', 'auth_token_expires_at']);
    stopBatchSender();
    console.log('[Background] Logout successful. Token removed.');
    return { success: true };
}

// --- Data Queuing and Sending ---
async function sendBatch() {
    console.log('[Background] sendBatch called (for regular messages).');
    if (isSending) {
        console.log('[Background] Already sending a batch. Skipping this call.');
        return;
    }

    if (!auth_token || !username) {
        console.warn('[Background] Not authenticated. Skipping sendBatch.');
        await updateQueueCountFromDb();
        return;
    }

    isSending = true;
    let itemsToSend = [];
    let keysToDelete = [];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const db = await openDb();
        const transaction = db.transaction([QUEUE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_STORE_NAME);
        const cursorRequest = store.openCursor();

        await new Promise((resolve, reject) => {
            cursorRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && itemsToSend.length < MAX_BATCH_SIZE) {
                    itemsToSend.push(cursor.value);
                    keysToDelete.push(cursor.key);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            cursorRequest.onerror = (event) => reject(event.target.error);
        });

        if (itemsToSend.length === 0) {
            console.log('[Background] No items to send in batch.');
            isSending = false;
            return;
        }

        console.log(`[Background] Attempting to send batch of ${itemsToSend.length} regular items to ${DATA_SERVER_URL}/data_batch`);
        itemsToSend.forEach(item => {
            console.log(item)
        });

        const response = await fetch(`${DATA_SERVER_URL}/data_batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${auth_token}`
            },
            body: JSON.stringify({
                data: itemsToSend,
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
            const responseData = await response.json();
            console.log('[Background] Batch sent successfully!');
            successfulSentCount += itemsToSend.length;
            serverReachable = true;

            if (responseData.new_token && responseData.new_expires_at) {
                auth_token = responseData.new_token;
                auth_token_expires_at = responseData.new_expires_at;
                await chrome.storage.local.set({ auth_token, auth_token_expires_at });
                console.log('[Background] Token refreshed successfully. New expiration:', new Date(auth_token_expires_at * 1000));
            }

            if (keysToDelete.length > 0) {
                console.log(responseData.arrived_ids)
                console.log(keysToDelete)
                //keysToDelete.map(key => response.arrived_ids.contains(key))
                await clearIndexedDB(keysToDelete);
            }
        } else if (response.status === 401) {
            console.error('[Background] Batch sending failed: Unauthorized (401). Token might be expired or invalid. Data remains in queue.');
            serverReachable = true;
        } else {
            console.error('Failed to send batch:', response.status, response.statusText, 'Data remains in queue.');
            serverReachable = false;
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            console.warn('[Background] Batch sending timed out (10s). Data remains in queue for retry.');
        } else {
            console.error('[Background] Network error sending batch:', error);
        }
        serverReachable = false;
    } finally {
        isSending = false;
        await updateQueueCountFromDb();
    }
}

// Function to send initial state immediately
async function sendInitialState(context, nextState) {
    if (!auth_token || !username) {
        console.warn('[Background] Not authenticated. Skipping initial state upload.');
        return;
    }
    console.log('[Background] Attempting to send initial state to /initial_state_upload.');

    try {
        const response = await fetch(`${DATA_SERVER_URL}/initial_state_upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${auth_token}`
            },
            body: JSON.stringify({
                context: context,
                initialState: nextState
            })
        });

        if (response.ok) {
            const responseData = await response.json();
            console.log('[Background] Initial state sent successfully!', responseData);
            serverReachable = true; // Server is reachable
            if (responseData.new_token && responseData.new_expires_at) {
                auth_token = responseData.new_token;
                auth_token_expires_at = responseData.new_expires_at;
                await chrome.storage.local.set({ auth_token, auth_token_expires_at });
                console.log('[Background] Token refreshed during initial state upload. New expiration:', new Date(auth_token_expires_at * 1000));
            }
        } else if (response.status === 401) {
            console.error('[Background] Initial state upload failed: Unauthorized (401). Token might be expired or invalid.');
            serverReachable = true;
        } else {
            console.error('[Background] Failed to send initial state:', response.status, response.statusText);
            serverReachable = false;
        }
    } catch (error) {
        console.error('[Background] Network error sending initial state:', error);
        serverReachable = false;
    }
}


let batchIntervalId = null;
function startBatchSender() {
    if (batchIntervalId) {
        clearInterval(batchIntervalId);
    }
    batchIntervalId = setInterval(sendBatch, BATCH_INTERVAL_MS);
    console.log('[Background] Batch sender started.');
}

function stopBatchSender() {
    if (batchIntervalId) {
        clearInterval(batchIntervalId);
        batchIntervalId = null;
        console.log('[Background] Batch sender stopped.');
    }
}

// --- Cookie Management for pu-debug ---
async function setPuDebugCookie(enabled) {
    puDebugEnabled = enabled;
    await chrome.storage.local.set({ puDebugEnabled });
    console.log(`[Background] Stored puDebugEnabled in chrome.storage.local: ${enabled}`);

    const cookieValue = enabled ? 'true' : 'false';
    const cookieUrl = 'https://apex.prosperousuniverse.com';

    try {
        await chrome.cookies.set({
            url: cookieUrl,
            name: 'pu-debug',
            value: cookieValue,
            expirationDate: (Date.now() / 1000) + (365 * 24 * 60 * 60)
        });
        console.log(`[Background] pu-debug cookie set to "${cookieValue}" for ${cookieUrl}.`);
    } catch (error) {
        console.error('[Background] Error setting pu-debug cookie:', error);
    }
}

// --- Message Listener from Popup and Content Scripts ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Check if the message is from a content script (game page)
    if (sender.tab && sender.tab.url && sender.tab.url.startsWith('https://apex.prosperousuniverse.com')) {
        console.log(`[Background] Received message from content script (Tab ID: ${sender.tab.id}, Type: ${request.type})`);
        if (request.type === 'PRUN_DATA_CAPTURED_BATCH') {
            if (auth_token && username) {
                console.log(request.payload)
                addToIndexedDB(request.payload).then(() => {
                    console.log('[Background] Data added to IndexedDB. Triggering sendBatch.');
                    sendBatch();
                    sendResponse({ success: true, message: 'Data received by background script.' });
                }).catch(error => {
                    console.error('[Background] Failed to add data to IndexedDB:', error);
                    sendResponse({ success: false, message: 'Failed to queue data locally.' });
                });
                return true;
            } else {
                console.warn('[Background] Data captured but user not logged in. Skipping data processing.');
                sendResponse({ success: false, message: 'User not logged in. Data not processed.' });
            }
        } else if (request.type === 'INITIAL_STATE_UPLOAD') {
            sendInitialState(request.payload.context, request.payload.nextState).then(() => {
                sendResponse({ success: true, message: 'Initial state processing initiated.' });
            }).catch(error => {
                console.error('[Background] Error processing INITIAL_STATE_UPLOAD:', error);
                sendResponse({ success: false, message: 'Failed to process initial state upload.' });
            });
            return true;
        }
    } else {
        console.log(`[Background] Received message from popup (Type: ${request.type})`);
        switch (request.type) {
            case 'REGISTER':
                registerUser(request.payload.username, request.payload.email, request.payload.password).then(sendResponse);
                return true;
            case 'VERIFY_EMAIL':
                verifyEmail(request.payload.email, request.payload.code).then(sendResponse);
                return true;
            case 'RESEND_VERIFICATION_CODE':
                resendVerificationCode(request.payload.email).then(sendResponse);
                return true;
            case 'LOGIN':
                loginUser(request.payload.username, request.payload.password).then(sendResponse);
                return true;
            case 'LOGOUT':
                logoutUser().then(sendResponse);
                return true;
            case 'QUEUEREMOVE':
                wipeIndexedDB()
                sendResponse({
                    success: true
                })
            case 'CHECK_AUTH_STATUS':
                sendResponse({
                    loggedIn: !!auth_token,
                    username: username,
                    puDebugEnabled: puDebugEnabled
                });
                break;
            case 'SET_PU_DEBUG_CONSENT':
                setPuDebugCookie(request.payload.enabled).then(() => sendResponse({ success: true }));
                return true;
            case 'GET_STATS':
                sendResponse({
                    successfulSentCount: successfulSentCount,
                    queueCount: messagesInQueueCount,
                    serverReachable: serverReachable
                });
                break;
        }
    }
});

// --- Initialization on Service Worker Startup ---
async function initialize() {
    console.log('[Background] Initializing service worker.');
    const storedData = await chrome.storage.local.get(['auth_token', 'username', 'puDebugEnabled', 'auth_token_expires_at']);
    auth_token = storedData.auth_token || null;
    username = storedData.username || null;
    puDebugEnabled = storedData.puDebugEnabled || false;
    auth_token_expires_at = storedData.auth_token_expires_at || null;

    console.log(`[Background] Initial state: LoggedIn=${!!auth_token}, Username=${username}, PuDebugEnabled=${puDebugEnabled}, ExpiresAt=${auth_token_expires_at ? new Date(auth_token_expires_at * 1000) : 'N/A'}`);

    startServerChecker();

    await updateQueueCountFromDb();

    if (auth_token) {
        startBatchSender();
    }

    console.log('[Background] Checking IndexedDB for unsent data on startup.');
    sendBatch();
}

initialize();
