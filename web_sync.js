(function() {
    const WEB_TOKEN_KEY = 'authToken'; 
    let syncInProgress = false;

    async function checkAndSync() {
        if (syncInProgress) return;

        try {
            // 1. Ask the background script if we actually need a token
            chrome.runtime.sendMessage({ type: 'GET_LOGIN_STATUS' }, (response) => {
                // Handle potential connection errors
                if (chrome.runtime.lastError) return;

                if (response && response.isLoggedIn) return; 

                // 2. If not logged in, check localStorage
                const webToken = localStorage.getItem(WEB_TOKEN_KEY);

                if (webToken) {
                    syncInProgress = true;
                    chrome.runtime.sendMessage({
                        type: 'SYNC_FROM_WEB',
                        payload: { token: webToken }
                    }, () => {
                        syncInProgress = false;
                        console.log("[PUNoted] Extension auto-synced from web.");
                    });
                }
            });
        } catch (e) {
            // Extension context might be invalidated during a reload
        }
    }

    checkAndSync();
    window.addEventListener('focus', checkAndSync); // Trigger when switching back to the tab
    window.addEventListener('click', checkAndSync);
})();