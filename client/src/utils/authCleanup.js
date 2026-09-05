// Wipe per-user client state on logout so nothing from one account is visible
// after signing in as another in the same tab. Cognito tokens are cleared by
// Amplify's signOut(); this handles the app's own caches. Chat history is
// already keyed per user, so this is defence-in-depth.

export function clearUserSessionData() {
  try {
    // AI chat history — one key per user (`upply_ai_chat_<id>`)
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith("upply_ai_chat")) sessionStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable — nothing to clean */
  }
}
