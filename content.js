const runtime = (typeof browser !== 'undefined') ? browser : chrome;

// ---- Config ----
const FLUSH_DEBOUNCE_MS = 100;
const LOGIN_TIMEOUT_MS = 5000;
const PORT_NAME = 'prun_keep_alive';
const HEARTBEAT_MS = 10_000; // send a keepalive every 10s

// ---- State ----
let bgPort = null;
let portConnected = false;
let portReconnectTimer = null;

let localMessageQueue = [];
let flushTimeout = null;
let isUserLoggedIn = false;
let loginStatusConfirmed = false;
let messageBuffer = [];

let currentMessageTypeSettings = {};
let currentMessageTypeSettingsAlwaysSend = [];
const queuedFingerprints = new Set();

// ---- Utilities ----
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
function computeMessageFingerprint(msg) {
  return (msg?.messageType || '') + ':' + JSON.stringify(msg?.payload || {});
}

runtime.runtime.onMessage.addListener((request) => {
    if (request.type === "FORCE_FLUSH") {
        console.log("[Content] Background requested a force flush.");
        flushLocalQueueToBackground();
    }
});

// ---- Ensure port connection ----
function ensurePort() {
  if (bgPort && portConnected) return;
  try {
    bgPort = runtime.runtime.connect({ name: PORT_NAME });
    portConnected = true;
    
    // Force background wakeup
    bgPort.postMessage({ type: 'KEEPALIVE' }); 
    
    bgPort.onMessage.addListener(handlePortMessage);
    bgPort.onDisconnect.addListener(() => {
      portConnected = false;
      bgPort = null;
      if (portReconnectTimer) clearTimeout(portReconnectTimer);
      portReconnectTimer = setTimeout(ensurePort, 1000); // Reconnect attempts
    });
  } catch (e) {
    console.error('[Content] Connection failed', e);
  }
}

// ---- Port message handler ----
function handlePortMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'PRUN_DATA_CAPTURED_BATCH_ACK':
      {
        const ackIds = new Set(msg.successfullyQueuedIds || []);
        // Remove acked items from local queue
        localMessageQueue = localMessageQueue.filter(item => !ackIds.has(item.id));
        // Remove fingerprints for acked items
        for (const id of ackIds) {
          // best-effort: we cannot reconstruct fingerprint easily without item; so we cleaned on dequeue
        }
        isUserLoggedIn = !!msg.isUserLoggedIn;
        break;
      }
    case 'ALIVE':
      // background responded to keepalive
      break;
    case 'LOGIN_STATUS':
      isUserLoggedIn = !!msg.isLoggedIn;
      loginStatusConfirmed = true;
      if (isUserLoggedIn) {
        fetchMessageTypeSettings().then(() => {
          for (const m of messageBuffer) processMessage(m);
          messageBuffer = [];
          if (localMessageQueue.length > 0) flushLocalQueueToBackground();
        });
      } else {
        messageBuffer = [];
      }
      break;
    default:
      // console.debug('[Content] Unknown port msg', msg);
  }
}

// ---- Fetch message type settings via sendMessage fallback ----
async function fetchMessageTypeSettings() {
  try {
    const s = await runtime.runtime.sendMessage({ type: 'GET_MESSAGE_TYPE_SETTINGS' }).catch(() => undefined);
    if (s && typeof s === 'object') {
      currentMessageTypeSettings = s;
    }

    const always = await runtime.runtime.sendMessage({ type: 'GET_MESSAGE_TYPE_SETTINGS_ALWAYS_SEND' }).catch(() => undefined);
    
    // ENSURE IT IS AN ARRAY:
    if (Array.isArray(always)) {
      currentMessageTypeSettingsAlwaysSend = always;
    } else if (always && typeof always === 'object') {
      // If the background accidentally sent an object, convert values/keys to array or reset to empty
      currentMessageTypeSettingsAlwaysSend = Object.values(always); 
    } else {
      currentMessageTypeSettingsAlwaysSend = []; // Fallback to empty array
    }

  } catch (e) {
    console.warn('[Content] fetchMessageTypeSettings failed', e);
    currentMessageTypeSettingsAlwaysSend = []; // Safety fallback
  }
}

// ---- Safe login check w/ timeout ----
async function safeGetLoginStatus() {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Login status timed out')), LOGIN_TIMEOUT_MS));
  const sendMsg = runtime.runtime.sendMessage({ type: 'GET_LOGIN_STATUS' }).catch(()=>undefined);
  try {
    const resp = await Promise.race([sendMsg, timeout]);
    if (!resp || typeof resp.isLoggedIn === 'undefined') return { isLoggedIn: false };
    return resp;
  } catch (e) {
    return { isLoggedIn: false };
  }
}

// ---- Initialize content ----
async function initializeContentScript() {
  ensurePort(); 
  
  // Use a simple sendMessage to "poke" the background script awake
  runtime.runtime.sendMessage({ type: 'GET_LOGIN_STATUS' })
    .then(resp => {
      isUserLoggedIn = !!resp?.isLoggedIn;
      loginStatusConfirmed = true;
      if (isUserLoggedIn) fetchMessageTypeSettings();
    })
    .catch(() => {
      // If background is still sleeping, try again in 2 seconds
      setTimeout(initializeContentScript, 2000);
    });
}
initializeContentScript();

// ---- Heartbeat to keep background alive while tab is open ----
setInterval(() => {
  try {
    ensurePort();
    if (bgPort && portConnected) bgPort.postMessage({ type: 'KEEPALIVE' });
  } catch (e) { /* ignore */ }
}, HEARTBEAT_MS);

// ---- In-page message listener (from injected script) ----
function windowMessageListener(event) {
  if (event.source !== window || !event.data || !event.data.type) return;
  if (event.data.type === 'prun-ws-message-parsed') {
    const message = event.data.message;
    
    // If we aren't ready, keep buffering!
    if (!loginStatusConfirmed || !portConnected) {
      messageBuffer.push(message);
      ensurePort(); // Try to wake it up again
      return;
    }
    
    processMessage(message);
  }
}
window.addEventListener('message', windowMessageListener);

// ---- message type predicate ----
function shouldSendMessageType(messageType) {
  if (Array.isArray(currentMessageTypeSettingsAlwaysSend) && currentMessageTypeSettingsAlwaysSend.includes(messageType)) {
    return true;
  }
  
  if (!currentMessageTypeSettings || Object.keys(currentMessageTypeSettings).length === 0) return true;
  if (currentMessageTypeSettings.hasOwnProperty(messageType)) return currentMessageTypeSettings[messageType] === true;
  return false;
}

// ---- processMessage (dedupe + queue) ----
function processMessage(message) {
  if (!isUserLoggedIn) return;
  if (!message || !message.messageType) return;

  let processedPayload = message;
  if (processedPayload.messageType === 'ACTION_COMPLETED') {
    if (message?.payload?.message) {
      processedPayload = { ...message.payload.message, context: message.context };
    } else return;
  }

  if (!processedPayload.payload) return;

  const fingerprint = computeMessageFingerprint(processedPayload);
  if (queuedFingerprints.has(fingerprint)) return;
  
  // Track fingerprint
  queuedFingerprints.add(fingerprint);
  // Auto-expire fingerprint after 10s to keep memory clean
  setTimeout(() => queuedFingerprints.delete(fingerprint), 10000);

  const itemToQueue = {
    id: generateUniqueId(),
    context: message.context,
    message: {
      messageType: processedPayload.messageType,
      payload: JSON.parse(JSON.stringify(processedPayload.payload)),
      context: processedPayload.context
    }
  };

  if (!shouldSendMessageType(itemToQueue.message.messageType)) return;

  localMessageQueue.push(itemToQueue);

  if (flushTimeout) clearTimeout(flushTimeout);
  flushTimeout = setTimeout(flushLocalQueueToBackground, FLUSH_DEBOUNCE_MS);
}

// ---- flushing to background via port (preferred) ----
function flushLocalQueueToBackground() {
  if (flushTimeout) { clearTimeout(flushTimeout); flushTimeout = null; }
  if (localMessageQueue.length === 0) return;

  const messagesToSend = [...localMessageQueue];

  ensurePort();
  
  if (bgPort && portConnected) {
    try {
      // Send the batch
      bgPort.postMessage({ type: 'PRUN_DATA_CAPTURED_BATCH', payload: messagesToSend });
      
      return; 
    } catch (e) {
      console.warn('[Content] Port postMessage failed, falling back', e);
      portConnected = false;
    }
  }

  // Fallback to sendMessage if port is dead
  runtime.runtime.sendMessage({ type: 'PRUN_DATA_CAPTURED_BATCH', payload: messagesToSend })
    .then(response => {
      if (response && response.success) {
        const ackIds = new Set(response.successfullyQueuedIds || []);
        localMessageQueue = localMessageQueue.filter(item => !ackIds.has(item.id));
      }
    }).catch(() => {});
}

// ---- helpers used above ----
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
function computeMessageFingerprint(msg) {
  return (msg?.messageType || '') + ':' + JSON.stringify(msg?.payload || {});
}

// ---- cleanup on unload ----
window.addEventListener('unload', () => {
  if (flushTimeout) clearTimeout(flushTimeout);
  window.removeEventListener('message', windowMessageListener);
  try { if (bgPort) bgPort.disconnect(); } catch (e) {}
});

// ---- inject in-page scripts (module) ----
(function injectScripts() {
  try {
    const decoderScript = document.createElement('script');
    decoderScript.src = chrome.runtime.getURL('prun-message-decoder.js');
    decoderScript.type = 'module';
    (document.head || document.documentElement).appendChild(decoderScript);
    decoderScript.onload = function() {
      const injectedScript = document.createElement('script');
      injectedScript.src = chrome.runtime.getURL('injected-script.js');
      injectedScript.type = 'module';
      (document.head || document.documentElement).appendChild(injectedScript);
      injectedScript.onload = () => setTimeout(() => {
        try { decoderScript.remove(); } catch (e) {}
        try { injectedScript.remove(); } catch (e) {}
      }, 50);
      injectedScript.onerror = (e) => console.error('[Content] injected-script.js load error', e);
    };
    decoderScript.onerror = (e) => console.error('[Content] prun-message-decoder.js load error', e);
  } catch (e) {
    console.error('[Content] injectScripts failed', e);
  }
})();