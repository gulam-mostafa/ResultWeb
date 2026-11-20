/** Minimal `firebase/auth` stub for the promotion smoke test. */
export function getAuth() {
  return {};
}
export function onAuthStateChanged() {
  return () => {};
}
export class GoogleAuthProvider {}
export class FacebookAuthProvider {}
export default { getAuth, onAuthStateChanged, GoogleAuthProvider, FacebookAuthProvider };
