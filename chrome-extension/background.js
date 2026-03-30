// Background Service Worker MV3 — proxy HTTPS
// Evite le Mixed Content : content.js délègue tous les fetch localhost au SW
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_PROXY") {
    handleFetchProxy(message.url, message.options)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // CRITIQUE : async response
  }
  if (message.type === "KEEPALIVE") {
    sendResponse({ alive: true });
    return true;
  }
});

async function handleFetchProxy(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error("HTTP " + response.status);
  return await response.json();
}
