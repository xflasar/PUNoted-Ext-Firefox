(function () {
	// --- Step 1: Inject injected-script.js and prun-message-decoder.js into the page's context ---
	const decoderScript = document.createElement("script");
	decoderScript.src = chrome.runtime.getURL("prun-message-decoder.js");
	decoderScript.type = "module";
	(document.head || document.documentElement).appendChild(decoderScript);

	decoderScript.onload = function () {
		const injectedScript = document.createElement("script");
		injectedScript.src = chrome.runtime.getURL("injected-script.js");
		injectedScript.type = "module";
		(document.head || document.documentElement).appendChild(injectedScript);

		injectedScript.onload = function () {
			decoderScript.remove();
			injectedScript.remove();
			console.log(
				"[PrUn WS Forwarder Content] Injected scripts loaded and cleaned up."
			);
		};
		injectedScript.onerror = function (e) {
			console.error(
				"[PrUn WS Forwarder Content] Failed to load injected-script.js:",
				e
			);
		};
	};
	decoderScript.onerror = function (e) {
		console.error(
			"[PrUn WS Forwarder Content] Failed to load prun-message-decoder.js:",
			e
		);
	};

	let localMessageQueue = [];
	let flushTimeout = null;
	const FLUSH_DEBOUNCE_MS = 100;

	/**
	 * Stores unique message types in localStorage for debugging.
	 * @param {string} messageType - The type of the message to store.
	 */
	function storeUniqueMessageType(messageType) {
		if (!messageType) return;

		try {
			let storedTypes =
				JSON.parse(localStorage.getItem("prunMessageTypes")) || [];
			if (!storedTypes.includes(messageType)) {
				storedTypes.push(messageType);
				localStorage.setItem("prunMessageTypes", JSON.stringify(storedTypes));
				console.log(
					`[PrUn WS Forwarder Content] Stored new unique message type: ${messageType}`
				);
			}
		} catch (e) {
			console.error(
				"[PrUn WS Forwarder Content] Error storing message type in localStorage:",
				e
			);
		}
	}

	function generateUniqueId() {
		return Date.now().toString(36) + Math.random().toString(36).substr(2);
	}

	function flushLocalQueueToBackground() {
		if (flushTimeout) {
			clearTimeout(flushTimeout);
			flushTimeout = null;
		}
		
		if (localMessageQueue.length === 0) {
			console.log("[PrUn WS Forwarder Content] No messages to flush.");
			return;
		}
		
		const messagesToSend = [...localMessageQueue];
		localMessageQueue = [];

		console.log(
			`[PrUn WS Forwarder Content] Flushing a batch of ${messagesToSend.length} messages to background script.`
		);
		
		const messageType = "PRUN_DATA_CAPTURED_BATCH";

		try {
			chrome.runtime.sendMessage({
				type: messageType,
				payload: messagesToSend,
			})
				.then(response => {
					if (response && response.success) {
						console.log(
							"[PrUn WS Forwarder Content] Batch successfully sent to background script."
						);
					} else {
						console.error(
							"[PrUn WS Forwarder Content] Failed to send batch:",
							response?.message || "Unknown error"
						);
						localMessageQueue.push(...messagesToSend);
						console.warn(
							`[PrUn WS Forwarder Content] Batch added back to local queue. Queue size: ${localMessageQueue.length}`
						);
					}
				})
				.catch(error => {
					console.error(
						"[PrUn WS Forwarder Content] Error sending batch to background script:",
						error
					);
					localMessageQueue.push(...messagesToSend);
					console.warn(
						`[PrUn WS Forwarder Content] Batch added back to local queue. Queue size: ${localMessageQueue.length}`
					);
				});
		} catch (e) {
			console.error(
				"[PrUn WS Forwarder Content] Synchronous error sending batch:",
				e
			);
			localMessageQueue.push(...messagesToSend);
			console.warn(
				`[PrUn WS Forwarder Content] Batch added back to local queue. Queue size: ${localMessageQueue.length}`
			);
		}
	}
	
	// --- Step 2: Listen for messages from the injected script ---
	window.addEventListener("message", function(event) {
		// Only accept messages from ourselves
		if (event.source !== window || !event.data || !event.data.type) {
			return;
		}
		
		// Handle initial state messages
		if (event.data.type === "prun-initial-state-captured") {
			const payloadToSend = {
				context: event.data.context,
				message: event.data.message,
			};
			console.log("[PrUn WS Forwarder Content] Sending initial state payload to background script:", payloadToSend);
			chrome.runtime.sendMessage({
					type: "PRUN_INITIAL_STATE",
					payload: payloadToSend,
				})
				.catch(e => console.error("[PrUn WS Forwarder Content] Error sending initial state to background:", e));
		}
		
		// Handle regular WebSocket messages
		if (event.data.type === 'prun-ws-message-parsed') {
			let payload = event.data.message;

			if (!payload || !payload.messageType) {
				console.warn('[PrUn WS Forwarder Content] Received a prun-ws-message-parsed event with a malformed payload. Skipping.');
				return;
			}
			
			// Unpack the nested message for "ACTION_COMPLETED"
			if (payload.messageType === "ACTION_COMPLETED") {
				payload = {
					...event.data.message.payload.message,
					context: event.data.message.context
				};
				console.log("[PrUn WS Forwarder Content] Detected ACTION_COMPLETED. Forwarding inner message type:", payload.messageType);
			}

			// Redefine message to forward
			const messageToForward = {
				messageType: payload.messageType,
				payload: payload.payload,
				context: payload.context,
			};

			const ignoredMessageTypes = [
				"SYSTEM_TRAFFIC_SHIP",
				"CHANNEL_DATA",
				"CHANNEL_UNSEEN_MESSAGES_COUNT",
				"TUTORIAL_TUTORIALS",
				"ALERTS_ALERTS",
				"UI_STACKS_STACKS",
				"CHANNEL_USER_LIST",
				"CHANNEL_MESSAGE_LIST",
				"PRESENCE_LIST",
			];

			if (messageToForward.messageType && ignoredMessageTypes.includes(messageToForward.messageType)) {
				console.log(`[PrUn WS Forwarder Content] Skipping message of type: ${messageToForward.messageType} (ignored).`);
				return;
			}

			localMessageQueue.push({
				id: generateUniqueId(),
				context: event.data.context,
				message: messageToForward,
			});
			
			if (flushTimeout) {
				clearTimeout(flushTimeout);
			}
			flushTimeout = setTimeout(flushLocalQueueToBackground, FLUSH_DEBOUNCE_MS);
		}
	});
})();