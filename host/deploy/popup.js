chrome.runtime.sendMessage('ping', (r) => {
  document.getElementById('state').textContent = r && r.ok
    ? 'Ready. Your agent can drive Chrome now.'
    : 'Waiting for the relay. It starts by itself on the first command from your agent.';
});
