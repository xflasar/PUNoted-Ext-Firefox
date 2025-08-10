console.log('████████████████████ [PrUn WS Interceptor] injected-script.js STARTED EXECUTION! ████████████████████');


(function() {
  // Store original console methods directly before any overriding
  const nativeConsoleLog = window.console.log;
  const nativeConsoleDebug = window.console.debug;
  const nativeConsoleError = window.console.error;
  const nativeConsoleWarn = window.console.warn;

  let hasInitialStateBeenCaptured = false;
  const INITIAL_STATE_CAPTURE_DELAY_MS = 2000;

  // Function to check if an object looks like the 'next state'
  function isNextStateObject(obj) {
    if (typeof obj !== 'object' || obj === null) {
      return false;
    }
    const hasCharacteristicKeys = (
      obj.hasOwnProperty('blueprints') ||
      obj.hasOwnProperty('contracts') ||
      obj.hasOwnProperty('mobile') ||
      obj.hasOwnProperty('populations') ||
      obj.hasOwnProperty('storage') ||
      obj.hasOwnProperty('workforce')
    );
    return hasCharacteristicKeys;
  }

  // --- OVERRIDE CONSOLE.LOG (ONLY for WebSocket messages) ---
  if (!window.__prunConsoleLogOverridden__) {
      window.__prunConsoleLogOverridden__ = true;

      const originalConsoleLog = window.console.log;

      window.console.log = function(...args) {
        originalConsoleLog.apply(window.console, args);
      };

      nativeConsoleLog('████████████████████████████████████████████████████████████████████████████████');
      nativeConsoleLog('████████████████████ [PrUn WS Interceptor] console.log OVERRIDDEN! ████████████████████');
      nativeConsoleLog('████████████████████████████████████████████████████████████████████████████████');
  }


  // --- WebSocket Proxying Logic ---
  if (typeof window.WebSocket !== 'undefined' && !window.WebSocket.__prunProxyActive__) {
    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const ws = new target(...args);
        nativeConsoleLog('[PrUn WS Interceptor] New WebSocket connection established:', args[0]);

        return new Proxy(ws, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (typeof value === 'function') {
              return value.bind(target);
            }
            return value;
          },
          set(target, prop, value) {
            if (prop === 'onmessage') {
              target.onmessage = e => {
                // Process the raw message data using the decoder
                if (typeof window.getPrunMessagePayload === 'function') {
                    const parsedMessage = window.getPrunMessagePayload(e.data);
                    if (parsedMessage) {
                      const match = location.href.match(/.*context=(?<context>[0-9a-fA-F-]{32})/);
                      const context = match?.groups?.context;

                      window.postMessage({ type: 'prun-ws-message-parsed', context, message: parsedMessage }, '*');
                      nativeConsoleLog('[PrUn WS Interceptor] Parsed WebSocket message forwarded to content script.');

                      // --- Initial State Capture Logic ---
                      if (parsedMessage.messageType === 'USER_DATA' && !hasInitialStateBeenCaptured) {
                          hasInitialStateBeenCaptured = true;
                          nativeConsoleLog('[PrUn WS Interceptor] USER_DATA received. Scheduling initial state capture...');

                          setTimeout(() => {
                              const nextState = findAndCaptureInitialState();
                              if (nextState) {
                                  window.postMessage({
                                      type: 'prun-initial-state-captured',
                                      context: context,
                                      nextState: nextState
                                  }, '*');
                                  nativeConsoleLog('[PrUn WS Interceptor] Initial state captured and forwarded to content script.');
                              } else {
                                  nativeConsoleWarn('[PrUn WS Interceptor] Initial state not found after USER_DATA and delay.');
                              }
                          }, INITIAL_STATE_CAPTURE_DELAY_MS);
                      }

                    } else {
                      nativeConsoleDebug('[PrUn WS Interceptor] Raw message not a recognized PrUn payload, skipping WebSocket forwarding:', e.data);
                    }
                } else {
                    nativeConsoleError('[PrUn WS Interceptor] getPrunMessagePayload is not available on window object.');
                }

                // Call the original onmessage handler
                if (typeof value === 'function') {
                  value(e);
                }
              };
              return true;
            }
            return Reflect.set(target, prop, value);
          },
        });
      },
    });

    window.WebSocket.__prunProxyActive__ = true;
    nativeConsoleLog('[PrUn WS Interceptor] WebSocket object proxied successfully.');

  } else {
    nativeConsoleWarn('[PrUn WS Interceptor] WebSocket not found or already proxied. Skipping WebSocket proxy injection.');
  }

  /**
   * Attempts to find and return the 'next state' object from the global scope.
   */
  function findAndCaptureInitialState() {
    const potentialGlobalStates = [
      window.store?.getState(),
      window.reduxStore?.getState(),
      window.app?.store?.getState(),
      window.app?.reduxStore?.getState(),
      window.__REDUX_DEVTOOLS_EXTENSION__?.backgroundPageConnection?.state,
      window.appState,
      window.prunState,
      window.game?.state,
      window.gameData,
    ];

    for (const stateCandidate of potentialGlobalStates) {
      if (stateCandidate && isNextStateObject(stateCandidate)) {
        return JSON.parse(JSON.stringify(stateCandidate));
      }
    }

    // Fallback: Exhaustive search
    for (const key in window) {
      try {
        if (typeof window[key] === 'object' && window[key] !== null) {
          if (isNextStateObject(window[key])) {
            return JSON.parse(JSON.stringify(window[key]));
          }
          // Check for nested 'state' property
          if (window[key].state && isNextStateObject(window[key].state)) {
            return JSON.parse(JSON.stringify(window[key].state));
          }
        }
      } catch (e) {
        // Ignore errors from accessing protected window properties
      }
    }
    return null;
  }

  nativeConsoleLog('[PrUn WS Interceptor] Injected script setup complete.');

})();
