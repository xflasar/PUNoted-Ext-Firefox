// ------------------ Initialization Logic ------------------
let resolveInitializationPromise;
const initializationPromise = new Promise((res) => {
	resolveInitializationPromise = res;
});

// ------------------ Config & State ------------------
const SERVER_URL = "https://api.punoted.net/auth";
const DATA_SERVER_URL = "https://api.punoted.net";
const QUEUE_DB_NAME = "prunDataQueue";
const QUEUE_STORE_NAME = "dataItems";
const MAX_PAYLOAD_SIZE = 15 * 1024 * 1024; // 15,728,640 bytes
const MIN_INTERVAL = 500;
const MAX_INTERVAL = 10000;

let auth_token = null;
let username = null;
let puDebugEnabled = false;
let messageTypeSettings = {};

let messagesInQueueCount = 0;
let serverReachable = false;

const idSet = new Set();
let isSending = false;
let lastRequestDuration = 0;
let currentBatchInterval = 1000;
let batchIntervalId = null;

const encoder = new TextEncoder();

// --- Message Type Groups ---
const HARDCODED_IGNORED_MESSAGE_TYPES = [
	"SYSTEM_TRAFFIC_SHIP",
	"CHANNEL_DATA",
	"CHANNEL_UNSEEN_MESSAGES_COUNT",
	"TUTORIAL_TUTORIALS",
	"ALERTS_ALERTS",
	"UI_STACKS_STACKS",
	"UI_DATA",
	"CHANNEL_USER_LIST",
	"CHANNEL_MESSAGE_LIST",
	"PRESENCE_LIST",
	"FCM_SUBSCRIPTION_UPDATE",
	"SYSTEM_DATA_UPDATED",
	"PLANET_DATA_UPDATED",
	"LEADERBOARD_UPDATED",
	"NOTIFICATIONS_CONFIG",
	"SYSTEM_TRAFFIC",
	"ALERTS_ALERT",
	"CONTRACT_DRAFTS_DRAFTS",
	"CONTRACTS_PARTNERS",
	"CHANNEL_CLIENT_MEMBERSHIP",
	"COMEX_TICKER_INVALID",
	"SHIP_FLIGHT_MISSION",
	"CHANNEL_STARTED_TYPING",
	"CHANNEL_STOPPED_TYPING",
	"CHANNEL_MESSAGE_ADDED",
	"UI_SCREENS_SET_STATE",
	"ALERTS_ALERTS_DELETED",
	"CHANNEL_USER_LEFT",
	"CONTRACT_DRAFTS_DRAFT",
	"CORPORATION_MANAGER_INVITE",
	"CORPORATION_MANAGER_INVITES",
	"CHANNEL_MESSAGE_DELETED",
	"UI_TILES_REMOVE",
	"UI_TILES_CHANGE_SIZE",
	"CHANNEL_USER_JOINED",
	"SYSTEM_TRAFFIC_SHIP_REMOVED",
];

const HARDCODED_ALWAYS_SEND_MESSAGE_TYPES = [
	"USER_DATA",
	"COMPANY_DATA",
	"SITE_SITES",
	"STORAGE_STORAGES",
	"WAREHOUSE_STORAGES",
	"SHIP_SHIPS",
	"WORKFORCE_WORKFORCES",
];

const USER_CONTROLLABLE_MESSAGE_TYPES_DEFAULTS = {
	STORAGE_CHANGE: true,
	WORKFORCE_CHANGE: true,
	ACTION_COMPLETED: true,
	DATA_DATA: true,
	ACCOUNTING_CASH_BALANCES: true,
	CORPORATION_SHAREHOLDER_HOLDINGS: true,
	SHIP_FLIGHT_FLIGHTS: true,
	CONTRACTS_CONTRACTS: true,
	PLANET_DATA: true,
	PRODUCTION_SITE_PRODUCTION_LINES: true,
	COMEX_TRADER_ORDERS: true,
	POPULATION_AVAILABLE_RESERVE_WORKFORCE: true,
	FOREX_TRADER_ORDERS: true,
	SHIPYARD_PROJECTS: true,
	BLUEPRINT_BLUEPRINTS: true,
	PRODUCTION_ORDER_REMOVED: true,
	PRODUCTION_ORDER_UPDATED: true,
	ACCOUNTING_BOOKINGS: true,
	PRODUCTION_ORDER_ADDED: true,
	COMEX_EXCHANGE_BROKER_LIST: true,
	COMEX_BROKER_DATA: true,
	DATA_AGGREGATION_DATA: true,
	PRODUCTION_PRODUCTION_LINES: true,
	EXPERTS_EXPERTS: true,
	CORPORATION_DATA: true,
	CORPORATION_PROJECTS_DATA: true,
	SHIP_FLIGHT_FLIGHT_ENDED: true,
	SHIP_DATA: true,
	SHIP_FLIGHT_FLIGHT: true,
	COMEX_TRADER_ORDER_DELETION_TERMS: true,
	COMEX_TRADER_ORDER_REMOVED: true,
	SITE_NO_SITE: true,
	AUTH_AUTHENTICATED: true,
	SITE_SITE: true,
	USER_STARTING_PROFILE_DATA: true,
	PRODUCTION_PRODUCTION_LINE_UPDATED: true,
	WORKFORCE_WORKFORCES_UPDATED: true,
	SITE_PLATFORM_UPDATED: true,
	COUNTRY_AGENT_DATA: true,
	CONTRACTS_CONTRACT: true,
	COMEX_TRADER_ORDER_UPDATED: true,
	COMEX_TRADER_ORDER_ADDED: true,
	LEADERBOARD_SCORES: true,
	COMEX_BROKER_NEW_PRICE: true,
	COMEX_BROKER_PRICES: true,
	ACCOUNTING_BALANCES: true,
	ACCOUNTING_CASH_BOOKINGS: true,
	WAREHOUSE_STORAGE: true,
	SITE_PLATFORM_BUILT: true,
	ADMIN_CENTER_CLIENT_VOTING_DATA: true,
	SHIPYARD_PROJECT: true,
	BLUEPRINT_BLUEPRINT: true,
	STORAGE_REMOVED: true,
	SERVER_CONNECTION_OPENED: true,
};

// ------------------ Listeners ------------------

// 1. Install/Update Listener
browser.runtime.onInstalled.addListener((details) => {
	if (details.reason === "install") {
		// Automatically open the website to trigger the web_sync
		browser.tabs.create({ url: "https://punoted.net/" });
	}
});

// 2. Watchdog Alarm (Passive Autosync)
browser.alarms.create("pulse", { periodInMinutes: 1 });

browser.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === "pulse") {
		await initializationPromise;

		console.log("[Background] Pulse check - Queue size:", messagesInQueueCount);

		await checkServerStatus();

		if (auth_token && serverReachable && messagesInQueueCount > 0) {
			console.log("[Background] Alarm-triggered batch run started.");
			runBatch();
		}
	}
});

browser.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === "queueWatchdog") {
		await initializationPromise; // Ensure DB and Auth are loaded
		if (messagesInQueueCount > 0 && auth_token && serverReachable) {
			console.log("[Background] Watchdog flushing queue...");
			runBatch(); // Process the bulk data
		}
	}
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
	await initializationPromise;
	// When user switch tabs, tell all tabs to flush their local buffers
	const tabs = await browser.tabs.query({
		url: "*://apex.prosperousuniverse.com/*",
	});
	for (const tab of tabs) {
		browser.tabs.sendMessage(tab.id, { type: "FORCE_FLUSH" }).catch(() => {});
	}

	// Also trigger a batch run just in case
	if (auth_token && messagesInQueueCount > 0) {
		runBatch();
	}
});

// 3. Port Listener (Game Communication)
browser.runtime.onConnect.addListener((port) => {
	if (!port || port.name !== "prun_keep_alive") return;
	port.onMessage.addListener(async (msg) => {
		await initializationPromise;
		try {
			if (msg.type === "PRUN_DATA_CAPTURED_BATCH") {
				const payload = Array.isArray(msg.payload) ? msg.payload : [];
				const ackIds = [];
				for (const item of payload) {
					const mType = item?.message?.messageType;
					let shouldSend =
						HARDCODED_ALWAYS_SEND_MESSAGE_TYPES.includes(mType) ||
						messageTypeSettings[mType] === true;
					if (shouldSend && auth_token && username) {
						await addToIndexedDB(item);
						ackIds.push(item.id);
					}
				}
				port.postMessage({
					type: "PRUN_DATA_CAPTURED_BATCH_ACK",
					success: true,
					successfullyQueuedIds: ackIds,
					isUserLoggedIn: !!auth_token,
				});
				if (auth_token && serverReachable && !batchIntervalId)
					startBatchSender();
			} else if (msg.type === "KEEPALIVE") {
				port.postMessage({ type: "ALIVE" });
			}
		} catch (err) {
			console.error("[Background] Port Error:", err);
		}
	});
});

// 4. Message Listener (Popup & Web Sync Bridge)
browser.runtime.onMessage.addListener(async (request, sender) => {
	await initializationPromise;

	// Handle Logic for Web Sync Bridge (from punoted.ddns.net)
	if (request.type === "SYNC_FROM_WEB") {
		// request.payload.token comes from your web_sync.js content script
		const success = await syncWithWebToken(request.payload.token);
		return { success };
	}

	// Handle Logic for Popup or Game Tab
	switch (request.type) {
		case "GET_LOGIN_STATUS":
			return { isLoggedIn: !!auth_token };
		case "GET_AUTH_STATUS":
			return { isLoggedIn: !!auth_token, username, puDebugEnabled };
		case "LOGIN":
			return loginUser(request.payload.username, request.payload.password);
		case "LOGOUT":
			return logoutUser();
		case "FORCE_SERVER_CHECK":
			await checkServerStatus();
			return { serverReachable, messagesInQueueCount };
		case "QUEUEREMOVE":
			await clearEntireQueue();
			return { success: true };
		case "SET_MESSAGE_TYPE_SETTINGS":
			Object.assign(messageTypeSettings, request.payload || {});
			await browser.storage.local.set({ messageTypeSettings });
			return { success: true };
		case "GET_MESSAGE_TYPE_SETTINGS":
			return messageTypeSettings;
		case "GET_MESSAGE_TYPE_SETTINGS_ALWAYS_SEND":
			return HARDCODED_ALWAYS_SEND_MESSAGE_TYPES;
		default:
			return { success: false };
	}
});

// ------------------ Core Functions ------------------

const EXTENSION_HEADER = { "X-Extension-Client": "PrunDataExtension-Firefox" };

async function syncWithWebToken(webToken) {
	try {
		console.log("[Background] Attempting extension_sync with web token...");

		const res = await fetch(`${SERVER_URL}/extension_sync`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${webToken}`,
				...EXTENSION_HEADER,
			},
		});

		const data = await res.json();

		if (res.ok && data.success) {
			// 1. Update memory
			auth_token = data.token;
			username = data.username;

			// 2. Update storage
			await browser.storage.local.set({
				auth_token: data.token,
				username: data.username,
			});

			// 3. Update UI and State
			serverReachable = true;
			browser.runtime
				.sendMessage({
					type: "AUTH_STATUS_UPDATED",
					isLoggedIn: true,
					username: data.username,
				})
				.catch(() => {});

			startBatchSender();
			console.log("[Background] Extension sync successful for:", data.username);
			return true;
		} else {
			console.warn(
				"[Background] Extension sync rejected by server:",
				data.message,
			);
		}
	} catch (e) {
		console.error("[Background] Sync failed error:", e);
	}
	return false;
}

async function runBatch() {
  if (isSending || !auth_token || !serverReachable) return;
  isSending = true;
  const start = Date.now();

  try {
    const db = await openDb();
    const tx = db.transaction([QUEUE_STORE_NAME], "readonly");
    const store = tx.objectStore(QUEUE_STORE_NAME);

    // 1. Fetch window (increased to 1000 to allow filling the 15MB batch better)
    const allItems = await new Promise((r) => {
      const items = [];
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && items.length < 1000) {
          items.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        } else r(items);
      };
    });

    if (allItems.length === 0) {
      isSending = false;
      return;
    }

    // 2. Greedy Batch Construction
    let batch = [];
    let batchSizeBytes = 2; // Initial [] brackets
    let keysInBatch = [];
    let itemsProcessed = 0;

    for (const item of allItems) {
      const serialized = JSON.stringify(item.value);
      const itemBytes = encoder.encode(serialized).length;

      // Single item check
      if (itemBytes > MAX_PAYLOAD_SIZE) {
        console.warn("[Sync] Dropping monster message", item.key);
        await clearIndexedDB([item.key]);
        itemsProcessed++; // Mark as seen to skip in next slicing
        continue;
      }

      // Check if adding this exceeds 15MB (item + comma)
      if (batchSizeBytes + itemBytes + 1 > MAX_PAYLOAD_SIZE) {
        // If batch is full, stop adding and send what we have
        break;
      }

      batch.push(item.value);
      keysInBatch.push(item.key);
      batchSizeBytes += itemBytes + 1;
      itemsProcessed++;
    }

    if (batch.length === 0) {
      // This only happens if all items were skipped/monster messages
      isSending = false;
      if (itemsProcessed < allItems.length) setTimeout(runBatch, 1000);
      return;
    }

    // 3. Send the single safe batch
    const compressedBody = await gzipPayload({ data: batch });
    const resp = await fetch(
      `${DATA_SERVER_URL}/data_batch?conn=${encodeURIComponent(username)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth_token}`,
          "Content-Encoding": "gzip",
          "Content-Type": "application/json",
        },
        body: compressedBody,
      },
    );

    if (resp.ok) {
      await clearIndexedDB(keysInBatch);
      // If we didn't finish the queue or reached the cursor limit, run again
      if (allItems.length >= 1000 || itemsProcessed < allItems.length) {
        setTimeout(runBatch, 1000);
      }
    } else if (resp.status === 400 || resp.status === 408) {
      console.error(`[Sync] Server error ${resp.status}. Clearing batch.`);
      await clearIndexedDB(keysInBatch);
      setTimeout(runBatch, 1000);
    } else if (resp.status === 401 || resp.status === 403) {
      await logoutUser();
    } else {
      serverReachable = false;
    }
  } catch (e) {
    serverReachable = false;
    console.error("[Sync] Runtime error", e);
  } finally {
    lastRequestDuration = Date.now() - start;
    adjustBatchInterval();
    isSending = false;
  }
}

// ------------------ Helpers ------------------

async function gzipPayload(payload) {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
			controller.close();
		},
	}).pipeThrough(new CompressionStream("gzip"));
	return await new Response(stream).arrayBuffer();
}

function openDb() {
	return new Promise((res, rej) => {
		const req = indexedDB.open(QUEUE_DB_NAME, 1);
		req.onupgradeneeded = (e) =>
			e.target.result.createObjectStore(QUEUE_STORE_NAME, {
				autoIncrement: true,
			});
		req.onsuccess = (e) => res(e.target.result);
		req.onerror = (e) => rej(e.target.error);
	});
}

async function addToIndexedDB(item) {
	if (!item?.id || idSet.has(item.id)) return;
	const db = await openDb();
	db
		.transaction([QUEUE_STORE_NAME], "readwrite")
		.objectStore(QUEUE_STORE_NAME)
		.add(item).onsuccess = () => {
		idSet.add(item.id);
		messagesInQueueCount++;
		browser.runtime
			.sendMessage({
				type: "QUEUE_COUNT_UPDATED",
				queueCount: messagesInQueueCount,
			})
			.catch(() => {});
	};
}

async function clearIndexedDB(keys) {
	const db = await openDb();
	const tx = db.transaction([QUEUE_STORE_NAME], "readwrite");
	const store = tx.objectStore(QUEUE_STORE_NAME);
	keys.forEach((k) => store.delete(k));
	messagesInQueueCount = Math.max(0, messagesInQueueCount - keys.length);
	browser.runtime
		.sendMessage({
			type: "QUEUE_COUNT_UPDATED",
			queueCount: messagesInQueueCount,
		})
		.catch(() => {});
}

async function clearEntireQueue() {
	const db = await openDb();
	db.transaction([QUEUE_STORE_NAME], "readwrite")
		.objectStore(QUEUE_STORE_NAME)
		.clear();
	idSet.clear();
	messagesInQueueCount = 0;
	browser.runtime
		.sendMessage({ type: "QUEUE_COUNT_UPDATED", queueCount: 0 })
		.catch(() => {});
}

async function loginUser(u, p) {
	try {
		const resp = await fetch(`${SERVER_URL}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: u, password: p, isWebsite: "false" }),
		});
		const data = await resp.json();
		if (resp.ok && data.success) {
			auth_token = data.token;
			username = data.username;
			await browser.storage.local.set({ auth_token, username });
			serverReachable = true;
			startBatchSender();
			return { success: true };
		}
		return { success: false, message: data.message };
	} catch (e) {
		return { success: false, message: e.message };
	}
}

async function logoutUser() {
	auth_token = null;
	username = null;
	await browser.storage.local.remove(["auth_token", "username"]);
	stopBatchSender();
	browser.alarms.clear("queueWatchdog");
	browser.runtime
		.sendMessage({ type: "AUTH_STATUS_UPDATED", isLoggedIn: false })
		.catch(() => {});
	return { success: true };
}

async function checkServerStatus() {
	try {
		const r = await fetch(`${DATA_SERVER_URL}/status`);
		serverReachable = r.ok;
	} catch (e) {
		serverReachable = false;
	}
}

function startBatchSender() {
	if (batchIntervalId) return;
	// 1. Fast sync for active use
	batchIntervalId = setInterval(() => {
		if (serverReachable && messagesInQueueCount > 0) runBatch();
	}, currentBatchInterval);

	// 2. Persistent Watchdog for background/mobile use (triggers every 1 minute)
	browser.alarms.create("queueWatchdog", { periodInMinutes: 1 });
}

function stopBatchSender() {
	clearInterval(batchIntervalId);
	batchIntervalId = null;
	browser.alarms.clear("queueWatchdog"); // Stop waking up if logged out
}

function adjustBatchInterval() {
	if (messagesInQueueCount > 50) currentBatchInterval = MIN_INTERVAL;
	else if (lastRequestDuration > 2000)
		currentBatchInterval = Math.min(MAX_INTERVAL, currentBatchInterval * 2);
	else
		currentBatchInterval = Math.max(
			MIN_INTERVAL,
			Math.floor(currentBatchInterval * 0.9),
		);
	if (batchIntervalId) {
		stopBatchSender();
		startBatchSender();
	}
}

// ------------------ Init ------------------
(async function init() {
	const s = await browser.storage.local.get([
		"auth_token",
		"username",
		"messageTypeSettings",
	]);
	auth_token = s.auth_token || null;
	username = s.username || null;

	if (!s.auth_token) {
		console.log(
			"[Background] No token found on init. Poking website for sync.",
		);

		// 1. Try to find if the tab is already open and wake it up
		const tabs = await browser.tabs.query({
			url: "https://punoted.net/*",
		});
		if (tabs.length > 0) {
			browser.tabs
				.sendMessage(tabs[0].id, { type: "WAKE_UP_SYNC" })
				.catch(() => {});
		} else {
			// 2. If not open, open it so web_sync.js can do its job
			browser.tabs.create({ url: "https://punoted.net/" });
		}
	}

	const saved = s.messageTypeSettings || {};
	for (const t in USER_CONTROLLABLE_MESSAGE_TYPES_DEFAULTS) {
		messageTypeSettings[t] = saved.hasOwnProperty(t)
			? saved[t]
			: USER_CONTROLLABLE_MESSAGE_TYPES_DEFAULTS[t];
	}

	await checkServerStatus();
	const db = await openDb();
	db
		.transaction([QUEUE_STORE_NAME], "readonly")
		.objectStore(QUEUE_STORE_NAME)
		.count().onsuccess = (e) => {
		messagesInQueueCount = e.target.result;
		if (auth_token) startBatchSender();
	};

	resolveInitializationPromise();
})();
