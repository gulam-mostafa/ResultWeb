import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase/firebaseConfig.js';

export function credentialEmail(value) {
  const input = String(value ?? '').trim().toLowerCase();
  if (input.includes('@')) return input;
  const digits = input.replace(/\D/g, '');
  return digits ? `${digits}@phone.resultweb.local` : '';
}

export async function registerFirebaseAccount(identity, password) {
  const email = credentialEmail(identity);
  if (!email || String(password ?? '').length < 6) throw new Error('Enter a valid email/phone and a password of at least 6 characters.');
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return { uid: credential.user.uid, email: credential.user.email };
}

export async function loginFirebaseAccount(identity, password) {
  const email = credentialEmail(identity);
  if (!email || !password) throw new Error('Enter your account and password.');
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return { uid: credential.user.uid, email: credential.user.email };
}
